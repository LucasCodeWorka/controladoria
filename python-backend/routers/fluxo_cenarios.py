"""
Cenarios do Fluxo de Caixa - "foto" das contas a pagar (duplicatas) e dos
pedidos de compra EM ABERTO num periodo, pra comparar depois com a situacao
atual e ver o que mudou (novas, pagas, movidas de dia, alteradas, canceladas).

Compartilhado: todo mundo que abre o fluxo ve os mesmos cenarios (como a
simulacao/Uso da Garantia). So informativo - nada daqui entra no saldo do dia
nem no acumulado, e as consultas normais do fluxo nao sao tocadas.

A foto guarda so o que estava EM ABERTO na hora de salvar (mesmos filtros do
fluxo: _filtros_saidas / _filtros_pedidos). Na comparacao, o lado "agora" de
cada dia e o TOTAL do dia (em aberto + ja pago), lido direto da tabela de
duplicatas - senao uma duplicata paga depois da foto sumiria do comparativo.
"""
import threading
import traceback
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from database import execute_query, execute_insert
from routers.fluxo_caixa import (
    _criar_tabelas_fluxo_caixa, _parse_empresas, _dia_str,
    _filtros_saidas, _filtros_pedidos, _PRE_FILTRO_VENCIMENTO,
    _EXPR_DT_SAIDA_EFETIVA, _EXPR_DT_PEDIDOS_EFETIVA, _NOME_FORNECEDOR,
)

router = APIRouter()

_tabelas_ok = False
_tabelas_lock = threading.Lock()


def _criar_tabelas_cenarios():
    global _tabelas_ok
    if _tabelas_ok:
        return
    with _tabelas_lock:
        if _tabelas_ok:
            return
        execute_insert("""
            CREATE TABLE IF NOT EXISTS fcp_cenarios (
                id BIGSERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                dt_inicio DATE NOT NULL,
                dt_fim DATE NOT NULL,
                empresas TEXT,
                criado_por TEXT,
                criado_em TIMESTAMP DEFAULT NOW(),
                qtd_duplicatas INT NOT NULL DEFAULT 0,
                vl_duplicatas NUMERIC(16,2) NOT NULL DEFAULT 0,
                qtd_pedidos INT NOT NULL DEFAULT 0,
                vl_pedidos NUMERIC(16,2) NOT NULL DEFAULT 0
            )
        """, ())
        execute_insert("""
            CREATE TABLE IF NOT EXISTS fcp_cenarios_itens (
                cenario_id BIGINT NOT NULL REFERENCES fcp_cenarios(id) ON DELETE CASCADE,
                tipo TEXT NOT NULL,
                cd_empresa BIGINT NOT NULL,
                cd_fornecedor BIGINT,
                nr_documento BIGINT NOT NULL,
                nr_parcela BIGINT NOT NULL,
                dt_efetiva DATE NOT NULL,
                dt_original DATE,
                valor NUMERIC(16,2) NOT NULL,
                previsao_real INT,
                fornecedor TEXT
            )
        """, ())
        execute_insert(
            "CREATE INDEX IF NOT EXISTS idx_fcp_cenarios_itens ON fcp_cenarios_itens (cenario_id, tipo)", ()
        )
        _tabelas_ok = True


