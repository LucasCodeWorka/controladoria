"""
Giro de estoque - estoque atual (em quantidade) vs venda media dos ultimos
3 meses completos, por loja, fabrica e consolidado.

Giro = estoque / venda media mensal (mesma convencao ja usada nas tabelas
historicas mv_giro_fabrica_mensal/mv_giro_lojas_mensal deste banco: "quantos
meses o estoque cobre no ritmo medio de venda"). Nao existe fonte rapida e
fresca pra isso pronta (as tabelas historicas sao snapshots estaticos,
paradas desde fev/mar de 2026, sem quebra por loja individual e com estoque
em R$, nao em quantidade como pedido) - entao e calculado direto das tabelas
originais e guardado num snapshot local por empresa+mes de referencia,
recalculado sob demanda.

Suporta filtrar por mes de referencia e por empresa antes de calcular:
- Mes de referencia (0 custo extra): dt_saldo aceita qualquer data de corte
  no passado (historico desde 2018), entao "estoque no mes X" e tao rapido
  quanto "estoque hoje". Convencao: mes de referencia = mes atual -> estoque
  de HOJE (tempo real); mes de referencia passado -> estoque no INICIO
  daquele mes. Venda media sempre = media dos 3 meses CHEIOS antes do mes de
  referencia.
- Empresa (ajuda parcial): a query de estoque (prd_prdsaldo, tabela base) fica
  bem mais rapida filtrada (1 loja ~7s vs 17 empresas ~29s); a de venda
  (vr_tra_transacao/vr_tra_transitem) tem custo quase fixo (1 loja ~37s vs
  17 empresas ~51s - mesma limitacao ja vista noutras telas). No total,
  calcular 1 loja fica em ~40s contra ~80s de todas juntas - ajuda, mas nao
  e instantaneo.
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date, timedelta
from database import execute_query, execute_insert
from routers.cmv_detalhado import EMPRESAS_CMV_DETALHADO, _nome_empresa_cmv, _eh_fabrica

router = APIRouter()


def _criar_tabela_giro():
    # Migracao unica: a tabela antiga (so um snapshot global, sem mes de
    # referencia) nao tem como virar a nova (chave cd_empresa+mes_referencia)
    # com ALTER - e so cache derivado (recalculavel), entao recria do zero se
    # detectar o esquema antigo.
    colunas = execute_query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'giro_snapshot'", ()
    ) or []
    if colunas and not any(c["column_name"] == "mes_referencia" for c in colunas):
        execute_insert("DROP TABLE giro_snapshot", ())

    execute_insert("""
        CREATE TABLE IF NOT EXISTS giro_snapshot (
            cd_empresa INTEGER NOT NULL,
            mes_referencia VARCHAR(7) NOT NULL,
            estoque_atual NUMERIC NOT NULL,
            venda_media_3m NUMERIC NOT NULL,
            mes_ini VARCHAR(7) NOT NULL,
            mes_fim VARCHAR(7) NOT NULL,
            dt_calculado TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (cd_empresa, mes_referencia)
        )
    """, ())


def _mes_atual() -> str:
    hoje = date.today()
    return f"{hoje.year:04d}-{hoje.month:02d}"


def _somar_meses(ano: int, mes: int, delta: int) -> tuple:
    m = mes - 1 + delta
    return ano + m // 12, m % 12 + 1


def _parse_empresas_giro(empresas: Optional[str]) -> list:
    if not empresas:
        return list(EMPRESAS_CMV_DETALHADO)
    try:
        pedidas = [int(p.strip()) for p in empresas.split(",") if p.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Lista de empresas invalida: {empresas}")
    invalidas = [p for p in pedidas if p not in EMPRESAS_CMV_DETALHADO]
    if invalidas:
        raise HTTPException(status_code=400, detail=f"Empresa(s) invalida(s): {invalidas}")
    return pedidas


def _datas_periodo(mes_referencia: str) -> tuple:
    """(dt_corte_estoque, data_inicio_venda, data_fim_venda, mes_ini, mes_fim)
    pro mes de referencia pedido - "regra dos 3 meses pra tras": estoque no
    mes de referencia (hoje, se for o mes atual; inicio do mes, se for
    passado) e venda media dos 3 meses CHEIOS imediatamente antes dele."""
    ano_ref, mes_ref = (int(p) for p in mes_referencia.split("-"))

    if mes_referencia == _mes_atual():
        dt_corte_estoque = date.today().isoformat()
    else:
        dt_corte_estoque = date(ano_ref, mes_ref, 1).isoformat()

    ano_ini, mes_ini_n = _somar_meses(ano_ref, mes_ref, -3)
    ano_fim, mes_fim_n = _somar_meses(ano_ref, mes_ref, -1)
    data_inicio = date(ano_ini, mes_ini_n, 1)
    ano_prox, mes_prox = _somar_meses(ano_fim, mes_fim_n, 1)
    data_fim = date(ano_prox, mes_prox, 1) - timedelta(days=1)

    return (
        dt_corte_estoque,
        data_inicio.isoformat(),
        data_fim.isoformat(),
        f"{ano_ini:04d}-{mes_ini_n:02d}",
        f"{ano_fim:04d}-{mes_fim_n:02d}",
    )


# Produtos fora da conta de giro: codigo >= 1000000 (materia-prima/insumo -
# mesma convencao ja usada em mv_estoque_primeiro_dia_mes/vl_mp, aplicada em
# TODAS as empresas - lojas tambem tem milhares de linhas de saldo nessa
# faixa, em codigos sem cadastro de produto e quantidades enormes, claramente
# material de PDV/embalagem) e produtos "sacola" (sem classificacao/grupo
# consistente no cadastro, filtrado pelo nome). O LEFT JOIN com a
# classificacao pode nao achar o produto (p.produto NULL) - nesse caso
# mantem o produto (so descarta quando da pra confirmar que e sacola).

_QUERY_ESTOQUE_ATUAL = """
    SELECT cd_empresa, SUM(qt_saldo) AS estoque_total
    FROM (
        SELECT DISTINCT ON (s.cd_empresa, s.cd_produto) s.cd_empresa, s.cd_produto, s.qt_saldo
        FROM prd_prdsaldo s
        LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = s.cd_produto
        WHERE s.cd_saldo = 1 AND s.dt_saldo < %s
          AND s.cd_empresa = ANY(%s)
          AND s.cd_produto < 1000000
          AND (p.produto IS NULL OR p.produto NOT ILIKE '%%SACOLA%%')
        ORDER BY s.cd_empresa, s.cd_produto, s.dt_saldo DESC
    ) x
    GROUP BY 1
