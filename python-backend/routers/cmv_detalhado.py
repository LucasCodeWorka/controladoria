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
import calendar
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


# ---------------------------------------------------------------------------
# Cache de CMV por loja+produto+mes.
#
# mv_cmv_loja_v2 (rapida) NAO guarda o produto da venda, so o agregado por
# conta/centro de custo - por isso o grafico de CMV por dimensao so cobria a
# fabrica. A fonte que TEM o produto (vr_cmv_lojas_v2) e construida em cima
# de vr_tra_transacao + vr_tra_transitem, que sao proibitivamente lentas por
# TRANSACAO/produto (~28s so pra contar linhas de 1 loja num mes). Mas o
# custo e fixo por mes, nao por filtro: rodar TODAS as lojas de um mes
# inteiro de uma vez leva o mesmo ~16-30s que uma loja so. Isso torna viavel
# um cache local: recalcula mes a mes (todas as lojas juntas), guarda o
# resultado agregado por loja+produto+mes numa tabela local, e o
# grafico/dimensao le so desse cache (instantaneo) - nunca das views lentas
# na hora do request.
# ---------------------------------------------------------------------------

def _criar_tabela_cache_loja_produto():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS cmv_loja_produto_cache (
            idcentrodecusto INTEGER NOT NULL,
            idproduto INTEGER NOT NULL,
            ano_mes VARCHAR(7) NOT NULL,
            valor NUMERIC NOT NULL,
            PRIMARY KEY (idcentrodecusto, idproduto, ano_mes)
        )
    """, ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS cmv_loja_produto_cache_status (
            ano_mes VARCHAR(7) PRIMARY KEY,
            linhas INTEGER NOT NULL,
            valor_total NUMERIC NOT NULL,
            dt_calculado TIMESTAMP NOT NULL DEFAULT NOW()
        )
    """, ())


# Query validada: o total bate exatamente com o total oficial do
# mv_cmv_loja_v2 pro mesmo periodo (testado ago/2026: -759.730,37 nos dois).
_QUERY_CMV_LOJA_PRODUTO_MES = """
    WITH base AS (
        SELECT t.cd_empresa AS idcentrodecusto,
            t.dt_transacao AS data,
            i.qt_solicitada,
            i.cd_produto AS idproduto,
            t.tp_operacao,
            btrim(pc_marca.cd_classificacao::text) AS idmarca
        FROM vr_tra_transacao t
        JOIN vr_tra_transitem i ON t.nr_transacao = i.nr_transacao AND t.cd_empresa = i.cd_empresa
        LEFT JOIN prd_produtoclas pc_marca ON pc_marca.cd_produto = i.cd_produto AND pc_marca.cd_tipoclas = 20
        WHERE t.tp_situacao = 4 AND t.cd_empresa <> ALL (ARRAY[1::bigint, 50::bigint])
          AND t.dt_transacao >= %s AND t.dt_transacao <= %s
          AND ((t.tp_modalidade::text = ANY (ARRAY['4','8']::text[])) AND t.tp_operacao::text = 'S'
               OR t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E')
    ), com_valor AS (
        SELECT b.idcentrodecusto, b.qt_solicitada, b.tp_operacao, b.idmarca, b.idproduto,
            CASE
                WHEN b.idmarca = ANY (ARRAY['0001','0002','0009']) THEN
                    COALESCE(
                        NULLIF(f_prd_valor_produto2(1::bigint, 1::bigint, 'P'::bpchar, 1::bigint, b.idproduto, b.data), 0),
                        NULLIF(f_prd_valor_produto2(1::bigint, 1::bigint, 'P'::bpchar, 1::bigint, b.idproduto, NULL::timestamp), 0),
                        21.9
                    )
                ELSE
                    COALESCE(
                        NULLIF(f_prd_valor_produto2(1::bigint, 1::bigint, 'C'::bpchar, 2::bigint, b.idproduto, b.data), 0),
                        NULLIF(f_prd_valor_produto2(1::bigint, 1::bigint, 'C'::bpchar, 2::bigint, b.idproduto, NULL::timestamp), 0),
                        21.9
                    )
            END AS valor_unitario
        FROM base b
        WHERE b.idmarca IS NOT NULL AND b.idmarca <> ''
    )
    SELECT idcentrodecusto, idproduto,
        SUM(qt_solicitada * valor_unitario * CASE WHEN tp_operacao::text = 'S' THEN -1 ELSE 1 END
            * CASE WHEN idcentrodecusto = 2 THEN 0.7 ELSE 0.8 END) AS valor
    FROM com_valor
    GROUP BY 1, 2
"""