# ── Salvar / listar / excluir ─────────────────────────────────────────────
@router.post("/api/fluxo-caixa/cenarios")
def salvar_cenario(dados: dict):
    """Salva a foto do periodo (so o que esta em aberto agora)."""
    nome = str(dados.get("nome") or "").strip()
    dt_inicio = str(dados.get("dtInicio") or "")
    dt_fim = str(dados.get("dtFim") or "")
    empresas = dados.get("empresas") or None
    criado_por = (str(dados.get("criadoPor") or "").strip() or None)
    if not nome:
        raise HTTPException(status_code=400, detail="Informe um nome pro cenário")
    try:
        date.fromisoformat(dt_inicio)
        date.fromisoformat(dt_fim)
    except ValueError:
        raise HTTPException(status_code=400, detail="Período inválido")
    try:
        _criar_tabelas_fluxo_caixa()
        _criar_tabelas_cenarios()
        cd_empresas = _parse_empresas(empresas)

        novo = execute_insert(
            "INSERT INTO fcp_cenarios (nome, dt_inicio, dt_fim, empresas, criado_por) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (nome, dt_inicio, dt_fim, empresas, criado_por),
        )
        cenario_id = novo[0]["id"]
        try:
            # Duplicatas em aberto (mesmo filtro do fluxo), direto no banco.
            where, params = _filtros_saidas(dt_inicio, dt_fim, cd_empresas)
            execute_insert(f"""
                INSERT INTO fcp_cenarios_itens
                    (cenario_id, tipo, cd_empresa, cd_fornecedor, nr_documento, nr_parcela, dt_efetiva, dt_original, valor, previsao_real, fornecedor)
                SELECT %s, 'duplicata', d.cd_empresa, d.cd_fornecedor, d.nr_duplicata, d.nr_parcela,
                    {_EXPR_DT_SAIDA_EFETIVA}::date, d.dt_vencimento::date,
                    ROUND((d.vl_duplicata - d.vl_pago)::numeric, 2), COALESCE(d.tp_previsaoreal, 0),
                    {_NOME_FORNECEDOR}
                FROM vr_fcp_duplicatai d
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
                {where}
            """, tuple([cenario_id] + list(params)))

            # Pedidos de compra (uma linha por parcela simulada).
            where_p, params_p = _filtros_pedidos(dt_inicio, dt_fim, cd_empresas)
            execute_insert(f"""
                INSERT INTO fcp_cenarios_itens
                    (cenario_id, tipo, cd_empresa, cd_fornecedor, nr_documento, nr_parcela, dt_efetiva, dt_original, valor, previsao_real, fornecedor)
                SELECT %s, 'pedido', p.cd_empresa, NULL, p.cd_pedido, c.nr_parcela,
                    {_EXPR_DT_PEDIDOS_EFETIVA}::date,
                    (p.dt_basepgto::date + (c.qt_dia || ' days')::interval)::date,
                    ROUND((p.vl_pendente / NULLIF(c.qt_parcela, 0))::numeric, 2), NULL, p.nm_fornecedor
                {where_p}
            """, tuple([cenario_id] + list(params_p)))

            execute_insert("""
                UPDATE fcp_cenarios SET
                    qtd_duplicatas = (SELECT COUNT(*) FROM fcp_cenarios_itens WHERE cenario_id = %s AND tipo = 'duplicata'),
                    vl_duplicatas = (SELECT COALESCE(SUM(valor), 0) FROM fcp_cenarios_itens WHERE cenario_id = %s AND tipo = 'duplicata'),
                    qtd_pedidos = (SELECT COUNT(*) FROM fcp_cenarios_itens WHERE cenario_id = %s AND tipo = 'pedido'),
                    vl_pedidos = (SELECT COALESCE(SUM(valor), 0) FROM fcp_cenarios_itens WHERE cenario_id = %s AND tipo = 'pedido')
                WHERE id = %s
            """, (cenario_id, cenario_id, cenario_id, cenario_id, cenario_id))
        except Exception:
            # Foto incompleta nao serve: desfaz o cabecalho (itens saem em cascata).
            execute_insert("DELETE FROM fcp_cenarios WHERE id = %s", (cenario_id,))
            raise
        return _listar_cenarios(cenario_id)[0]
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao salvar cenario: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Erro ao salvar o cenário")


def _listar_cenarios(cenario_id: Optional[int] = None) -> list:
    where = "WHERE id = %s" if cenario_id is not None else ""
    rows = execute_query(f"""
        SELECT id, nome, dt_inicio, dt_fim, empresas, criado_por, criado_em,
               qtd_duplicatas, vl_duplicatas, qtd_pedidos, vl_pedidos
        FROM fcp_cenarios {where} ORDER BY criado_em DESC, id DESC
    """, (cenario_id,) if cenario_id is not None else ()) or []
    return [
        {
            "id": r["id"], "nome": r["nome"],
            "dtInicio": _dia_str(r["dt_inicio"]), "dtFim": _dia_str(r["dt_fim"]),
            "empresas": r["empresas"], "criadoPor": r["criado_por"],
            "criadoEm": r["criado_em"].strftime("%d/%m/%Y %H:%M") if r["criado_em"] else None,
            "qtdDuplicatas": r["qtd_duplicatas"], "vlDuplicatas": float(r["vl_duplicatas"] or 0),
            "qtdPedidos": r["qtd_pedidos"], "vlPedidos": float(r["vl_pedidos"] or 0),
        }
        for r in rows
    ]


