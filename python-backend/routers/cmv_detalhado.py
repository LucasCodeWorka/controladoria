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
  /calcular) e fica salvo pra sempre depois disso.
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime
import calendar
from database import execute_query, execute_insert
from routers.dre import CCUSTOS_LOJAS, EMPRESAS_FABRICA

router = APIRouter()

EMPRESAS_CMV_DETALHADO = sorted(set(EMPRESAS_FABRICA) | set(CCUSTOS_LOJAS.keys()))


def _nome_empresa_cmv(cd_empresa: int) -> str:
    if cd_empresa in EMPRESAS_FABRICA:
        return "FABRICA"
    return CCUSTOS_LOJAS.get(cd_empresa, f"EMPRESA {cd_empresa}")


def _eh_fabrica(cd_empresa: int) -> bool:
    return cd_empresa in EMPRESAS_FABRICA


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
    execute_insert("CREATE INDEX IF NOT EXISTS idx_cmv_cache_produto ON cmv_detalhado_cache (cd_empresa, ano_mes, cd_produto)")
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
# LEITURA (resumo / itens / transacoes) - fabrica direto de mv_cmv_fab,
# lojas do cache (cmv_detalhado_cache) com fallback pro agregado rapido
# (mv_cmv_loja_v2) quando ainda nao foi calculado o detalhe daquele mes.
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
    dataFim: str = Query(..., description="Data final (YYYY-MM-DD)")
):
    """
    Visao geral: total de CMV por loja/fabrica e por mes no periodo. Sempre
    responde rapido (usa as tabelas agregadas ja existentes) - marca
    'detalhado: true' nas fatias (empresa+mes) que ja tem o item-a-item
    calculado e disponivel pra drill-down.
    """
    try:
        meses = _gerar_meses(dataInicio, dataFim)
        if not meses:
            raise HTTPException(status_code=400, detail="Periodo invalido")

        _criar_tabelas_cache()

        resultado = []

        # --- FABRICA: agregado direto de mv_cmv_fab, por mes ---
        query_fab = """
            SELECT DATE_TRUNC('month', data) AS mes, idconta, ABS(SUM(valor)) AS valor
            FROM mv_cmv_fab
            WHERE data >= %s AND data <= %s
            GROUP BY DATE_TRUNC('month', data), idconta
        """
        rows_fab = execute_query(query_fab, (dataInicio, dataFim))
        totais_fab = {}
        for r in rows_fab or []:
            ano_mes = r['mes'].strftime('%Y-%m')
            totais_fab.setdefault(ano_mes, {"04.02.01": 0.0, "04.02.02": 0.0})
            totais_fab[ano_mes][r['idconta']] = totais_fab[ano_mes].get(r['idconta'], 0) + float(r['valor'] or 0)

        for ano, mes in meses:
            ano_mes = f"{ano:04d}-{mes:02d}"
            valores = totais_fab.get(ano_mes, {"04.02.01": 0.0, "04.02.02": 0.0})
            valor_total = valores.get("04.02.01", 0) + valores.get("04.02.02", 0)
            resultado.append({
                "cdEmpresa": EMPRESAS_FABRICA[0],
                "nome": "FABRICA",
                "tipo": "fabrica",
                "anoMes": ano_mes,
                "mercadoriaRevenda": valores.get("04.02.01", 0),
                "produtoProprio": valores.get("04.02.02", 0),
                "valorTotal": valor_total,
                "detalhado": valor_total > 0,  # mv_cmv_fab ja E o detalhado
            })

        # --- LOJAS: agregado rapido (mv_cmv_loja_v2) + status do cache detalhado ---
        query_lojas = """
            SELECT DATE_TRUNC('month', data) AS mes, idcentrodecusto, idconta, ABS(SUM(valor)) AS valor
            FROM mv_cmv_loja_v2
            WHERE data >= %s AND data <= %s
            GROUP BY DATE_TRUNC('month', data), idcentrodecusto, idconta
        """
        rows_lojas = execute_query(query_lojas, (dataInicio, dataFim))
        totais_lojas = {}
        for r in rows_lojas or []:
            ano_mes = r['mes'].strftime('%Y-%m')
            chave = (r['idcentrodecusto'], ano_mes)
            totais_lojas.setdefault(chave, {"04.02.01": 0.0, "04.02.02": 0.0})
            totais_lojas[chave][r['idconta']] = totais_lojas[chave].get(r['idconta'], 0) + float(r['valor'] or 0)

        status_rows = execute_query(
            "SELECT cd_empresa, ano_mes, valor_total FROM cmv_detalhado_cache_status WHERE ano_mes >= %s AND ano_mes <= %s",
            (f"{meses[0][0]:04d}-{meses[0][1]:02d}", f"{meses[-1][0]:04d}-{meses[-1][1]:02d}")
        )
        status_map = {(r['cd_empresa'], r['ano_mes']): float(r['valor_total'] or 0) for r in status_rows or []}

        for cd_empresa in CCUSTOS_LOJAS:
            for ano, mes in meses:
                ano_mes = f"{ano:04d}-{mes:02d}"
                valores = totais_lojas.get((cd_empresa, ano_mes), {"04.02.01": 0.0, "04.02.02": 0.0})
                valor_total = valores.get("04.02.01", 0) + valores.get("04.02.02", 0)
                if valor_total == 0 and (cd_empresa, ano_mes) not in status_map:
                    continue  # loja sem nenhum movimento nesse mes - nao polui a lista
                detalhado = (cd_empresa, ano_mes) in status_map
                resultado.append({
                    "cdEmpresa": cd_empresa,
                    "nome": CCUSTOS_LOJAS[cd_empresa],
                    "tipo": "loja",
                    "anoMes": ano_mes,
                    "mercadoriaRevenda": valores.get("04.02.01", 0),
                    "produtoProprio": valores.get("04.02.02", 0),
                    "valorTotal": valor_total,
                    "detalhado": detalhado,
                    "valorDetalhado": status_map.get((cd_empresa, ano_mes)),
                })

        return {"periodos": [f"{a:04d}-{m:02d}" for a, m in meses], "linhas": resultado}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar resumo CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar resumo CMV detalhado: {str(e)}")