def _calcular_e_cachear_mes_loja(ano_mes: str) -> dict:
    """Recalcula (a partir das views originais) e substitui o cache de um
    mes, com TODAS as lojas de uma vez - e o que torna isso viavel em tempo
    (~16-30s pro mes inteiro, nao por loja)."""
    _criar_tabela_cache_loja_produto()
    ano, mes = ano_mes.split("-")
    data_inicio = f"{ano}-{mes}-01"
    ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]
    data_fim = f"{ano}-{mes}-{ultimo_dia:02d}"

    linhas = execute_query(_QUERY_CMV_LOJA_PRODUTO_MES, (data_inicio, data_fim)) or []

    execute_insert("DELETE FROM cmv_loja_produto_cache WHERE ano_mes = %s", (ano_mes,))
    valor_total = 0.0
    for i in range(0, len(linhas), 500):
        lote = linhas[i:i + 500]
        valores_sql = []
        params = []
        for r in lote:
            v = float(r["valor"] or 0)
            valor_total += v
            valores_sql.append("(%s, %s, %s, %s)")
            params.extend([r["idcentrodecusto"], r["idproduto"], ano_mes, v])
        if valores_sql:
            execute_insert(
                f"INSERT INTO cmv_loja_produto_cache (idcentrodecusto, idproduto, ano_mes, valor) VALUES {','.join(valores_sql)}",
                tuple(params)
            )

    execute_insert("""
        INSERT INTO cmv_loja_produto_cache_status (ano_mes, linhas, valor_total, dt_calculado)
        VALUES (%s, %s, %s, NOW())
        ON CONFLICT (ano_mes) DO UPDATE SET linhas = EXCLUDED.linhas, valor_total = EXCLUDED.valor_total, dt_calculado = NOW()
    """, (ano_mes, len(linhas), valor_total))

    return {"anoMes": ano_mes, "linhas": len(linhas), "valorTotal": valor_total}


