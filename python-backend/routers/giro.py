"""
Giro de estoque - estoque atual (em quantidade) vs venda media dos ultimos
3 meses completos, por loja, fabrica e consolidado.

Giro = estoque atual / venda media mensal (mesma convencao ja usada nas
tabelas historicas mv_giro_fabrica_mensal/mv_giro_lojas_mensal deste banco:
"quantos meses o estoque atual cobre no ritmo medio de venda"). Nao existe
fonte rapida e fresca pra isso pronta (as tabelas historicas sao snapshots
estaticos, paradas desde fev/mar de 2026, sem quebra por loja individual e
com estoque em R$, nao em quantidade como pedido aqui) - entao e calculado
direto das tabelas originais e guardado num snapshot local, recalculado sob
demanda (~40-65s, todas as empresas de uma vez).
"""
from fastapi import APIRouter, HTTPException
from datetime import date
from database import execute_query, execute_insert
from routers.cmv_detalhado import EMPRESAS_CMV_DETALHADO, _nome_empresa_cmv, _eh_fabrica

router = APIRouter()


def _criar_tabela_giro():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS giro_snapshot (
            cd_empresa INTEGER PRIMARY KEY,
            estoque_atual NUMERIC NOT NULL,
            venda_media_3m NUMERIC NOT NULL,
            mes_ini VARCHAR(7) NOT NULL,
            mes_fim VARCHAR(7) NOT NULL,
            dt_calculado TIMESTAMP NOT NULL DEFAULT NOW()
        )
    """, ())


def _ultimos_3_meses_completos() -> tuple:
    """(data_inicio, data_fim, mes_ini, mes_fim) dos ultimos 3 meses
    CHEIOS antes do mes atual (ex: hoje set/2026 -> jun,jul,ago/2026)."""
    hoje = date.today()
    ano, mes = hoje.year, hoje.month
    # Volta 3 meses a partir do mes atual pro inicio do periodo.
    ano_ini, mes_ini = ano, mes - 3
    while mes_ini <= 0:
        mes_ini += 12
        ano_ini -= 1
    ano_fim, mes_fim = ano, mes - 1
    while mes_fim <= 0:
        mes_fim += 12
        ano_fim -= 1
    data_inicio = date(ano_ini, mes_ini, 1)
    # Fim = ultimo dia do mes_fim.
    if mes_fim == 12:
        data_fim = date(ano_fim + 1, 1, 1)
    else:
        data_fim = date(ano_fim, mes_fim + 1, 1)
    from datetime import timedelta
    data_fim = data_fim - timedelta(days=1)
    return (
        data_inicio.isoformat(),
        data_fim.isoformat(),
        f"{ano_ini:04d}-{mes_ini:02d}",
        f"{ano_fim:04d}-{mes_fim:02d}",
    )


# Estoque atual em quantidade, por empresa - ultimo saldo (cd_saldo=1,
# estoque disponivel) de cada produto. Pra fabrica (cd_empresa=1), exclui
# codigos de materia-prima (cd_produto >= 1000000 - mesma convencao ja usada
# em mv_estoque_primeiro_dia_mes/vl_mp) pra nao inflar o estoque com MP em
# vez de produto acabado.
_QUERY_ESTOQUE_ATUAL = """
    SELECT cd_empresa, SUM(qt_saldo) AS estoque_total
    FROM (
        SELECT DISTINCT ON (s.cd_empresa, s.cd_produto) s.cd_empresa, s.cd_produto, s.qt_saldo
        FROM prd_prdsaldo s
        WHERE s.cd_saldo = 1 AND s.dt_saldo < CURRENT_DATE
          AND s.cd_empresa = ANY(%s)
          AND (s.cd_empresa <> 1 OR s.cd_produto < 1000000)
        ORDER BY s.cd_empresa, s.cd_produto, s.dt_saldo DESC
    ) x
    GROUP BY 1