@router.get("/api/fluxo-caixa/cenarios")
def listar_cenarios():
    try:
        _criar_tabelas_cenarios()
        return _listar_cenarios()
    except Exception as e:
        print(f"[ERROR] Erro ao listar cenarios: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Erro ao listar cenários")


@router.delete("/api/fluxo-caixa/cenarios/{cenario_id}")
def excluir_cenario(cenario_id: int):
    try:
        _criar_tabelas_cenarios()
        execute_insert("DELETE FROM fcp_cenarios WHERE id = %s", (cenario_id,))
        return {"ok": True}
    except Exception as e:
        print(f"[ERROR] Erro ao excluir cenario: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Erro ao excluir o cenário")


# ── Comparacao ────────────────────────────────────────────────────────────
def _situacao_duplicata(r) -> tuple:
    """(estado, saldo_em_aberto, valor_total) do estado ATUAL da duplicata.
    estado: aberta | paga | cancelada | outra. Estagio 90 = liquidada (o
    sistema deixa saldo em vl_pago mesmo liquidada - conta como paga)."""
    sit = r["tp_situacao"]
    est = r["tp_estagio"]
    total = float(r["vl_duplicata"] or 0)
    saldo = round(total - float(r["vl_pago"] or 0), 2)
    if sit == "C" and est != 90:
        return "cancelada", 0.0, total
    if est == 90 or saldo <= 0:
        return "paga", 0.0, total
    if sit == "N":
        return "aberta", saldo, total
    return "outra", 0.0, total


_ROTULO_ESTADO = {
    "aberta": "em aberto", "paga": "paga", "cancelada": "cancelada/substituída",
    "outra": "outra situação", "sumiu": "não encontrada",
}


def _novo_dia() -> dict:
    return {"cenario": 0.0, "atual": 0.0, "aberto": 0.0, "pago": 0.0, "cats": {}}


def _somar_cat(dias: dict, dia: str, cat: str, valor: float):
    d = dias.setdefault(dia, _novo_dia())
    c = d["cats"].setdefault(cat, {"qtd": 0, "valor": 0.0})
    c["qtd"] += 1
    c["valor"] = round(c["valor"] + valor, 2)