def _meses_cacheados() -> set:
    _criar_tabela_cache_loja_produto()
    rows = execute_query("SELECT ano_mes FROM cmv_loja_produto_cache_status", ()) or []
    return {r["ano_mes"] for r in rows}


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
    continuidade). Fabrica: join rapido e ao vivo entre mv_cmv_fab
    (idproduto) e mv_prd_referencia_produto (cadastro do produto, tambem
    materializada, entao rapida). Lojas: mv_cmv_loja_v2 nao guarda o produto
    da venda, entao lojas leem do cache local cmv_loja_produto_cache
    (recalculado mes a mes via /calcular-mes-loja, ver esse endpoint pro
    porque). Meses do periodo pedido que ainda nao foram calculados pras
    lojas selecionadas voltam em 'mesesFaltantesLojas', pro front avisar e
    oferecer calcular.

    O campo 'percentual' de cada item e a fatia da categoria sobre o TOTAL DE
    CMV do proprio grafico (composicao), nao CMV/receita como nos outros
    graficos da tela: a unica fonte rapida de receita por produto pra fabrica
    (mv_vendas_valor) vem de PEDIDOS, nao de vendas realizadas, e bate ~35%
    diferente da receita oficial ja usada no resto da tela - usar isso geraria
    um % que nao reconcilia com o resto do painel.
    """
    try:
        coluna = DIMENSOES_CMV.get(dimensao)
        if not coluna:
            raise HTTPException(status_code=400, detail=f"Dimensao invalida: {dimensao}. Use uma de: {list(DIMENSOES_CMV.keys())}")

        cd_empresas = _parse_empresas(empresas)
        empresas_fabrica_pedidas = [e for e in cd_empresas if _eh_fabrica(e)]
        empresas_lojas_pedidas = [e for e in cd_empresas if not _eh_fabrica(e)]

        acumulado: dict = {}

        if empresas_fabrica_pedidas:
            query_fab = f"""
                SELECT COALESCE(p.{coluna}, 'SEM CLASSIFICACAO') AS chave, ABS(SUM(mv.valor)) AS valor
                FROM mv_cmv_fab mv
                LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = mv.idproduto
                WHERE mv.data >= %s AND mv.data <= %s
                GROUP BY 1
            """
            for r in execute_query(query_fab, (dataInicio, dataFim)) or []:
                acumulado[r["chave"]] = acumulado.get(r["chave"], 0.0) + float(r["valor"] or 0)

        meses_faltantes = []
        if empresas_lojas_pedidas:
            meses = [f"{a:04d}-{m:02d}" for a, m in _gerar_meses(dataInicio, dataFim)]
            cacheados = _meses_cacheados()
            meses_faltantes = [m for m in meses if m not in cacheados]
            meses_prontos = [m for m in meses if m in cacheados]

            if meses_prontos:
                placeholders_meses = ",".join(["%s"] * len(meses_prontos))
                placeholders_lojas = ",".join(["%s"] * len(empresas_lojas_pedidas))
                query_lojas = f"""
                    SELECT COALESCE(p.{coluna}, 'SEM CLASSIFICACAO') AS chave, ABS(SUM(c.valor)) AS valor
                    FROM cmv_loja_produto_cache c
                    LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = c.idproduto
                    WHERE c.ano_mes IN ({placeholders_meses}) AND c.idcentrodecusto IN ({placeholders_lojas})
                    GROUP BY 1
                """
                for r in execute_query(query_lojas, (*meses_prontos, *empresas_lojas_pedidas)) or []:
                    acumulado[r["chave"]] = acumulado.get(r["chave"], 0.0) + float(r["valor"] or 0)

        itens = sorted(
            [{"chave": k, "valor": v} for k, v in acumulado.items() if v > 0],
            key=lambda i: i["valor"],
            reverse=True,
        )

        if len(itens) > TOP_N_DIMENSAO:
            principais = itens[:TOP_N_DIMENSAO]
            outros_valor = sum(i["valor"] for i in itens[TOP_N_DIMENSAO:])
            if outros_valor > 0:
                principais.append({"chave": "OUTROS", "valor": outros_valor})
            itens = principais

        # Percentual de composicao: fatia de cada categoria sobre o total de
        # CMV do grafico (nao e CMV/receita - nao ha fonte rapida e correta
        # de receita por produto pra fabrica, ver docstring da funcao).
        total_valor = sum(i["valor"] for i in itens)
        for item in itens:
            item["percentual"] = (item["valor"] / total_valor * 100) if total_valor else 0.0

        return {
            "dimensao": dimensao,
            "itens": itens,
            "mesesFaltantesLojas": meses_faltantes,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar CMV por dimensao: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar CMV por dimensao: {str(e)}")


@router.get("/api/cmv-detalhado/meses-cache-lojas")
def meses_cache_lojas(
    dataInicio: str = Query(..., description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query(..., description="Data final (YYYY-MM-DD)")
):
    """Quais meses do periodo pedido ja estao no cache de CMV por produto das
    lojas (cmv_loja_produto_cache) e quais ainda faltam calcular."""
    try:
        meses = [f"{a:04d}-{m:02d}" for a, m in _gerar_meses(dataInicio, dataFim)]
        cacheados = _meses_cacheados()
        return {
            "mesesNecessarios": meses,
            "mesesCalculados": [m for m in meses if m in cacheados],
            "mesesFaltantes": [m for m in meses if m not in cacheados],
        }
    except Exception as e:
        print(f"[ERROR] Erro ao checar cache de lojas: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao checar cache de lojas: {str(e)}")


@router.post("/api/cmv-detalhado/calcular-mes-loja")
def calcular_mes_loja(anoMes: str = Query(..., description="Mes a calcular, formato YYYY-MM")):
    """
    Recalcula o cache de CMV por produto das lojas pra UM mes (todas as
    lojas de uma vez - e o que mantem isso rapido, ~16-30s, em vez de horas:
    o custo das views originais e fixo por mes, nao por filtro de loja/
    transacao, entao processar todas juntas nao custa mais que processar uma
    so). Chamado pelo front mes a mes, com barra de progresso, quando
    'mesesFaltantesLojas' do /por-dimensao acusa meses nao calculados.
    """
    try:
        if len(anoMes) != 7 or anoMes[4] != "-":
            raise HTTPException(status_code=400, detail=f"anoMes invalido: {anoMes}. Use YYYY-MM.")
        resultado = _calcular_e_cachear_mes_loja(anoMes)
        return resultado
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao calcular cache de loja pro mes {anoMes}: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular cache de loja pro mes {anoMes}: {str(e)}")