@router.get("/api/cmv-detalhado/itens")
def itens_cmv_detalhado(
    cdEmpresa: int = Query(..., description="Codigo da empresa/loja"),
    anoMes: str = Query(..., description="Mes, formato YYYY-MM")
):
    """Quebra por produto (item a item) de uma empresa/mes especifico."""
    try:
        ano, mes = (int(p) for p in anoMes.split("-"))
        data_inicio, data_fim_exclusiva, data_fim_inclusiva = _limites_mes(ano, mes)

        if _eh_fabrica(cdEmpresa):
            query = """
                SELECT idproduto AS cd_produto, idconta,
                       COUNT(DISTINCT nr_transacao) AS qtd_transacoes,
                       ABS(SUM(valor)) AS valor_cmc
                FROM mv_cmv_fab
                WHERE idcentrocusto = %s AND data >= %s AND data <= %s
                GROUP BY idproduto, idconta
                ORDER BY valor_cmc DESC
            """
            linhas = execute_query(query, (cdEmpresa, data_inicio, data_fim_inclusiva))
        else:
            if cdEmpresa not in CCUSTOS_LOJAS:
                raise HTTPException(status_code=400, detail=f"Empresa/loja invalida: {cdEmpresa}")
            query = """
                SELECT cd_produto, idconta,
                       COUNT(DISTINCT nr_transacao) AS qtd_transacoes,
                       ABS(SUM(valor_cmc)) AS valor_cmc
                FROM cmv_detalhado_cache
                WHERE cd_empresa = %s AND ano_mes = %s
                GROUP BY cd_produto, idconta
                ORDER BY valor_cmc DESC
            """
            linhas = execute_query(query, (cdEmpresa, anoMes))

        produto_ids = [l['cd_produto'] for l in linhas if l.get('cd_produto') is not None]
        nomes_produto = {}
        if produto_ids:
            placeholders = ",".join(["%s"] * len(produto_ids))
            rows_nome = execute_query(
                f"SELECT cd_produto, ds_produto FROM prd_produto WHERE cd_produto IN ({placeholders})",
                tuple(produto_ids)
            )
            nomes_produto = {r['cd_produto']: r['ds_produto'] for r in rows_nome or []}

        itens = [{
            "cdProduto": l['cd_produto'],
            "dsProduto": nomes_produto.get(l['cd_produto'], f"PRODUTO {l['cd_produto']}"),
            "idconta": l['idconta'],
            "qtdTransacoes": l['qtd_transacoes'],
            "valorCmc": float(l['valor_cmc'] or 0),
        } for l in linhas or []]

        return {
            "cdEmpresa": cdEmpresa,
            "nome": _nome_empresa_cmv(cdEmpresa),
            "anoMes": anoMes,
            "itens": itens,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar itens CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar itens CMV detalhado: {str(e)}")


@router.get("/api/cmv-detalhado/transacoes")
def transacoes_cmv_detalhado(
    cdEmpresa: int = Query(..., description="Codigo da empresa/loja"),
    anoMes: str = Query(..., description="Mes, formato YYYY-MM"),
    cdProduto: Optional[int] = Query(None, description="Filtrar por um produto especifico")
):
    """Venda a venda (nivel de transacao) de uma empresa/mes, opcionalmente
    filtrado por produto."""
    try:
        ano, mes = (int(p) for p in anoMes.split("-"))
        data_inicio, _, data_fim_inclusiva = _limites_mes(ano, mes)

        if _eh_fabrica(cdEmpresa):
            where_produto = "AND idproduto = %s" if cdProduto is not None else ""
            params = [cdEmpresa, data_inicio, data_fim_inclusiva] + ([cdProduto] if cdProduto is not None else [])
            query = f"""
                SELECT nr_transacao, data AS dt_transacao, idproduto AS cd_produto, idconta,
                       ABS(SUM(valor)) AS valor_cmc
                FROM mv_cmv_fab
                WHERE idcentrocusto = %s AND data >= %s AND data <= %s {where_produto}
                GROUP BY nr_transacao, data, idproduto, idconta
                ORDER BY data DESC, valor_cmc DESC
                LIMIT 2000
            """
            linhas = execute_query(query, tuple(params))
            transacoes = [{
                "nrTransacao": l['nr_transacao'],
                "dtTransacao": l['dt_transacao'].isoformat() if l['dt_transacao'] else None,
                "cdProduto": l['cd_produto'],
                "idconta": l['idconta'],
                "vlTransacao": None,
                "qtSolicitada": None,
                "valorUnitario": None,
                "valorCmc": float(l['valor_cmc'] or 0),
            } for l in linhas or []]
        else:
            if cdEmpresa not in CCUSTOS_LOJAS:
                raise HTTPException(status_code=400, detail=f"Empresa/loja invalida: {cdEmpresa}")
            where_produto = "AND cd_produto = %s" if cdProduto is not None else ""
            params = [cdEmpresa, anoMes] + ([cdProduto] if cdProduto is not None else [])
            query = f"""
                SELECT nr_transacao, dt_transacao, cd_produto, idconta,
                       vl_transacao, qt_solicitada, valor_unitario, valor_cmc
                FROM cmv_detalhado_cache
                WHERE cd_empresa = %s AND ano_mes = %s {where_produto}
                ORDER BY dt_transacao DESC, valor_cmc ASC
                LIMIT 2000
            """
            linhas = execute_query(query, tuple(params))
            transacoes = [{
                "nrTransacao": l['nr_transacao'],
                "dtTransacao": l['dt_transacao'].isoformat() if l['dt_transacao'] else None,
                "cdProduto": l['cd_produto'],
                "idconta": l['idconta'],
                "vlTransacao": float(l['vl_transacao']) if l['vl_transacao'] is not None else None,
                "qtSolicitada": float(l['qt_solicitada']) if l['qt_solicitada'] is not None else None,
                "valorUnitario": float(l['valor_unitario']) if l['valor_unitario'] is not None else None,
                "valorCmc": float(l['valor_cmc'] or 0),
            } for l in linhas or []]

        return {"cdEmpresa": cdEmpresa, "anoMes": anoMes, "cdProduto": cdProduto, "transacoes": transacoes}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar transacoes CMV detalhado: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar transacoes CMV detalhado: {str(e)}")
