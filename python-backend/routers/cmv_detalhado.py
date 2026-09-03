"""
CMV Detalhado - analise venda a venda e item a item do Custo de Mercadoria
Vendida (contas 04.02.01 Mercadoria p/Revenda e 04.02.02 Produto Proprio).

Duas fontes de dado, por causa de uma diferenca real de performance:

- FABRICA (cd_empresa em EMPRESAS_FABRICA): ja existe uma tabela pronta com
  o detalhe completo (mv_cmv_fab - por venda, por item), extremamente rapida
  de consultar (materializada). Usamos ela direto, sem recalcular nada -
  recalcular a fabrica com a query "crua" levaria horas so pra um mes (a
  fabrica tem ~140 mil linhas de item/mes, contra ~2-5 mil de uma loja).

- LOJAS (cd_empresa em CCUSTOS_LOJAS): a tabela equivalente (mv_cmv_loja_v2)
  so guarda o valor agregado por loja/mes, sem item nem transacao. Pra ter o
  detalhe de lojas, rodamos a MESMA logica de calculo que a consultoria usa
  pra fabricar o CMV (join com vr_tra_transacao/vr_tra_transitem e a funcao
  f_prd_valor_produto2 pra achar o custo de cada item vendido) e guardamos o
  resultado num cache proprio (cmv_detalhado_cache) - o calculo e pesado
  (validado: ~150s pra uma loja/mes, por causa das views de origem, nao da
  funcao de custo) entao so roda quando pedido explicitamente (endpoint
  /calcular), um mes de cada vez, e fica salvo pra sempre depois disso.

Hierarquia de navegacao da tela: loja/fabrica -> transacao (venda inteira,
valor e CMV somados de todos os itens dela) -> item (o que exatamente foi
vendido naquela transacao).
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


def _limites_mes(ano: int, mes: int):
    data_inicio = f"{ano:04d}-{mes:02d}-01"
    if mes == 12:
        data_fim_exclusiva = f"{ano + 1:04d}-01-01"
    else:
        data_fim_exclusiva = f"{ano:04d}-{mes + 1:02d}-01"
    ultimo_dia = calendar.monthrange(ano, mes)[1]
    data_fim_inclusiva = f"{ano:04d}-{mes:02d}-{ultimo_dia:02d}"
    return data_inicio, data_fim_exclusiva, data_fim_inclusiva


def _buscar_receita_por_empresa(cd_empresas: list, data_inicio: str, data_fim_inclusiva: str) -> dict:
    """Receita liquida (venda bruta - devolucao) por empresa no periodo -
    mesma regra de inclusao de vendas usada no calculo do CMV (vr_tra_transacao,
    tp_situacao=4, modalidade/operacao de venda ou devolucao), mas SEM o join
    com item/produto - por isso e uma consulta leve, ao contrario do calculo
    de CMV de lojas. Serve de base pro percentual de CMV sobre a receita."""
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


def _cmv_percentual(valor_cmv: float, receita: float) -> Optional[float]:
    if not receita:
        return None
    return (abs(valor_cmv) / receita) * 100


# ============================================================================
# CACHE (so para LOJAS - ver docstring do modulo)
# ============================================================================

def _criar_tabelas_cache():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS cmv_detalhado_cache (
            id SERIAL PRIMARY KEY,
            cd_empresa INTEGER NOT NULL,
            ano_mes VARCHAR(7) NOT NULL,
            nr_transacao BIGINT,
            dt_transacao TIMESTAMP,
            vl_transacao NUMERIC,
            cd_produto INTEGER,
            qt_solicitada NUMERIC,
            idmarca VARCHAR(10),
            idconta VARCHAR(20),
            valor_unitario NUMERIC,
            valor_cmc NUMERIC
        )
    """)
    execute_insert("CREATE INDEX IF NOT EXISTS idx_cmv_cache_empresa_mes ON cmv_detalhado_cache (cd_empresa, ano_mes)")
    execute_insert("CREATE INDEX IF NOT EXISTS idx_cmv_cache_empresa_data ON cmv_detalhado_cache (cd_empresa, dt_transacao)")
    execute_insert("CREATE INDEX IF NOT EXISTS idx_cmv_cache_transacao ON cmv_detalhado_cache (cd_empresa, nr_transacao)")
    execute_insert("""
        CREATE TABLE IF NOT EXISTS cmv_detalhado_cache_status (
            cd_empresa INTEGER NOT NULL,
            ano_mes VARCHAR(7) NOT NULL,
            qtd_linhas INTEGER,
            valor_total NUMERIC,
            dt_calculado TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (cd_empresa, ano_mes)
        )
    """)


