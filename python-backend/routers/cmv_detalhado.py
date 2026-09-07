"""
CMV Detalhado - percentual de Custo de Mercadoria Vendida (contas 04.02.01
Mercadoria p/Revenda e 04.02.02 Produto Proprio) sobre a receita, por
loja/fabrica e por mes.

Sempre responde rapido: usa as tabelas agregadas ja existentes (mv_cmv_fab
pra fabrica, mv_cmv_loja_v2 pra lojas) e uma consulta leve de receita em
vr_tra_transacao (sem join com item/produto).
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime
from database import execute_query, execute_insert
from routers.dre import CCUSTOS_LOJAS, EMPRESAS_FABRICA

router = APIRouter()

EMPRESAS_CMV_DETALHADO = sorted(set(EMPRESAS_FABRICA) | set(CCUSTOS_LOJAS.keys()))
CD_EMPRESA_FABRICA = EMPRESAS_FABRICA[0]


def _nome_empresa_cmv(cd_empresa: int) -> str:
    if cd_empresa in EMPRESAS_FABRICA:
        return "FABRICA"
    return CCUSTOS_LOJAS.get(cd_empresa, f"EMPRESA {cd_empresa}")


def _eh_fabrica(cd_empresa: int) -> bool:
    return cd_empresa in EMPRESAS_FABRICA


def _parse_empresas(empresas: Optional[str]) -> list:
    """'empresas' e uma lista opcional de cd_empresa separados por virgula.
    Sem o parametro, usa todas (fabrica + todas as lojas)."""
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


def _gerar_meses(dataInicio: str, dataFim: str) -> list:
    """Lista de (ano, mes) cobertos pelo periodo, do mes de dataInicio ao mes
    de dataFim, inclusive."""
    inicio = datetime.strptime(dataInicio, "%Y-%m-%d")
    fim = datetime.strptime(dataFim, "%Y-%m-%d")
    meses = []
    ano, mes = inicio.year, inicio.month
    while (ano, mes) <= (fim.year, fim.month):
        meses.append((ano, mes))
        if mes == 12:
            ano, mes = ano + 1, 1
        else:
            mes += 1
    return meses


def _buscar_receita_por_empresa(cd_empresas: list, data_inicio: str, data_fim_inclusiva: str) -> dict:
    """Receita liquida (venda bruta - devolucao) por empresa no periodo -
    mesma regra de inclusao de vendas usada no calculo do CMV (vr_tra_transacao,
    tp_situacao=4, modalidade/operacao de venda ou devolucao), mas SEM o join
    com item/produto - por isso e uma consulta leve. Serve de base pro
    percentual de CMV sobre a receita."""
    if not cd_empresas:
        return {}
    placeholders = ",".join(["%s"] * len(cd_empresas))
    query = f"""
        SELECT
            cd_empresa,
            SUM(
                CASE
                    WHEN tp_modalidade::text IN ('4', '8') AND tp_operacao::text = 'S' THEN vl_transacao
                    WHEN tp_modalidade::text = '3' AND tp_operacao::text = 'E' THEN -vl_transacao
                    ELSE 0
                END
            ) AS receita
        FROM vr_tra_transacao
        WHERE tp_situacao = 4
          AND cd_empresa IN ({placeholders})
          AND dt_transacao >= %s AND dt_transacao <= %s
          AND (
                (tp_modalidade::text IN ('4', '8') AND tp_operacao::text = 'S')
                OR (tp_modalidade::text = '3' AND tp_operacao::text = 'E')
              )
        GROUP BY cd_empresa
    """
    rows = execute_query(query, (*cd_empresas, data_inicio, data_fim_inclusiva))
    return {r['cd_empresa']: float(r['receita'] or 0) for r in rows or []}


def _buscar_receita_por_mes(cd_empresas: list, data_inicio: str, data_fim_inclusiva: str) -> dict:
    """Mesma regra da receita acima, mas agrupada por mes (somando todas as
    empresas pedidas) - base do grafico de %CMV por mes."""
    if not cd_empresas:
        return {}
    placeholders = ",".join(["%s"] * len(cd_empresas))
    query = f"""
        SELECT
            TO_CHAR(DATE_TRUNC('month', dt_transacao), 'YYYY-MM') AS ano_mes,
            SUM(
                CASE
                    WHEN tp_modalidade::text IN ('4', '8') AND tp_operacao::text = 'S' THEN vl_transacao
                    WHEN tp_modalidade::text = '3' AND tp_operacao::text = 'E' THEN -vl_transacao
                    ELSE 0
                END
            ) AS receita
        FROM vr_tra_transacao
        WHERE tp_situacao = 4
          AND cd_empresa IN ({placeholders})
          AND dt_transacao >= %s AND dt_transacao <= %s
          AND (
                (tp_modalidade::text IN ('4', '8') AND tp_operacao::text = 'S')
                OR (tp_modalidade::text = '3' AND tp_operacao::text = 'E')
              )
        GROUP BY DATE_TRUNC('month', dt_transacao)
    """
    rows = execute_query(query, (*cd_empresas, data_inicio, data_fim_inclusiva))
    return {r['ano_mes']: float(r['receita'] or 0) for r in rows or []}


def _cmv_percentual(valor_cmv: float, receita: float) -> Optional[float]:
    if not receita:
        return None
    return (abs(valor_cmv) / receita) * 100


DIMENSOES_CMV = {
    "linha": "linha",
    "familia": "familia",
    "colecao": "colecao",
    "status": "status",
    "continuidade": "continuidade",
}
TOP_N_DIMENSAO = 12


@router.get("/api/cmv-detalhado/empresas")
def listar_empresas_cmv_detalhado():
    """Lista fabrica + todas as lojas (cd_empresa 1-120) disponiveis pra
    analise de CMV detalhado, com nome e se e fabrica ou loja."""
    itens = [{"cdEmpresa": cd, "nome": _nome_empresa_cmv(cd), "tipo": "fabrica" if _eh_fabrica(cd) else "loja"}
             for cd in EMPRESAS_CMV_DETALHADO]
    return {"empresas": itens}


@router.get("/api/cmv-detalhado/resumo")
def resumo_cmv_detalhado(
    dataInicio: str = Query(..., description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query(..., description="Data final (YYYY-MM-DD)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """
    Visao geral pro periodo inteiro (pode cobrir varios meses) e pro conjunto
    de empresas pedido: total de CMV, receita e % de CMV sobre a receita, por
    empresa ('totais'), por mes somando as empresas selecionadas ('porMes') e
    consolidado de tudo que foi pedido ('consolidado').
    """
    try:
        cd_empresas = _parse_empresas(empresas)
        meses = _gerar_meses(dataInicio, dataFim)
        if not meses:
            raise HTTPException(status_code=400, detail="Periodo invalido")
        meses_str = [f"{a:04d}-{m:02d}" for a, m in meses]

        empresas_fabrica_pedidas = [e for e in cd_empresas if _eh_fabrica(e)]
        empresas_lojas_pedidas = [e for e in cd_empresas if not _eh_fabrica(e)]

        totais_por_empresa = {e: {"04.02.01": 0.0, "04.02.02": 0.0} for e in cd_empresas}

        if empresas_fabrica_pedidas:
            query_fab = """
                SELECT idconta, ABS(SUM(valor)) AS valor
                FROM mv_cmv_fab
                WHERE data >= %s AND data <= %s
                GROUP BY idconta
            """
            for r in execute_query(query_fab, (dataInicio, dataFim)) or []:
                totais_por_empresa[CD_EMPRESA_FABRICA][r['idconta']] = totais_por_empresa[CD_EMPRESA_FABRICA].get(r['idconta'], 0) + float(r['valor'] or 0)

        if empresas_lojas_pedidas:
            placeholders = ",".join(["%s"] * len(empresas_lojas_pedidas))
            query_lojas = f"""
                SELECT idcentrodecusto, idconta, ABS(SUM(valor)) AS valor
                FROM mv_cmv_loja_v2
                WHERE data >= %s AND data <= %s AND idcentrodecusto IN ({placeholders})
                GROUP BY idcentrodecusto, idconta
            """
            for r in execute_query(query_lojas, (dataInicio, dataFim, *empresas_lojas_pedidas)) or []:
                cd = r['idcentrodecusto']
                if cd in totais_por_empresa:
                    totais_por_empresa[cd][r['idconta']] = totais_por_empresa[cd].get(r['idconta'], 0) + float(r['valor'] or 0)

        receita_por_empresa = _buscar_receita_por_empresa(cd_empresas, dataInicio, dataFim)

        # CMV por mes (somando todas as empresas pedidas) - base do grafico
        # de %CMV por mes, so relevante quando o periodo cobre varios meses.
        cmv_por_mes = {m: 0.0 for m in meses_str}
        if empresas_fabrica_pedidas:
            query_fab_mes = """
                SELECT TO_CHAR(DATE_TRUNC('month', data), 'YYYY-MM') AS ano_mes, ABS(SUM(valor)) AS valor
                FROM mv_cmv_fab
                WHERE data >= %s AND data <= %s
                GROUP BY DATE_TRUNC('month', data)
            """
            for r in execute_query(query_fab_mes, (dataInicio, dataFim)) or []:
                if r['ano_mes'] in cmv_por_mes:
                    cmv_por_mes[r['ano_mes']] += float(r['valor'] or 0)

        if empresas_lojas_pedidas:
            placeholders = ",".join(["%s"] * len(empresas_lojas_pedidas))
            query_lojas_mes = f"""
                SELECT TO_CHAR(DATE_TRUNC('month', data), 'YYYY-MM') AS ano_mes, ABS(SUM(valor)) AS valor
                FROM mv_cmv_loja_v2
                WHERE data >= %s AND data <= %s AND idcentrodecusto IN ({placeholders})
                GROUP BY DATE_TRUNC('month', data)
            """
            for r in execute_query(query_lojas_mes, (dataInicio, dataFim, *empresas_lojas_pedidas)) or []:
                if r['ano_mes'] in cmv_por_mes:
                    cmv_por_mes[r['ano_mes']] += float(r['valor'] or 0)

        receita_por_mes = _buscar_receita_por_mes(cd_empresas, dataInicio, dataFim)

        por_mes = []
        for m in meses_str:
            valor_total_mes = cmv_por_mes.get(m, 0.0)
            receita_mes = receita_por_mes.get(m, 0.0)
            por_mes.append({
                "anoMes": m,
                "valorTotal": valor_total_mes,
                "receita": receita_mes,
                "cmvPercentual": _cmv_percentual(valor_total_mes, receita_mes),
            })

        totais = []
        for cd_empresa in cd_empresas:
            valores = totais_por_empresa[cd_empresa]
            valor_total = valores.get("04.02.01", 0) + valores.get("04.02.02", 0)
            receita = receita_por_empresa.get(cd_empresa, 0.0)
            totais.append({
                "cdEmpresa": cd_empresa,
                "nome": _nome_empresa_cmv(cd_empresa),
                "tipo": "fabrica" if _eh_fabrica(cd_empresa) else "loja",
                "mercadoriaRevenda": valores.get("04.02.01", 0),
                "produtoProprio": valores.get("04.02.02", 0),
                "valorTotal": valor_total,
                "receita": receita,
                "cmvPercentual": _cmv_percentual(valor_total, receita),
            })

        totais.sort(key=lambda x: x["valorTotal"], reverse=True)

        valor_total_consolidado = sum(t["valorTotal"] for t in totais)
        receita_total_consolidada = sum(t["receita"] for t in totais)
        consolidado = {
            "valorTotal": valor_total_consolidado,
            "receita": receita_total_consolidada,
            "cmvPercentual": _cmv_percentual(valor_total_consolidado, receita_total_consolidada),
        }

        return {"periodos": meses_str, "totais": totais, "consolidado": consolidado, "porMes": por_mes}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar resumo CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar resumo CMV detalhado: {str(e)}")


@router.get("/api/cmv-detalhado/por-dimensao")
def cmv_por_dimensao(
    dimensao: str = Query(..., description="linha, familia, colecao, status ou continuidade"),
    dataInicio: str = Query(..., description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query(..., description="Data final (YYYY-MM-DD)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """
    CMV agrupado por uma dimensao do produto (linha/familia/colecao/status/
    continuidade), via join rapido entre a materialized view mv_cmv_fab
    (idproduto) e a materialized view mv_prd_referencia_produto (cadastro do
    produto - tambem materializada, entao rapida).

    So cobre a FABRICA: as materialized views de CMV de loja (mv_cmv_loja_v2
    / mv_cmv_lojas) nao guardam o produto da venda, so o agregado por
    conta/centro de custo - nao ha como quebrar o CMV de loja por produto sem
    cair de volta nas views originais (vr_...), que sao proibitivamente
    lentas (varias dezenas de segundos, custo fixo, independente do filtro).
    Empresas do tipo loja pedidas em 'empresas' sao ignoradas aqui e
    reportadas em 'empresasIgnoradas'.
    """
    try:
        coluna = DIMENSOES_CMV.get(dimensao)
        if not coluna:
            raise HTTPException(status_code=400, detail=f"Dimensao invalida: {dimensao}. Use uma de: {list(DIMENSOES_CMV.keys())}")

        cd_empresas = _parse_empresas(empresas)
        empresas_fabrica_pedidas = [e for e in cd_empresas if _eh_fabrica(e)]
        empresas_lojas_pedidas = [e for e in cd_empresas if not _eh_fabrica(e)]

        if not empresas_fabrica_pedidas:
            return {
                "dimensao": dimensao,
                "itens": [],
                "empresasIgnoradas": [_nome_empresa_cmv(e) for e in empresas_lojas_pedidas],
            }

        query = f"""
            SELECT COALESCE(p.{coluna}, 'SEM CLASSIFICACAO') AS chave, ABS(SUM(mv.valor)) AS valor
            FROM mv_cmv_fab mv
            LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = mv.idproduto
            WHERE mv.data >= %s AND mv.data <= %s
            GROUP BY 1
            ORDER BY 2 DESC
        """
        linhas = execute_query(query, (dataInicio, dataFim)) or []
        itens = [{"chave": r["chave"], "valor": float(r["valor"] or 0)} for r in linhas if float(r["valor"] or 0) > 0]

        if len(itens) > TOP_N_DIMENSAO:
            principais = itens[:TOP_N_DIMENSAO]
            outros_valor = sum(i["valor"] for i in itens[TOP_N_DIMENSAO:])
            if outros_valor > 0:
                principais.append({"chave": "OUTROS", "valor": outros_valor})
            itens = principais

        return {
            "dimensao": dimensao,
            "itens": itens,
            "empresasIgnoradas": [_nome_empresa_cmv(e) for e in empresas_lojas_pedidas],
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar CMV por dimensao: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar CMV por dimensao: {str(e)}")