def _comparar_duplicatas(cen: dict, snap: list) -> tuple:
    """(dias, itens, resumo_por_categoria) das duplicatas."""
    dt_ini, dt_fim = cen["dt_inicio"], cen["dt_fim"]
    cd_empresas = _parse_empresas(cen["empresas"])
    criado_em = cen["criado_em"]
    dias: dict = {}
    itens: list = []

    # Estado atual: tudo com vencimento efetivo no periodo (qualquer situacao).
    params: list = [dt_ini, dt_fim, dt_ini, dt_fim]
    filtro_emp = ""
    if cd_empresas:
        filtro_emp = " AND cd_empresa = ANY(%s)"
        params.append(cd_empresas)
    atuais_rows = execute_query(f"""
        SELECT cd_empresa, cd_fornecedor, nr_duplicata, nr_parcela, tp_situacao, tp_estagio,
               vl_duplicata, vl_pago, dt_vencimento::date AS dt_orig,
               {_EXPR_DT_SAIDA_EFETIVA}::date AS dia, dt_inclusao
        FROM vr_fcp_duplicatai
        WHERE {_PRE_FILTRO_VENCIMENTO} AND {_EXPR_DT_SAIDA_EFETIVA} BETWEEN %s AND %s{filtro_emp}
    """, tuple(params)) or []
    atuais = {(r["cd_empresa"], r["cd_fornecedor"], r["nr_duplicata"], r["nr_parcela"]): r for r in atuais_rows}

    snap_map = {(s["cd_empresa"], s["cd_fornecedor"], s["nr_documento"], s["nr_parcela"]): s for s in snap}

    # Itens da foto que NAO estao no periodo agora (mudaram de data pra fora,
    # sumiram...): busca o estado atual pela chave.
    fora = [k for k in snap_map if k not in atuais]
    if fora:
        rows = execute_query("""
            SELECT d.cd_empresa, d.cd_fornecedor, d.nr_duplicata, d.nr_parcela, d.tp_situacao, d.tp_estagio,
                   d.vl_duplicata, d.vl_pago, d.dt_vencimento::date AS dt_orig,
                   d.dt_vencimento::date AS dia, d.dt_inclusao
            FROM unnest(%s::bigint[], %s::bigint[], %s::bigint[], %s::bigint[]) AS k(emp, forn, doc, parc)
            JOIN vr_fcp_duplicatai d ON d.cd_empresa = k.emp AND d.cd_fornecedor = k.forn
                 AND d.nr_duplicata = k.doc AND d.nr_parcela = k.parc
        """, tuple([k[i] for k in fora] for i in range(4))) or []
        for r in rows:
            atuais.setdefault((r["cd_empresa"], r["cd_fornecedor"], r["nr_duplicata"], r["nr_parcela"]), r)

    def item(cat, k, s, r, dia_cen, dia_atu, v_cen, v_atu, aberto, pago, estado):
        itens.append({
            "tipo": "duplicata", "categoria": cat,
            "documento": f"{k[2]}/{k[3]}", "empresa": k[0], "cdFornecedor": k[1],
            "fornecedor": (s or {}).get("fornecedor"),
            "diaCenario": dia_cen, "diaAtual": dia_atu,
            "valorCenario": v_cen, "valorAtual": v_atu, "aberto": aberto, "pago": pago,
            "situacao": _ROTULO_ESTADO.get(estado, estado),
        })

    # Foto -> agora
    for k, s in snap_map.items():
        a = _dia_str(s["dt_efetiva"])
        S = float(s["valor"])
        dias.setdefault(a, _novo_dia())["cenario"] += S
        r = atuais.get(k)
        if r is None:
            _somar_cat(dias, a, "sumiu", -S)
            item("sumiu", k, s, None, a, None, S, 0.0, 0.0, 0.0, "sumiu")
            continue
        estado, saldo, total = _situacao_duplicata(r)
        b = _dia_str(r["dia"])
        if estado in ("cancelada", "outra"):
            _somar_cat(dias, a, "cancelada" if estado == "cancelada" else "outra_situacao", -S)
            item("cancelada" if estado == "cancelada" else "outra_situacao", k, s, r, a, b, S, 0.0, 0.0, 0.0, estado)
            continue
        if estado == "paga":
            d = dias.setdefault(a, _novo_dia())
            d["atual"] += S
            d["pago"] += S
            _somar_cat(dias, a, "paga", S)  # informativo: valor pago, nao entra na variacao
            item("paga", k, s, r, a, b, S, S, 0.0, S, estado)
            continue
        # aberta
        total_item = max(saldo, S)
        pago_item = round(total_item - saldo, 2)
        if b != a:
            dias.setdefault(a, _novo_dia())
            _somar_cat(dias, a, "movida_saida", -S)
            d = dias.setdefault(b, _novo_dia())
            d["atual"] += total_item
            d["aberto"] += saldo
            d["pago"] += pago_item
            _somar_cat(dias, b, "movida_entrada", total_item)
            item("movida", k, s, r, a, b, S, total_item, saldo, pago_item, estado)
            continue
        d = dias.setdefault(a, _novo_dia())
        d["atual"] += total_item
        d["aberto"] += saldo
        d["pago"] += pago_item
        if abs(saldo - S) < 0.005:
            continue  # igual a foto
        if saldo > S:
            _somar_cat(dias, a, "alterada", saldo - S)
            item("alterada", k, s, r, a, b, S, saldo, saldo, 0.0, estado)
        else:
            _somar_cat(dias, a, "paga_parcial", S - saldo)  # informativo: valor pago
            item("paga_parcial", k, s, r, a, b, S, S, saldo, S - saldo, estado)

    # Agora -> foto: o que existe hoje e nao estava na foto.
    novos = []
    for k, r in atuais.items():
        if k in snap_map:
            continue
        dia_r = _dia_str(r["dia"])
        if not (dt_ini <= dia_r <= dt_fim):
            continue
        estado, saldo, total = _situacao_duplicata(r)
        if estado in ("cancelada", "outra"):
            continue
        nova_de_verdade = r["dt_inclusao"] is not None and r["dt_inclusao"] >= criado_em
        if estado == "paga" and not nova_de_verdade:
            continue  # ja estava paga antes da foto - nunca fez parte do aberto
        cat = "nova" if nova_de_verdade else "entrou_no_periodo"
        if estado == "paga":
            cat = "nova_paga"
        d = dias.setdefault(dia_r, _novo_dia())
        d["atual"] += total
        d["aberto"] += saldo
        d["pago"] += round(total - saldo, 2)
        _somar_cat(dias, dia_r, cat, total)
        novos.append((k, r, cat, dia_r, saldo, total, estado))

    if novos:
        # Nome do fornecedor so dos itens novos (um lote).
        forn_ids = list({k[1] for k, *_ in novos})
        nomes_sql = _NOME_FORNECEDOR.replace("d.cd_fornecedor", "p.cd_pessoa")
        nomes_rows = execute_query(f"""
            SELECT p.cd_pessoa, {nomes_sql} AS nome
            FROM vr_pes_pessoa p LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = p.cd_pessoa
            WHERE p.cd_pessoa = ANY(%s)
        """, (forn_ids,)) or []
        nomes = {r["cd_pessoa"]: r["nome"] for r in nomes_rows}
        for k, r, cat, dia_r, saldo, total, estado in novos:
            item(cat, k, {"fornecedor": nomes.get(k[1]) or f"Fornecedor {k[1]}"}, r, None, dia_r, 0.0, total, saldo, round(total - saldo, 2), estado)

    return dias, itens