# Query fornecida pela consultoria - mesma logica que fabrica o CMV real,
# rodada aqui item a item / venda a venda para uma loja e um mes especificos.
# NAO ALTERAR a logica de calculo (classificacao de marca, formula do
# valor_cmc, fallback de custo) sem validar com quem manda a regra - so
# parametrizamos empresa e periodo, que no original vinham fixos.
_QUERY_CMV_LOJA_DETALHADO = """
    WITH base AS (
        SELECT
            t.nr_transacao,
            t.dt_transacao,
            t.vl_transacao,
            i.qt_solicitada,
            i.cd_produto AS idproduto,
            t.tp_operacao,
            BTRIM(pc_marca.cd_classificacao::text) AS idmarca
        FROM vr_tra_transacao t
        INNER JOIN vr_tra_transitem i
            ON t.nr_transacao = i.nr_transacao
           AND t.cd_empresa = i.cd_empresa
        LEFT JOIN prd_produtoclas pc_marca
            ON pc_marca.cd_produto = i.cd_produto
           AND pc_marca.cd_tipoclas = 20
        WHERE t.tp_situacao = 4
          AND t.cd_empresa = %s
          AND t.dt_transacao >= TIMESTAMP %s
          AND t.dt_transacao <  TIMESTAMP %s
          AND (
                (t.tp_modalidade::text IN ('4', '8') AND t.tp_operacao::text = 'S')
                OR (t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E')
              )
    ),
    com_valor AS (
        SELECT
            b.*,
            CASE
                WHEN b.idmarca IN ('0001', '0002', '0009') THEN
                    COALESCE(
                        NULLIF(f_prd_valor_produto2(1, 1, 'P', 1, b.idproduto, b.dt_transacao), 0),
                        NULLIF(f_prd_valor_produto2(1, 1, 'P', 1, b.idproduto, NULL), 0),
                        21.9
                    )
                ELSE
                    COALESCE(
                        NULLIF(f_prd_valor_produto2(1, 1, 'C', 2, b.idproduto, b.dt_transacao), 0),
                        NULLIF(f_prd_valor_produto2(1, 1, 'C', 2, b.idproduto, NULL), 0),
                        21.9
                    )
            END AS valor_unitario
        FROM base b
        WHERE b.idmarca IS NOT NULL AND b.idmarca <> ''
    )
    SELECT
        cv.nr_transacao,
        cv.dt_transacao,
        cv.vl_transacao,
        cv.idproduto AS cd_produto,
        cv.qt_solicitada,
        cv.idmarca,
        CASE WHEN cv.idmarca IN ('0001', '0002', '0009') THEN '04.02.01' ELSE '04.02.02' END AS idconta,
        cv.valor_unitario,
        (
            cv.qt_solicitada * cv.valor_unitario
            * CASE WHEN cv.tp_operacao::text = 'S' THEN -1 ELSE 1 END
            * 0.8
        ) AS valor_cmc
    FROM com_valor cv
"""


