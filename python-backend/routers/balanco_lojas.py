"""Balanco de estoque das LOJAS (nao confundir com Balanco Patrimonial):
acompanhamento de como os balanços (contagens) estao sendo feitos e da
acuracidade do estoque.

Fonte: views do ERP vr_bal_balancoc (cabecalho do balanco: loja, numero, data,
tipo, situacao, operador) e vr_bal_balancoi (itens: saldo, contagem, diferenca,
falta, sobra, preco). Fabrica (empresa 1) fica de fora, por enquanto.

Consultar os itens direto leva ~30s por 90 dias (milhoes de linhas), entao a
tela le de duas tabelas proprias, alimentadas aos poucos (semana a semana) e
renovadas em segundo plano:
- fcp_bal_resumo: uma linha por balanco (contagens e valores ja somados);
- fcp_bal_diverg: so os itens COM diferenca (pra reincidencia e maiores
  divergencias);
- fcp_bal_sync: quais semanas ja foram lidas do ERP.

Definicoes (as mesmas aparecem em popup na tela):
- item ativo = item da lista com saldo ou contagem diferente de zero (a lista
  do balanco rotativo traz muitos itens zerados, que nao dizem nada);
- acuracidade por itens = (itens ativos - itens com diferenca) / itens ativos;
- acuracidade por pecas = 1 - soma(|diferenca|) / soma(maior entre saldo e
  contagem de cada item);
- valores a preco de tabela do proprio balanco (vl_preco).
So entra MERCADORIA: ficam de fora sacola, saquinho, embalagem, brinde, expositor,
material de marketing, consumo, servico e uniforme (ver TERMOS_NAO_PRODUTO) e
qualquer codigo >= 1.000.000 (insumo/material de PDV) - mesma regra do Giro.
Balanço em andamento (1) e cancelado (6) nao entram na acuracidade; aparecem
nos indicadores de processo.
"""
import asyncio
import threading
import time
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from database import execute_insert, execute_query
from routers.dre import CCUSTOS_LOJAS
from routers.giro import TERMOS_PRODUTO_EXCLUIDOS

router = APIRouter()

LOJAS = sorted(CCUSTOS_LOJAS.keys())  # 2..22 e 120 (sem a fabrica, empresa 1)
INICIO_HISTORICO = date(2026, 1, 1)
DIAS_RECENTES = 3          # janelas com data nesse prazo sao sempre relidas
SITUACOES_VALIDAS = (3, 5, 7, 8)  # calculado, encerrado, 7 e 8 (rotativo concluido)
SITUACAO_NOME = {1: "Em andamento", 3: "Calculado", 5: "Encerrado", 6: "Cancelado", 7: "Situação 7", 8: "Concluído (rotativo)"}
TIPOS = ("ROTATIVO", "PRINCIPAL", "RECONTAGEM", "AJUSTE")
TIPOS_PADRAO = ("ROTATIVO", "PRINCIPAL", "RECONTAGEM")
META_OK, META_ATENCAO = 98.0, 95.0  # acuracidade por itens (%): verde / amarelo / vermelho

# Fora da avaliacao: o que nao e mercadoria de venda (sacola, saquinho, embalagem,
# brinde, expositor, material de marketing, consumo, servico, uniforme...). Mesma
# regra do Giro (codigo >= 1.000.000 = insumo/material de PDV + termos no nome),
# mais a linha MATERIAIS DE MKT e alguns termos de consumo/servico.
TERMOS_NAO_PRODUTO = list(TERMOS_PRODUTO_EXCLUIDOS) + ["CONSUMO", "SERVICO", "UNIFORME"]
PADROES_NAO_PRODUTO = [f"%{t}%" for t in TERMOS_NAO_PRODUTO]
# trecho SQL (alias i = item do balanco) + 1 parametro (lista de padroes)
SQL_SO_PRODUTO = """i.cd_produto < 1000000
        AND NOT EXISTS (SELECT 1 FROM giro_prd_referencia pn WHERE pn.cd_produto = i.cd_produto
                        AND (pn.produto ILIKE ANY(%s) OR pn.linha ILIKE 'MATERIAIS DE MKT%%'))"""

_tabelas_ok = False
_trava_sync = threading.Lock()
_estado_sync = {"rodando": False, "janelasFeitas": 0, "janelasTotal": 0, "inicio": None, "fim": None, "erro": None}


