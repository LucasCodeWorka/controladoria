"""
Quebra de Pedidos - cancelamentos de itens de pedido da fabrica, abertos por
motivo, por data e consolidados, com o percentual sobre o faturamento da
fabrica no periodo.

Mesma base do indicador "Quebra de Pedidos" (routers/indicadores.py):
 - vr_ped_pedidoicanc2: so o ULTIMO cancelamento de cada pedido+produto no
   periodo (ROW_NUMBER por dt_cadastro desc), pela data do cancelamento;
 - ligado a vr_ped_pedidoi (item do pedido), so operacoes 52 e 1;
 - valor = vl_unitario x qt_cancelada do item.
O indicador considera so o motivo 6 (QUEBRA DE PEDIDOS); aqui entram todos os
motivos, e o motivo 6 vem marcado (ehQuebra) - o total dele bate com o card do
indicador. Faturamento da fabrica = mesmo calculo do indicador (empresa 1,
situacao 4, sem representantes e operacoes excluidos).
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date, timedelta
from database import execute_query, execute_insert
from routers.indicadores import OPERACOES_EXCLUIDAS, REPRESENTANTES_EXCLUIDOS

router = APIRouter()

MOTIVO_QUEBRA = 6
LIMITE_PCT = 0.10  # pedido so conta como quebra se cancelou ate 10% das pecas dele


def _parse_data(valor: Optional[str], padrao: date) -> date:
    if not valor:
        return padrao
    try:
        return date.fromisoformat(valor)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Data invalida: {valor} (use AAAA-MM-DD)")


def _parse_motivos(valor: Optional[str]) -> list:
    if not valor:
        return []
    try:
        return [int(v) for v in valor.split(",") if v.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Motivos invalidos: {valor}")


def _pct(parte: float, total: float) -> Optional[float]:
    return round(parte / total * 100, 2) if total else None


def _ate_limite(p) -> bool:
    return p is not None and p <= LIMITE_PCT + 1e-9


def _pct_pedidos(itens: list) -> dict:
    """(cd_empresa, cd_pedido) -> fracao cancelada (qt_cancelada / qt_solicitada) do pedido todo."""
    ids = sorted({i["cd_pedido"] for i in itens})
    if not ids:
        return {}
    rows = execute_query(
        """SELECT cd_empresa, cd_pedido, SUM(qt_cancelada) AS c, SUM(qt_solicitada) AS s
           FROM vr_ped_pedidoi WHERE cd_operacao IN (52, 1) AND cd_pedido = ANY(%s)
           GROUP BY cd_empresa, cd_pedido""", (ids,)) or []
    return {(r["cd_empresa"], r["cd_pedido"]): (float(r["c"] or 0) / float(r["s"]) if r["s"] else None) for r in rows}


# ── Cache mensal (meses fechados nao mudam) ──────────────────────────────

def _criar_tabelas_cache():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS quebra_pedidos_mes (
            mes TEXT NOT NULL, cd_motivo INTEGER NOT NULL, motivo TEXT,
            valor NUMERIC NOT NULL DEFAULT 0, qtd NUMERIC NOT NULL DEFAULT 0,
            PRIMARY KEY (mes, cd_motivo)
        )""", ())
    execute_insert("ALTER TABLE quebra_pedidos_mes ADD COLUMN IF NOT EXISTS valor_ate10 NUMERIC NOT NULL DEFAULT 0", ())
    execute_insert("ALTER TABLE quebra_pedidos_mes ADD COLUMN IF NOT EXISTS qtd_ate10 NUMERIC NOT NULL DEFAULT 0", ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS quebra_pedidos_mes_calc (
            mes TEXT PRIMARY KEY, faturamento NUMERIC NOT NULL DEFAULT 0,
            calculado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""", ())
    execute_insert("ALTER TABLE quebra_pedidos_mes_calc ADD COLUMN IF NOT EXISTS ate10 BOOLEAN NOT NULL DEFAULT FALSE", ())


def _calcular_mes(mes: str):
    """Calcula (por motivo) e grava no cache o mes AAAA-MM."""
    ano, m = (int(p) for p in mes.split("-"))
    ini = date(ano, m, 1)
    fim = date(ano + 1, 1, 1) if m == 12 else date(ano, m + 1, 1)
    ops_fab = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS)
    reps_excl = ", ".join(str(r) for r in REPRESENTANTES_EXCLUIDOS)
    itens = execute_query(
        """
        WITH ult AS (
            SELECT a.*, ROW_NUMBER() OVER (
                PARTITION BY a.cd_empresa, a.cd_pedido, a.cd_produto ORDER BY a.dt_cadastro DESC
            ) AS rn
            FROM vr_ped_pedidoicanc2 a
            WHERE a.dt_cadastro >= %s::date AND a.dt_cadastro < %s::date
        )
        SELECT u.cd_empresa, u.cd_pedido, u.cd_motivocanc AS cd_motivo,
               COALESCE(NULLIF(TRIM(u.ds_motivocanc), ''), 'Motivo ' || u.cd_motivocanc::text) AS motivo,
               COALESCE(b.vl_unitario * b.qt_cancelada, 0) AS valor,
               COALESCE(b.qt_cancelada, 0) AS qtd
        FROM ult u
        JOIN vr_ped_pedidoi b
          ON u.cd_pedido = b.cd_pedido AND u.cd_empresa = b.cd_empresa AND u.cd_produto = b.cd_produto
        WHERE u.rn = 1 AND b.cd_operacao IN (52, 1) AND u.cd_motivocanc IS NOT NULL
        """,
        (ini.isoformat(), fim.isoformat()),
    ) or []
    pct = _pct_pedidos(itens)
    agg: dict = {}
    for i in itens:
        a = agg.setdefault(i["cd_motivo"], {"cd_motivo": i["cd_motivo"], "motivo": i["motivo"],
                                            "valor": 0.0, "qtd": 0.0, "valor10": 0.0, "qtd10": 0.0})
        v, q = float(i["valor"] or 0), float(i["qtd"] or 0)
        a["valor"] += v
        a["qtd"] += q
        if _ate_limite(pct.get((i["cd_empresa"], i["cd_pedido"]))):
            a["valor10"] += v
            a["qtd10"] += q
    rows = list(agg.values())
    fat = execute_query(
        f"""
        SELECT COALESCE(SUM(CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END), 0) AS fat
        FROM vr_tra_transacao t
        LEFT JOIN vr_tra_transitem i
          ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
        WHERE t.cd_empresa = 1 AND t.tp_situacao = 4 AND t.cd_representant IS NOT NULL
          AND t.cd_representant <> ALL (ARRAY[{reps_excl}])
          AND t.cd_operacao NOT IN ({ops_fab})
          AND t.dt_transacao >= %s::date AND t.dt_transacao < %s::date
          AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
               OR (t.tp_modalidade IN ('3') AND t.tp_operacao = 'E'))
        """,
        (ini.isoformat(), fim.isoformat()),
    ) or [{"fat": 0}]
    execute_insert("DELETE FROM quebra_pedidos_mes WHERE mes = %s", (mes,))
    for r in rows:
        execute_insert(
            "INSERT INTO quebra_pedidos_mes (mes, cd_motivo, motivo, valor, qtd, valor_ate10, qtd_ate10) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (mes, r["cd_motivo"], r["motivo"], float(r["valor"] or 0), float(r["qtd"] or 0),
             float(r["valor10"] or 0), float(r["qtd10"] or 0)),
        )
    execute_insert(
        """INSERT INTO quebra_pedidos_mes_calc (mes, faturamento, calculado_em, ate10) VALUES (%s, %s, CURRENT_TIMESTAMP, TRUE)
           ON CONFLICT (mes) DO UPDATE SET faturamento = EXCLUDED.faturamento, calculado_em = CURRENT_TIMESTAMP, ate10 = TRUE""",
        (mes, float(fat[0]["fat"] or 0)),
    )


def _meses_fechados(hoje: date) -> list:
    return [f"{hoje.year}-{m:02d}" for m in range(1, hoje.month)]


def garantir_meses_fechados():
    """Calcula os meses fechados do ano que ainda nao estao no cache."""
    _criar_tabelas_cache()
    hoje = date.today()
    prontos = {r["mes"] for r in (execute_query("SELECT mes FROM quebra_pedidos_mes_calc WHERE ate10") or [])}
    for mes in _meses_fechados(hoje):
        if mes not in prontos:
            _calcular_mes(mes)


def _serie_mensal(hoje: date, motivos_filtro: list, ate10: bool = False) -> list:
    meses = _meses_fechados(hoje)
    if not meses:
        return []
    garantir_meses_fechados()
    calc = {r["mes"]: float(r["faturamento"] or 0) for r in (execute_query(
        "SELECT mes, faturamento FROM quebra_pedidos_mes_calc WHERE mes IN %s", (tuple(meses),)) or [])}
    linhas = execute_query(
        "SELECT mes, cd_motivo, valor, qtd, valor_ate10, qtd_ate10 FROM quebra_pedidos_mes WHERE mes IN %s", (tuple(meses),)) or []
    por_mes: dict = {m: {"valor": 0.0, "qtd": 0.0, "valorQuebra": 0.0} for m in meses}
    for r in linhas:
        if motivos_filtro and r["cd_motivo"] not in motivos_filtro:
            continue
        d = por_mes[r["mes"]]
        v = float(r["valor_ate10"] if ate10 else r["valor"])
        d["valor"] += v
        d["qtd"] += float(r["qtd_ate10"] if ate10 else r["qtd"])
        if r["cd_motivo"] == MOTIVO_QUEBRA:
            d["valorQuebra"] += v
    serie = []
    for m in meses:
        d = por_mes[m]
        fat = calc.get(m, 0.0)
        serie.append({"mes": m, "valor": round(d["valor"], 2), "qtd": round(d["qtd"], 2),
                      "valorQuebra": round(d["valorQuebra"], 2), "faturamento": round(fat, 2),
                      "pctFaturamento": _pct(d["valor"], fat)})
    return serie


@router.get("/api/quebra-pedidos")
def quebra_pedidos(
    dataInicio: Optional[str] = Query(None, description="Data inicial AAAA-MM-DD (default: 1o dia do mes atual)"),
    dataFim: Optional[str] = Query(None, description="Data final AAAA-MM-DD, inclusive (default: hoje)"),
    somenteQuebra: bool = Query(False, description="true = so o motivo 6 (QUEBRA DE PEDIDOS), igual ao indicador"),
    motivos: Optional[str] = Query(None, description="Lista de cd_motivocanc separados por virgula (default: todos)"),
    ate10: bool = Query(False, description="true = so pedidos que cancelaram ate 10% das pecas"),
):
    try:
        hoje = date.today()
        ini = _parse_data(dataInicio, hoje.replace(day=1))
        fim = _parse_data(dataFim, hoje)
        if fim < ini:
            raise HTTPException(status_code=400, detail="dataFim anterior a dataInicio")
        fim_exclusivo = fim + timedelta(days=1)
        ops_fab = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS)
        reps_excl = ", ".join(str(r) for r in REPRESENTANTES_EXCLUIDOS)
        lista_motivos_filtro = _parse_motivos(motivos)
        if somenteQuebra:
            lista_motivos_filtro = [MOTIVO_QUEBRA]
        filtro_motivo = (
            f"AND u.cd_motivocanc IN ({', '.join(str(m) for m in lista_motivos_filtro)})" if lista_motivos_filtro else ""
        )

        itens = execute_query(
            f"""
            WITH ult AS (
                SELECT a.*, ROW_NUMBER() OVER (
                    PARTITION BY a.cd_empresa, a.cd_pedido, a.cd_produto
                    ORDER BY a.dt_cadastro DESC
                ) AS rn
                FROM vr_ped_pedidoicanc2 a
                WHERE a.dt_cadastro >= %s::date AND a.dt_cadastro < %s::date
            )
            SELECT u.cd_motivocanc AS cd_motivo,
                   COALESCE(NULLIF(TRIM(u.ds_motivocanc), ''), 'Motivo ' || u.cd_motivocanc::text) AS motivo,
                   u.dt_cadastro::date AS data,
                   u.cd_empresa, u.cd_pedido, b.cd_cliente,
                   COALESCE(b.qt_cancelada, 0) AS qtd,
                   COALESCE(b.vl_unitario * b.qt_cancelada, 0) AS valor
            FROM ult u
            JOIN vr_ped_pedidoi b
              ON u.cd_pedido = b.cd_pedido
             AND u.cd_empresa = b.cd_empresa
             AND u.cd_produto = b.cd_produto
            WHERE u.rn = 1
              AND b.cd_operacao IN (52, 1)
              {filtro_motivo}
            """,
            (ini.isoformat(), fim_exclusivo.isoformat()),
        ) or []

        if ate10:
            pct_ped = _pct_pedidos(itens)
            itens = [i for i in itens if _ate_limite(pct_ped.get((i["cd_empresa"], i["cd_pedido"])))]

        fat_rows = execute_query(
            f"""
            SELECT t.dt_transacao::date AS data,
                   COALESCE(SUM(CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END), 0) AS fat
            FROM vr_tra_transacao t
            LEFT JOIN vr_tra_transitem i
              ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
            WHERE t.cd_empresa = 1
              AND t.tp_situacao = 4
              AND t.cd_representant IS NOT NULL
              AND t.cd_representant <> ALL (ARRAY[{reps_excl}])
              AND t.cd_operacao NOT IN ({ops_fab})
              AND t.dt_transacao >= %s::date AND t.dt_transacao < %s::date
              AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
                   OR (t.tp_modalidade IN ('3') AND t.tp_operacao = 'E'))
            GROUP BY 1
            """,
            (ini.isoformat(), fim_exclusivo.isoformat()),
        ) or []
        fat_por_dia = {r["data"].isoformat(): float(r["fat"] or 0) for r in fat_rows}
        faturamento = sum(fat_por_dia.values())

        total_valor = sum(float(i["valor"] or 0) for i in itens)
        total_qtd = sum(float(i["qtd"] or 0) for i in itens)

        por_motivo: dict = {}
        por_data: dict = {}
        for i in itens:
            v, q = float(i["valor"] or 0), float(i["qtd"] or 0)
            m = por_motivo.setdefault(i["cd_motivo"], {
                "cdMotivo": i["cd_motivo"], "motivo": i["motivo"], "ehQuebra": i["cd_motivo"] == MOTIVO_QUEBRA,
                "itens": 0, "pedidos": set(), "qtd": 0.0, "valor": 0.0,
            })
            m["itens"] += 1
            m["pedidos"].add(i["cd_pedido"])
            m["qtd"] += q
            m["valor"] += v
            d = por_data.setdefault(i["data"].isoformat(), {"data": i["data"].isoformat(), "itens": 0, "qtd": 0.0, "valor": 0.0, "valorQuebra": 0.0})
            d["itens"] += 1
            d["qtd"] += q
            d["valor"] += v
            if i["cd_motivo"] == MOTIVO_QUEBRA:
                d["valorQuebra"] += v

        lista_motivos = []
        for m in sorted(por_motivo.values(), key=lambda x: x["valor"], reverse=True):
            lista_motivos.append({
                "cdMotivo": m["cdMotivo"], "motivo": m["motivo"], "ehQuebra": m["ehQuebra"],
                "itens": m["itens"], "pedidos": len(m["pedidos"]),
                "qtd": round(m["qtd"], 2), "valor": round(m["valor"], 2),
                "pctDoTotal": _pct(m["valor"], total_valor),
                "pctFaturamento": _pct(m["valor"], faturamento),
            })

        por_cliente: dict = {}
        for i in itens:
            cl = por_cliente.setdefault(i["cd_cliente"], {"cdCliente": i["cd_cliente"], "pedidos": set(), "itens": 0, "qtd": 0.0, "valor": 0.0})
            cl["pedidos"].add(i["cd_pedido"])
            cl["itens"] += 1
            cl["qtd"] += float(i["qtd"] or 0)
            cl["valor"] += float(i["valor"] or 0)
        nomes = {}
        ids_cli = [k for k in por_cliente if k is not None]
        if ids_cli:
            for r in execute_query("SELECT cd_pessoa, nm_pessoa FROM vr_pes_pessoa WHERE cd_pessoa = ANY(%s)", (ids_cli,)) or []:
                nomes[r["cd_pessoa"]] = r["nm_pessoa"]
        lista_clientes = [{
            "cdCliente": c["cdCliente"], "cliente": nomes.get(c["cdCliente"]) or "(sem nome)",
            "pedidos": len(c["pedidos"]), "itens": c["itens"], "qtd": round(c["qtd"], 2), "valor": round(c["valor"], 2),
            "pctDoTotal": _pct(c["valor"], total_valor),
        } for c in sorted(por_cliente.values(), key=lambda x: x["valor"], reverse=True)]

        lista_datas = []
        for k in sorted(por_data):
            d = por_data[k]
            fat_dia = fat_por_dia.get(k, 0.0)
            lista_datas.append({
                "data": d["data"], "itens": d["itens"], "qtd": round(d["qtd"], 2), "valor": round(d["valor"], 2),
                "valorQuebra": round(d["valorQuebra"], 2), "faturamento": round(fat_dia, 2),
                "pctFaturamento": _pct(d["valor"], fat_dia),
            })

        # Grafico mensal: meses do ano atual ate o ULTIMO MES FECHADO (nao depende das
        # datas do filtro; respeita o filtro de motivo). Meses fechados ficam em cache
        # no banco (calcular um mes leva dezenas de segundos).
        por_mes = _serie_mensal(hoje, lista_motivos_filtro, ate10)

        quebra = por_motivo.get(MOTIVO_QUEBRA)
        return {
            "dataInicio": ini.isoformat(), "dataFim": fim.isoformat(), "somenteQuebra": somenteQuebra, "ate10": ate10,
            "consolidado": {
                "itens": len(itens),
                "pedidos": len({i["cd_pedido"] for i in itens}),
                "qtd": round(total_qtd, 2),
                "valor": round(total_valor, 2),
                "faturamentoFabrica": round(faturamento, 2),
                "pctFaturamento": _pct(total_valor, faturamento),
                "valorQuebra": round(quebra["valor"], 2) if quebra else 0.0,
                "qtdQuebra": round(quebra["qtd"], 2) if quebra else 0.0,
                "pctQuebraFaturamento": _pct(quebra["valor"], faturamento) if quebra else (0.0 if faturamento else None),
            },
            "porMotivo": lista_motivos,
            "porData": lista_datas,
            "porCliente": lista_clientes,
            "porMes": por_mes,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro em quebra-pedidos: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular a quebra de pedidos: {str(e)}")


@router.get("/api/quebra-pedidos/motivos")
def motivos_disponiveis():
    """Motivos de cancelamento existentes no ano atual (pro filtro da tela)."""
    try:
        rows = execute_query(
            """
            SELECT cd_motivocanc AS cd, MAX(COALESCE(NULLIF(TRIM(ds_motivocanc), ''), 'Motivo ' || cd_motivocanc::text)) AS motivo
            FROM vr_ped_pedidoicanc2
            WHERE dt_cadastro >= %s::date AND cd_motivocanc IS NOT NULL
            GROUP BY cd_motivocanc
            ORDER BY cd_motivocanc
            """,
            (date.today().replace(month=1, day=1).isoformat(),),
        ) or []
        return {"motivos": [{"cdMotivo": r["cd"], "motivo": r["motivo"], "ehQuebra": r["cd"] == MOTIVO_QUEBRA} for r in rows]}
    except Exception as e:
        print(f"[ERROR] Erro ao listar motivos da quebra de pedidos: {e}")
        raise HTTPException(status_code=500, detail=str(e))