def _calcular_e_cachear_loja_mes(cd_empresa: int, ano: int, mes: int) -> dict:
    """Roda a query pesada pra uma loja/mes e substitui o cache dessa fatia.
    Demorado (minutos) - so chamar quando o usuario pedir explicitamente."""
    if _eh_fabrica(cd_empresa):
        raise HTTPException(status_code=400, detail="Fabrica ja usa a tabela rapida (mv_cmv_fab), nao precisa calcular.")
    if cd_empresa not in CCUSTOS_LOJAS:
        raise HTTPException(status_code=400, detail=f"Empresa/loja invalida: {cd_empresa}")

    _criar_tabelas_cache()
    ano_mes = f"{ano:04d}-{mes:02d}"
    data_inicio, data_fim_exclusiva, _ = _limites_mes(ano, mes)

    print(f"[CMV-DETALHADO] Calculando loja {cd_empresa} ({_nome_empresa_cmv(cd_empresa)}) - {ano_mes}...")
    linhas = execute_query(_QUERY_CMV_LOJA_DETALHADO, (cd_empresa, data_inicio, data_fim_exclusiva))
    print(f"[CMV-DETALHADO] {len(linhas)} linhas calculadas para {cd_empresa}/{ano_mes}")

    execute_insert(
        "DELETE FROM cmv_detalhado_cache WHERE cd_empresa = %s AND ano_mes = %s",
        (cd_empresa, ano_mes)
    )

    valor_total = 0.0
    tamanho_lote = 500
    for inicio in range(0, len(linhas), tamanho_lote):
        lote = linhas[inicio:inicio + tamanho_lote]
        placeholders = ",".join(["(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"] * len(lote))
        params = []
        for linha in lote:
            valor_cmc = float(linha['valor_cmc'] or 0)
            valor_total += valor_cmc
            params.extend([
                cd_empresa,
                ano_mes,
                linha['nr_transacao'],
                linha['dt_transacao'],
                float(linha['vl_transacao'] or 0),
                linha['cd_produto'],
                float(linha['qt_solicitada'] or 0),
                linha['idmarca'],
                linha['idconta'],
                float(linha['valor_unitario'] or 0),
                valor_cmc,
            ])
        execute_insert(
            f"""
                INSERT INTO cmv_detalhado_cache
                    (cd_empresa, ano_mes, nr_transacao, dt_transacao, vl_transacao,
                     cd_produto, qt_solicitada, idmarca, idconta, valor_unitario, valor_cmc)
                VALUES {placeholders}
            """,
            tuple(params)
        )

    execute_insert("""
        INSERT INTO cmv_detalhado_cache_status (cd_empresa, ano_mes, qtd_linhas, valor_total, dt_calculado)
        VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
        ON CONFLICT (cd_empresa, ano_mes) DO UPDATE SET
            qtd_linhas = EXCLUDED.qtd_linhas,
            valor_total = EXCLUDED.valor_total,
            dt_calculado = CURRENT_TIMESTAMP
    """, (cd_empresa, ano_mes, len(linhas), valor_total))

    return {"cdEmpresa": cd_empresa, "anoMes": ano_mes, "qtdLinhas": len(linhas), "valorTotal": valor_total}