"""

# Quantidade vendida por empresa no periodo - mesma regra de
# modalidade/operacao/situacao ja validada (bate com a receita oficial) pro
# cache de CMV/receita por produto, so que aqui em quantidade e agrupado so
# por empresa (sem produto - mais leve, sem precisar de cache por mes).
_QUERY_QTD_VENDIDA = """
    SELECT t.cd_empresa,
        SUM(
            CASE
                WHEN t.tp_modalidade::text IN ('4','8') AND t.tp_operacao::text = 'S' THEN i.qt_solicitada
                WHEN t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E' THEN -i.qt_solicitada
                ELSE 0
            END
        ) AS qt_vendida
    FROM vr_tra_transacao t
    JOIN vr_tra_transitem i ON t.nr_transacao = i.nr_transacao AND t.cd_empresa = i.cd_empresa
    WHERE t.tp_situacao = 4
      AND t.cd_empresa = ANY(%s)
      AND t.dt_transacao >= %s AND t.dt_transacao <= %s
      AND ((t.tp_modalidade::text IN ('4','8') AND t.tp_operacao::text = 'S') OR (t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E'))
    GROUP BY 1
"""


def _calcular_giro() -> dict:
    _criar_tabela_giro()
    data_inicio, data_fim, mes_ini, mes_fim = _ultimos_3_meses_completos()

    estoque_por_empresa = {r["cd_empresa"]: float(r["estoque_total"] or 0)
                            for r in execute_query(_QUERY_ESTOQUE_ATUAL, (EMPRESAS_CMV_DETALHADO,)) or []}
    qtd_por_empresa = {r["cd_empresa"]: float(r["qt_vendida"] or 0)
                        for r in execute_query(_QUERY_QTD_VENDIDA, (EMPRESAS_CMV_DETALHADO, data_inicio, data_fim)) or []}

    execute_insert("DELETE FROM giro_snapshot", ())
    for cd_empresa in EMPRESAS_CMV_DETALHADO:
        estoque = estoque_por_empresa.get(cd_empresa, 0.0)
        venda_media_3m = qtd_por_empresa.get(cd_empresa, 0.0) / 3.0
        execute_insert("""
            INSERT INTO giro_snapshot (cd_empresa, estoque_atual, venda_media_3m, mes_ini, mes_fim, dt_calculado)
            VALUES (%s, %s, %s, %s, %s, NOW())
        """, (cd_empresa, estoque, venda_media_3m, mes_ini, mes_fim))

    return _montar_resposta()


def _montar_resposta() -> dict:
    _criar_tabela_giro()
    rows = execute_query("SELECT * FROM giro_snapshot ORDER BY cd_empresa", ()) or []
    if not rows:
        return {"itens": [], "consolidadoLojas": None, "consolidadoGeral": None, "dtCalculado": None, "mesIni": None, "mesFim": None}

    def _giro(estoque: float, venda_media: float):
        if venda_media <= 0:
            return None
        return estoque / venda_media

    itens = []
    for r in rows:
        estoque = float(r["estoque_atual"])
        venda_media = float(r["venda_media_3m"])
        itens.append({
            "cdEmpresa": r["cd_empresa"],
            "nome": _nome_empresa_cmv(r["cd_empresa"]),
            "tipo": "fabrica" if _eh_fabrica(r["cd_empresa"]) else "loja",
            "estoqueAtual": estoque,
            "vendaMedia3m": venda_media,
            "giro": _giro(estoque, venda_media),
        })

    itens_fabrica = [i for i in itens if i["tipo"] == "fabrica"]
    itens_lojas = [i for i in itens if i["tipo"] == "loja"]

    def _consolidar(lista):
        estoque_total = sum(i["estoqueAtual"] for i in lista)
        venda_total = sum(i["vendaMedia3m"] for i in lista)
        return {"estoqueAtual": estoque_total, "vendaMedia3m": venda_total, "giro": _giro(estoque_total, venda_total)}

    return {
        "itens": itens,
        "consolidadoFabrica": _consolidar(itens_fabrica),
        "consolidadoLojas": _consolidar(itens_lojas),
        "consolidadoGeral": _consolidar(itens),
        "dtCalculado": rows[0]["dt_calculado"].isoformat(),
        "mesIni": rows[0]["mes_ini"],
        "mesFim": rows[0]["mes_fim"],
    }


@router.get("/api/giro/dados")
def obter_giro():
    """Ultimo snapshot de giro calculado (nao recalcula na hora - use
    /recalcular pra isso). Vazio se nunca foi calculado ainda."""
    try:
        return _montar_resposta()
    except Exception as e:
        print(f"[ERROR] Erro ao buscar giro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar giro: {str(e)}")


@router.post("/api/giro/recalcular")
def recalcular_giro():
    """Recalcula o giro na hora (~40-65s: estoque atual de todas as
    empresas ~15-25s + quantidade vendida dos ultimos 3 meses completos, de
    todas as empresas de uma vez, ~40s)."""
    try:
        return _calcular_giro()
    except Exception as e:
        print(f"[ERROR] Erro ao recalcular giro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao recalcular giro: {str(e)}")