"""

# Quantidade vendida por empresa no periodo - mesma regra de
# modalidade/operacao/situacao ja validada (bate com a receita oficial) pro
# cache de CMV/receita por produto, so que aqui em quantidade e agrupado so
# por empresa (sem produto - mais leve, sem precisar de cache por produto).
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
    LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = i.cd_produto
    WHERE t.tp_situacao = 4
      AND t.cd_empresa = ANY(%s)
      AND t.dt_transacao >= %s AND t.dt_transacao <= %s
      AND ((t.tp_modalidade::text IN ('4','8') AND t.tp_operacao::text = 'S') OR (t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E'))
      AND i.cd_produto < 1000000
      AND (p.produto IS NULL OR p.produto NOT ILIKE '%%SACOLA%%')
    GROUP BY 1
"""


def _calcular_giro(mes_referencia: str, cd_empresas: list) -> dict:
    _criar_tabela_giro()
    dt_corte_estoque, data_inicio, data_fim, mes_ini, mes_fim = _datas_periodo(mes_referencia)

    estoque_por_empresa = {r["cd_empresa"]: float(r["estoque_total"] or 0)
                            for r in execute_query(_QUERY_ESTOQUE_ATUAL, (dt_corte_estoque, cd_empresas)) or []}
    qtd_por_empresa = {r["cd_empresa"]: float(r["qt_vendida"] or 0)
                        for r in execute_query(_QUERY_QTD_VENDIDA, (cd_empresas, data_inicio, data_fim)) or []}

    for cd_empresa in cd_empresas:
        estoque = estoque_por_empresa.get(cd_empresa, 0.0)
        venda_media_3m = qtd_por_empresa.get(cd_empresa, 0.0) / 3.0
        execute_insert("""
            INSERT INTO giro_snapshot (cd_empresa, mes_referencia, estoque_atual, venda_media_3m, mes_ini, mes_fim, dt_calculado)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (cd_empresa, mes_referencia) DO UPDATE SET
                estoque_atual = EXCLUDED.estoque_atual,
                venda_media_3m = EXCLUDED.venda_media_3m,
                mes_ini = EXCLUDED.mes_ini,
                mes_fim = EXCLUDED.mes_fim,
                dt_calculado = NOW()
        """, (cd_empresa, mes_referencia, estoque, venda_media_3m, mes_ini, mes_fim))

    return _montar_resposta(mes_referencia, cd_empresas)