def _comparar_pedidos(cen: dict, snap: list) -> tuple:
    dt_ini, dt_fim = cen["dt_inicio"], cen["dt_fim"]
    cd_empresas = _parse_empresas(cen["empresas"])
    dias: dict = {}
    itens: list = []

    where, params = _filtros_pedidos(dt_ini, dt_fim, cd_empresas)
    rows = execute_query(f"""
        SELECT p.cd_empresa, p.cd_pedido, c.nr_parcela, p.nm_fornecedor,
               {_EXPR_DT_PEDIDOS_EFETIVA}::date AS dia,
               ROUND((p.vl_pendente / NULLIF(c.qt_parcela, 0))::numeric, 2) AS valor
        {where}
    """, tuple(params)) or []
    atuais = {(r["cd_empresa"], r["cd_pedido"], r["nr_parcela"]): r for r in rows}
    snap_map = {(s["cd_empresa"], s["nr_documento"], s["nr_parcela"]): s for s in snap}

    # Pedidos da foto que nao estao mais em aberto no periodo: busca a situacao atual.
    saiu_info: dict = {}
    fora = [k for k in snap_map if k not in atuais]
    if fora:
        rows2 = execute_query("""
            SELECT p.cd_empresa, p.cd_pedido, p.tp_situacao
            FROM unnest(%s::bigint[], %s::bigint[]) AS k(emp, ped)
            JOIN vr_cmp_pedidoc2 p ON p.cd_empresa = k.emp AND p.cd_pedido = k.ped
        """, ([k[0] for k in fora], [k[1] for k in fora])) or []
        saiu_info = {(r["cd_empresa"], r["cd_pedido"]): r["tp_situacao"] for r in rows2}

    def item(cat, k, nome, dia_cen, dia_atu, v_cen, v_atu, situacao):
        itens.append({
            "tipo": "pedido", "categoria": cat, "documento": f"Pedido {k[1]} — parcela {k[2]}",
            "empresa": k[0], "cdFornecedor": None, "fornecedor": nome,
            "diaCenario": dia_cen, "diaAtual": dia_atu, "valorCenario": v_cen, "valorAtual": v_atu,
            "aberto": v_atu, "pago": 0.0, "situacao": situacao,
        })

    for k, s in snap_map.items():
        a = _dia_str(s["dt_efetiva"])
        S = float(s["valor"])
        dias.setdefault(a, _novo_dia())["cenario"] += S
        r = atuais.get(k)
        if r is None:
            cod = saiu_info.get((k[0], k[1]))
            sit = "não encontrado" if cod is None else f"saiu da lista (situação {cod})"
            _somar_cat(dias, a, "saiu", -S)
            item("saiu", k, s["fornecedor"], a, None, S, 0.0, sit)
            continue
        b = _dia_str(r["dia"])
        V = float(r["valor"] or 0)
        if b != a:
            _somar_cat(dias, a, "movida_saida", -S)
            d = dias.setdefault(b, _novo_dia())
            d["atual"] += V
            d["aberto"] += V
            _somar_cat(dias, b, "movida_entrada", V)
            item("movida", k, s["fornecedor"], a, b, S, V, "em aberto")
            continue
        d = dias.setdefault(a, _novo_dia())
        d["atual"] += V
        d["aberto"] += V
        if abs(V - S) >= 0.005:
            _somar_cat(dias, a, "alterada", V - S)
            item("alterada", k, s["fornecedor"], a, b, S, V, "em aberto")

    for k, r in atuais.items():
        if k in snap_map:
            continue
        dia_r = _dia_str(r["dia"])
        V = float(r["valor"] or 0)
        d = dias.setdefault(dia_r, _novo_dia())
        d["atual"] += V
        d["aberto"] += V
        _somar_cat(dias, dia_r, "nova", V)
        item("nova", k, r["nm_fornecedor"], None, dia_r, 0.0, V, "em aberto")

    return dias, itens