# ----------------------------------------------------------------------------
# tabelas e sincronizacao
# ----------------------------------------------------------------------------
def _criar_tabelas() -> None:
    global _tabelas_ok
    if _tabelas_ok:
        return
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_bal_resumo (
            cd_empbal INT NOT NULL, nr_balanco BIGINT NOT NULL,
            dt_cadastro TIMESTAMP, dt_inclusao TIMESTAMP, dt_validade TIMESTAMP,
            ds_balanco TEXT, tp_balanco INT, tp_situacao INT, tipo TEXT, cd_operador INT,
            itens_lista INT, itens_ativos INT, itens_contados INT, itens_divergentes INT,
            pecas_saldo NUMERIC, pecas_contadas NUMERIC, pecas_dif_abs NUMERIC, pecas_base NUMERIC,
            pecas_falta NUMERIC, pecas_sobra NUMERIC,
            valor_saldo NUMERIC, valor_falta NUMERIC, valor_sobra NUMERIC,
            dt_lista TIMESTAMP, dt_contagem TIMESTAMP,
            dt_sync TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (cd_empbal, nr_balanco)
        )""", ())
    execute_insert("CREATE INDEX IF NOT EXISTS ix_fcp_bal_resumo_dt ON fcp_bal_resumo (dt_cadastro)", ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_bal_diverg (
            cd_empbal INT NOT NULL, nr_balanco BIGINT NOT NULL, cd_produto BIGINT NOT NULL,
            dt_cadastro TIMESTAMP, qt_saldo NUMERIC, qt_contagem NUMERIC, qt_diferenca NUMERIC,
            vl_preco NUMERIC, vl_diferenca NUMERIC,
            PRIMARY KEY (cd_empbal, nr_balanco, cd_produto)
        )""", ())
    execute_insert("CREATE INDEX IF NOT EXISTS ix_fcp_bal_diverg_dt ON fcp_bal_diverg (dt_cadastro)", ())
    execute_insert("CREATE INDEX IF NOT EXISTS ix_fcp_bal_diverg_prod ON fcp_bal_diverg (cd_produto)", ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_bal_sync (
            janela_ini DATE PRIMARY KEY, dt_sync TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""", ())
    _tabelas_ok = True


def _janelas(ate: date) -> list:
    """Semanas [ini, fim) desde INICIO_HISTORICO ate hoje."""
    out, d = [], INICIO_HISTORICO
    while d <= ate:
        out.append((d, d + timedelta(days=7)))
        d += timedelta(days=7)
    return out


_SQL_RESUMO = """
    INSERT INTO fcp_bal_resumo (
        cd_empbal, nr_balanco, dt_cadastro, dt_inclusao, dt_validade, ds_balanco, tp_balanco, tp_situacao, tipo, cd_operador,
        itens_lista, itens_ativos, itens_contados, itens_divergentes,
        pecas_saldo, pecas_contadas, pecas_dif_abs, pecas_base, pecas_falta, pecas_sobra,
        valor_saldo, valor_falta, valor_sobra, dt_lista, dt_contagem, dt_sync)
    SELECT c.cd_empbal, c.nr_balanco, c.dt_cadastro, c.dt_inclusao, c.dt_validade, c.ds_balanco, c.tp_balanco, c.tp_situacao,
        CASE WHEN c.ds_balanco ILIKE '%%RECONTAGEM%%' THEN 'RECONTAGEM'
             WHEN c.tp_balanco = 4 THEN 'ROTATIVO'
             WHEN c.ds_balanco ILIKE 'BALANCO PRINCIPAL%%' THEN 'PRINCIPAL'
             ELSE 'AJUSTE' END,
        c.cd_operador,
        COUNT(i.cd_produto),
        COUNT(*) FILTER (WHERE i.qt_saldo <> 0 OR i.qt_contagem <> 0),
        COUNT(*) FILTER (WHERE i.qt_contagem <> 0),
        COUNT(*) FILTER (WHERE i.qt_diferenca <> 0),
        COALESCE(SUM(i.qt_saldo), 0), COALESCE(SUM(i.qt_contagem), 0),
        COALESCE(SUM(ABS(i.qt_diferenca)), 0), COALESCE(SUM(GREATEST(i.qt_saldo, i.qt_contagem)), 0),
        COALESCE(SUM(i.qt_falta), 0), COALESCE(SUM(i.qt_sobra), 0),
        COALESCE(SUM(i.qt_saldo * i.vl_preco), 0), COALESCE(SUM(i.qt_falta * i.vl_preco), 0), COALESCE(SUM(i.qt_sobra * i.vl_preco), 0),
        MIN(i.dt_inclusao), MAX(i.dt_cadastro), NOW()
    FROM vr_bal_balancoc c
    LEFT JOIN vr_bal_balancoi i ON i.cd_empbal = c.cd_empbal AND i.nr_balanco = c.nr_balanco
        AND """ + SQL_SO_PRODUTO + """
    WHERE c.cd_empbal = ANY(%s) AND c.dt_cadastro >= %s AND c.dt_cadastro < %s
    GROUP BY c.cd_empbal, c.nr_balanco, c.dt_cadastro, c.dt_inclusao, c.dt_validade, c.ds_balanco, c.tp_balanco, c.tp_situacao, c.cd_operador
    ON CONFLICT (cd_empbal, nr_balanco) DO UPDATE SET
        dt_cadastro = EXCLUDED.dt_cadastro, dt_inclusao = EXCLUDED.dt_inclusao, dt_validade = EXCLUDED.dt_validade,
        ds_balanco = EXCLUDED.ds_balanco, tp_balanco = EXCLUDED.tp_balanco, tp_situacao = EXCLUDED.tp_situacao,
        tipo = EXCLUDED.tipo, cd_operador = EXCLUDED.cd_operador, itens_lista = EXCLUDED.itens_lista,
        itens_ativos = EXCLUDED.itens_ativos, itens_contados = EXCLUDED.itens_contados, itens_divergentes = EXCLUDED.itens_divergentes,
        pecas_saldo = EXCLUDED.pecas_saldo, pecas_contadas = EXCLUDED.pecas_contadas, pecas_dif_abs = EXCLUDED.pecas_dif_abs,
        pecas_base = EXCLUDED.pecas_base, pecas_falta = EXCLUDED.pecas_falta, pecas_sobra = EXCLUDED.pecas_sobra,
        valor_saldo = EXCLUDED.valor_saldo, valor_falta = EXCLUDED.valor_falta, valor_sobra = EXCLUDED.valor_sobra,
        dt_lista = EXCLUDED.dt_lista, dt_contagem = EXCLUDED.dt_contagem, dt_sync = NOW()
"""

_SQL_DIVERG = """
    INSERT INTO fcp_bal_diverg (cd_empbal, nr_balanco, cd_produto, dt_cadastro, qt_saldo, qt_contagem, qt_diferenca, vl_preco, vl_diferenca)
    SELECT i.cd_empbal, i.nr_balanco, i.cd_produto, c.dt_cadastro, i.qt_saldo, i.qt_contagem, i.qt_diferenca, i.vl_preco,
           i.qt_diferenca * COALESCE(i.vl_preco, 0)
    FROM vr_bal_balancoc c
    JOIN vr_bal_balancoi i ON i.cd_empbal = c.cd_empbal AND i.nr_balanco = c.nr_balanco
    WHERE c.cd_empbal = ANY(%s) AND c.dt_cadastro >= %s AND c.dt_cadastro < %s AND i.qt_diferenca <> 0
      AND """ + SQL_SO_PRODUTO + """
    ON CONFLICT (cd_empbal, nr_balanco, cd_produto) DO UPDATE SET
        qt_saldo = EXCLUDED.qt_saldo, qt_contagem = EXCLUDED.qt_contagem, qt_diferenca = EXCLUDED.qt_diferenca,
        vl_preco = EXCLUDED.vl_preco, vl_diferenca = EXCLUDED.vl_diferenca
"""


def _sincronizar_janela(ini: date, fim: date) -> None:
    # Balanco que mudou de numero/loja nao existe; mas item que deixou de ter
    # diferenca (recontagem corrigiu) precisa sair: apaga a janela e regrava.
    execute_insert("DELETE FROM fcp_bal_diverg WHERE dt_cadastro >= %s AND dt_cadastro < %s AND cd_empbal = ANY(%s)", (ini, fim, LOJAS))
    execute_insert(_SQL_RESUMO, (PADROES_NAO_PRODUTO, LOJAS, ini, fim))
    execute_insert(_SQL_DIVERG, (LOJAS, ini, fim, PADROES_NAO_PRODUTO))
    execute_insert("INSERT INTO fcp_bal_sync (janela_ini, dt_sync) VALUES (%s, NOW()) ON CONFLICT (janela_ini) DO UPDATE SET dt_sync = NOW()", (ini,))


def sincronizar(dias: Optional[int] = None) -> dict:
    """dias=None: o que falta do historico + janelas recentes. dias=N: relê so
    os ultimos N dias (botao 'Atualizar dados')."""
    if not _trava_sync.acquire(blocking=False):
        return {**_estado_sync, "jaRodando": True}
    try:
        _criar_tabelas()
        hoje = date.today()
        if dias is not None:
            limite = hoje - timedelta(days=dias)
            alvo = [(i, f) for i, f in _janelas(hoje) if f > limite]
        else:
            feitas = {r["janela_ini"] for r in (execute_query("SELECT janela_ini FROM fcp_bal_sync") or [])}
            recente = hoje - timedelta(days=DIAS_RECENTES)
            alvo = [(i, f) for i, f in _janelas(hoje) if i not in feitas or f > recente]
        _estado_sync.update(rodando=True, janelasFeitas=0, janelasTotal=len(alvo), inicio=datetime.now().isoformat(), fim=None, erro=None)
        for ini, fim in alvo:
            _sincronizar_janela(ini, fim)
            _estado_sync["janelasFeitas"] += 1
        return dict(_estado_sync)
    except Exception as e:  # noqa: BLE001
        _estado_sync["erro"] = str(e)
        print(f"[balanco-lojas] erro na sincronizacao: {e}")
        raise
    finally:
        _estado_sync.update(rodando=False, fim=datetime.now().isoformat())
        _trava_sync.release()


async def loop_sincronizacao():
    """Primeira leitura 60s depois de subir; depois a cada 20 min."""
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(sincronizar)
        except Exception as e:  # noqa: BLE001
            print(f"[balanco-lojas] loop: {e}")
        await asyncio.sleep(20 * 60)


# ----------------------------------------------------------------------------
# consultas
# ----------------------------------------------------------------------------
def _parse_empresas(empresas: Optional[str]) -> list:
    if not empresas:
        return list(LOJAS)
    try:
        ids = [int(x) for x in empresas.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Lista de empresas inválida")
    ids = [i for i in ids if i in CCUSTOS_LOJAS]
    return ids or list(LOJAS)


def _parse_tipos(tipos: Optional[str]) -> list:
    if not tipos:
        return list(TIPOS_PADRAO)
    t = [x.strip().upper() for x in tipos.split(",") if x.strip().upper() in TIPOS]
    return t or list(TIPOS_PADRAO)


def _parse_situacoes(situacoes: Optional[str]) -> list:
    """Situacoes do balanco escolhidas no filtro (padrao: as validas)."""
    if not situacoes:
        return list(SITUACOES_VALIDAS)
    try:
        ids = [int(x) for x in situacoes.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Lista de situações inválida")
    ids = [i for i in ids if i in SITUACAO_NOME]
    return ids or list(SITUACOES_VALIDAS)


def _periodo(ini: Optional[str], fim: Optional[str]):
    hoje = date.today()
    try:
        d_ini = date.fromisoformat(ini) if ini else hoje - timedelta(days=29)
        d_fim = date.fromisoformat(fim) if fim else hoje
    except ValueError:
        raise HTTPException(status_code=400, detail="Datas devem ser YYYY-MM-DD")
    if d_fim < d_ini:
        raise HTTPException(status_code=400, detail="Data final menor que a inicial")
    return d_ini, d_fim


def _busca(busca: Optional[str], alias: str = ""):
    """Filtro por numero ou descricao do balanco -> (clausula SQL, params)."""
    b = (busca or "").strip()
    if not b:
        return "", ()
    a = f"{alias}." if alias else ""
    return f" AND ({a}nr_balanco::text = %s OR {a}ds_balanco ILIKE %s)", (b, f"%{b}%")


def _f(v) -> float:
    return float(v) if v is not None else 0.0


def _pct(num, den) -> Optional[float]:
    return round(100.0 * num / den, 2) if den else None


def _status_acuracidade(a: Optional[float]) -> str:
    if a is None:
        return "neutro"
    return "ok" if a >= META_OK else "atencao" if a >= META_ATENCAO else "ruim"


def _agregar(r: dict) -> dict:
    """Soma de linhas do resumo -> indicadores."""
    ativos, div = _f(r.get("itens_ativos")), _f(r.get("itens_divergentes"))
    base, dif = _f(r.get("pecas_base")), _f(r.get("pecas_dif_abs"))
    ac_itens = _pct(ativos - div, ativos)
    ac_pecas = None if not base else round(max(0.0, 100.0 * (1 - dif / base)), 2)
    return {
        "balancos": int(r.get("balancos") or 0),
        "itensAtivos": int(ativos), "itensContados": int(_f(r.get("itens_contados"))), "itensDivergentes": int(div),
        "pecasSaldo": round(_f(r.get("pecas_saldo"))), "pecasContadas": round(_f(r.get("pecas_contadas"))),
        "pecasFalta": round(_f(r.get("pecas_falta"))), "pecasSobra": round(_f(r.get("pecas_sobra"))),
        "valorFalta": round(_f(r.get("valor_falta")), 2), "valorSobra": round(_f(r.get("valor_sobra")), 2),
        "valorSaldo": round(_f(r.get("valor_saldo")), 2),
        "valorLiquido": round(_f(r.get("valor_sobra")) - _f(r.get("valor_falta")), 2),
        "acuracidadeItens": ac_itens, "acuracidadePecas": ac_pecas,
        "acuracidadeValor": None if not _f(r.get("valor_saldo")) else round(max(0.0, 100.0 * (1 - (_f(r.get("valor_falta")) + _f(r.get("valor_sobra"))) / max(_f(r.get("valor_saldo")), 1e-9))), 2),
        "status": _status_acuracidade(ac_itens),
    }


_COLS_SOMA = """
    COUNT(*) AS balancos, SUM(itens_ativos) AS itens_ativos, SUM(itens_contados) AS itens_contados, SUM(itens_divergentes) AS itens_divergentes,
    SUM(pecas_saldo) AS pecas_saldo, SUM(pecas_contadas) AS pecas_contadas, SUM(pecas_dif_abs) AS pecas_dif_abs, SUM(pecas_base) AS pecas_base,
    SUM(pecas_falta) AS pecas_falta, SUM(pecas_sobra) AS pecas_sobra, SUM(valor_saldo) AS valor_saldo, SUM(valor_falta) AS valor_falta, SUM(valor_sobra) AS valor_sobra
"""


def _dias_uteis(d_ini: date, d_fim: date, dias_com_balanco: dict) -> list:
    """Dias seg-sex do periodo em que pelo menos metade das lojas do filtro
    fez balanco (rotativo) - dia que nenhuma/poucas lojas contaram e tratado
    como feriado/sem operacao e nao pesa na cobertura. Vale para os tipos de
    balanco e a busca escolhidos no filtro."""
    limite = min(d_fim, date.today())
    n_lojas = max(1, len(dias_com_balanco))
    por_dia: dict = {}
    for loja, dias in dias_com_balanco.items():
        for d in dias:
            por_dia[d] = por_dia.get(d, 0) + 1
    out, d = [], d_ini
    while d <= limite:
        if d.weekday() < 5 and por_dia.get(d, 0) * 2 >= n_lojas:
            out.append(d)
        d += timedelta(days=1)
    return out


@router.get("/api/balanco-lojas/status")
def status_sincronizacao():
    try:
        _criar_tabelas()
        r = (execute_query("SELECT COUNT(*) n, MIN(dt_cadastro) mn, MAX(dt_cadastro) mx, MAX(dt_sync) sync FROM fcp_bal_resumo") or [{}])[0]
        feitas = (execute_query("SELECT COUNT(*) n FROM fcp_bal_sync") or [{"n": 0}])[0]["n"]
        total = len(_janelas(date.today()))
        return {
            **_estado_sync,
            "balancosGravados": int(r.get("n") or 0),
            "primeiraData": r["mn"].date().isoformat() if r.get("mn") else None,
            "ultimaData": r["mx"].date().isoformat() if r.get("mx") else None,
            "atualizadoEm": r["sync"].isoformat() if r.get("sync") else None,
            "janelasGravadas": int(feitas), "janelasHistorico": total,
            "historicoCompleto": int(feitas) >= total,
        }
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Erro no status: {e}")


@router.post("/api/balanco-lojas/sincronizar")
def sincronizar_agora(dias: int = Query(14, ge=1, le=400)):
    """Botao 'Atualizar dados': relê do ERP os ultimos N dias (padrao 14)."""
    try:
        t0 = time.time()
        r = sincronizar(dias)
        return {**r, "segundos": round(time.time() - t0, 1)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Erro ao atualizar: {e}")


@router.get("/api/balanco-lojas/opcoes")
def opcoes():
    return {
        "lojas": [{"cdEmpresa": k, "nome": CCUSTOS_LOJAS[k]} for k in LOJAS],
        "tipos": [{"id": t, "padrao": t in TIPOS_PADRAO} for t in TIPOS],
        "metaOk": META_OK, "metaAtencao": META_ATENCAO,
        "primeiraData": INICIO_HISTORICO.isoformat(),
    }


@router.get("/api/balanco-lojas/resumo")
def resumo(
    inicio: Optional[str] = Query(None), fim: Optional[str] = Query(None),
    empresas: Optional[str] = Query(None), tipos: Optional[str] = Query(None), busca: Optional[str] = Query(None),
    situacoes: Optional[str] = Query(None),
):
    try:
        _criar_tabelas()
        d_ini, d_fim = _periodo(inicio, fim)
        lojas, tps = _parse_empresas(empresas), _parse_tipos(tipos)
        sits = _parse_situacoes(situacoes)
        ini_ts, fim_ts = d_ini, d_fim + timedelta(days=1)
        cb, pbusca = _busca(busca)
        base = f"FROM fcp_bal_resumo WHERE cd_empbal = ANY(%s) AND tipo = ANY(%s) AND dt_cadastro >= %s AND dt_cadastro < %s{cb}"
        pb = (lojas, tps, ini_ts, fim_ts, *pbusca)
        validas = f"{base} AND tp_situacao = ANY(%s)"
        pv = (*pb, sits)

        total = _agregar((execute_query(f"SELECT {_COLS_SOMA} {validas}", pv) or [{}])[0])

        # processo: cancelados / em andamento / sem nenhum item contado / tempo ate contar
        proc = (execute_query(f"""
            SELECT COUNT(*) FILTER (WHERE tp_situacao = 6) AS cancelados,
                   COUNT(*) FILTER (WHERE tp_situacao = 1) AS em_andamento,
                   COUNT(*) FILTER (WHERE tp_situacao = ANY(%s) AND itens_contados = 0) AS sem_contagem,
                   COUNT(*) FILTER (WHERE tp_situacao = ANY(%s) AND itens_divergentes > 0) AS com_divergencia,
                   COUNT(*) AS total,
                   AVG(EXTRACT(EPOCH FROM (dt_contagem - dt_lista)) / 3600.0)
                       FILTER (WHERE tp_situacao = ANY(%s) AND tipo = 'ROTATIVO' AND dt_contagem > dt_lista AND dt_contagem - dt_lista < INTERVAL '2 days') AS horas_ate_contar
            {base}""", (sits,) * 3 + pb) or [{}])[0]
        n_validos = total["balancos"]
        total.update({
            "cancelados": int(proc.get("cancelados") or 0), "emAndamento": int(proc.get("em_andamento") or 0),
            "balancosTotal": int(proc.get("total") or 0),
            "balancosSemContagem": int(proc.get("sem_contagem") or 0),
            "balancosComDivergencia": int(proc.get("com_divergencia") or 0),
            "pctBalancosComDivergencia": _pct(int(proc.get("com_divergencia") or 0), n_validos),
            "pctCancelados": _pct(int(proc.get("cancelados") or 0), int(proc.get("total") or 0)),
            "horasAteContar": round(_f(proc.get("horas_ate_contar")), 1) if proc.get("horas_ate_contar") is not None else None,
        })

        # por loja
        linhas = execute_query(f"SELECT cd_empbal, {_COLS_SOMA} {validas} GROUP BY cd_empbal", pv) or []
        procs = {r["cd_empbal"]: r for r in (execute_query(f"""
            SELECT cd_empbal, COUNT(*) FILTER (WHERE tp_situacao = 6) AS cancelados, MAX(dt_cadastro) FILTER (WHERE tp_situacao = ANY(%s)) AS ultimo
            {base} GROUP BY cd_empbal""", (sits,) + pb) or [])}
        dias_loja: dict = {l: set() for l in lojas}
        for r in execute_query(f"SELECT cd_empbal, dt_cadastro::date AS d FROM fcp_bal_resumo WHERE cd_empbal = ANY(%s) AND tipo = ANY(%s) AND tp_situacao = ANY(%s) AND dt_cadastro >= %s AND dt_cadastro < %s AND itens_contados > 0{cb} GROUP BY 1, 2",
                               (lojas, tps, sits, ini_ts, fim_ts, *pbusca)) or []:
            dias_loja.setdefault(r["cd_empbal"], set()).add(r["d"])
        uteis = _dias_uteis(d_ini, d_fim, dias_loja)
        set_uteis = set(uteis)
        por_loja = []
        por_id = {r["cd_empbal"]: r for r in linhas}
        for l in lojas:
            ag = _agregar(por_id.get(l, {}))
            p = procs.get(l, {})
            ultimo = p.get("ultimo")
            feitos = len(dias_loja.get(l, set()) & set_uteis)
            por_loja.append({
                "cdEmpresa": l, "loja": CCUSTOS_LOJAS[l], **ag,
                "cancelados": int(p.get("cancelados") or 0),
                "diasComBalanco": feitos, "diasUteis": len(uteis), "cobertura": _pct(feitos, len(uteis)),
                "ultimoBalanco": ultimo.isoformat() if ultimo else None,
                "diasSemBalanco": (date.today() - ultimo.date()).days if ultimo else None,
            })

        # por dia (acuracidade diaria consolidada)
        por_dia = []
        for r in execute_query(f"SELECT dt_cadastro::date AS d, {_COLS_SOMA} {validas} GROUP BY 1 ORDER BY 1", pv) or []:
            ag = _agregar(r)
            por_dia.append({"data": r["d"].isoformat(), "balancos": ag["balancos"], "itensAtivos": ag["itensAtivos"],
                            "itensDivergentes": ag["itensDivergentes"], "acuracidadeItens": ag["acuracidadeItens"],
                            "acuracidadePecas": ag["acuracidadePecas"], "valorFalta": ag["valorFalta"], "valorSobra": ag["valorSobra"]})

        # por tipo (ignora o filtro de tipo pra comparar os tipos entre si)
        por_tipo = []
        for r in execute_query(f"""SELECT tipo, {_COLS_SOMA} FROM fcp_bal_resumo
            WHERE cd_empbal = ANY(%s) AND dt_cadastro >= %s AND dt_cadastro < %s AND tp_situacao = ANY(%s){cb} GROUP BY tipo""",
                               (lojas, ini_ts, fim_ts, sits, *pbusca)) or []:
            por_tipo.append({"tipo": r["tipo"], **_agregar(r)})
        por_tipo.sort(key=lambda x: TIPOS.index(x["tipo"]) if x["tipo"] in TIPOS else 9)

        # por operador (codigo do ERP; o nome nao esta nas tabelas de balanco)
        ops = execute_query(f"SELECT cd_operador, {_COLS_SOMA} {validas} GROUP BY cd_operador HAVING SUM(itens_ativos) > 0", pv) or []
        por_operador = []
        for o in ops:
            ag = _agregar(o)
            por_operador.append({"cdOperador": o["cd_operador"], "operador": f"Operador {o['cd_operador']}" if o["cd_operador"] is not None else "(sem operador)", **ag})

        return {
            "periodo": {"inicio": d_ini.isoformat(), "fim": d_fim.isoformat()},
            "filtros": {"empresas": lojas, "tipos": tps},
            "total": total, "porLoja": por_loja, "porDia": por_dia, "porTipo": por_tipo, "porOperador": por_operador,
            "diasUteis": len(uteis),
            "metas": {"ok": META_OK, "atencao": META_ATENCAO},
        }
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao montar o resumo dos balanços: {e}")


@router.get("/api/balanco-lojas/balancos")
def balancos(
    inicio: Optional[str] = Query(None), fim: Optional[str] = Query(None),
    empresas: Optional[str] = Query(None), tipos: Optional[str] = Query(None),
    busca: Optional[str] = Query(None), situacoes: Optional[str] = Query(None),
):
    try:
        _criar_tabelas()
        d_ini, d_fim = _periodo(inicio, fim)
        lojas, tps = _parse_empresas(empresas), _parse_tipos(tipos)
        cb, pbusca = _busca(busca, "r")
        sits = _parse_situacoes(situacoes)
        filtro_sit = " AND r.tp_situacao = ANY(%s)" + cb
        rows = execute_query(f"""
            SELECT r.* FROM fcp_bal_resumo r
            WHERE r.cd_empbal = ANY(%s) AND r.tipo = ANY(%s) AND r.dt_cadastro >= %s AND r.dt_cadastro < %s{filtro_sit}
            ORDER BY r.dt_cadastro DESC LIMIT 3000""", (lojas, tps, d_ini, d_fim + timedelta(days=1), sits, *pbusca)) or []
        out = []
        for r in rows:
            ag = _agregar({**r, "balancos": 1})
            valida = r["tp_situacao"] in SITUACOES_VALIDAS
            out.append({
                "cdEmpresa": r["cd_empbal"], "loja": CCUSTOS_LOJAS.get(r["cd_empbal"], str(r["cd_empbal"])), "nrBalanco": r["nr_balanco"],
                "data": r["dt_cadastro"].isoformat() if r["dt_cadastro"] else None, "descricao": r["ds_balanco"], "tipo": r["tipo"],
                "situacao": SITUACAO_NOME.get(r["tp_situacao"], f"Situação {r['tp_situacao']}"), "tpSituacao": r["tp_situacao"],
                "operador": f"Operador {r['cd_operador']}" if r["cd_operador"] is not None else None,
                "itensLista": r["itens_lista"], "itensAtivos": ag["itensAtivos"], "itensContados": ag["itensContados"],
                "itensDivergentes": ag["itensDivergentes"],
                "pecasSaldo": ag["pecasSaldo"], "pecasContadas": ag["pecasContadas"], "pecasFalta": ag["pecasFalta"], "pecasSobra": ag["pecasSobra"],
                "valorFalta": ag["valorFalta"], "valorSobra": ag["valorSobra"],
                "acuracidadeItens": ag["acuracidadeItens"] if valida else None,
                "acuracidadePecas": ag["acuracidadePecas"] if valida else None,
                "status": ag["status"] if valida else "neutro",
                "horasAteContar": round((r["dt_contagem"] - r["dt_lista"]).total_seconds() / 3600, 1)
                    if r["dt_contagem"] and r["dt_lista"] and r["dt_contagem"] > r["dt_lista"] and (r["dt_contagem"] - r["dt_lista"]) < timedelta(days=2) else None,
            })
        return {"itens": out, "limitado": len(rows) >= 3000}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Erro ao listar balanços: {e}")


_SQL_NOME_PRODUTO = """
    LEFT JOIN giro_prd_referencia p ON p.cd_produto = {alias}.cd_produto
"""


@router.get("/api/balanco-lojas/produtos-criticos")
def produtos_criticos(
    inicio: Optional[str] = Query(None), fim: Optional[str] = Query(None),
    empresas: Optional[str] = Query(None), tipos: Optional[str] = Query(None), busca: Optional[str] = Query(None),
    situacoes: Optional[str] = Query(None),
):
    """Reincidencia (produto que divergiu em varios balanços) e maiores
    divergencias em valor."""
    try:
        _criar_tabelas()
        d_ini, d_fim = _periodo(inicio, fim)
        lojas, tps = _parse_empresas(empresas), _parse_tipos(tipos)
        cb, pbusca = _busca(busca, "r")
        pb = (lojas, tps, _parse_situacoes(situacoes), d_ini, d_fim + timedelta(days=1), *pbusca)
        filtro = f"""FROM fcp_bal_diverg d JOIN fcp_bal_resumo r ON r.cd_empbal = d.cd_empbal AND r.nr_balanco = d.nr_balanco
                    WHERE d.cd_empbal = ANY(%s) AND r.tipo = ANY(%s) AND r.tp_situacao = ANY(%s) AND d.dt_cadastro >= %s AND d.dt_cadastro < %s{cb}"""
        reinc = execute_query(f"""
            SELECT d.cd_produto, COUNT(*) AS vezes, COUNT(DISTINCT d.cd_empbal) AS lojas,
                   SUM(ABS(d.qt_diferenca)) AS pecas_abs, SUM(d.qt_diferenca) AS pecas_liq,
                   SUM(ABS(d.vl_diferenca)) AS valor_abs, MAX(d.dt_cadastro) AS ultima
            {filtro} GROUP BY d.cd_produto HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, SUM(ABS(d.vl_diferenca)) DESC LIMIT 60""", pb) or []
        maiores = execute_query(f"""
            SELECT d.cd_produto, d.cd_empbal, d.nr_balanco, d.dt_cadastro, d.qt_saldo, d.qt_contagem, d.qt_diferenca, d.vl_preco, d.vl_diferenca
            {filtro} ORDER BY ABS(d.vl_diferenca) DESC LIMIT 60""", pb) or []
        cds = list({r["cd_produto"] for r in reinc} | {r["cd_produto"] for r in maiores})
        nomes = {}
        if cds:
            nomes = {r["cd_produto"]: r for r in (execute_query(
                "SELECT cd_produto, referencia, produto, ds_cor, ds_tamanho, grupo FROM giro_prd_referencia WHERE cd_produto = ANY(%s)", (cds,)) or [])}

        def nome(cd):
            n = nomes.get(cd) or {}
            return {"referencia": n.get("referencia"), "produto": n.get("produto"), "cor": n.get("ds_cor"), "tamanho": n.get("ds_tamanho"), "grupo": n.get("grupo")}

        return {
            "reincidentes": [{"cdProduto": r["cd_produto"], **nome(r["cd_produto"]), "vezes": int(r["vezes"]), "lojas": int(r["lojas"]),
                              "pecasAbs": round(_f(r["pecas_abs"])), "pecasLiquidas": round(_f(r["pecas_liq"])),
                              "valorAbs": round(_f(r["valor_abs"]), 2), "ultima": r["ultima"].isoformat()} for r in reinc],
            "maiores": [{"cdProduto": r["cd_produto"], **nome(r["cd_produto"]), "cdEmpresa": r["cd_empbal"], "loja": CCUSTOS_LOJAS.get(r["cd_empbal"]),
                         "nrBalanco": r["nr_balanco"], "data": r["dt_cadastro"].isoformat(), "saldo": round(_f(r["qt_saldo"])),
                         "contagem": round(_f(r["qt_contagem"])), "diferenca": round(_f(r["qt_diferenca"])),
                         "preco": round(_f(r["vl_preco"]), 2), "valorDiferenca": round(_f(r["vl_diferenca"]), 2)} for r in maiores],
        }
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar produtos críticos: {e}")


@router.get("/api/balanco-lojas/itens")
def itens_do_balanco(cdEmpresa: int = Query(...), nrBalanco: int = Query(...), somenteDivergentes: bool = Query(True)):
    """Itens de UM balanço, direto do ERP (rapido por balanço)."""
    try:
        if cdEmpresa not in CCUSTOS_LOJAS:
            raise HTTPException(status_code=400, detail="Empresa inválida")
        filtro = (" AND i.qt_diferenca <> 0" if somenteDivergentes else " AND (i.qt_saldo <> 0 OR i.qt_contagem <> 0)") + " AND " + SQL_SO_PRODUTO
        rows = execute_query(f"""
            SELECT i.cd_produto, i.qt_saldo, i.qt_contagem, i.qt_diferenca, i.qt_falta, i.qt_sobra, i.vl_preco,
                   p.referencia, p.produto, p.ds_cor, p.ds_tamanho
            FROM vr_bal_balancoi i LEFT JOIN giro_prd_referencia p ON p.cd_produto = i.cd_produto
            WHERE i.cd_empbal = %s AND i.nr_balanco = %s{filtro}
            ORDER BY ABS(i.qt_diferenca * COALESCE(i.vl_preco, 0)) DESC, i.cd_produto LIMIT 1000""", (cdEmpresa, nrBalanco, PADROES_NAO_PRODUTO)) or []
        return {"itens": [{
            "cdProduto": r["cd_produto"], "referencia": r["referencia"], "produto": r["produto"], "cor": r["ds_cor"], "tamanho": r["ds_tamanho"],
            "saldo": _f(r["qt_saldo"]), "contagem": _f(r["qt_contagem"]), "diferenca": _f(r["qt_diferenca"]),
            "preco": _f(r["vl_preco"]), "valorDiferenca": round(_f(r["qt_diferenca"]) * _f(r["vl_preco"]), 2),
        } for r in rows]}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Erro ao buscar itens do balanço: {e}")