def _montar_resposta(mes_referencia: str, cd_empresas: list) -> dict:
    _criar_tabela_giro()
    placeholders = ",".join(["%s"] * len(cd_empresas))
    rows = execute_query(
        f"SELECT * FROM giro_snapshot WHERE mes_referencia = %s AND cd_empresa IN ({placeholders}) ORDER BY cd_empresa",
        (mes_referencia, *cd_empresas)
    ) or []

    calculadas = {r["cd_empresa"] for r in rows}
    empresas_faltantes = [
        {"cdEmpresa": e, "nome": _nome_empresa_cmv(e)}
        for e in cd_empresas if e not in calculadas
    ]

    if not rows:
        return {
            "itens": [], "consolidadoFabrica": None, "consolidadoLojas": None, "consolidadoGeral": None,
            "dtCalculado": None, "mesIni": None, "mesFim": None,
            "mesReferencia": mes_referencia, "empresasFaltantes": empresas_faltantes,
        }

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
        if not lista:
            return None
        estoque_total = sum(i["estoqueAtual"] for i in lista)
        venda_total = sum(i["vendaMedia3m"] for i in lista)
        return {"estoqueAtual": estoque_total, "vendaMedia3m": venda_total, "giro": _giro(estoque_total, venda_total)}

    return {
        "itens": itens,
        "consolidadoFabrica": _consolidar(itens_fabrica),
        "consolidadoLojas": _consolidar(itens_lojas),
        "consolidadoGeral": _consolidar(itens),
        "dtCalculado": max(r["dt_calculado"] for r in rows).isoformat(),
        "mesIni": rows[0]["mes_ini"],
        "mesFim": rows[0]["mes_fim"],
        "mesReferencia": mes_referencia,
        "empresasFaltantes": empresas_faltantes,
    }


@router.get("/api/giro/dados")
def obter_giro(
    mesReferencia: Optional[str] = Query(None, description="Mes de referencia YYYY-MM (default: mes atual)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """Snapshot de giro ja calculado pro mes de referencia + empresas
    pedidos (nao recalcula na hora - use /recalcular pra isso). Empresas
    ainda sem calculo pra esse mes voltam em 'empresasFaltantes'."""
    try:
        mes_ref = mesReferencia or _mes_atual()
        cd_empresas = _parse_empresas_giro(empresas)
        return _montar_resposta(mes_ref, cd_empresas)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar giro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar giro: {str(e)}")


@router.post("/api/giro/recalcular")
def recalcular_giro(
    mesReferencia: Optional[str] = Query(None, description="Mes de referencia YYYY-MM (default: mes atual)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """
    Recalcula o giro pro mes de referencia + empresas pedidos. Filtrar por
    empresa reduz o tempo (1 loja ~40s contra ~80s de todas juntas - ver
    docstring do modulo pro detalhe de onde vem essa diferenca). Filtrar por
    mes de referencia nao muda o tempo (estoque historico custa o mesmo que
    estoque de hoje).
    """
    try:
        mes_ref = mesReferencia or _mes_atual()
        cd_empresas = _parse_empresas_giro(empresas)
        return _calcular_giro(mes_ref, cd_empresas)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao recalcular giro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao recalcular giro: {str(e)}")