def _montar_bloco(dias: dict) -> dict:
    return {
        d: {
            "cenario": round(v["cenario"], 2), "atual": round(v["atual"], 2),
            "aberto": round(v["aberto"], 2), "pago": round(v["pago"], 2),
            "variacao": round(v["atual"] - v["cenario"], 2), "categorias": v["cats"],
        }
        for d, v in dias.items()
    }


@router.get("/api/fluxo-caixa/cenarios/{cenario_id}/comparar")
def comparar_cenario(cenario_id: int):
    """Compara a foto salva com a situacao de agora, dia a dia, pro mesmo
    periodo/empresas da foto. Duplicatas (com pagas) e pedidos em blocos
    separados. So informativo."""
    try:
        _criar_tabelas_fluxo_caixa()
        _criar_tabelas_cenarios()
        cab = execute_query(
            "SELECT id, nome, dt_inicio, dt_fim, empresas, criado_por, criado_em FROM fcp_cenarios WHERE id = %s",
            (cenario_id,),
        )
        if not cab:
            raise HTTPException(status_code=404, detail="Cenário não encontrado")
        c = cab[0]
        cen = {
            "dt_inicio": _dia_str(c["dt_inicio"]), "dt_fim": _dia_str(c["dt_fim"]),
            "empresas": c["empresas"], "criado_em": c["criado_em"],
        }
        itens_foto = execute_query("""
            SELECT tipo, cd_empresa, cd_fornecedor, nr_documento, nr_parcela, dt_efetiva, dt_original, valor, previsao_real, fornecedor
            FROM fcp_cenarios_itens WHERE cenario_id = %s
        """, (cenario_id,)) or []
        snap_dup = [i for i in itens_foto if i["tipo"] == "duplicata"]
        snap_ped = [i for i in itens_foto if i["tipo"] == "pedido"]

        dias_d, itens_d = _comparar_duplicatas(cen, snap_dup)
        dias_p, itens_p = _comparar_pedidos(cen, snap_ped)
        return {
            "cenario": {
                "id": c["id"], "nome": c["nome"], "dtInicio": cen["dt_inicio"], "dtFim": cen["dt_fim"],
                "criadoPor": c["criado_por"],
                "criadoEm": c["criado_em"].strftime("%d/%m/%Y %H:%M") if c["criado_em"] else None,
            },
            "geradoEm": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
            "duplicatas": _montar_bloco(dias_d),
            "pedidos": _montar_bloco(dias_p),
            "itens": itens_d + itens_p,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao comparar cenario: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Erro ao comparar o cenário")