@router.post("/api/cmv-detalhado/calcular")
def calcular_cmv_detalhado_loja(
    cdEmpresa: int = Query(..., description="Codigo da loja (cd_empresa)"),
    anoMes: str = Query(..., description="Mes a calcular, formato YYYY-MM")
):
    """
    Dispara o calculo item-a-item/venda-a-venda de uma loja para um mes
    especifico e grava no cache. Demorado (pode levar alguns minutos) - so
    precisa rodar uma vez por loja/mes, depois fica salvo.
    """
    try:
        ano, mes = (int(p) for p in anoMes.split("-"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"anoMes invalido: {anoMes} (esperado YYYY-MM)")

    try:
        return _calcular_e_cachear_loja_mes(cdEmpresa, ano, mes)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao calcular CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular CMV detalhado: {str(e)}")


# ============================================================================
# LEITURA
# ============================================================================

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
    empresa ('totais') e consolidado de tudo que foi pedido ('consolidado').
    Sempre responde rapido (usa as tabelas agregadas ja existentes: mv_cmv_fab
    pra fabrica, mv_cmv_loja_v2 pra lojas). Pra lojas, tambem informa quais
    meses do periodo ja tem o detalhe item-a-venda calculado
    ('mesesCalculados'/'mesesFaltando') - sem isso calculado, a linha ainda
    aparece no grafico (usa o agregado rapido), mas o drill-down de
    transacao/item fica indisponivel.
    """
    try:
        cd_empresas = _parse_empresas(empresas)
        meses = _gerar_meses(dataInicio, dataFim)
        if not meses:
            raise HTTPException(status_code=400, detail="Periodo invalido")
        meses_str = [f"{a:04d}-{m:02d}" for a, m in meses]

        _criar_tabelas_cache()

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

        # Meses ja calculados (cache detalhado) por loja, dentro do periodo pedido
        meses_calculados_por_loja = {e: set() for e in empresas_lojas_pedidas}
        if empresas_lojas_pedidas:
            placeholders = ",".join(["%s"] * len(empresas_lojas_pedidas))
            status_rows = execute_query(
                f"""
                    SELECT cd_empresa, ano_mes FROM cmv_detalhado_cache_status
                    WHERE cd_empresa IN ({placeholders}) AND ano_mes >= %s AND ano_mes <= %s
                """,
                (*empresas_lojas_pedidas, meses_str[0], meses_str[-1])
            )
            for r in status_rows or []:
                if r['ano_mes'] in meses_str:
                    meses_calculados_por_loja.setdefault(r['cd_empresa'], set()).add(r['ano_mes'])

        receita_por_empresa = _buscar_receita_por_empresa(cd_empresas, dataInicio, dataFim)

        totais = []
        for cd_empresa in cd_empresas:
            valores = totais_por_empresa[cd_empresa]
            valor_total = valores.get("04.02.01", 0) + valores.get("04.02.02", 0)
            receita = receita_por_empresa.get(cd_empresa, 0.0)
            item = {
                "cdEmpresa": cd_empresa,
                "nome": _nome_empresa_cmv(cd_empresa),
                "tipo": "fabrica" if _eh_fabrica(cd_empresa) else "loja",
                "mercadoriaRevenda": valores.get("04.02.01", 0),
                "produtoProprio": valores.get("04.02.02", 0),
                "valorTotal": valor_total,
                "receita": receita,
                "cmvPercentual": _cmv_percentual(valor_total, receita),
            }
            if not _eh_fabrica(cd_empresa):
                calculados = meses_calculados_por_loja.get(cd_empresa, set())
                item["mesesCalculados"] = sorted(calculados)
                item["mesesFaltando"] = [m for m in meses_str if m not in calculados]
                item["detalhado"] = len(calculados) == len(meses_str)
            else:
                item["mesesCalculados"] = meses_str
                item["mesesFaltando"] = []
                item["detalhado"] = True
            totais.append(item)

        totais.sort(key=lambda x: x["valorTotal"], reverse=True)

        valor_total_consolidado = sum(t["valorTotal"] for t in totais)
        receita_total_consolidada = sum(t["receita"] for t in totais)
        consolidado = {
            "valorTotal": valor_total_consolidado,
            "receita": receita_total_consolidada,
            "cmvPercentual": _cmv_percentual(valor_total_consolidado, receita_total_consolidada),
        }

        return {"periodos": meses_str, "totais": totais, "consolidado": consolidado}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar resumo CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar resumo CMV detalhado: {str(e)}")


@router.get("/api/cmv-detalhado/transacoes-resumo")
def transacoes_resumo_cmv_detalhado(
    cdEmpresa: int = Query(..., description="Codigo da empresa/loja"),
    dataInicio: str = Query(..., description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query(..., description="Data final (YYYY-MM-DD)")
):
    """
    Uma linha por venda (transacao inteira) de uma empresa no periodo: valor
    total vendido naquela transacao, CMV total dela (soma de todos os itens)
    e o % de CMV sobre o valor vendido. Pode abrir os itens de uma transacao
    especifica em /transacao-itens.
    """
    try:
        if _eh_fabrica(cdEmpresa):
            query_cmv = """
                SELECT nr_transacao, MAX(data) AS dt_transacao,
                       ABS(SUM(valor)) AS valor_cmc, COUNT(DISTINCT idproduto) AS qtd_itens
                FROM mv_cmv_fab
                WHERE idcentrocusto = %s AND data >= %s AND data <= %s
                GROUP BY nr_transacao
                ORDER BY MAX(data) DESC
                LIMIT 3000
            """
            linhas = execute_query(query_cmv, (cdEmpresa, dataInicio, dataFim))
            nrs_transacao = [l['nr_transacao'] for l in linhas]
            valores_venda = {}
            if nrs_transacao:
                placeholders = ",".join(["%s"] * len(nrs_transacao))
                rows_venda = execute_query(
                    f"""
                        SELECT nr_transacao, SUM(vl_transacao) as vl_transacao
                        FROM vr_tra_transacao
                        WHERE cd_empresa = %s AND nr_transacao IN ({placeholders})
                        GROUP BY nr_transacao
                    """,
                    (cdEmpresa, *nrs_transacao)
                )
                valores_venda = {r['nr_transacao']: float(r['vl_transacao'] or 0) for r in rows_venda or []}
            transacoes = []
            for l in linhas:
                vl_transacao = valores_venda.get(l['nr_transacao'])
                valor_cmc = float(l['valor_cmc'] or 0)
                transacoes.append({
                    "nrTransacao": l['nr_transacao'],
                    "dtTransacao": l['dt_transacao'].isoformat() if l['dt_transacao'] else None,
                    "vlTransacao": vl_transacao,
                    "valorCmc": valor_cmc,
                    "cmvPercentual": _cmv_percentual(valor_cmc, vl_transacao) if vl_transacao else None,
                    "qtdItens": l['qtd_itens'],
                })
        else:
            if cdEmpresa not in CCUSTOS_LOJAS:
                raise HTTPException(status_code=400, detail=f"Empresa/loja invalida: {cdEmpresa}")
            query = """
                SELECT nr_transacao, MAX(dt_transacao) AS dt_transacao, MAX(vl_transacao) AS vl_transacao,
                       SUM(valor_cmc) AS valor_cmc, COUNT(*) AS qtd_itens
                FROM cmv_detalhado_cache
                WHERE cd_empresa = %s AND dt_transacao >= %s AND dt_transacao <= %s
                GROUP BY nr_transacao
                ORDER BY MAX(dt_transacao) DESC
                LIMIT 3000
            """
            linhas = execute_query(query, (cdEmpresa, dataInicio, dataFim))
            transacoes = []
            for l in linhas or []:
                vl_transacao = float(l['vl_transacao']) if l['vl_transacao'] is not None else None
                valor_cmc = float(l['valor_cmc'] or 0)
                transacoes.append({
                    "nrTransacao": l['nr_transacao'],
                    "dtTransacao": l['dt_transacao'].isoformat() if l['dt_transacao'] else None,
                    "vlTransacao": vl_transacao,
                    "valorCmc": valor_cmc,
                    "cmvPercentual": _cmv_percentual(valor_cmc, vl_transacao) if vl_transacao else None,
                    "qtdItens": l['qtd_itens'],
                })

        return {"cdEmpresa": cdEmpresa, "nome": _nome_empresa_cmv(cdEmpresa), "transacoes": transacoes}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar transacoes-resumo CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar transacoes-resumo CMV detalhado: {str(e)}")


@router.get("/api/cmv-detalhado/transacao-itens")
def transacao_itens_cmv_detalhado(
    cdEmpresa: int = Query(..., description="Codigo da empresa/loja"),
    nrTransacao: int = Query(..., description="Numero da transacao (venda)")
):
    """Os itens (produtos) que compoem uma transacao especifica."""
    try:
        if _eh_fabrica(cdEmpresa):
            query = """
                SELECT idproduto AS cd_produto, idconta, ABS(SUM(valor)) AS valor_cmc
                FROM mv_cmv_fab
                WHERE idcentrocusto = %s AND nr_transacao = %s
                GROUP BY idproduto, idconta
                ORDER BY valor_cmc DESC
            """
            linhas = execute_query(query, (cdEmpresa, nrTransacao))
            itens_base = [{
                "cdProduto": l['cd_produto'], "idconta": l['idconta'],
                "qtSolicitada": None, "valorUnitario": None, "valorCmc": float(l['valor_cmc'] or 0),
            } for l in linhas or []]
        else:
            if cdEmpresa not in CCUSTOS_LOJAS:
                raise HTTPException(status_code=400, detail=f"Empresa/loja invalida: {cdEmpresa}")
            query = """
                SELECT cd_produto, idconta, qt_solicitada, valor_unitario, valor_cmc
                FROM cmv_detalhado_cache
                WHERE cd_empresa = %s AND nr_transacao = %s
                ORDER BY valor_cmc ASC
            """
            linhas = execute_query(query, (cdEmpresa, nrTransacao))
            itens_base = [{
                "cdProduto": l['cd_produto'], "idconta": l['idconta'],
                "qtSolicitada": float(l['qt_solicitada']) if l['qt_solicitada'] is not None else None,
                "valorUnitario": float(l['valor_unitario']) if l['valor_unitario'] is not None else None,
                "valorCmc": float(l['valor_cmc'] or 0),
            } for l in linhas or []]

        produto_ids = [i['cdProduto'] for i in itens_base if i['cdProduto'] is not None]
        nomes_produto = {}
        if produto_ids:
            placeholders = ",".join(["%s"] * len(produto_ids))
            rows_nome = execute_query(
                f"SELECT cd_produto, ds_produto FROM prd_produto WHERE cd_produto IN ({placeholders})",
                tuple(produto_ids)
            )
            nomes_produto = {r['cd_produto']: r['ds_produto'] for r in rows_nome or []}

        for item in itens_base:
            item["dsProduto"] = nomes_produto.get(item["cdProduto"], f"PRODUTO {item['cdProduto']}")

        return {"cdEmpresa": cdEmpresa, "nrTransacao": nrTransacao, "itens": itens_base}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar itens da transacao CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar itens da transacao CMV detalhado: {str(e)}")
