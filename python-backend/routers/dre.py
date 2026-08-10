from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime, timedelta
from database import execute_query, execute_insert
import services
import unicodedata

router = APIRouter()

# ============================================================================
# FILTRO GLOBAL DE EMPRESAS EXCLUÍDAS
# ============================================================================
# As seguintes empresas são EXCLUÍDAS de TODOS os relatórios DRE:
#   - 50  = CORPO SEXY
#   - 100 = CAIRO BENEVIDES
#   - 110 = CB EMPREENDIMENTOS
#
# Lojas encerradas (não funcionam mais):
#   - 9   = LIEBE SHOPPING IBIRAPUERA - SP
#   - 11  = LIEBE OSCAR FREIRE - SP
#   - 12  = LIEBE ANALIA FRANCO - SP
#   - 13  = LIEBE BH SHOPPING - MG
#   - 16  = LIEBE BOURBON SP
#   - 18  = LIEBE VILA OLIMPIA
#
# Para incluir essas empresas novamente, remova os IDs da lista abaixo.
# ============================================================================
EMPRESAS_EXCLUIDAS = [50, 100, 110, 9, 11, 12, 13, 16, 18]

# Centros de custo das lojas ATIVAS (exclui lojas encerradas: 9, 11, 12, 13, 16, 18)
CCUSTOS_LOJAS_ATIVOS = [2, 3, 4, 5, 6, 7, 8, 10, 14, 15, 17, 19, 20, 21, 22, 120]


def _normalizar_texto(value: Optional[str]) -> str:
    if not value:
        return ""
    text = str(value).strip().upper()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(text.split())


# Descricoes que devem ser EXCLUIDAS da DRE (nao classificar)
EXCLUSOES_DESCRICAO_DRE = [
    'MERC P/ REVENDA',
    'MERC P/REVENDA',
    'MERCADORIA P/ REVENDA',
    'MERCADORIA REVENDA',
]


def _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db):
    """
    Classifica uma despesa em uma conta DRE usando APENAS o banco de dados.

    Args:
        cd_despesaitem: Codigo do item de despesa
        descricao_despesa: Descricao da despesa (usado apenas para exclusoes)
        classificacoes_db: Dict com classificacoes por codigo do banco
    """
    descricao_normalizada = _normalizar_texto(descricao_despesa)

    # Verificar se a descricao deve ser excluida (ex: MERC P/REVENDA)
    for exclusao in EXCLUSOES_DESCRICAO_DRE:
        if exclusao in descricao_normalizada:
            return 'EXCLUIDO'

    # Classificacao por codigo do banco
    conta = classificacoes_db.get(cd_despesaitem)
    if conta:
        return conta

    return 'NAO_CLASSIFICADO'


def _execute_query_with_date_fallback(execute_query_fn, query_emissao, query_fallback, params, context):
    """
    Tenta executar usando dt_emissao; se a coluna não existir na VIEW,
    faz fallback para dtvencimento.
    """
    try:
        return execute_query_fn(query_emissao, params)
    except Exception as e:
        msg = str(e).lower()
        if "dt_emissao" in msg and "does not exist" in msg:
            print(f"[DRE] Aviso: dt_emissao ausente em {context}; usando dtvencimento.")
            return execute_query_fn(query_fallback, params)
        raise


def _init_valores_periodo(periodos):
    valores = {'total': 0}
    for periodo in periodos:
        valores[periodo] = 0
    return valores


def _somar_hierarquia(valores_por_conta, periodos):
    pais = {}

    for codigo, valores in valores_por_conta.items():
        if codigo in ('NAO_CLASSIFICADO', 'EXCLUIDO'):
            continue

        partes = codigo.split('.')
        if len(partes) <= 1:
            continue

        for nivel in range(1, len(partes)):
            codigo_pai = '.'.join(partes[:nivel])
            if codigo_pai not in pais:
                pais[codigo_pai] = _init_valores_periodo(periodos)

            for periodo in periodos:
                pais[codigo_pai][periodo] += valores.get(periodo, 0)
            pais[codigo_pai]['total'] += valores.get('total', 0)

    for codigo_pai, valores_pai in pais.items():
        valores_por_conta[codigo_pai] = valores_pai

    return valores_por_conta


def _calcular_totalizadores(valores_por_conta, periodos):
    """
    Calcula as contas totalizadoras do DRE:
    03 = 01 + 02 (Receita Líquida)
    05 = 03 + 04 (Margem Contribuição)
    07 = 05 + 06 (Lucro Operacional Bruto)
    09 = 07 + 08 (EBITDA)
    11 = 09 + 10 (Lucro Bruto)
    14 = 11 + 13 (Lucro Líquido)
    """
    def get_valor(codigo, chave):
        return valores_por_conta.get(codigo, {}).get(chave, 0)

    def criar_conta(codigo, componentes):
        valores = {'total': 0}
        for p in periodos:
            valores[p] = sum(get_valor(c, p) for c in componentes)
        valores['total'] = sum(get_valor(c, 'total') for c in componentes)
        return valores

    # 03 = Receita Líquida = 01 + 02
    valores_por_conta['03'] = criar_conta('03', ['01', '02'])

    # 05 = Margem Contribuição = 03 + 04
    valores_por_conta['05'] = criar_conta('05', ['03', '04'])

    # 07 = Lucro Operacional Bruto = 05 + 06
    valores_por_conta['07'] = criar_conta('07', ['05', '06'])

    # 09 = EBITDA = 07 + 08
    valores_por_conta['09'] = criar_conta('09', ['07', '08'])

    # 11 = Lucro Bruto = 09 + 10
    valores_por_conta['11'] = criar_conta('11', ['09', '10'])

    # 14 = Lucro Líquido = 11 + 13
    valores_por_conta['14'] = criar_conta('14', ['11', '13'])

    return valores_por_conta


@router.get("/api/dre")
def get_dre(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    empresas: Optional[str] = Query(None, description="IDs de empresa separados por vírgula (ex: 1,120,11)")
):
    """
    Retorna dados da DRE agrupados por conta e período mensal

    Args:
        dataInicio: Data inicial no formato YYYY-MM-DD
        dataFim: Data final no formato YYYY-MM-DD

    Returns:
        JSON com dados da DRE estruturados
    """
    try:
        print(f"[INFO] Buscando DRE: {dataInicio} até {dataFim}, empresas={empresas}")
        import calendar

        # Gerar períodos mensais
        periodos = services.gerar_periodos(dataInicio, dataFim)

        # Parsear filtro de empresas (se informado)
        empresas_ids = None
        if empresas:
            try:
                empresas_ids = [int(e.strip()) for e in empresas.split(',') if e.strip()]
            except ValueError:
                raise HTTPException(status_code=400, detail="Parametro 'empresas' invalido. Use IDs separados por virgula.")
            if not empresas_ids:
                raise HTTPException(status_code=400, detail="Parametro 'empresas' invalido. Informe pelo menos um ID.")

        # Buscar TODAS as despesas do período por DATA DE EMISSÃO
        # Filtro por cd_ccusto (centros de custo válidos), excluindo 50, 100, 110
        # Monta lista de ccustos válidos: fábrica + lojas + ecommerce + diretoria
        ccustos_dre_analitico = CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys()) + CCUSTOS_ECOMMERCE + [515]

        # Filtro de empresa específica (se informado) - filtra por cd_ccusto
        empresa_desp_filter = ""
        empresa_desp_params = []
        if empresas_ids:
            empresa_desp_placeholders = ",".join(["%s"] * len(empresas_ids))
            empresa_desp_filter = f" AND d.cd_ccusto IN ({empresa_desp_placeholders})"
            empresa_desp_params = empresas_ids

        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.dt_emissao as dt_emissao,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({",".join(["%s"] * len(ccustos_dre_analitico))})
              AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
              {empresa_desp_filter}
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos_dre_analitico, *CCUSTOS_EXCLUIDOS_FABRICA, *empresa_desp_params))
        print(f"[DRE] Total de despesas: {len(despesas)}")

        # Buscar classificações do banco de dados (prioridade) e depois usar mapeamento fixo como fallback
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    # Extrair apenas o código (ex: "08.01.02" de "08.01.02 ALUGUEL MINIMO")
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
            print(f"[DRE] Classificações carregadas do banco: {len(classificacoes_db)}")
        except Exception as e:
            print(f"[DRE] Aviso: não foi possível carregar classificações do banco: {e}")

        # Agrupar despesas por conta_dre e período
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

            # Pular despesas excluidas (ex: MERC P/ REVENDA)
            if conta == 'EXCLUIDO':
                continue

            # Determinar período (YYYY-MM)
            if dt_emissao:
                periodo = dt_emissao.strftime('%Y-%m')
            else:
                continue

            # Só considerar se o período estiver na lista
            if periodo not in periodos:
                continue

            if conta not in valores_por_conta:
                valores_por_conta[conta] = {'total': 0}
                for p in periodos:
                    valores_por_conta[conta][p] = 0

            valores_por_conta[conta][periodo] += valor
            valores_por_conta[conta]['total'] += valor

        # Log das contas encontradas
        print(f"[DRE] Contas com valores: {list(valores_por_conta.keys())}")
        print(f"[DRE] Despesas nao classificadas: {nao_classificados}")

        # Buscar VENDAS e DEVOLUCOES por transacao (Receita Bruta e Deducoes)
        empresa_filter_sql = ""
        empresa_params = []
        if empresas_ids:
            placeholders = ",".join(["%s"] * len(empresas_ids))
            empresa_filter_sql = f" AND t.cd_empresa IN ({placeholders})"
            empresa_params = empresas_ids

        # Filtro para EXCLUIR empresas específicas (CORPO SEXY, CAIRO BENEVIDES, CB EMPREENDIMENTOS)
        exclusao_vendas_placeholders = ",".join(["%s"] * len(EMPRESAS_EXCLUIDAS))
        exclusao_filter_sql = f" AND t.cd_empresa NOT IN ({exclusao_vendas_placeholders})"

        base_where_common = f"""
            t.dt_transacao >= %s
            AND t.dt_transacao <= %s
            AND t.tp_situacao = 4
            {empresa_filter_sql}
            {exclusao_filter_sql}
        """

        query_vendas = f"""
            SELECT
                t.dt_transacao as dt_transacao,
                t.vl_transacao as valor
            FROM vr_tra_transacao t
            WHERE
                {base_where_common}
                AND t.tp_modalidade IN ('4')
                AND t.tp_operacao = 'S'
            ORDER BY t.dt_transacao
        """

        query_devolucoes = f"""
            SELECT
                t.dt_transacao as dt_transacao,
                t.vl_transacao as valor
            FROM vr_tra_transacao t
            WHERE
                {base_where_common}
                AND t.tp_modalidade IN ('3')
                AND t.tp_operacao = 'E'
            ORDER BY t.dt_transacao
        """

        params = [dataInicio, dataFim] + empresa_params + list(EMPRESAS_EXCLUIDAS)
        vendas = execute_query(query_vendas, tuple(params))
        devolucoes = execute_query(query_devolucoes, tuple(params))
        print(f"[DRE] Total de vendas (transacoes): {len(vendas)}")
        print(f"[DRE] Total de devolucoes (transacoes): {len(devolucoes)}")

        # Agrupar por periodo (YYYY-MM)
        receita_bruta = _init_valores_periodo(periodos)
        devolucoes_brutas = _init_valores_periodo(periodos)

        for v in vendas:
            valor = float(v['valor'] or 0)
            dt_transacao = v['dt_transacao']
            if not dt_transacao:
                continue
            periodo = dt_transacao.strftime('%Y-%m')
            if periodo in periodos:
                receita_bruta[periodo] += valor
                receita_bruta['total'] += valor

        for d in devolucoes:
            valor = -abs(float(d['valor'] or 0))
            dt_transacao = d['dt_transacao']
            if not dt_transacao:
                continue
            periodo = dt_transacao.strftime('%Y-%m')
            if periodo in periodos:
                devolucoes_brutas[periodo] += valor
                devolucoes_brutas['total'] += valor

        # Adicionar receita bruta e devolucoes nas contas DRE
        def _merge_conta(codigo: str, valores: dict):
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = valores
                return
            for p in periodos:
                valores_por_conta[codigo][p] = valores_por_conta[codigo].get(p, 0) + valores.get(p, 0)
            valores_por_conta[codigo]['total'] = valores_por_conta[codigo].get('total', 0) + valores.get('total', 0)

        _merge_conta('01.01.02', receita_bruta)
        _merge_conta('02.01.03', devolucoes_brutas)

        # CMV por período → conta 04.02.02 (CUSTO MERCADORIAS VENDIDAS)
        # Filtro de empresa específica para CMV (se informado)
        cmv_empresa_filter = ""
        cmv_empresa_params = []
        if empresas_ids:
            cmv_empresa_placeholders = ",".join(["%s"] * len(empresas_ids))
            cmv_empresa_filter = f" AND idcentrodecusto IN ({cmv_empresa_placeholders})"
            cmv_empresa_params = empresas_ids

        cmv_loja_raw = execute_query(f"""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja_v2
            WHERE data >= %s AND data <= %s
              {cmv_empresa_filter}
            GROUP BY DATE_TRUNC('month', data)
        """, (dataInicio, dataFim, *cmv_empresa_params))

        # Filtro de empresa específica para CMV fábrica (coluna diferente: idcentrocusto)
        cmv_fab_empresa_filter = ""
        cmv_fab_empresa_params = []
        if empresas_ids:
            cmv_fab_empresa_placeholders = ",".join(["%s"] * len(empresas_ids))
            cmv_fab_empresa_filter = f" AND idcentrocusto IN ({cmv_fab_empresa_placeholders})"
            cmv_fab_empresa_params = empresas_ids

        cmv_fab_raw = execute_query(f"""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_fab
            WHERE data >= %s AND data <= %s
              {cmv_fab_empresa_filter}
            GROUP BY DATE_TRUNC('month', data)
        """, (dataInicio, dataFim, *cmv_fab_empresa_params))

        cmv_valores = _init_valores_periodo(periodos)
        for r in (cmv_loja_raw or []) + (cmv_fab_raw or []):
            p = r['mes'].strftime('%Y-%m')
            if p in periodos:
                v = -abs(float(r['cmv'] or 0))
                cmv_valores[p] += v
                cmv_valores['total'] += v

        _merge_conta('04.02.02', cmv_valores)
        valores_por_conta = _somar_hierarquia(valores_por_conta, periodos)
        valores_por_conta = _calcular_totalizadores(valores_por_conta, periodos)
        print(f"[DRE] CMV total: {cmv_valores['total']:.2f}")

        # Montar resposta
        response = {
            "periodos": [
                {
                    "key": p,
                    "label": services.formatar_label_periodo(p)
                }
                for p in periodos
            ],
            "valores": valores_por_conta,
            "metadata": {
                "totalDespesas": len(despesas),
                "naoClassificadas": nao_classificados,
                "totalVendasItens": len(vendas),
                "totalDevolucoesItens": len(devolucoes),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "empresas": empresas_ids,
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE gerado com sucesso.")
        return response

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar dados da DRE: {str(e)}"
        )


# ============================================================================
# CENTROS DE CUSTO DA FABRICA
# ============================================================================
# Removido 50 dos centros de custo (era duplicado com empresa)
CCUSTOS_FABRICA = [1, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 514]
EMPRESAS_FABRICA = [1, 50]
CCUSTOS_ECOMMERCE = [49, 120]
CCUSTO_ECOMMERCE_AGRUPADO = 120
# Centros de custo excluidos das despesas (lojas/outras empresas)
CCUSTOS_EXCLUIDOS_FABRICA = [50, 100, 110]


def _agrupar_ccusto_dre_por_empresa(cd_ccusto: int) -> int:
    if cd_ccusto in CCUSTOS_ECOMMERCE:
        return CCUSTO_ECOMMERCE_AGRUPADO
    if cd_ccusto == 1 or cd_ccusto > 120:
        return 1
    return cd_ccusto


def _buscar_ccustos_lojas():
    """Busca centros de custo que tem LOJAS no nome"""
    query = """
        SELECT cd_ccusto, ds_ccusto
        FROM vr_gec_ccusto
        WHERE UPPER(ds_ccusto) LIKE %s
        ORDER BY cd_ccusto
    """
    rows = execute_query(query, ('%LOJAS%',))
    return [r['cd_ccusto'] for r in rows], {r['cd_ccusto']: r['ds_ccusto'] for r in rows}


def _buscar_empresas_lojas():
    """Busca empresas que tem LOJAS no nome"""
    query = """
        SELECT e.cd_empresa, COALESCE(p.nm_fantasia, p.nm_pessoa) as nome
        FROM vr_ger_empresa e
        LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = e.cd_pessoa
        WHERE UPPER(COALESCE(p.nm_fantasia, p.nm_pessoa, '')) LIKE %s
           OR UPPER(COALESCE(p.nm_fantasia, p.nm_pessoa, '')) LIKE %s
        ORDER BY e.cd_empresa
    """
    rows = execute_query(query, ('%LOJAS%', '%LOJA %'))
    return [r['cd_empresa'] for r in rows], {r['cd_empresa']: r['nome'] for r in rows}



@router.get("/api/dre/fabrica")
def get_dre_fabrica(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna dados da DRE FABRICA agrupados por conta e periodo mensal.
    Filtra apenas centros de custo e empresas da fabrica.

    Filtros aplicados:
    - Empresas: cd_empresa IN (1, 50)
    - Centros de custo: cd_ccusto IN (1, 50, 500-514)
    - CMV: apenas mv_cmv_fab
    """
    try:
        print(f"[INFO] Buscando DRE FABRICA: {dataInicio} ate {dataFim}")

        # Gerar periodos mensais
        periodos = services.gerar_periodos(dataInicio, dataFim)

        # Placeholders para filtros
        ccusto_placeholders = ",".join(["%s"] * len(CCUSTOS_FABRICA))
        ccusto_excluidos_placeholders = ",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))
        empresa_placeholders = ",".join(["%s"] * len(EMPRESAS_FABRICA))

        # =========================================================================
        # DESPESAS - filtrar por centro de custo da fabrica, excluindo 50, 100, 110
        # =========================================================================
        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.dt_emissao as dt_emissao,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({ccusto_excluidos_placeholders})
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *CCUSTOS_FABRICA, *CCUSTOS_EXCLUIDOS_FABRICA))
        print(f"[DRE FABRICA] Total de despesas: {len(despesas)}")

        # Buscar classificacoes do banco de dados
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
            print(f"[DRE FABRICA] Classificacoes carregadas: {len(classificacoes_db)}")
        except Exception as e:
            print(f"[DRE FABRICA] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Agrupar despesas por conta_dre e periodo
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

            # Pular despesas excluidas (ex: MERC P/ REVENDA)
            if conta == 'EXCLUIDO':
                continue

            if dt_emissao:
                periodo = dt_emissao.strftime('%Y-%m')
            else:
                continue

            if periodo not in periodos:
                continue

            if conta not in valores_por_conta:
                valores_por_conta[conta] = {'total': 0}
                for p in periodos:
                    valores_por_conta[conta][p] = 0

            valores_por_conta[conta][periodo] += valor
            valores_por_conta[conta]['total'] += valor

        print(f"[DRE FABRICA] Contas com valores: {list(valores_por_conta.keys())}")
        print(f"[DRE FABRICA] Despesas nao classificadas: {nao_classificados}")

        # =========================================================================
        # VENDAS - filtrar por empresas da fabrica
        # =========================================================================
        query_vendas = f"""
            SELECT
                t.dt_transacao as dt_transacao,
                t.vl_transacao as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.cd_empresa IN ({empresa_placeholders})
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
            ORDER BY t.dt_transacao
        """

        # =========================================================================
        # DEVOLUCOES - filtrar por empresas da fabrica
        # =========================================================================
        query_devolucoes = f"""
            SELECT
                t.dt_transacao as dt_transacao,
                t.vl_transacao as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.cd_empresa IN ({empresa_placeholders})
              AND t.tp_modalidade IN ('3')
              AND t.tp_operacao = 'E'
            ORDER BY t.dt_transacao
        """

        vendas = execute_query(query_vendas, (dataInicio, dataFim, *EMPRESAS_FABRICA))
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *EMPRESAS_FABRICA))
        print(f"[DRE FABRICA] Total de vendas: {len(vendas)}")
        print(f"[DRE FABRICA] Total de devolucoes: {len(devolucoes)}")

        # Agrupar vendas por periodo
        receita_bruta = _init_valores_periodo(periodos)
        devolucoes_brutas = _init_valores_periodo(periodos)

        for v in vendas:
            valor = float(v['valor'] or 0)
            dt_transacao = v['dt_transacao']
            if not dt_transacao:
                continue
            periodo = dt_transacao.strftime('%Y-%m')
            if periodo in periodos:
                receita_bruta[periodo] += valor
                receita_bruta['total'] += valor

        for d in devolucoes:
            valor = -abs(float(d['valor'] or 0))
            dt_transacao = d['dt_transacao']
            if not dt_transacao:
                continue
            periodo = dt_transacao.strftime('%Y-%m')
            if periodo in periodos:
                devolucoes_brutas[periodo] += valor
                devolucoes_brutas['total'] += valor

        # Funcao auxiliar para merge de contas
        def _merge_conta(codigo: str, valores: dict):
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = valores
                return
            for p in periodos:
                valores_por_conta[codigo][p] = valores_por_conta[codigo].get(p, 0) + valores.get(p, 0)
            valores_por_conta[codigo]['total'] = valores_por_conta[codigo].get('total', 0) + valores.get('total', 0)

        _merge_conta('01.01.02', receita_bruta)
        _merge_conta('02.01.03', devolucoes_brutas)

        # =========================================================================
        # CMV - APENAS mv_cmv_fab (sem mv_cmv_loja_v2)
        # =========================================================================
        cmv_fab_raw = execute_query("""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_fab
            WHERE data >= %s AND data <= %s
            GROUP BY DATE_TRUNC('month', data)
        """, (dataInicio, dataFim))

        cmv_valores = _init_valores_periodo(periodos)
        for r in (cmv_fab_raw or []):
            p = r['mes'].strftime('%Y-%m')
            if p in periodos:
                v = -abs(float(r['cmv'] or 0))
                cmv_valores[p] += v
                cmv_valores['total'] += v

        _merge_conta('04.02.02', cmv_valores)
        valores_por_conta = _somar_hierarquia(valores_por_conta, periodos)
        print(f"[DRE FABRICA] CMV total: {cmv_valores['total']:.2f}")

        # Montar resposta
        response = {
            "periodos": [
                {
                    "key": p,
                    "label": services.formatar_label_periodo(p)
                }
                for p in periodos
            ],
            "valores": valores_por_conta,
            "metadata": {
                "totalDespesas": len(despesas),
                "naoClassificadas": nao_classificados,
                "totalVendasItens": len(vendas),
                "totalDevolucoesItens": len(devolucoes),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "filtroFabrica": {
                    "empresas": EMPRESAS_FABRICA,
                    "centrosCusto": CCUSTOS_FABRICA
                },
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE FABRICA gerado com sucesso.")
        return response

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE FABRICA: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar dados da DRE FABRICA: {str(e)}"
        )


@router.get("/api/dre/lojas")
def get_dre_lojas(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna dados da DRE LOJAS agrupados por conta e periodo mensal.
    Filtra apenas centros de custo e empresas que tem LOJAS no nome.
    """
    try:
        print(f"[INFO] Buscando DRE LOJAS: {dataInicio} ate {dataFim}")

        # Buscar centros de custo e empresas de lojas dinamicamente
        ccustos_lojas, nomes_ccustos = _buscar_ccustos_lojas()
        empresas_lojas, nomes_empresas = _buscar_empresas_lojas()

        if not ccustos_lojas:
            print("[DRE LOJAS] Nenhum centro de custo de lojas encontrado!")
            return {
                "periodos": [],
                "valores": {},
                "metadata": {
                    "erro": "Nenhum centro de custo com 'LOJAS' no nome encontrado",
                    "dataInicio": dataInicio,
                    "dataFim": dataFim
                }
            }

        print(f"[DRE LOJAS] Centros de custo encontrados: {ccustos_lojas}")
        print(f"[DRE LOJAS] Empresas encontradas: {empresas_lojas}")

        # Gerar periodos mensais
        periodos = services.gerar_periodos(dataInicio, dataFim)

        # Placeholders para filtros
        ccusto_placeholders = ",".join(["%s"] * len(ccustos_lojas))
        empresa_placeholders = ",".join(["%s"] * len(empresas_lojas)) if empresas_lojas else "0"

        # =========================================================================
        # DESPESAS - filtrar por centro de custo de lojas
        # =========================================================================
        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.dt_emissao as dt_emissao,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos_lojas))
        print(f"[DRE LOJAS] Total de despesas: {len(despesas)}")

        # Buscar classificacoes do banco de dados
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[DRE LOJAS] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Agrupar despesas por conta_dre e periodo
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

            # Pular despesas excluidas (ex: MERC P/ REVENDA)
            if conta == 'EXCLUIDO':
                continue

            if dt_emissao:
                periodo = dt_emissao.strftime('%Y-%m')
            else:
                continue

            if periodo not in periodos:
                continue

            if conta not in valores_por_conta:
                valores_por_conta[conta] = {'total': 0}
                for p in periodos:
                    valores_por_conta[conta][p] = 0

            valores_por_conta[conta][periodo] += valor
            valores_por_conta[conta]['total'] += valor

        print(f"[DRE LOJAS] Despesas nao classificadas: {nao_classificados}")

        # =========================================================================
        # VENDAS - filtrar por empresas de lojas
        # =========================================================================
        receita_bruta = _init_valores_periodo(periodos)
        devolucoes_brutas = _init_valores_periodo(periodos)

        if empresas_lojas:
            query_vendas = f"""
                SELECT
                    t.dt_transacao as dt_transacao,
                    t.vl_transacao as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('4')
                  AND t.tp_operacao = 'S'
                ORDER BY t.dt_transacao
            """

            query_devolucoes = f"""
                SELECT
                    t.dt_transacao as dt_transacao,
                    t.vl_transacao as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
                ORDER BY t.dt_transacao
            """

            vendas = execute_query(query_vendas, (dataInicio, dataFim, *empresas_lojas))
            devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *empresas_lojas))
            print(f"[DRE LOJAS] Total de vendas: {len(vendas)}")
            print(f"[DRE LOJAS] Total de devolucoes: {len(devolucoes)}")

            for v in vendas:
                valor = float(v['valor'] or 0)
                dt_transacao = v['dt_transacao']
                if not dt_transacao:
                    continue
                periodo = dt_transacao.strftime('%Y-%m')
                if periodo in periodos:
                    receita_bruta[periodo] += valor
                    receita_bruta['total'] += valor

            for d in devolucoes:
                valor = -abs(float(d['valor'] or 0))
                dt_transacao = d['dt_transacao']
                if not dt_transacao:
                    continue
                periodo = dt_transacao.strftime('%Y-%m')
                if periodo in periodos:
                    devolucoes_brutas[periodo] += valor
                    devolucoes_brutas['total'] += valor

        # Funcao auxiliar para merge de contas
        def _merge_conta(codigo: str, valores: dict):
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = valores
                return
            for p in periodos:
                valores_por_conta[codigo][p] = valores_por_conta[codigo].get(p, 0) + valores.get(p, 0)
            valores_por_conta[codigo]['total'] = valores_por_conta[codigo].get('total', 0) + valores.get('total', 0)

        _merge_conta('01.01.02', receita_bruta)
        _merge_conta('02.01.03', devolucoes_brutas)

        # =========================================================================
        # CMV - mv_cmv_loja_v2 para lojas
        # =========================================================================
        cmv_loja_raw = execute_query("""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_loja_v2
            WHERE data >= %s AND data <= %s
            GROUP BY DATE_TRUNC('month', data)
        """, (dataInicio, dataFim))

        cmv_valores = _init_valores_periodo(periodos)
        for r in (cmv_loja_raw or []):
            p = r['mes'].strftime('%Y-%m')
            if p in periodos:
                v = -abs(float(r['cmv'] or 0))
                cmv_valores[p] += v
                cmv_valores['total'] += v

        _merge_conta('04.02.02', cmv_valores)
        valores_por_conta = _somar_hierarquia(valores_por_conta, periodos)
        print(f"[DRE LOJAS] CMV total: {cmv_valores['total']:.2f}")

        # Montar resposta
        response = {
            "periodos": [
                {
                    "key": p,
                    "label": services.formatar_label_periodo(p)
                }
                for p in periodos
            ],
            "valores": valores_por_conta,
            "metadata": {
                "totalDespesas": len(despesas),
                "naoClassificadas": nao_classificados,
                "totalVendasItens": len(vendas) if empresas_lojas else 0,
                "totalDevolucoesItens": len(devolucoes) if empresas_lojas else 0,
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "filtroLojas": {
                    "empresas": empresas_lojas,
                    "centrosCusto": ccustos_lojas,
                    "nomesCCustos": nomes_ccustos
                },
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE LOJAS gerado com sucesso.")
        return response

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE LOJAS: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar dados da DRE LOJAS: {str(e)}"
        )


@router.get("/api/dre/lojas/duplicatas")
def get_dre_lojas_duplicatas(
    conta: str = Query(..., description="Conta DRE (ex: 08.04.02)"),
    periodo: str = Query(..., description="Periodo YYYY-MM")
):
    """
    Retorna duplicatas relacionadas a uma conta DRE das LOJAS em um periodo mensal.
    """
    try:
        import calendar

        if len(periodo) != 7 or '-' not in periodo:
            raise HTTPException(status_code=400, detail="Periodo invalido. Use YYYY-MM.")

        ano, mes = periodo.split('-')
        primeiro_dia = f"{periodo}-01"
        ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]
        data_fim = f"{periodo}-{ultimo_dia:02d}"

        # Buscar centros de custo de lojas
        ccustos_lojas, _ = _buscar_ccustos_lojas()

        if not ccustos_lojas:
            return {
                "duplicatas": [],
                "total": 0,
                "conta": conta,
                "periodo": periodo,
                "filtroLojas": True
            }

        # Carregar classificacoes do banco
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception:
            pass

        # Resolver cd_despesaitem associados a conta (APENAS do banco)
        conta_prefixo = f"{conta}."
        itens = [
            cd for cd, c in classificacoes_db.items()
            if c == conta or c.startswith(conta_prefixo)
        ]

        if not itens:
            return {
                "duplicatas": [],
                "total": 0,
                "conta": conta,
                "periodo": periodo,
                "filtroLojas": True
            }

        placeholders_itens = ','.join(['%s'] * len(itens))
        placeholders_ccusto = ','.join(['%s'] * len(ccustos_lojas))

        query = f"""
            SELECT
                d.nr_duplicata as nr_duplicata,
                i.ds_despesaitem as ds_despesaitem,
                d.dt_emissao as dt_emissao,
                d.dt_vencimento as dt_vencimento,
                ABS(d.vl_rateio) as vl_rateio,
                d.cd_despesaitem,
                d.cd_fornecedor as cd_fornecedor,
                d.cd_ccusto,
                COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_despesaitem IN ({placeholders_itens})
              AND d.cd_ccusto IN ({placeholders_ccusto})
            ORDER BY d.dt_emissao
        """

        params = [primeiro_dia, data_fim, *itens, *ccustos_lojas]
        duplicatas = execute_query(query, tuple(params))

        total = sum(float(d.get('vl_rateio') or 0) for d in duplicatas)

        return {
            "duplicatas": duplicatas,
            "total": total,
            "conta": conta,
            "periodo": periodo,
            "filtroLojas": {
                "centrosCusto": ccustos_lojas
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar duplicatas DRE LOJAS: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar duplicatas da DRE LOJAS: {str(e)}"
        )


@router.get("/api/dre/fabrica/duplicatas")
def get_dre_fabrica_duplicatas(
    conta: str = Query(..., description="Conta DRE (ex: 08.04.02)"),
    periodo: str = Query(..., description="Periodo YYYY-MM")
):
    """
    Retorna duplicatas relacionadas a uma conta DRE da FABRICA em um periodo mensal.
    Filtra apenas centros de custo da fabrica.
    """
    try:
        import calendar

        if len(periodo) != 7 or '-' not in periodo:
            raise HTTPException(status_code=400, detail="Periodo invalido. Use YYYY-MM.")

        ano, mes = periodo.split('-')
        primeiro_dia = f"{periodo}-01"
        ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]
        data_fim = f"{periodo}-{ultimo_dia:02d}"

        # Carregar classificacoes do banco
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception:
            pass

        # Resolver cd_despesaitem associados a conta (APENAS do banco)
        conta_prefixo = f"{conta}."
        itens = [
            cd for cd, c in classificacoes_db.items()
            if c == conta or c.startswith(conta_prefixo)
        ]

        if not itens:
            return {
                "duplicatas": [],
                "total": 0,
                "conta": conta,
                "periodo": periodo,
                "filtroFabrica": True
            }

        placeholders_itens = ','.join(['%s'] * len(itens))
        placeholders_ccusto = ','.join(['%s'] * len(CCUSTOS_FABRICA))
        placeholders_ccusto_excluidos = ','.join(['%s'] * len(CCUSTOS_EXCLUIDOS_FABRICA))

        # Query usando a mesma tabela do endpoint principal (vr_fcp_despduplicatai)
        # para manter consistencia e evitar duplicatas
        query = f"""
            SELECT
                d.nr_duplicata as nr_duplicata,
                i.ds_despesaitem as ds_despesaitem,
                d.dt_emissao as dt_emissao,
                d.dt_vencimento as dt_vencimento,
                ABS(d.vl_rateio) as vl_rateio,
                d.cd_despesaitem,
                d.cd_fornecedor as cd_fornecedor,
                d.cd_ccusto,
                COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_despesaitem IN ({placeholders_itens})
              AND d.cd_ccusto IN ({placeholders_ccusto})
              AND d.cd_ccusto NOT IN ({placeholders_ccusto_excluidos})
            ORDER BY d.dt_emissao
        """

        params = [primeiro_dia, data_fim, *itens, *CCUSTOS_FABRICA, *CCUSTOS_EXCLUIDOS_FABRICA]
        duplicatas = execute_query(query, tuple(params))

        total = sum(float(d.get('vl_rateio') or 0) for d in duplicatas)

        return {
            "duplicatas": duplicatas,
            "total": total,
            "conta": conta,
            "periodo": periodo,
            "filtroFabrica": {
                "centrosCusto": CCUSTOS_FABRICA
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar duplicatas DRE FABRICA: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar duplicatas da DRE FABRICA: {str(e)}"
        )


@router.get("/api/dre/fabrica/sintetico")
def get_dre_fabrica_sintetico(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna visão sintética da DRE FABRICA com métricas principais por centro de custo.
    Métricas: Receita Líquida, CMV, Despesas Operacionais, Lucro Líquido, Margem %
    """
    try:
        print(f"[INFO] Buscando DRE FABRICA Sintético: {dataInicio} até {dataFim}")

        # Buscar nomes dos centros de custo
        query_ccustos = """
            SELECT cd_ccusto, ds_ccusto
            FROM vr_gec_ccusto
        """
        ccustos_raw = execute_query(query_ccustos, ())
        nomes_ccustos = {r['cd_ccusto']: r['ds_ccusto'] for r in ccustos_raw}

        # Placeholders
        ccusto_placeholders = ",".join(["%s"] * len(CCUSTOS_FABRICA))
        ccusto_excluidos_placeholders = ",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))
        empresa_placeholders = ",".join(["%s"] * len(EMPRESAS_FABRICA))

        # Buscar vendas por empresa (Receita Bruta) - empresas da fábrica
        query_vendas = f"""
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as receita_bruta
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
              AND t.cd_empresa IN ({empresa_placeholders})
            GROUP BY t.cd_empresa
        """
        vendas = execute_query(query_vendas, (dataInicio, dataFim, *EMPRESAS_FABRICA))
        receita_total = sum(float(r['receita_bruta'] or 0) for r in vendas)

        # Buscar devoluções por empresa
        query_devolucoes = f"""
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as devolucoes
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('3')
              AND t.tp_operacao = 'E'
              AND t.cd_empresa IN ({empresa_placeholders})
            GROUP BY t.cd_empresa
        """
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *EMPRESAS_FABRICA))
        devolucoes_total = sum(float(r['devolucoes'] or 0) for r in devolucoes)

        # Buscar CMV da fábrica
        cmv_fab_raw = execute_query("""
            SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_fab
            WHERE data >= %s AND data <= %s
        """, (dataInicio, dataFim))
        cmv_total = float(cmv_fab_raw[0]['cmv'] or 0) if cmv_fab_raw else 0

        # Buscar despesas por centro de custo da fábrica
        query_despesas = f"""
            SELECT
                d.cd_ccusto,
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({ccusto_excluidos_placeholders})
        """
        despesas_raw = execute_query(query_despesas, (dataInicio, dataFim, *CCUSTOS_FABRICA, *CCUSTOS_EXCLUIDOS_FABRICA))

        # Carregar classificações do banco
        classificacoes_db = {}
        try:
            rows_cls = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows_cls or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception:
            pass

        # Somar despesas operacionais (08.xx) por centro de custo
        despesas_por_ccusto = {}
        for d in despesas_raw:
            conta = _classificar_conta_dre(
                d['cd_despesaitem'], d.get('descricao_despesa'),
                classificacoes_db
            )
            # Só contar como despesa operacional contas 08.xx
            if not conta.startswith('08.'):
                continue
            cd_ccusto = d['cd_ccusto']
            despesas_por_ccusto[cd_ccusto] = despesas_por_ccusto.get(cd_ccusto, 0) + float(d['valor'] or 0)

        # Calcular totais
        despesas_op_total = sum(despesas_por_ccusto.values())
        receita_liquida = receita_total - devolucoes_total
        lucro_bruto = receita_liquida - cmv_total
        lucro_liquido = lucro_bruto - despesas_op_total
        margem = (lucro_liquido / receita_liquida * 100) if receita_liquida > 0 else 0

        # Montar resultado por centro de custo
        resultados = []
        for cd_ccusto in sorted(despesas_por_ccusto.keys()):
            desp = despesas_por_ccusto.get(cd_ccusto, 0)
            resultados.append({
                "cd_ccusto": cd_ccusto,
                "nome": nomes_ccustos.get(cd_ccusto, f"Centro de Custo {cd_ccusto}"),
                "despesas_operacionais": desp
            })

        totais = {
            "receita_bruta": receita_total,
            "devolucoes": devolucoes_total,
            "receita_liquida": receita_liquida,
            "cmv": cmv_total,
            "lucro_bruto": lucro_bruto,
            "despesas_operacionais": despesas_op_total,
            "lucro_liquido": lucro_liquido,
            "margem_percentual": round(margem, 2)
        }

        response = {
            "centros_custo": resultados,
            "totais": totais,
            "metadata": {
                "totalCentrosCusto": len(resultados),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "filtroFabrica": {
                    "empresas": EMPRESAS_FABRICA,
                    "centrosCusto": CCUSTOS_FABRICA
                },
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE FABRICA Sintético gerado com {len(resultados)} centros de custo.")
        return response

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE FABRICA Sintético: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar DRE FABRICA sintético: {str(e)}"
        )


@router.get("/api/dre/fabrica/por-ccusto")
def get_dre_fabrica_por_ccusto(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna dados da DRE FABRICA agrupados por centro de custo.
    Cada coluna representa um centro de custo diferente.
    """
    try:
        print(f"[INFO] Buscando DRE FABRICA por Centro de Custo: {dataInicio} até {dataFim}")

        periodos = services.gerar_periodos(dataInicio, dataFim)

        # Buscar nomes dos centros de custo
        query_ccustos = """
            SELECT cd_ccusto, ds_ccusto
            FROM vr_gec_ccusto
        """
        ccustos_raw = execute_query(query_ccustos, ())
        nomes_ccustos = {r['cd_ccusto']: r['ds_ccusto'] for r in ccustos_raw}

        # Placeholders
        ccusto_placeholders = ",".join(["%s"] * len(CCUSTOS_FABRICA))
        ccusto_excluidos_placeholders = ",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))
        empresa_placeholders = ",".join(["%s"] * len(EMPRESAS_FABRICA))

        # Buscar despesas agrupadas por centro de custo
        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.cd_ccusto,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({ccusto_excluidos_placeholders})
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *CCUSTOS_FABRICA, *CCUSTOS_EXCLUIDOS_FABRICA))
        print(f"[DRE-FAB-CCUSTO] Total de despesas: {len(despesas)}")

        # Buscar classificações do banco
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[DRE-FAB-CCUSTO] Aviso: não foi possível carregar classificações: {e}")

        # Agrupar despesas por conta_dre e centro de custo
        valores_por_conta = {}
        ccustos_encontrados = set()

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
            valor = -abs(float(d['valor'] or 0))
            cd_ccusto = d['cd_ccusto']

            if conta in ('NAO_CLASSIFICADO', 'EXCLUIDO'):
                continue

            ccustos_encontrados.add(cd_ccusto)

            if conta not in valores_por_conta:
                valores_por_conta[conta] = {'total': 0}

            ccusto_key = str(cd_ccusto)
            if ccusto_key not in valores_por_conta[conta]:
                valores_por_conta[conta][ccusto_key] = 0

            valores_por_conta[conta][ccusto_key] += valor
            valores_por_conta[conta]['total'] += valor

        # Buscar vendas por empresa (receita total da fábrica)
        query_vendas = f"""
            SELECT SUM(t.vl_transacao) as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
              AND t.cd_empresa IN ({empresa_placeholders})
        """

        query_devolucoes = f"""
            SELECT SUM(t.vl_transacao) as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('3')
              AND t.tp_operacao = 'E'
              AND t.cd_empresa IN ({empresa_placeholders})
        """

        vendas = execute_query(query_vendas, (dataInicio, dataFim, *EMPRESAS_FABRICA))
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *EMPRESAS_FABRICA))

        receita_bruta = float(vendas[0]['valor'] or 0) if vendas and vendas[0]['valor'] else 0
        devolucoes_valor = float(devolucoes[0]['valor'] or 0) if devolucoes and devolucoes[0]['valor'] else 0

        # Receita e devoluções vão no total (não por ccusto)
        valores_por_conta['01.01.02'] = {'total': receita_bruta}
        valores_por_conta['02.01.03'] = {'total': -abs(devolucoes_valor)}

        # CMV da fábrica (total)
        cmv_fab_raw = execute_query("""
            SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_fab
            WHERE data >= %s AND data <= %s
        """, (dataInicio, dataFim))

        cmv_total = float(cmv_fab_raw[0]['cmv'] or 0) if cmv_fab_raw else 0
        valores_por_conta['04.02.02'] = {'total': -abs(cmv_total)}

        # Somar hierarquia para cada centro de custo
        ccustos_list = sorted(ccustos_encontrados)
        for codigo, valores in list(valores_por_conta.items()):
            if codigo in ('NAO_CLASSIFICADO', 'EXCLUIDO'):
                continue
            partes = codigo.split('.')
            if len(partes) <= 1:
                continue
            for nivel in range(1, len(partes)):
                codigo_pai = '.'.join(partes[:nivel])
                if codigo_pai not in valores_por_conta:
                    valores_por_conta[codigo_pai] = {'total': 0}
                for ccusto in ccustos_list:
                    ccusto_key = str(ccusto)
                    if ccusto_key not in valores_por_conta[codigo_pai]:
                        valores_por_conta[codigo_pai][ccusto_key] = 0
                    valores_por_conta[codigo_pai][ccusto_key] += valores.get(ccusto_key, 0)
                valores_por_conta[codigo_pai]['total'] += valores.get('total', 0)

        # Montar lista de centros de custo com nomes
        ccustos_info = []
        for cd_ccusto in ccustos_list:
            ccustos_info.append({
                "cd_ccusto": cd_ccusto,
                "nome": nomes_ccustos.get(cd_ccusto, f"Centro de Custo {cd_ccusto}")
            })

        response = {
            "centros_custo": ccustos_info,
            "valores": valores_por_conta,
            "metadata": {
                "totalCentrosCusto": len(ccustos_list),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "filtroFabrica": {
                    "empresas": EMPRESAS_FABRICA,
                    "centrosCusto": CCUSTOS_FABRICA
                },
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE FABRICA por Centro de Custo gerado com {len(ccustos_list)} centros.")
        return response

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE FABRICA por Centro de Custo: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar DRE FABRICA por centro de custo: {str(e)}"
        )


@router.get("/api/planejado")
def get_planejado(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    conta: Optional[str] = Query(None, description="Conta DRE (ex: 03)"),
    grupo: Optional[str] = Query(None, description="Grupo (ex: Lojas)")
):
    """
    Retorna valores planejados agregados por mês.
    """
    try:
        periodos = services.gerar_periodos(dataInicio, dataFim)

        where = "data >= %s AND data <= %s"
        params = [dataInicio, dataFim]

        if conta:
            where += " AND conta_dre = %s"
            params.append(conta)

        if grupo:
            where += " AND grupo = %s"
            params.append(grupo)

        query = f"""
            SELECT
                date_trunc('month', data) as mes,
                conta_dre,
                grupo,
                SUM(valor) as valor
            FROM planejado_dre
            WHERE {where}
            GROUP BY 1, 2, 3
            ORDER BY 1, 2, 3
        """

        rows = execute_query(query, tuple(params))

        valores = {}
        for r in rows:
            conta_dre = r['conta_dre']
            mes = r['mes']
            valor = float(r['valor'] or 0)

            if conta_dre not in valores:
                valores[conta_dre] = {'total': 0}
                for p in periodos:
                    valores[conta_dre][p] = 0

            if mes:
                periodo = mes.strftime('%Y-%m')
                if periodo in periodos:
                    valores[conta_dre][periodo] += valor
                    valores[conta_dre]['total'] += valor

        return {
            "periodos": [
                {
                    "key": p,
                    "label": services.formatar_label_periodo(p)
                }
                for p in periodos
            ],
            "valores": valores,
            "metadata": {
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "conta": conta,
                "grupo": grupo,
                "dataConsulta": datetime.now().isoformat()
            }
        }

    except Exception as e:
        print(f"[ERROR] Erro ao buscar dados planejados: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar dados planejados: {str(e)}"
        )


@router.get("/api/dre/totais")
def get_dre_totais(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    empresas: Optional[str] = Query(None, description="IDs de empresa separados por vírgula")
):
    """
    Retorna totais agregados por grupo de despesa para cálculo do Lucro Líquido.
    Agrupa as contas DRE por prefixo (08.01, 08.02, ..., 10.03, 13.01) e soma os valores.
    """
    try:
        periodos = services.gerar_periodos(dataInicio, dataFim)

        # Buscar despesas por DATA DE EMISSÃO direto da tabela
        # EXCLUINDO empresas específicas (CORPO SEXY, CAIRO BENEVIDES, CB EMPREENDIMENTOS)
        exclusao_totais_placeholders = ",".join(["%s"] * len(EMPRESAS_EXCLUIDAS))
        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.dt_emissao as dt_emissao,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_empresa NOT IN ({exclusao_totais_placeholders})
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))

        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception:
            pass

        GRUPOS = {
            "08.01": "Ocupação",
            "08.02": "Administrativas",
            "08.03": "Manutenção",
            "08.04": "Pessoal",
            "08.05": "Marketing",
            "08.10": "Vendas",
            "08.11": "Crédito e Cobrança",
            "08.12": "Veículos",
            "10.03": "Financeiras",
            "13.01": "Tributárias (IRPJ + CSLL)",
        }

        GRUPOS_OPERACIONAIS = {"08.01","08.02","08.03","08.04","08.05","08.10","08.11","08.12"}
        GRUPOS_FINANCEIRAS  = {"10.03"}
        GRUPOS_TRIBUTARIAS  = {"13.01"}

        def _novo_grupo(label):
            g = {"label": label, "total": 0}
            for p in periodos:
                g[p] = 0
            return g

        totais = {k: _novo_grupo(v) for k, v in GRUPOS.items()}

        for d in despesas:
            cd = d["cd_despesaitem"]
            conta = _classificar_conta_dre(cd, d.get("descricao_despesa"), classificacoes_db)
            if not conta:
                continue
            grupo = ".".join(conta.split(".")[:2])
            if grupo not in totais:
                continue
            valor = float(d["valor"] or 0)
            dt = d["dt_emissao"]
            if not dt:
                continue
            periodo = dt.strftime("%Y-%m")
            if periodo not in periodos:
                continue
            totais[grupo]["total"] += valor
            totais[grupo][periodo] += valor

        def _subtotal(keys):
            sub = {"total": 0}
            for p in periodos:
                sub[p] = 0
            for k in keys:
                if k in totais:
                    sub["total"] += totais[k]["total"]
                    for p in periodos:
                        sub[p] += totais[k].get(p, 0)
            return sub

        subtotal_operacional = _subtotal(GRUPOS_OPERACIONAIS)
        subtotal_financeiras = _subtotal(GRUPOS_FINANCEIRAS)
        subtotal_tributarias = _subtotal(GRUPOS_TRIBUTARIAS)

        total_abatimentos = {"total": 0}
        for p in periodos:
            total_abatimentos[p] = 0
        for p in periodos:
            total_abatimentos[p] = (
                subtotal_operacional.get(p, 0) +
                subtotal_financeiras.get(p, 0) +
                subtotal_tributarias.get(p, 0)
            )
        total_abatimentos["total"] = (
            subtotal_operacional["total"] +
            subtotal_financeiras["total"] +
            subtotal_tributarias["total"]
        )

        return {
            "periodos": [{"key": p, "label": services.formatar_label_periodo(p)} for p in periodos],
            "despesas_operacionais": {
                **{k: totais[k] for k in GRUPOS_OPERACIONAIS},
                "subtotal": subtotal_operacional,
            },
            "despesas_financeiras": {
                **{k: totais[k] for k in GRUPOS_FINANCEIRAS},
                "subtotal": subtotal_financeiras,
            },
            "tributarias": {
                **{k: totais[k] for k in GRUPOS_TRIBUTARIAS},
                "subtotal": subtotal_tributarias,
            },
            "total_abatimentos": total_abatimentos,
            "metadata": {
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat(),
            },
        }

    except Exception as e:
        print(f"[ERROR] /api/dre/totais: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular totais DRE: {str(e)}")


@router.get("/api/dre/duplicatas")
def get_dre_duplicatas(
    conta: str = Query(..., description="Conta DRE (ex: 08.02.05)"),
    periodo: str = Query(..., description="Período YYYY-MM")
):
    """
    Retorna duplicatas relacionadas a uma conta DRE em um período mensal.
    Usa classificações do banco de dados.
    """
    try:
        import calendar

        if len(periodo) != 7 or '-' not in periodo:
            raise HTTPException(status_code=400, detail="Período inválido. Use YYYY-MM.")

        ano, mes = periodo.split('-')
        primeiro_dia = f"{periodo}-01"
        ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]
        data_fim = f"{periodo}-{ultimo_dia:02d}"

        # Carregar classificações do banco
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception:
            pass

        # Resolver cd_despesaitem associados à conta (APENAS do banco)
        conta_prefixo = f"{conta}."
        itens = [
            cd for cd, c in classificacoes_db.items()
            if c == conta or c.startswith(conta_prefixo)
        ]

        if not itens:
            return {
                "duplicatas": [],
                "total": 0,
                "conta": conta,
                "periodo": periodo
            }

        placeholders = ','.join(['%s'] * len(itens))
        query_emissao = f"""
            SELECT
                faturaduplicata as nr_duplicata,
                descricao_despesa as ds_despesaitem,
                dt_emissao as dt_emissao,
                ABS(valor) as vl_rateio,
                cd_despesaitem,
                idfornecedorcliente as cd_fornecedor,
                origem_tabela,
                tipo_documento,
                COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
            FROM vw_fluxo_pagamentos
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = idfornecedorcliente
            WHERE dt_emissao >= %s
              AND dt_emissao <= %s
              AND cd_despesaitem IN ({placeholders})
            ORDER BY dt_emissao
        """

        query_fallback = f"""
            SELECT
                faturaduplicata as nr_duplicata,
                descricao_despesa as ds_despesaitem,
                dtvencimento as dt_emissao,
                ABS(valor) as vl_rateio,
                cd_despesaitem,
                idfornecedorcliente as cd_fornecedor,
                origem_tabela,
                tipo_documento,
                COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
            FROM vw_fluxo_pagamentos
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = idfornecedorcliente
            WHERE dtvencimento >= %s
              AND dtvencimento <= %s
              AND cd_despesaitem IN ({placeholders})
            ORDER BY dtvencimento
        """

        params = [primeiro_dia, data_fim, *itens]
        duplicatas = _execute_query_with_date_fallback(
            execute_query,
            query_emissao,
            query_fallback,
            tuple(params),
            "vw_fluxo_pagamentos"
        )

        total = sum(float(d.get('vl_rateio') or 0) for d in duplicatas)

        return {
            "duplicatas": duplicatas,
            "total": total,
            "conta": conta,
            "periodo": periodo
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar duplicatas DRE: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar duplicatas da DRE: {str(e)}"
        )


@router.get("/api/dre/por-empresa")
def get_dre_por_empresa(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna dados da DRE agrupados por empresa.
    Baseado na mesma lógica da DRE analítica, apenas trocando período por empresa.
    """
    try:
        print(f"[INFO] Buscando DRE por Empresa: {dataInicio} até {dataFim}")

        # Inclui: fábrica, lojas, ecommerce (49) e diretoria (515)
        ccustos_dre = CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys()) + CCUSTOS_ECOMMERCE + [515]
        empresas_dre = sorted({e for e in ([1] + list(CCUSTOS_LOJAS.keys())) if e not in EMPRESAS_EXCLUIDAS})

        def _init_valores_empresa():
            valores = {'total': 0}
            for emp in empresas_dre:
                valores[str(emp)] = 0
            return valores

        def _somar_valor_empresa(codigo: str, cd_emp: int, valor: float):
            if cd_emp not in empresas_dre:
                return
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = _init_valores_empresa()
            valores_por_conta[codigo][str(cd_emp)] += valor

        def _merge_valores_empresa(codigo: str, valores: dict):
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = _init_valores_empresa()
            for emp in empresas_dre:
                emp_key = str(emp)
                valores_por_conta[codigo][emp_key] += valores.get(emp_key, 0)

        def _recalcular_totais():
            for valores in valores_por_conta.values():
                valores['total'] = sum(valores.get(str(emp), 0) for emp in empresas_dre)

        # Buscar nomes das empresas e ccustos
        query_empresas = """
            SELECT e.cd_empresa, COALESCE(p.nm_fantasia, p.nm_pessoa, 'Empresa ' || e.cd_empresa::text) AS nome
            FROM vr_ger_empresa e
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = e.cd_pessoa
        """
        empresas_raw = execute_query(query_empresas, ())
        nomes_empresas = {r['cd_empresa']: r['nome'] for r in empresas_raw}

        query_ccustos = """
            SELECT cd_ccusto, COALESCE(ds_ccusto, 'Centro de Custo ' || cd_ccusto::text) AS nome
            FROM vr_gec_ccusto
        """
        ccustos_raw = execute_query(query_ccustos, ())
        nomes_ccustos = {r['cd_ccusto']: r['nome'] for r in ccustos_raw}

        # =====================================================================
        # DESPESAS - filtro por cd_ccusto (centros de custo válidos)
        # =====================================================================
        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.cd_ccusto,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({",".join(["%s"] * len(ccustos_dre))})
              AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
        """
        despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos_dre, *CCUSTOS_EXCLUIDOS_FABRICA))
        print(f"[DRE-EMP] Total de despesas: {len(despesas)}")

        # Buscar classificações do banco
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[DRE-EMP] Aviso: não foi possível carregar classificações: {e}")

        # Agrupar despesas por conta_dre e empresa
        valores_por_conta = {}

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
            valor = -abs(float(d['valor'] or 0))

            # Pular despesas excluidas (ex: MERC P/ REVENDA)
            if conta == 'EXCLUIDO':
                continue

            cd_ccusto = d['cd_ccusto']
            if cd_ccusto is None:
                continue
            cd_emp = _agrupar_ccusto_dre_por_empresa(int(cd_ccusto))
            _somar_valor_empresa(conta, cd_emp, valor)

        # =====================================================================
        # VENDAS E DEVOLUÇÕES - Mesma query da analítica
        # =====================================================================
        exclusao_vendas_placeholders = ",".join(["%s"] * len(EMPRESAS_EXCLUIDAS))

        query_vendas = f"""
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
              AND t.cd_empresa NOT IN ({exclusao_vendas_placeholders})
            GROUP BY t.cd_empresa
        """

        query_devolucoes = f"""
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('3')
              AND t.tp_operacao = 'E'
              AND t.cd_empresa NOT IN ({exclusao_vendas_placeholders})
            GROUP BY t.cd_empresa
        """

        vendas = execute_query(query_vendas, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))

        # Receita bruta por empresa
        receita_bruta = _init_valores_empresa()
        for v in vendas:
            cd_emp = int(v['cd_empresa'])
            if cd_emp not in empresas_dre:
                continue
            valor = float(v['valor'] or 0)
            emp_key = str(cd_emp)
            receita_bruta[emp_key] = receita_bruta.get(emp_key, 0) + valor
        _merge_valores_empresa('01.01.02', receita_bruta)

        # Devoluções por empresa
        devolucoes_brutas = _init_valores_empresa()
        for d in devolucoes:
            cd_emp = int(d['cd_empresa'])
            if cd_emp not in empresas_dre:
                continue
            valor = -abs(float(d['valor'] or 0))
            emp_key = str(cd_emp)
            devolucoes_brutas[emp_key] = devolucoes_brutas.get(emp_key, 0) + valor
        _merge_valores_empresa('02.01.03', devolucoes_brutas)

        # =====================================================================
        # CMV - Mesma lógica da analítica
        # =====================================================================
        cmv_valores = _init_valores_empresa()

        # CMV loja por empresa
        cmv_loja_raw = execute_query("""
            SELECT
                idcentrodecusto AS cd_empresa,
                DATE_TRUNC('month', data) AS mes,
                ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja_v2
            WHERE data >= %s AND data <= %s
            GROUP BY idcentrodecusto, DATE_TRUNC('month', data)
        """, (dataInicio, dataFim))

        for r in (cmv_loja_raw or []):
            cd_emp = int(r['cd_empresa'])
            if cd_emp not in empresas_dre:
                continue
            v = -abs(float(r['cmv'] or 0))
            emp_key = str(cd_emp)
            cmv_valores[emp_key] = cmv_valores.get(emp_key, 0) + v

        # CMV fábrica vai para empresa 1
        try:
            cmv_fab_raw = execute_query("""
                SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv
                FROM mv_cmv_fab
                WHERE data >= %s AND data <= %s
            """, (dataInicio, dataFim))
            cmv_fabrica = float(cmv_fab_raw[0]['cmv'] if cmv_fab_raw else 0)
            if cmv_fabrica:
                cmv_valores['1'] = cmv_valores.get('1', 0) - abs(cmv_fabrica)
        except Exception as e:
            print(f"[DRE-EMP] Erro ao buscar CMV fabrica: {e}")

        _merge_valores_empresa('04.02.02', cmv_valores)

        # =====================================================================
        # SOMAR HIERARQUIA - Mesma lógica da _somar_hierarquia
        # =====================================================================
        pais = {}

        for codigo, valores in valores_por_conta.items():
            if codigo in ('NAO_CLASSIFICADO', 'EXCLUIDO'):
                continue

            partes = codigo.split('.')
            if len(partes) <= 1:
                continue

            for nivel in range(1, len(partes)):
                codigo_pai = '.'.join(partes[:nivel])
                if codigo_pai not in pais:
                    pais[codigo_pai] = _init_valores_empresa()

                # Somar para cada empresa
                for emp in empresas_dre:
                    emp_key = str(emp)
                    pais[codigo_pai][emp_key] += valores.get(emp_key, 0)

        # Adicionar pais ao valores_por_conta
        for codigo_pai, valores_pai in pais.items():
            valores_por_conta[codigo_pai] = valores_pai

        _recalcular_totais()

        # Calcular contas totalizadoras (03, 05, 07, 09, 11, 14)
        def criar_conta_totalizada(componentes):
            valores = _init_valores_empresa()
            for emp in empresas_dre:
                emp_key = str(emp)
                valores[emp_key] = sum(valores_por_conta.get(c, {}).get(emp_key, 0) for c in componentes)
            valores['total'] = sum(valores_por_conta.get(c, {}).get('total', 0) for c in componentes)
            return valores

        valores_por_conta['03'] = criar_conta_totalizada(['01', '02'])  # Receita Líquida
        valores_por_conta['05'] = criar_conta_totalizada(['03', '04'])  # Margem Contribuição
        valores_por_conta['07'] = criar_conta_totalizada(['05', '06'])  # Lucro Operacional Bruto
        valores_por_conta['09'] = criar_conta_totalizada(['07', '08'])  # EBITDA
        valores_por_conta['11'] = criar_conta_totalizada(['09', '10'])  # Lucro Bruto
        valores_por_conta['14'] = criar_conta_totalizada(['11', '13'])  # Lucro Líquido

        # Montar lista de empresas com nomes
        empresas_info = []
        for cd_emp in empresas_dre:
            empresas_info.append({
                "cd_empresa": cd_emp,
                "nome": nomes_ccustos.get(cd_emp) or nomes_empresas.get(cd_emp, f"Empresa {cd_emp}")
            })

        response = {
            "empresas": empresas_info,
            "valores": valores_por_conta,
            "metadata": {
                "totalEmpresas": len(empresas_dre),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE por Empresa gerado com {len(empresas_dre)} empresas.")
        return response

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE por Empresa: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar DRE por empresa: {str(e)}"
        )


@router.get("/api/dre/sintetico")
def get_dre_sintetico(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    lojas: Optional[str] = Query(None, description="Codigos das lojas separados por virgula (ex: 2,3,4)")
):
    """
    Retorna visão sintética da DRE com métricas principais por empresa.
    Métricas: Receita Líquida, CMV, Despesas Operacionais, Lucro Líquido, Margem %
    """
    try:
        print(f"[INFO] Buscando DRE Sintético: {dataInicio} até {dataFim}, lojas={lojas}")

        data_fim_exclusivo = (datetime.strptime(dataFim, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

        lojas_ids = None
        if lojas:
            try:
                lojas_ids = [int(loja.strip()) for loja in lojas.split(",") if loja.strip()]
            except ValueError:
                raise HTTPException(status_code=400, detail="Parametro 'lojas' invalido. Use IDs separados por virgula.")

            lojas_ids = [loja for loja in lojas_ids if loja in CCUSTOS_LOJAS and loja not in EMPRESAS_EXCLUIDAS]
            if not lojas_ids:
                raise HTTPException(status_code=400, detail="Nenhuma loja valida selecionada.")

        # Buscar nomes das empresas
        query_empresas = """
            SELECT e.cd_empresa, COALESCE(p.nm_fantasia, p.nm_pessoa, 'Empresa ' || e.cd_empresa::text) AS nome
            FROM vr_ger_empresa e
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = e.cd_pessoa
        """
        empresas_raw = execute_query(query_empresas, ())
        nomes_empresas = {r['cd_empresa']: r['nome'] for r in empresas_raw}

        # EXCLUINDO empresas específicas (CORPO SEXY, CAIRO BENEVIDES, CB EMPREENDIMENTOS)
        exclusao_sint_placeholders = ",".join(["%s"] * len(EMPRESAS_EXCLUIDAS))

        # Buscar vendas por empresa (Receita Bruta)
        query_vendas = f"""
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as receita_bruta
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao < %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
              AND t.cd_empresa NOT IN ({exclusao_sint_placeholders})
              {"AND t.cd_empresa IN (" + ",".join(["%s"] * len(lojas_ids)) + ")" if lojas_ids else ""}
            GROUP BY t.cd_empresa
        """
        vendas = execute_query(query_vendas, (dataInicio, data_fim_exclusivo, *EMPRESAS_EXCLUIDAS, *(lojas_ids or [])))
        receita_por_empresa = {r['cd_empresa']: float(r['receita_bruta'] or 0) for r in vendas}

        # Buscar devoluções por empresa
        query_devolucoes = f"""
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as devolucoes
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao < %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('3')
              AND t.tp_operacao = 'E'
              AND t.cd_empresa NOT IN ({exclusao_sint_placeholders})
              {"AND t.cd_empresa IN (" + ",".join(["%s"] * len(lojas_ids)) + ")" if lojas_ids else ""}
            GROUP BY t.cd_empresa
        """
        devolucoes = execute_query(query_devolucoes, (dataInicio, data_fim_exclusivo, *EMPRESAS_EXCLUIDAS, *(lojas_ids or [])))
        devolucoes_por_empresa = {r['cd_empresa']: float(r['devolucoes'] or 0) for r in devolucoes}

        # Buscar CMV por empresa (lojas) - filtrado por lojas ativas para bater com DRE Unificada
        # Exclui lojas encerradas (9, 11, 12, 13, 16, 18)
        # CORRIGIDO: Agrupar por mes primeiro, aplicar ABS a cada mes, depois somar
        # Isso garante que valores positivos e negativos em meses diferentes sejam tratados corretamente
        ccustos_lojas_cmv = lojas_ids or CCUSTOS_LOJAS_ATIVOS
        ccustos_lojas_placeholders = ",".join(["%s"] * len(ccustos_lojas_cmv))
        cmv_loja_raw = execute_query(f"""
            SELECT idcentrodecusto AS cd_empresa, DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv_mes
            FROM mv_cmv_loja_v2
            WHERE data >= %s AND data < %s
              AND idcentrodecusto IN ({ccustos_lojas_placeholders})
            GROUP BY idcentrodecusto, DATE_TRUNC('month', data)
        """, (dataInicio, data_fim_exclusivo, *ccustos_lojas_cmv))
        # Somar CMV por empresa (somando todos os meses)
        cmv_por_empresa = {}
        for r in cmv_loja_raw:
            emp = r['cd_empresa']
            cmv_mes = float(r['cmv_mes'] or 0)
            cmv_por_empresa[emp] = cmv_por_empresa.get(emp, 0) + cmv_mes

        if not lojas_ids:
            # Buscar CMV fábrica - CORRIGIDO: agrupar por mes primeiro
            cmv_fab_raw = execute_query("""
                SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv_mes
                FROM mv_cmv_fab
                WHERE data >= %s AND data < %s
                GROUP BY DATE_TRUNC('month', data)
            """, (dataInicio, data_fim_exclusivo))
            # Adicionar CMV fábrica ao centro de custo 1 (FABRICA) - somando todos os meses
            cmv_fab_total = sum(float(r['cmv_mes'] or 0) for r in cmv_fab_raw)
            if cmv_fab_total > 0:
                cmv_por_empresa[1] = cmv_por_empresa.get(1, 0) + cmv_fab_total

        # Buscar despesas por empresa — com cd_despesaitem para classificar
        filtro_lojas_despesas = ""
        params_lojas_despesas = []
        campo_empresa_despesas = "d.cd_empresa"
        if lojas_ids:
            filtro_lojas_despesas = "AND d.cd_ccusto IN (" + ",".join(["%s"] * len(lojas_ids)) + ")"
            params_lojas_despesas = lojas_ids
            campo_empresa_despesas = "d.cd_ccusto"

        query_despesas = f"""
            SELECT
                {campo_empresa_despesas} AS cd_empresa,
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao < %s
              AND d.tp_situacao = 'N'
              AND d.cd_empresa NOT IN ({exclusao_sint_placeholders})
              {filtro_lojas_despesas}
        """
        despesas_raw = execute_query(query_despesas, (dataInicio, data_fim_exclusivo, *EMPRESAS_EXCLUIDAS, *params_lojas_despesas))

        # Carregar classificações do banco (mesma lógica da DRE analítica)
        classificacoes_db = {}
        try:
            rows_cls = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows_cls or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception:
            pass

        # Somar despesas por categoria para cada empresa
        despesas_por_empresa = {}        # 08.xx - Despesas Operacionais
        custos_fixos_por_empresa = {}    # 06.xx - Custos Fixos
        outras_despesas_por_empresa = {} # 10, 12, 13 - Resultados, Depreciação, Tributárias

        for d in despesas_raw:
            conta = _classificar_conta_dre(
                d['cd_despesaitem'], d.get('descricao_despesa'),
                classificacoes_db
            )
            cd_emp = d['cd_empresa']
            valor = float(d['valor'] or 0)

            if conta.startswith('08.'):
                # Despesas Operacionais
                despesas_por_empresa[cd_emp] = despesas_por_empresa.get(cd_emp, 0) + valor
            elif conta.startswith('06.'):
                # Custos Fixos (Gastos Gerais de Fabricação)
                custos_fixos_por_empresa[cd_emp] = custos_fixos_por_empresa.get(cd_emp, 0) + valor
            elif conta.startswith('10.') or conta.startswith('12.') or conta.startswith('13.'):
                # Outras despesas (Resultados, Depreciação, Tributárias)
                outras_despesas_por_empresa[cd_emp] = outras_despesas_por_empresa.get(cd_emp, 0) + valor

        # Consolidar empresas (incluindo todas com qualquer tipo de custo)
        todas_empresas = (
            set(receita_por_empresa.keys()) |
            set(cmv_por_empresa.keys()) |
            set(despesas_por_empresa.keys()) |
            set(custos_fixos_por_empresa.keys()) |
            set(outras_despesas_por_empresa.keys())
        )

        resultados = []
        totais = {
            "receita_bruta": 0,
            "devolucoes": 0,
            "receita_liquida": 0,
            "cmv": 0,
            "custos_fixos": 0,
            "lucro_bruto": 0,
            "despesas_operacionais": 0,
            "outras_despesas": 0,
            "lucro_liquido": 0
        }

        for cd_emp in sorted(todas_empresas):
            receita_bruta = receita_por_empresa.get(cd_emp, 0)
            devolucoes_val = devolucoes_por_empresa.get(cd_emp, 0)
            receita_liquida = receita_bruta - devolucoes_val
            cmv = cmv_por_empresa.get(cd_emp, 0)
            custos_fixos = custos_fixos_por_empresa.get(cd_emp, 0)
            # Lucro bruto = Receita Líquida - CMV - Custos Fixos
            lucro_bruto = receita_liquida - cmv - custos_fixos
            despesas_op = despesas_por_empresa.get(cd_emp, 0)
            outras_desp = outras_despesas_por_empresa.get(cd_emp, 0)
            # Lucro líquido = Lucro Bruto - Despesas Operacionais - Outras Despesas
            lucro_liquido = lucro_bruto - despesas_op - outras_desp
            margem = (lucro_liquido / receita_liquida * 100) if receita_liquida > 0 else 0

            resultados.append({
                "cd_empresa": cd_emp,
                "nome": CCUSTOS_LOJAS.get(cd_emp) or nomes_empresas.get(cd_emp, f"Empresa {cd_emp}"),
                "receita_bruta": receita_bruta,
                "devolucoes": devolucoes_val,
                "receita_liquida": receita_liquida,
                "cmv": cmv,
                "custos_fixos": custos_fixos,
                "lucro_bruto": lucro_bruto,
                "despesas_operacionais": despesas_op,
                "outras_despesas": outras_desp,
                "lucro_liquido": lucro_liquido,
                "margem_percentual": round(margem, 2)
            })

            totais["receita_bruta"] += receita_bruta
            totais["devolucoes"] += devolucoes_val
            totais["receita_liquida"] += receita_liquida
            totais["cmv"] += cmv
            totais["custos_fixos"] += custos_fixos
            totais["lucro_bruto"] += lucro_bruto
            totais["despesas_operacionais"] += despesas_op
            totais["outras_despesas"] += outras_desp
            totais["lucro_liquido"] += lucro_liquido

        totais["margem_percentual"] = round(
            (totais["lucro_liquido"] / totais["receita_liquida"] * 100) if totais["receita_liquida"] > 0 else 0,
            2
        )

        response = {
            "empresas": resultados,
            "totais": totais,
            "metadata": {
                "totalEmpresas": len(resultados),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "lojasSelecionadas": lojas_ids or [],
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE Sintético gerado com {len(resultados)} empresas.")
        return response

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE Sintético: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar DRE sintético: {str(e)}"
        )


# ============================================================================
# CENTROS DE CUSTO - LISTA PARA DROPDOWN
# ============================================================================
# Mapeamento fixo dos centros de custo das lojas
# Lojas encerradas removidas: 9, 11, 12, 13, 16, 18
CCUSTOS_LOJAS = {
    2: "MARAPONGA",
    3: "IGUATEMI",
    4: "TABOSA",
    5: "NORTH",
    6: "DOM LUIS",
    7: "PARANGABA",
    8: "RIO MAR",
    10: "BARRA SHOPPING - RJ",
    14: "SALVADOR SHOPPING - BA",
    15: "MORUMBI SHOPPING",
    17: "RIO MAR RECIFE",
    19: "NORTH JOQUEI",
    20: "PORTO ALEGRE",
    21: "RIOMAR KENNEDY",
    22: "INTIMATES",
    120: "ECOMMERCE ANGELICA",
}


@router.get("/api/dre/centros-custo")
def get_centros_custo():
    """
    Retorna lista de centros de custo para popular dropdown do filtro DRE.
    Inclui: CONSOLIDADO, FABRICA, e todas as lojas individuais.
    """
    try:
        opcoes = [
            {"valor": "consolidado", "label": "CONSOLIDADO (TODAS)", "tipo": "todos"},
            {"valor": "fabrica", "label": "FABRICA", "tipo": "fabrica"},
        ]

        # Adicionar lojas ordenadas por código
        for cd_ccusto in sorted(CCUSTOS_LOJAS.keys()):
            nome = CCUSTOS_LOJAS[cd_ccusto]
            opcoes.append({
                "valor": str(cd_ccusto),
                "label": nome,
                "tipo": "loja"
            })

        return {
            "opcoes": opcoes,
            "metadata": {
                "totalOpcoes": len(opcoes),
                "fabricaCCustos": CCUSTOS_FABRICA,
                "lojasCCustos": list(CCUSTOS_LOJAS.keys())
            }
        }
    except Exception as e:
        print(f"[ERROR] Erro ao listar centros de custo: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/dre/unificada")
def get_dre_unificada(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    filtro: str = Query("consolidado", description="Filtro: 'consolidado', 'fabrica', ou codigo do centro de custo")
):
    """
    DRE Unificada com filtro flexível.

    Filtros:
    - consolidado: Todos os centros de custo (fabrica + lojas)
    - fabrica: Apenas centros de custo da fabrica (1, 500-514)
    - [numero]: Centro de custo específico (ex: 2 para LIEBE MARAPONGA)
    """
    try:
        print(f"[INFO] Buscando DRE UNIFICADA: {dataInicio} ate {dataFim}, filtro={filtro}")

        # Determinar quais centros de custo usar
        if filtro == "consolidado":
            # Todos: fabrica + lojas + ecommerce (49) + diretoria (515) - igual ao DRE Por Empresa
            ccustos = list(set(CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys()) + CCUSTOS_ECOMMERCE + [515]))
            nome_filtro = "CONSOLIDADO"
            tipo_filtro = "consolidado"
            usar_cmv_fab = True
            usar_cmv_loja = True
        elif filtro == "fabrica":
            ccustos = CCUSTOS_FABRICA
            nome_filtro = "FABRICA"
            tipo_filtro = "fabrica"
            usar_cmv_fab = True
            usar_cmv_loja = False
        elif "," in filtro:
            try:
                ccustos_selecionados = [int(item.strip()) for item in filtro.split(",") if item.strip()]
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

            ccustos_lojas = [cd for cd in ccustos_selecionados if cd in CCUSTOS_LOJAS]
            if not ccustos_lojas:
                raise HTTPException(status_code=400, detail="Nenhuma loja valida selecionada")

            ccustos = ccustos_lojas
            nome_filtro = f"{len(ccustos_lojas)} LOJAS"
            tipo_filtro = "loja"
            usar_cmv_fab = False
            usar_cmv_loja = True
        else:
            # Centro de custo específico (loja)
            try:
                cd_ccusto = int(filtro)
                if cd_ccusto in CCUSTOS_LOJAS:
                    ccustos = [cd_ccusto]
                    nome_filtro = CCUSTOS_LOJAS[cd_ccusto]
                    tipo_filtro = "loja"
                    usar_cmv_fab = False
                    usar_cmv_loja = True
                elif cd_ccusto in CCUSTOS_FABRICA:
                    ccustos = [cd_ccusto]
                    nome_filtro = f"FABRICA CC {cd_ccusto}"
                    tipo_filtro = "fabrica"
                    usar_cmv_fab = True
                    usar_cmv_loja = False
                else:
                    raise HTTPException(status_code=400, detail=f"Centro de custo {cd_ccusto} nao encontrado")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

        # Gerar periodos mensais
        periodos = services.gerar_periodos(dataInicio, dataFim)

        # Placeholders para filtros
        ccusto_placeholders = ",".join(["%s"] * len(ccustos))

        # =========================================================================
        # DESPESAS - filtrar por centro de custo
        # =========================================================================
        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.dt_emissao as dt_emissao,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos, *CCUSTOS_EXCLUIDOS_FABRICA))
        print(f"[DRE UNIFICADA] Total de despesas: {len(despesas)}")

        # Buscar classificacoes do banco de dados
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[DRE UNIFICADA] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Agrupar despesas por conta_dre e periodo
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

            # Pular despesas excluidas (ex: MERC P/ REVENDA)
            if conta == 'EXCLUIDO':
                continue

            if dt_emissao:
                periodo = dt_emissao.strftime('%Y-%m')
            else:
                continue

            if periodo not in periodos:
                continue

            if conta not in valores_por_conta:
                valores_por_conta[conta] = {'total': 0}
                for p in periodos:
                    valores_por_conta[conta][p] = 0

            valores_por_conta[conta][periodo] += valor
            valores_por_conta[conta]['total'] += valor

        print(f"[DRE UNIFICADA] Despesas nao classificadas: {nao_classificados}")

        # =========================================================================
        # VENDAS - filtrar por empresas associadas aos centros de custo
        # =========================================================================
        receita_bruta = _init_valores_periodo(periodos)
        devolucoes_brutas = _init_valores_periodo(periodos)

        # Determinar empresas baseado nos centros de custo
        # IMPORTANTE: Para lojas, cd_empresa = idcentrodecusto (mesmos codigos)
        # Fabrica: cd_empresa = 1
        # Lojas: cd_empresa = codigo do centro de custo (2=MARAPONGA, 3=IGUATEMI, etc.)

        empresas_filtro = []

        if tipo_filtro == "fabrica":
            empresas_filtro = [1]  # Empresa principal da fabrica
        elif tipo_filtro == "loja":
            # Para loja especifica, usar o proprio codigo do centro de custo como empresa
            # pois cd_empresa = idcentrodecusto para lojas
            ccustos_lojas_filtro = [c for c in ccustos if c in CCUSTOS_LOJAS]
            empresas_filtro = ccustos_lojas_filtro  # Usar ccusto como cd_empresa
        elif tipo_filtro == "consolidado":
            # Consolidado: empresa 1 (fabrica) + todas as lojas (ccustos como empresas)
            empresas_filtro = [1]  # Fabrica
            ccustos_lojas_filtro = [c for c in ccustos if c in CCUSTOS_LOJAS]
            empresas_filtro.extend(ccustos_lojas_filtro)

        # Remover duplicatas e empresas excluidas
        empresas_filtro = [e for e in set(empresas_filtro) if e not in EMPRESAS_EXCLUIDAS]

        print(f"[DRE UNIFICADA] Empresas para vendas: {empresas_filtro}")

        if empresas_filtro:
            empresa_placeholders = ",".join(["%s"] * len(empresas_filtro))

            # Query de vendas (tp_modalidade 4 = venda, tp_operacao S = saida)
            query_vendas = f"""
                SELECT
                    t.dt_transacao,
                    SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('4')
                  AND t.tp_operacao = 'S'
                GROUP BY t.dt_transacao
                ORDER BY t.dt_transacao
            """
            vendas = execute_query(query_vendas, (dataInicio, dataFim, *empresas_filtro))

            for v in vendas:
                dt_transacao = v['dt_transacao']
                if dt_transacao:
                    periodo = dt_transacao.strftime('%Y-%m')
                else:
                    continue

                if periodo not in periodos:
                    continue

                valor = float(v['valor'] or 0)
                receita_bruta[periodo] += valor
                receita_bruta['total'] += valor

            # Query de devolucoes (tp_modalidade 3 = devolucao, tp_operacao E = entrada)
            query_devolucoes = f"""
                SELECT
                    t.dt_transacao,
                    SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
                GROUP BY t.dt_transacao
                ORDER BY t.dt_transacao
            """
            devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *empresas_filtro))

            for d in devolucoes:
                dt_transacao = d['dt_transacao']
                if dt_transacao:
                    periodo = dt_transacao.strftime('%Y-%m')
                else:
                    continue

                if periodo not in periodos:
                    continue

                valor = float(d['valor'] or 0)
                devolucoes_brutas[periodo] -= abs(valor)
                devolucoes_brutas['total'] -= abs(valor)

        # RECEITA DE FRETE (01.02.01) - repasse de frete cobrado do cliente,
        # via nota fiscal (vr_fis_nf), nao via vr_tra_transacao. Por enquanto
        # restrito ao e-commerce (cd_empfat = 120); so calculamos quando o
        # ccusto 120 esta no escopo do filtro atual (consolidado ou loja 120
        # especifica), senao a conta fica zerada nesse recorte.
        receita_frete = _init_valores_periodo(periodos)
        if 120 in ccustos:
            query_frete = """
                SELECT
                    dt_emissao,
                    SUM(vl_frete) as valor
                FROM public.vr_fis_nf
                WHERE cd_empfat = '120'
                  AND tp_situacaonf = 'E'
                  AND tp_operacao = 'S'
                  AND tp_modalidade = '4'
                  AND dt_emissao >= %s
                  AND dt_emissao <= %s
                  AND tp_frete = '2'
                GROUP BY dt_emissao
            """
            rows_frete = execute_query(query_frete, (dataInicio, dataFim))

            for row in (rows_frete or []):
                dt_emissao = row['dt_emissao']
                if not dt_emissao:
                    continue
                periodo = dt_emissao.strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                valor = float(row['valor'] or 0)
                receita_frete[periodo] += valor
                receita_frete['total'] += valor

        # Usar os codigos corretos do plano de contas
        def _merge_conta_unif(codigo: str, valores: dict):
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = valores
                return
            for p in periodos:
                valores_por_conta[codigo][p] = valores_por_conta[codigo].get(p, 0) + valores.get(p, 0)
            valores_por_conta[codigo]['total'] = valores_por_conta[codigo].get('total', 0) + valores.get('total', 0)

        _merge_conta_unif('01.01.02', receita_bruta)  # RECEITA VENDA MERCADORIAS
        _merge_conta_unif('02.01.03', devolucoes_brutas)  # DEVOLUCOES
        _merge_conta_unif('01.02.01', receita_frete)  # RECEITA DE FRETE (e-commerce)

        # =========================================================================
        # CMV - Custo de Mercadoria Vendida
        # =========================================================================
        cmv = _init_valores_periodo(periodos)

        # CMV Fabrica (mv_cmv_fab) - AGREGADO por mes
        if usar_cmv_fab:
            try:
                query_cmv_fab = """
                    SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
                    FROM mv_cmv_fab
                    WHERE data >= %s AND data <= %s
                    GROUP BY DATE_TRUNC('month', data)
                """
                cmv_fab = execute_query(query_cmv_fab, (dataInicio, dataFim))
                for c in cmv_fab:
                    dt = c['mes']
                    if dt:
                        periodo = dt.strftime('%Y-%m')
                        if periodo in periodos:
                            valor = -abs(float(c['cmv'] or 0))
                            cmv[periodo] += valor
                            cmv['total'] += valor
            except Exception as e:
                print(f"[DRE UNIFICADA] Erro ao buscar CMV fabrica: {e}")

        # CMV Lojas (mv_cmv_loja_v2) - AGREGADO por mes
        if usar_cmv_loja:
            try:
                ccustos_lojas_filtro = [c for c in ccustos if c in CCUSTOS_LOJAS]
                if ccustos_lojas_filtro:
                    ccusto_placeholders_loja = ",".join(["%s"] * len(ccustos_lojas_filtro))
                    query_cmv_loja = f"""
                        SELECT
                            DATE_TRUNC('month', data) AS mes,
                            idcentrodecusto,
                            ABS(COALESCE(SUM(valor), 0)) AS cmv
                        FROM mv_cmv_loja_v2
                        WHERE data >= %s
                          AND data <= %s
                          AND idcentrodecusto IN ({ccusto_placeholders_loja})
                        GROUP BY DATE_TRUNC('month', data), idcentrodecusto
                    """
                    cmv_loja = execute_query(query_cmv_loja, (dataInicio, dataFim, *ccustos_lojas_filtro))
                    for c in cmv_loja:
                        dt = c['mes']
                        if dt:
                            periodo = dt.strftime('%Y-%m')
                            if periodo in periodos:
                                valor = -abs(float(c['cmv'] or 0))
                                cmv[periodo] += valor
                                cmv['total'] += valor
            except Exception as e:
                print(f"[DRE UNIFICADA] Erro ao buscar CMV lojas: {e}")

        _merge_conta_unif('04.02.02', cmv)  # CUSTO MERCADORIAS VENDIDAS

        # Somar hierarquia
        valores_por_conta = _somar_hierarquia(valores_por_conta, periodos)

        # Calcular totalizadores (03, 05, 07, 09, 11, 14)
        valores_por_conta = _calcular_totalizadores(valores_por_conta, periodos)

        # Preparar response
        periodos_response = [
            {"key": p, "label": f"{p.split('-')[1]}/{p.split('-')[0][2:]}"}
            for p in periodos
        ]

        return {
            "periodos": periodos_response,
            "valores": valores_por_conta,
            "metadata": {
                "filtro": filtro,
                "nomeFiltro": nome_filtro,
                "tipoFiltro": tipo_filtro,
                "centrosCusto": ccustos,
                "empresas": empresas_filtro if empresas_filtro else [],
                "naoClassificados": nao_classificados,
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat()
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE UNIFICADA: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar dados da DRE UNIFICADA: {str(e)}"
        )


@router.get("/api/dre/despesas-sem-associacao")
def get_despesas_sem_associacao(
    dataInicio: str = Query(..., description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query(..., description="Data final (YYYY-MM-DD)"),
    filtro: str = Query(..., description="Filtro: 'consolidado', 'fabrica', codigo do centro de custo, ou lista separada por virgula")
):
    """
    Lista despesas lancadas no periodo/centro(s) de custo selecionados que NAO
    estao classificadas em nenhuma conta do plano de contas DRE
    (NAO_CLASSIFICADO). Nao inclui despesas EXCLUIDO, pois essas ja sao
    propositalmente deixadas de fora da DRE.
    """
    try:
        # Mesma resolucao de ccustos usada em /api/dre/unificada
        if filtro == "consolidado":
            ccustos = list(set(CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys()) + CCUSTOS_ECOMMERCE + [515]))
        elif filtro == "fabrica":
            ccustos = CCUSTOS_FABRICA
        elif "," in filtro:
            try:
                ccustos = [int(item.strip()) for item in filtro.split(",") if item.strip()]
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")
        else:
            try:
                ccustos = [int(filtro)]
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

        if not ccustos:
            raise HTTPException(status_code=400, detail="Nenhum centro de custo valido no filtro")

        ccusto_placeholders = ",".join(["%s"] * len(ccustos))

        query = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao,
                d.cd_ccusto,
                COUNT(*) as quantidade,
                SUM(ABS(d.vl_rateio)) as valor_total
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.tp_situacao = 'N'
            GROUP BY d.cd_despesaitem, i.ds_despesaitem, d.cd_ccusto
            ORDER BY valor_total DESC
        """
        params = [dataInicio, dataFim, *ccustos]
        rows = execute_query(query, params) or []

        classificacoes_db = {}
        try:
            crows = execute_query(
                "SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ()
            )
            for crow in crows or []:
                cd = crow.get('cd_despesaitem')
                conta_dre = crow.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[DESPESAS-SEM-ASSOCIACAO] Aviso ao carregar classificacoes: {e}")

        sem_associacao = []
        total = 0.0
        for row in rows:
            conta = _classificar_conta_dre(row['cd_despesaitem'], row['descricao'], classificacoes_db)
            if conta != 'NAO_CLASSIFICADO':
                continue
            valor = float(row['valor_total'] or 0)
            total += valor
            sem_associacao.append({
                "cdDespesaItem": row['cd_despesaitem'],
                "descricao": row['descricao'],
                "cdCcusto": row['cd_ccusto'],
                "nomeCcusto": CCUSTOS_LOJAS.get(row['cd_ccusto'], f"CC {row['cd_ccusto']}"),
                "quantidade": row['quantidade'],
                "valorTotal": valor,
            })

        return {
            "despesas": sem_associacao,
            "totalItens": len(sem_associacao),
            "valorTotal": total,
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar despesas sem associacao: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/dre/unificada/duplicatas")
def get_dre_unificada_duplicatas(
    conta: str = Query(..., description="Codigo da conta DRE (ex: 08.04.01)"),
    periodo: str = Query(..., description="Periodo no formato YYYY-MM"),
    filtro: str = Query("consolidado", description="Filtro: 'consolidado', 'fabrica', ou codigo do centro de custo")
):
    """
    Retorna duplicatas detalhadas para uma conta e periodo especificos da DRE Unificada.
    """
    try:
        print(f"[INFO] Buscando duplicatas DRE UNIFICADA: conta={conta}, periodo={periodo}, filtro={filtro}")

        # Determinar quais centros de custo usar
        if filtro == "consolidado":
            ccustos = CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys())
        elif filtro == "fabrica":
            ccustos = CCUSTOS_FABRICA
        else:
            try:
                cd_ccusto = int(filtro)
                if cd_ccusto in CCUSTOS_LOJAS or cd_ccusto in CCUSTOS_FABRICA:
                    ccustos = [cd_ccusto]
                else:
                    raise HTTPException(status_code=400, detail=f"Centro de custo {cd_ccusto} nao encontrado")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

        # Calcular datas do periodo
        ano, mes = periodo.split('-')
        import calendar
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]
        data_fim = f"{ano}-{mes}-{ultimo_dia:02d}"

        # Buscar classificacoes
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[DRE UNIFICADA DUPLICATAS] Aviso: {e}")

        # Encontrar cd_despesaitem que mapeiam para esta conta (APENAS do banco)
        itens_conta = []
        for cd_item, cd_conta in classificacoes_db.items():
            if cd_conta == conta or cd_conta.startswith(conta + '.'):
                itens_conta.append(cd_item)

        # Se nao tem itens, retorna vazio
        if not itens_conta:
            return {"duplicatas": [], "total": 0, "conta": conta, "periodo": periodo}

        # Buscar duplicatas
        ccusto_placeholders = ",".join(["%s"] * len(ccustos))

        # Construir clausula WHERE apenas por cd_despesaitem
        params = [primeiro_dia, data_fim]
        itens_placeholders = ",".join(["%s"] * len(itens_conta))
        items_or_desc = f"d.cd_despesaitem IN ({itens_placeholders})"
        params.extend(itens_conta)

        params.extend(ccustos)
        params.extend(CCUSTOS_EXCLUIDOS_FABRICA)

        ccusto_excluidos_placeholders = ",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))

        query = f"""
            SELECT
                d.nr_duplicata,
                d.cd_despesaitem,
                i.ds_despesaitem as descricao,
                d.dt_emissao,
                d.dt_vencimento,
                ABS(d.vl_rateio) as valor,
                d.cd_ccusto,
                cc.ds_ccusto as nome_ccusto,
                d.cd_fornecedor,
                CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fornecedor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN vr_gec_ccusto cc ON cc.cd_ccusto = d.cd_ccusto
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND ({items_or_desc})
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({ccusto_excluidos_placeholders})
              AND d.tp_situacao = 'N'
            ORDER BY d.dt_emissao DESC
        """

        rows = execute_query(query, params)

        duplicatas = []
        total = 0
        for row in (rows or []):
            valor = float(row['valor'] or 0)
            descricao = row['descricao'] or ''

            # Reclassificar pela descricao usando as mesmas regras da agregacao
            conta_classificada = _classificar_conta_dre(
                row['cd_despesaitem'],
                descricao,
                classificacoes_db
            )

            # Verificar se este registro realmente pertence a conta solicitada
            if conta_classificada != conta and not conta_classificada.startswith(conta + '.'):
                # Este registro foi reclassificado para outra conta, ignorar
                continue

            total += valor
            duplicatas.append({
                "id": row['nr_duplicata'],
                "nrDuplicata": row['nr_duplicata'],
                "cdDespesaItem": row['cd_despesaitem'],
                "descricao": descricao,
                "dtEmissao": row['dt_emissao'].strftime('%Y-%m-%d') if row['dt_emissao'] else None,
                "dtVencimento": row['dt_vencimento'].strftime('%Y-%m-%d') if row['dt_vencimento'] else None,
                "valor": valor,
                "cdCCusto": row['cd_ccusto'],
                "nomeCCusto": row['nome_ccusto'],
                "cdFornecedor": row['cd_fornecedor'],
                "nmFornecedor": row['nm_fornecedor']
            })

        return {
            "duplicatas": duplicatas,
            "total": total,
            "conta": conta,
            "periodo": periodo,
            "filtro": filtro
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar duplicatas DRE UNIFICADA: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# AUDITORIA: fornecedor x despesa
# ============================================================================
# Um fornecedor normalmente sempre lanca duplicatas na mesma despesa. Se um
# fornecedor com bastante historico tem uma despesa fortemente dominante e
# a duplicata em questao esta fora desse padrao, provavelmente foi
# classificada errado. Isso e so um indicio estatistico (moda por
# fornecedor), nao uma certeza - precisa de revisao humana.
AUDITORIA_MIN_DUPLICATAS = 10
AUDITORIA_LIMIAR_DOMINANCIA_PCT = 85


def _criar_tabela_auditoria_validado():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS auditoria_fornecedor_despesa_validado (
            cd_fornecedor INTEGER NOT NULL,
            cd_despesaitem INTEGER NOT NULL,
            usuario_validacao TEXT,
            dt_validacao TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (cd_fornecedor, cd_despesaitem)
        )
    """)


def _combos_validados() -> set:
    """Retorna o conjunto de (cd_fornecedor, cd_despesaitem) ja validados manualmente."""
    _criar_tabela_auditoria_validado()
    rows = execute_query(
        "SELECT cd_fornecedor, cd_despesaitem FROM auditoria_fornecedor_despesa_validado", ()
    ) or []
    return {(r['cd_fornecedor'], r['cd_despesaitem']) for r in rows}


@router.post("/api/dre/auditoria/validar")
def validar_auditoria_fornecedor_despesa(data: dict):
    """
    Marca uma combinacao fornecedor+despesa como revisada e correta, para
    que a auditoria pare de sinalizar essa combinacao (tanto no modal
    individual quanto no icone da grade principal).
    """
    try:
        cd_fornecedor = data.get('cdFornecedor')
        cd_despesaitem = data.get('cdDespesaItem')
        usuario = data.get('usuario', 'sistema')

        if not cd_fornecedor or not cd_despesaitem:
            raise HTTPException(status_code=400, detail="cdFornecedor e cdDespesaItem sao obrigatorios")

        _criar_tabela_auditoria_validado()
        execute_insert("""
            INSERT INTO auditoria_fornecedor_despesa_validado (cd_fornecedor, cd_despesaitem, usuario_validacao, dt_validacao)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (cd_fornecedor, cd_despesaitem)
            DO UPDATE SET usuario_validacao = EXCLUDED.usuario_validacao, dt_validacao = CURRENT_TIMESTAMP
        """, (cd_fornecedor, cd_despesaitem, usuario))

        return {"success": True, "cdFornecedor": cd_fornecedor, "cdDespesaItem": cd_despesaitem}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao validar auditoria fornecedor-despesa: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/dre/auditoria/validar")
def desfazer_validacao_auditoria_fornecedor_despesa(
    cdFornecedor: int = Query(...),
    cdDespesaItem: int = Query(...)
):
    """Remove uma validacao manual, voltando a sinalizar a combinacao se aplicavel."""
    try:
        _criar_tabela_auditoria_validado()
        execute_insert(
            "DELETE FROM auditoria_fornecedor_despesa_validado WHERE cd_fornecedor = %s AND cd_despesaitem = %s",
            (cdFornecedor, cdDespesaItem)
        )
        return {"success": True}
    except Exception as e:
        print(f"[ERROR] Erro ao desfazer validacao: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/dre/auditoria/fornecedor-despesa")
def get_auditoria_fornecedor_despesa(
    cdFornecedor: int = Query(..., description="Codigo do fornecedor (cd_pessoa)"),
    cdDespesaItemAtual: int = Query(..., description="Codigo da despesa lancada na duplicata em analise")
):
    """
    Compara a despesa lancada em uma duplicata especifica com o padrao
    historico do fornecedor (despesa mais frequente nas duplicatas dele).
    """
    try:
        query = """
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao,
                COUNT(*) as quantidade
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.cd_fornecedor = %s
              AND d.tp_situacao = 'N'
            GROUP BY d.cd_despesaitem, i.ds_despesaitem
            ORDER BY quantidade DESC
        """
        rows = execute_query(query, (cdFornecedor,)) or []
        total = sum(r['quantidade'] for r in rows)

        if total == 0:
            return {
                "totalDuplicatas": 0,
                "amostraInsuficiente": True,
                "distribuicao": [],
                "dominante": None,
                "despesaAtual": None,
                "alerta": False,
            }

        distribuicao = [
            {
                "cdDespesaItem": r['cd_despesaitem'],
                "descricao": r['descricao'],
                "quantidade": r['quantidade'],
                "percentual": round(r['quantidade'] / total * 100, 1),
            }
            for r in rows
        ]

        dominante = distribuicao[0]
        despesa_atual = next((d for d in distribuicao if d['cdDespesaItem'] == cdDespesaItemAtual), None)
        amostra_insuficiente = total < AUDITORIA_MIN_DUPLICATAS
        atual_e_dominante = despesa_atual is not None and despesa_atual['cdDespesaItem'] == dominante['cdDespesaItem']

        alerta = (
            not amostra_insuficiente
            and dominante['percentual'] >= AUDITORIA_LIMIAR_DOMINANCIA_PCT
            and not atual_e_dominante
        )

        validado = (cdFornecedor, cdDespesaItemAtual) in _combos_validados()
        if validado:
            alerta = False

        return {
            "totalDuplicatas": total,
            "amostraInsuficiente": amostra_insuficiente,
            "distribuicao": distribuicao[:5],
            "dominante": dominante,
            "despesaAtual": despesa_atual,
            "alerta": alerta,
            "validado": validado,
        }

    except Exception as e:
        print(f"[ERROR] Erro na auditoria fornecedor-despesa: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/dre/auditoria/alertas")
def get_auditoria_alertas(
    dataInicio: str = Query(..., description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query(..., description="Data final (YYYY-MM-DD)"),
    filtro: str = Query("consolidado", description="Filtro: 'consolidado', 'fabrica', ou codigo do centro de custo")
):
    """
    Versao em lote da auditoria fornecedor x despesa: varre todas as
    duplicatas do periodo/filtro selecionados e retorna quais celulas
    (conta:periodo) da grade tem pelo menos uma duplicata fora do padrao
    do fornecedor, para sinalizar antes mesmo de abrir o modal.
    """
    try:
        if filtro == "consolidado":
            ccustos = CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys())
        elif filtro == "fabrica":
            ccustos = CCUSTOS_FABRICA
        else:
            try:
                cd_ccusto = int(filtro)
                if cd_ccusto in CCUSTOS_LOJAS or cd_ccusto in CCUSTOS_FABRICA:
                    ccustos = [cd_ccusto]
                else:
                    raise HTTPException(status_code=400, detail=f"Centro de custo {cd_ccusto} nao encontrado")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

        # OBS: o filtro de cd_ccusto e aplicado em Python (mais abaixo), nao no SQL.
        # A view vr_fcp_despduplicatai fica muito lenta (45s+) com "cd_ccusto IN (...)"
        # numa lista grande combinado com filtro de data - sem esse filtro no SQL a
        # mesma consulta roda em poucos segundos.
        query = """
            WITH fornecedores_periodo AS (
                SELECT DISTINCT cd_fornecedor
                FROM vr_fcp_despduplicatai
                WHERE dt_emissao >= %s
                  AND dt_emissao <= %s
                  AND tp_situacao = 'N'
                  AND cd_fornecedor IS NOT NULL
            ),
            fornecedor_despesa AS (
                SELECT d.cd_fornecedor, d.cd_despesaitem, COUNT(*) as qtd
                FROM vr_fcp_despduplicatai d
                JOIN fornecedores_periodo fp ON fp.cd_fornecedor = d.cd_fornecedor
                WHERE d.tp_situacao = 'N'
                GROUP BY d.cd_fornecedor, d.cd_despesaitem
            ),
            fornecedor_total AS (
                SELECT cd_fornecedor, SUM(qtd) as total
                FROM fornecedor_despesa
                GROUP BY cd_fornecedor
            ),
            fornecedor_dominante AS (
                SELECT DISTINCT ON (fd.cd_fornecedor)
                    fd.cd_fornecedor,
                    fd.cd_despesaitem as despesa_dominante,
                    ft.total,
                    (fd.qtd::float / ft.total * 100) as percentual
                FROM fornecedor_despesa fd
                JOIN fornecedor_total ft ON ft.cd_fornecedor = fd.cd_fornecedor
                ORDER BY fd.cd_fornecedor, fd.qtd DESC
            ),
            fornecedor_alerta AS (
                SELECT cd_fornecedor, despesa_dominante
                FROM fornecedor_dominante
                WHERE total >= %s AND percentual >= %s
            )
            SELECT DISTINCT
                d.cd_fornecedor,
                d.cd_despesaitem,
                d.cd_ccusto,
                d.dt_emissao
            FROM vr_fcp_despduplicatai d
            JOIN fornecedor_alerta fa ON fa.cd_fornecedor = d.cd_fornecedor
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_despesaitem != fa.despesa_dominante
        """
        params = [
            dataInicio, dataFim,
            AUDITORIA_MIN_DUPLICATAS, AUDITORIA_LIMIAR_DOMINANCIA_PCT,
            dataInicio, dataFim,
        ]
        rows_brutas = execute_query(query, params) or []

        combos_validados = _combos_validados()
        ccustos_set = set(ccustos)
        excluidos_set = set(CCUSTOS_EXCLUIDOS_FABRICA)
        rows = [
            r for r in rows_brutas
            if r['cd_ccusto'] in ccustos_set
            and r['cd_ccusto'] not in excluidos_set
            and (r['cd_fornecedor'], r['cd_despesaitem']) not in combos_validados
        ]

        classificacoes_db = {}
        try:
            crows = execute_query(
                "SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ()
            )
            for crow in crows or []:
                cd = crow.get('cd_despesaitem')
                conta_dre = crow.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[AUDITORIA ALERTAS] Aviso ao carregar classificacoes: {e}")

        celulas = set()
        for row in rows:
            conta = _classificar_conta_dre(row['cd_despesaitem'], None, classificacoes_db)
            if conta in ('NAO_CLASSIFICADO', 'EXCLUIDO'):
                continue
            if not row['dt_emissao']:
                continue
            periodo = row['dt_emissao'].strftime('%Y-%m')
            celulas.add(f"{conta}:{periodo}")

        return {"celulasAlertadas": sorted(celulas)}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro na auditoria de alertas em lote: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/dre/unificada/sintetico")
def get_dre_unificada_sintetico(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    filtro: str = Query("consolidado", description="Filtro: 'consolidado', 'fabrica', codigo ou codigos de lojas")
):
    """
    Retorna visao sintetica da DRE com metricas principais por centro de custo.
    Mostra: Receita Liquida, CMV, Margem de Contribuicao, EBITDA, Lucro Liquido

    IMPORTANTE: Os valores de CMV sao calculados usando a MESMA logica do endpoint
    /api/dre/unificada (analitico) para garantir que os totais batam:
    - Agrupa por mes primeiro
    - Aplica ABS ao SUM de cada mes
    - Depois soma todos os meses
    """
    try:
        print(f"[INFO] Buscando DRE SINTETICO: {dataInicio} ate {dataFim}, filtro={filtro}")
        data_fim_exclusivo = (datetime.strptime(dataFim, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

        incluir_fabrica = filtro in ("consolidado", "fabrica")
        lojas_filtradas = list(CCUSTOS_LOJAS.keys()) if filtro == "consolidado" else []
        ccustos_extras_sintetico = [49, 515] if filtro == "consolidado" else []
        if filtro not in ("consolidado", "fabrica"):
            try:
                lojas_solicitadas = [int(item.strip()) for item in filtro.split(",") if item.strip()]
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

            lojas_filtradas = [loja for loja in lojas_solicitadas if loja in CCUSTOS_LOJAS]
            if not lojas_filtradas:
                raise HTTPException(status_code=400, detail="Nenhuma loja valida selecionada")

        # =========================================================================
        # 1. BUSCAR TODOS OS DADOS DE CMV DE UMA VEZ (igual ao endpoint analitico)
        # =========================================================================

        # CMV Fabrica - agrupado por mes (igual /api/dre/unificada)
        cmv_fabrica_total = 0
        try:
            if not incluir_fabrica:
                raise RuntimeError("CMV fabrica ignorado pelo filtro")
            query_cmv_fab = """
                SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
                FROM mv_cmv_fab
                WHERE data >= %s AND data < %s
                GROUP BY DATE_TRUNC('month', data)
            """
            cmv_fab_rows = execute_query(query_cmv_fab, (dataInicio, data_fim_exclusivo))
            for row in cmv_fab_rows or []:
                cmv_fabrica_total += float(row['cmv'] or 0)
            print(f"[SINTETICO] CMV Fabrica total: {cmv_fabrica_total:.2f}")
        except Exception as e:
            print(f"[SINTETICO] Erro CMV fabrica: {e}")

        # CMV Lojas - agrupado por mes E por idcentrodecusto (igual /api/dre/unificada)
        cmv_por_loja = {}  # {cd_ccusto: total_cmv}
        try:
            ccustos_lojas_list = lojas_filtradas
            if not ccustos_lojas_list:
                raise RuntimeError("CMV lojas ignorado pelo filtro")
            ccusto_placeholders = ",".join(["%s"] * len(ccustos_lojas_list))
            query_cmv_loja = f"""
                SELECT
                    DATE_TRUNC('month', data) AS mes,
                    idcentrodecusto,
                    ABS(COALESCE(SUM(valor), 0)) AS cmv
                FROM mv_cmv_loja_v2
                WHERE data >= %s
                  AND data < %s
                  AND idcentrodecusto IN ({ccusto_placeholders})
                GROUP BY DATE_TRUNC('month', data), idcentrodecusto
            """
            cmv_loja_rows = execute_query(query_cmv_loja, (dataInicio, data_fim_exclusivo, *ccustos_lojas_list))
            for row in cmv_loja_rows or []:
                cd_ccusto = row['idcentrodecusto']
                cmv_mes = float(row['cmv'] or 0)
                cmv_por_loja[cd_ccusto] = cmv_por_loja.get(cd_ccusto, 0) + cmv_mes
            print(f"[SINTETICO] CMV Lojas calculado para {len(cmv_por_loja)} centros de custo")
        except Exception as e:
            print(f"[SINTETICO] Erro CMV lojas: {e}")

        # Calcular CMV total das lojas (para comparacao)
        cmv_lojas_total = sum(cmv_por_loja.values())
        cmv_total = cmv_fabrica_total + cmv_lojas_total
        print(f"[SINTETICO] CMV Total (fab + lojas): {cmv_total:.2f}")

        # =========================================================================
        # 2. BUSCAR CLASSIFICACOES
        # =========================================================================
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[SINTETICO] Aviso classificacoes: {e}")

        # =========================================================================
        # 3. PROCESSAR CADA CENTRO DE CUSTO
        # =========================================================================

        # Lista de todos os centros de custo (fabrica + lojas)
        todos_ccustos = []

        # Adicionar fabrica
        if incluir_fabrica:
            todos_ccustos.append({
                "codigo": "fabrica",
                "nome": "FABRICA",
                "ccustos": CCUSTOS_FABRICA,
                "tipo": "fabrica"
            })

        # Adicionar cada loja
        for cd_ccusto in sorted(lojas_filtradas):
            todos_ccustos.append({
                "codigo": str(cd_ccusto),
                "nome": CCUSTOS_LOJAS[cd_ccusto],
                "ccustos": [cd_ccusto],
                "tipo": "loja"
            })

        if ccustos_extras_sintetico:
            todos_ccustos.append({
                "codigo": "outros",
                "nome": "ECOMMERCE / DIRETORIA",
                "ccustos": ccustos_extras_sintetico,
                "tipo": "outros"
            })

        def _inicio_janela_meses(data_fim_str: str, meses: int) -> str:
            data_fim_dt = datetime.strptime(data_fim_str, "%Y-%m-%d")
            mes_base = data_fim_dt.year * 12 + data_fim_dt.month - 1
            mes_inicio = mes_base - (meses - 1)
            ano_inicio = mes_inicio // 12
            mes_inicio_num = mes_inicio % 12 + 1
            return f"{ano_inicio}-{mes_inicio_num:02d}-01"

        def _calcular_lucro_liquido_janelas(data_inicio_minimo: str, data_fim_periodo: str, inicios_janelas):
            periodos_janelas = services.gerar_periodos(data_inicio_minimo, data_fim_periodo)
            data_fim_janela_exclusivo = (datetime.strptime(data_fim_periodo, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
            metricas = {}

            def garantir_metricas(codigo_item, periodo):
                if codigo_item not in metricas:
                    metricas[codigo_item] = {}
                if periodo not in metricas[codigo_item]:
                    metricas[codigo_item][periodo] = {
                        "receitaBruta": 0,
                        "devolucoes": 0,
                        "cmv": 0,
                        "deducoesDre": 0,
                        "custosVariaveisDre": 0,
                        "custosFixos": 0,
                        "despesasOperacionais": 0,
                        "resultadoNaoOperacional": 0,
                        "despesasTributarias": 0,
                    }
                return metricas[codigo_item][periodo]

            empresas_lojas = [c for c in lojas_filtradas if c not in EMPRESAS_EXCLUIDAS]
            empresas_vendas = []
            if incluir_fabrica:
                empresas_vendas.append(1)
            empresas_vendas.extend(empresas_lojas)
            if not empresas_vendas:
                return {}, {}, {}
            empresa_placeholders = ",".join(["%s"] * len(empresas_vendas))

            query_vendas_janelas = f"""
                SELECT
                    DATE_TRUNC('month', t.dt_transacao) AS mes,
                    t.cd_empresa,
                    SUM(t.vl_transacao) AS receita_bruta
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao < %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('4')
                  AND t.tp_operacao = 'S'
                GROUP BY DATE_TRUNC('month', t.dt_transacao), t.cd_empresa
            """
            vendas_janelas = execute_query(query_vendas_janelas, (data_inicio_minimo, data_fim_janela_exclusivo, *empresas_vendas))
            for row in vendas_janelas or []:
                dt = row.get('mes')
                if not dt:
                    continue
                periodo = dt.strftime('%Y-%m')
                if periodo not in periodos_janelas:
                    continue
                cd_empresa = row.get('cd_empresa')
                codigo_item = "fabrica" if cd_empresa == 1 else str(cd_empresa)
                if codigo_item != "fabrica" and cd_empresa not in CCUSTOS_LOJAS:
                    continue
                valores = garantir_metricas(codigo_item, periodo)
                valores["receitaBruta"] += float(row.get('receita_bruta') or 0)

            query_devolucoes_janelas = f"""
                SELECT
                    DATE_TRUNC('month', t.dt_transacao) AS mes,
                    t.cd_empresa,
                    SUM(t.vl_transacao) AS devolucoes
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao < %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
                GROUP BY DATE_TRUNC('month', t.dt_transacao), t.cd_empresa
            """
            devolucoes_janelas = execute_query(query_devolucoes_janelas, (data_inicio_minimo, data_fim_janela_exclusivo, *empresas_vendas))
            for row in devolucoes_janelas or []:
                dt = row.get('mes')
                if not dt:
                    continue
                periodo = dt.strftime('%Y-%m')
                if periodo not in periodos_janelas:
                    continue
                cd_empresa = row.get('cd_empresa')
                codigo_item = "fabrica" if cd_empresa == 1 else str(cd_empresa)
                if codigo_item != "fabrica" and cd_empresa not in CCUSTOS_LOJAS:
                    continue
                valores = garantir_metricas(codigo_item, periodo)
                valores["devolucoes"] += abs(float(row.get('devolucoes') or 0))

            if incluir_fabrica:
                query_cmv_fab_janelas = """
                    SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
                    FROM mv_cmv_fab
                    WHERE data >= %s AND data < %s
                    GROUP BY DATE_TRUNC('month', data)
                """
                cmv_fab_janelas = execute_query(query_cmv_fab_janelas, (data_inicio_minimo, data_fim_janela_exclusivo))
                for row in cmv_fab_janelas or []:
                    dt = row.get('mes')
                    if not dt:
                        continue
                    periodo = dt.strftime('%Y-%m')
                    if periodo in periodos_janelas:
                        garantir_metricas("fabrica", periodo)["cmv"] += float(row.get('cmv') or 0)

            ccustos_lojas_list = lojas_filtradas
            if ccustos_lojas_list:
                ccusto_loja_placeholders = ",".join(["%s"] * len(ccustos_lojas_list))
                query_cmv_loja_janelas = f"""
                    SELECT
                        DATE_TRUNC('month', data) AS mes,
                        idcentrodecusto,
                        ABS(COALESCE(SUM(valor), 0)) AS cmv
                    FROM mv_cmv_loja_v2
                    WHERE data >= %s
                      AND data < %s
                      AND idcentrodecusto IN ({ccusto_loja_placeholders})
                    GROUP BY DATE_TRUNC('month', data), idcentrodecusto
                """
                cmv_loja_janelas = execute_query(query_cmv_loja_janelas, (data_inicio_minimo, data_fim_janela_exclusivo, *ccustos_lojas_list))
                for row in cmv_loja_janelas or []:
                    dt = row.get('mes')
                    if not dt:
                        continue
                    periodo = dt.strftime('%Y-%m')
                    if periodo in periodos_janelas:
                        garantir_metricas(str(row.get('idcentrodecusto')), periodo)["cmv"] += float(row.get('cmv') or 0)

            ccustos_despesas = []
            if incluir_fabrica:
                ccustos_despesas.extend(CCUSTOS_FABRICA)
            ccustos_despesas.extend(lojas_filtradas)
            ccustos_despesas.extend(ccustos_extras_sintetico)
            ccustos_despesas = list(set(ccustos_despesas))
            if not ccustos_despesas:
                return {}, {}, {}
            ccusto_despesa_placeholders = ",".join(["%s"] * len(ccustos_despesas))
            query_despesas_janelas = f"""
                SELECT
                    DATE_TRUNC('month', d.dt_emissao) AS mes,
                    d.cd_ccusto,
                    d.cd_despesaitem,
                    i.ds_despesaitem as descricao_despesa,
                    SUM(ABS(d.vl_rateio)) as valor
                FROM vr_fcp_despduplicatai d
                JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                WHERE d.dt_emissao >= %s
                  AND d.dt_emissao < %s
                  AND d.tp_situacao = 'N'
                  AND d.cd_ccusto IN ({ccusto_despesa_placeholders})
                  AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
                GROUP BY DATE_TRUNC('month', d.dt_emissao), d.cd_ccusto, d.cd_despesaitem, i.ds_despesaitem
            """
            despesas_janelas = execute_query(
                query_despesas_janelas,
                (data_inicio_minimo, data_fim_janela_exclusivo, *ccustos_despesas, *CCUSTOS_EXCLUIDOS_FABRICA)
            )
            for row in despesas_janelas or []:
                dt = row.get('mes')
                if not dt:
                    continue
                periodo = dt.strftime('%Y-%m')
                if periodo not in periodos_janelas:
                    continue
                cd_ccusto = row.get('cd_ccusto')
                if cd_ccusto in CCUSTOS_FABRICA:
                    codigo_item = "fabrica"
                elif cd_ccusto in CCUSTOS_LOJAS:
                    codigo_item = str(cd_ccusto)
                elif cd_ccusto in ccustos_extras_sintetico:
                    codigo_item = "outros"
                else:
                    continue
                conta = _classificar_conta_dre(row.get('cd_despesaitem'), row.get('descricao_despesa'), classificacoes_db)
                valores = garantir_metricas(codigo_item, periodo)
                valor = float(row.get('valor') or 0)
                if conta.startswith('02'):
                    valores["deducoesDre"] += valor
                elif conta.startswith('04'):
                    valores["custosVariaveisDre"] += valor
                elif conta.startswith('06'):
                    valores["custosFixos"] += valor
                elif conta.startswith('08'):
                    valores["despesasOperacionais"] += valor
                elif conta.startswith('10'):
                    valores["resultadoNaoOperacional"] += valor
                elif conta.startswith('13'):
                    valores["despesasTributarias"] += valor

            resultado = {}
            resultado_receita = {}
            cmv_incompleto = {}
            for label, inicio in inicios_janelas.items():
                lucros = {}
                receitas = {}
                total = 0
                total_receita = 0
                cmv_incompleto[label] = []
                for item_janela in todos_ccustos:
                    codigo_item = item_janela["codigo"]
                    lucro = 0
                    receita_janela = 0
                    periodos_sem_cmv = []
                    for periodo in periodos_janelas:
                        if periodo < inicio[:7]:
                            continue
                        valores = metricas.get(codigo_item, {}).get(periodo, {})
                        receita_liquida = (
                            valores.get("receitaBruta", 0)
                            - valores.get("devolucoes", 0)
                            - valores.get("deducoesDre", 0)
                        )
                        receita_janela += receita_liquida
                        if item_janela["tipo"] == "loja" and receita_liquida > 0 and valores.get("cmv", 0) == 0:
                            periodos_sem_cmv.append(periodo)
                        lucro += (
                            receita_liquida
                            - valores.get("cmv", 0)
                            - valores.get("custosVariaveisDre", 0)
                            - valores.get("custosFixos", 0)
                            - valores.get("despesasOperacionais", 0)
                            - valores.get("resultadoNaoOperacional", 0)
                            - valores.get("despesasTributarias", 0)
                        )
                    lucros[codigo_item] = lucro
                    receitas[codigo_item] = receita_janela
                    total += lucro
                    total_receita += receita_janela
                    if periodos_sem_cmv:
                        cmv_incompleto[label].append({
                            "codigo": codigo_item,
                            "nome": item_janela["nome"],
                            "periodos": periodos_sem_cmv,
                        })
                resultado[label] = (lucros, total)
                resultado_receita[label] = (receitas, total_receita)
            return resultado, resultado_receita, cmv_incompleto

        inicio_12m = _inicio_janela_meses(dataFim, 12)
        inicio_6m = _inicio_janela_meses(dataFim, 6)
        inicio_3m = _inicio_janela_meses(dataFim, 3)
        lucros_janelas, receitas_janelas, cmv_incompleto_janelas = _calcular_lucro_liquido_janelas(
            inicio_12m,
            dataFim,
            {"12m": inicio_12m, "6m": inicio_6m, "3m": inicio_3m}
        )
        lucro_12m_por_ccusto, lucro_12m_total = lucros_janelas["12m"]
        lucro_6m_por_ccusto, lucro_6m_total = lucros_janelas["6m"]
        lucro_3m_por_ccusto, lucro_3m_total = lucros_janelas["3m"]
        receita_12m_por_ccusto, receita_12m_total = receitas_janelas["12m"]
        receita_6m_por_ccusto, receita_6m_total = receitas_janelas["6m"]
        receita_3m_por_ccusto, receita_3m_total = receitas_janelas["3m"]

        resultados = []
        totais = {
            "receitaLiquida": 0,
            "cmv": 0,
            "custosFixos": 0,
            "margemContribuicao": 0,
            "lucroOperacionalBruto": 0,
            "despesasOperacionais": 0,
            "ebitda": 0,
            "resultadoNaoOperacional": 0,
            "despesasFinanceiras": 0,
            "despesasTributarias": 0,
            # Despesas detalhadas
            "despOcupacao": 0,
            "despAdministrativas": 0,
            "despManutencao": 0,
            "despPessoal": 0,
            "despMarketing": 0,
            "despVendas": 0,
            "despCobranca": 0,
            "despVeiculos": 0,
            "despBancarias": 0,
            "freteVendas": 0,
            "comissaoRepresentante": 0,
            "premiacaoComercial": 0,
            # Janelas de lucro
            "lucroLiquido12m": lucro_12m_total,
            "lucroLiquido6m": lucro_6m_total,
            "lucroLiquido3m": lucro_3m_total,
            "receitaLiquida12m": receita_12m_total,
            "receitaLiquida6m": receita_6m_total,
            "receitaLiquida3m": receita_3m_total,
            "lucroLiquido": 0
        }

        for item in todos_ccustos:
            ccustos = item["ccustos"]
            ccusto_placeholders = ",".join(["%s"] * len(ccustos))

            # Despesas
            query_despesas = f"""
                SELECT
                    d.cd_despesaitem,
                    i.ds_despesaitem as descricao_despesa,
                    SUM(ABS(d.vl_rateio)) as valor
                FROM vr_fcp_despduplicatai d
                JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                WHERE d.dt_emissao >= %s
                  AND d.dt_emissao < %s
                  AND d.tp_situacao = 'N'
                  AND d.cd_ccusto IN ({ccusto_placeholders})
                  AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
                GROUP BY d.cd_despesaitem, i.ds_despesaitem
            """
            despesas = execute_query(query_despesas, (dataInicio, data_fim_exclusivo, *ccustos, *CCUSTOS_EXCLUIDOS_FABRICA))

            despesas_operacionais = 0
            deducoes_dre = 0
            custos_variaveis_dre = 0
            custos_fixos = 0
            despesas_financeiras = 0
            despesas_tributarias = 0

            # Despesas detalhadas por grupo
            desp_ocupacao = 0        # 08.01
            desp_administrativas = 0 # 08.02
            desp_manutencao = 0      # 08.03
            desp_pessoal = 0         # 08.04
            desp_marketing = 0       # 08.05
            desp_vendas = 0          # 08.10
            desp_cobranca = 0        # 08.11
            desp_veiculos = 0        # 08.12
            # Subcontas especiais
            frete_vendas = 0         # 08.10.03
            comissao_representante = 0  # 08.10.04
            premiacao_comercial = 0  # 08.10.02
            desp_bancarias = 0       # 10.03.01

            for d in despesas:
                cd_despesaitem = d['cd_despesaitem']
                descricao_despesa = d.get('descricao_despesa')
                conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
                valor = float(d['valor'] or 0)

                if conta.startswith('02'):
                    deducoes_dre += valor
                elif conta.startswith('04'):
                    custos_variaveis_dre += valor
                elif conta.startswith('06'):
                    custos_fixos += valor
                elif conta.startswith('08'):
                    despesas_operacionais += valor
                    # Detalhar por grupo
                    if conta.startswith('08.01'):
                        desp_ocupacao += valor
                    elif conta.startswith('08.02'):
                        desp_administrativas += valor
                    elif conta.startswith('08.03'):
                        desp_manutencao += valor
                    elif conta.startswith('08.04'):
                        desp_pessoal += valor
                    elif conta.startswith('08.05'):
                        desp_marketing += valor
                    elif conta.startswith('08.10'):
                        desp_vendas += valor
                        # Subcontas de vendas
                        if conta.startswith('08.10.02'):
                            premiacao_comercial += valor
                        elif conta.startswith('08.10.03'):
                            frete_vendas += valor
                        elif conta.startswith('08.10.04'):
                            comissao_representante += valor
                    elif conta.startswith('08.11'):
                        desp_cobranca += valor
                    elif conta.startswith('08.12'):
                        desp_veiculos += valor
                elif conta.startswith('10'):
                    despesas_financeiras += valor
                    if conta.startswith('10.03.01'):
                        desp_bancarias += valor
                elif conta.startswith('13'):
                    despesas_tributarias += valor

            # Vendas
            receita_bruta = 0
            devolucoes = 0

            if item["tipo"] == "fabrica":
                empresas_filtro = [1]
            elif item["tipo"] == "outros":
                empresas_filtro = []
            else:
                empresas_filtro = [c for c in ccustos if c not in EMPRESAS_EXCLUIDAS]

            if empresas_filtro:
                empresa_placeholders = ",".join(["%s"] * len(empresas_filtro))

                query_vendas = f"""
                    SELECT
                        COALESCE(SUM(t.vl_transacao), 0) AS receita_bruta
                    FROM vr_tra_transacao t
                    WHERE t.dt_transacao >= %s
                      AND t.dt_transacao < %s
                      AND t.tp_situacao = 4
                      AND t.cd_empresa IN ({empresa_placeholders})
                      AND t.tp_modalidade IN ('4')
                      AND t.tp_operacao = 'S'
                """
                result_vendas = execute_query(query_vendas, (dataInicio, data_fim_exclusivo, *empresas_filtro))
                if result_vendas:
                    receita_bruta = float(result_vendas[0]['receita_bruta'] or 0)

                query_devolucoes = f"""
                    SELECT
                        COALESCE(SUM(t.vl_transacao), 0) AS devolucoes
                    FROM vr_tra_transacao t
                    WHERE t.dt_transacao >= %s
                      AND t.dt_transacao < %s
                      AND t.tp_situacao = 4
                      AND t.cd_empresa IN ({empresa_placeholders})
                      AND t.tp_modalidade IN ('3')
                      AND t.tp_operacao = 'E'
                """
                result_devolucoes = execute_query(query_devolucoes, (dataInicio, data_fim_exclusivo, *empresas_filtro))
                if result_devolucoes:
                    devolucoes = abs(float(result_devolucoes[0]['devolucoes'] or 0))

            # CMV - usar os valores pre-calculados (mesma logica do analitico)
            if item["tipo"] == "fabrica":
                cmv = cmv_fabrica_total
            elif item["tipo"] == "outros":
                cmv = 0
            else:
                # Para lojas, somar o CMV de cada ccusto do item
                cmv = sum(cmv_por_loja.get(c, 0) for c in ccustos)
            custos_variaveis = cmv + custos_variaveis_dre

            # Calcular metricas
            devolucoes_total = devolucoes + deducoes_dre
            receita_liquida = receita_bruta - devolucoes_total
            margem_contribuicao = receita_liquida - custos_variaveis
            lucro_operacional_bruto = margem_contribuicao - custos_fixos
            ebitda = lucro_operacional_bruto - despesas_operacionais
            lucro_liquido = ebitda - despesas_financeiras - despesas_tributarias

            margem_pct = (margem_contribuicao / receita_liquida * 100) if receita_liquida > 0 else 0
            ebitda_pct = (ebitda / receita_liquida * 100) if receita_liquida > 0 else 0

            resultado = {
                "codigo": item["codigo"],
                "nome": item["nome"],
                "tipo": item["tipo"],
                "receitaBruta": receita_bruta,
                "devolucoes": devolucoes_total,
                "receitaLiquida": receita_liquida,
                "cmv": custos_variaveis,
                "cmvCalculado": cmv,
                "custosVariaveisDre": custos_variaveis_dre,
                "deducoesDre": deducoes_dre,
                "custosFixos": custos_fixos,
                "margemContribuicao": margem_contribuicao,
                "margemPct": round(margem_pct, 1),
                "lucroOperacionalBruto": lucro_operacional_bruto,
                "despesasOperacionais": despesas_operacionais,
                "ebitda": ebitda,
                "ebitdaPct": round(ebitda_pct, 1),
                "resultadoNaoOperacional": despesas_financeiras,
                "despesasFinanceiras": despesas_financeiras,
                "despesasTributarias": despesas_tributarias,
                # Despesas detalhadas
                "despOcupacao": desp_ocupacao,
                "despAdministrativas": desp_administrativas,
                "despManutencao": desp_manutencao,
                "despPessoal": desp_pessoal,
                "despMarketing": desp_marketing,
                "despVendas": desp_vendas,
                "despCobranca": desp_cobranca,
                "despVeiculos": desp_veiculos,
                "despBancarias": desp_bancarias,
                "freteVendas": frete_vendas,
                "comissaoRepresentante": comissao_representante,
                "premiacaoComercial": premiacao_comercial,
                # Janelas de lucro
                "lucroLiquido12m": lucro_12m_por_ccusto.get(item["codigo"], 0),
                "lucroLiquido6m": lucro_6m_por_ccusto.get(item["codigo"], 0),
                "lucroLiquido3m": lucro_3m_por_ccusto.get(item["codigo"], 0),
                "receitaLiquida12m": receita_12m_por_ccusto.get(item["codigo"], 0),
                "receitaLiquida6m": receita_6m_por_ccusto.get(item["codigo"], 0),
                "receitaLiquida3m": receita_3m_por_ccusto.get(item["codigo"], 0),
                "lucroLiquido": lucro_liquido
            }

            resultados.append(resultado)

            totais["receitaLiquida"] += receita_liquida
            totais["cmv"] += custos_variaveis
            totais["custosFixos"] += custos_fixos
            totais["margemContribuicao"] += margem_contribuicao
            totais["lucroOperacionalBruto"] += lucro_operacional_bruto
            totais["despesasOperacionais"] += despesas_operacionais
            totais["ebitda"] += ebitda
            totais["resultadoNaoOperacional"] += despesas_financeiras
            totais["despesasFinanceiras"] += despesas_financeiras
            totais["despesasTributarias"] += despesas_tributarias
            # Despesas detalhadas
            totais["despOcupacao"] += desp_ocupacao
            totais["despAdministrativas"] += desp_administrativas
            totais["despManutencao"] += desp_manutencao
            totais["despPessoal"] += desp_pessoal
            totais["despMarketing"] += desp_marketing
            totais["despVendas"] += desp_vendas
            totais["despCobranca"] += desp_cobranca
            totais["despVeiculos"] += desp_veiculos
            totais["despBancarias"] += desp_bancarias
            totais["freteVendas"] += frete_vendas
            totais["comissaoRepresentante"] += comissao_representante
            totais["premiacaoComercial"] += premiacao_comercial
            totais["lucroLiquido"] += lucro_liquido

        if totais["receitaLiquida"] > 0:
            totais["margemPct"] = round(totais["margemContribuicao"] / totais["receitaLiquida"] * 100, 1)
            totais["ebitdaPct"] = round(totais["ebitda"] / totais["receitaLiquida"] * 100, 1)
        else:
            totais["margemPct"] = 0
            totais["ebitdaPct"] = 0

        return {
            "resumo": resultados,
            "totais": totais,
            "metadata": {
                "totalCentrosCusto": len(resultados),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "janelasLucroLiquido": {
                    "12m": {"dataInicio": inicio_12m, "dataFim": dataFim},
                    "6m": {"dataInicio": inicio_6m, "dataFim": dataFim},
                    "3m": {"dataInicio": inicio_3m, "dataFim": dataFim}
                },
                "cmvIncompletoJanelas": cmv_incompleto_janelas,
                "dataConsulta": datetime.now().isoformat()
            }
        }

    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE SINTETICO: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/dre/unificada/por-loja")
def get_dre_unificada_por_loja(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    lojas: str = Query("", description="Codigos das lojas separados por virgula (ex: 2,3,4). Vazio = todas")
):
    """
    Retorna DRE completa lado a lado por loja.
    Permite selecionar quais lojas comparar.
    """
    try:
        print(f"[INFO] Buscando DRE POR LOJA: {dataInicio} ate {dataFim}, lojas={lojas}")

        # Parsear lojas selecionadas
        if lojas:
            try:
                lojas_selecionadas = [int(l.strip()) for l in lojas.split(',') if l.strip()]
            except ValueError:
                raise HTTPException(status_code=400, detail="Parametro 'lojas' invalido")
        else:
            # Todas as lojas
            lojas_selecionadas = list(CCUSTOS_LOJAS.keys())

        # Validar lojas
        lojas_validas = [l for l in lojas_selecionadas if l in CCUSTOS_LOJAS]
        if not lojas_validas:
            raise HTTPException(status_code=400, detail="Nenhuma loja valida selecionada")

        # Buscar classificacoes
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[POR LOJA] Aviso: {e}")

        # Estrutura de resultado por loja
        resultado_por_loja = {}

        for cd_loja in lojas_validas:
            nome_loja = CCUSTOS_LOJAS[cd_loja]

            # Despesas
            query_despesas = """
                SELECT
                    d.cd_despesaitem,
                    i.ds_despesaitem as descricao_despesa,
                    SUM(ABS(d.vl_rateio)) as valor
                FROM vr_fcp_despduplicatai d
                JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                WHERE d.dt_emissao >= %s
                  AND d.dt_emissao <= %s
                  AND d.tp_situacao = 'N'
                  AND d.cd_ccusto = %s
                GROUP BY d.cd_despesaitem, i.ds_despesaitem
            """
            despesas = execute_query(query_despesas, (dataInicio, dataFim, cd_loja))

            valores_conta = {}
            for d in despesas:
                cd_despesaitem = d['cd_despesaitem']
                descricao_despesa = d.get('descricao_despesa')
                conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
                valor = -float(d['valor'] or 0)

                if conta not in valores_conta:
                    valores_conta[conta] = 0
                valores_conta[conta] += valor

            # CMV
            try:
                query_cmv = """
                    SELECT SUM(ABS(valor)) as total
                    FROM mv_cmv_loja_v2
                    WHERE data >= %s
                      AND data <= %s
                      AND idcentrodecusto = %s
                """
                result = execute_query(query_cmv, (dataInicio, dataFim, cd_loja))
                if result and result[0]['total']:
                    valores_conta['04'] = -abs(float(result[0]['total']))
            except:
                valores_conta['04'] = 0

            # Vendas - usar cd_loja como cd_empresa (pois sao iguais para lojas)
            # Vendas
            query_vendas = """
                SELECT SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa = %s
                  AND t.tp_modalidade IN ('4')
                  AND t.tp_operacao = 'S'
            """
            result_vendas = execute_query(query_vendas, (dataInicio, dataFim, cd_loja))
            if result_vendas and result_vendas[0]['valor']:
                valores_conta['01'] = float(result_vendas[0]['valor'])

            # Devolucoes
            query_devolucoes = """
                SELECT SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa = %s
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
            """
            result_devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, cd_loja))
            if result_devolucoes and result_devolucoes[0]['valor']:
                valores_conta['02'] = -abs(float(result_devolucoes[0]['valor']))

            resultado_por_loja[str(cd_loja)] = {
                "codigo": cd_loja,
                "nome": nome_loja,
                "valores": valores_conta
            }

        return {
            "lojas": resultado_por_loja,
            "lojasDisponiveis": [
                {"codigo": k, "nome": v} for k, v in sorted(CCUSTOS_LOJAS.items())
            ],
            "metadata": {
                "lojasSelecionadas": lojas_validas,
                "totalLojas": len(lojas_validas),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat()
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE POR LOJA: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# DUPLICATAS POR EMPRESA
# ============================================================================
@router.get("/api/dre/por-empresa/duplicatas")
def get_duplicatas_por_empresa(
    conta: str = Query(..., description="Codigo da conta DRE (ex: 08.01.01)"),
    dataInicio: str = Query("2026-01-01", description="Data inicial"),
    dataFim: str = Query("2026-12-31", description="Data final"),
    cdEmpresa: int = Query(..., description="Codigo da empresa/centro de custo")
):
    """
    Retorna duplicatas de uma conta DRE especifica para um centro de custo.
    Filtra por cd_ccusto, mesma logica da tabela principal DRE Por Empresa.
    """
    try:
        ccustos_filtro = [cdEmpresa]

        print(f"[DUPLICATAS-EMP] Buscando conta={conta}, empresa={cdEmpresa}, ccustos={ccustos_filtro}, periodo={dataInicio} a {dataFim}")

        # Carregar classificacoes do banco
        classificacoes_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
        except Exception as e:
            print(f"[DUPLICATAS-EMP] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Primeiro, identificar quais cd_despesaitem correspondem a conta solicitada
        conta_prefixo = f"{conta}."

        # Buscar do banco de dados (APENAS)
        itens = [
            cd for cd, c in classificacoes_db.items()
            if c == conta or c.startswith(conta_prefixo)
        ]

        # Criar filtros. cdEmpresa=0 representa o total da linha, sem filtro de centro de custo.
        # cdEmpresa=1 representa a fabrica agrupada: centro 1 + centros maiores que 120.
        filtrar_ccusto = cdEmpresa > 0
        if cdEmpresa == 1:
            filtro_ccusto_sql = "AND (d.cd_ccusto = %s OR d.cd_ccusto > %s)"
            params_ccusto = [1, 120]
        elif cdEmpresa == CCUSTO_ECOMMERCE_AGRUPADO:
            placeholders_ccusto = ','.join(['%s'] * len(CCUSTOS_ECOMMERCE))
            filtro_ccusto_sql = f"AND d.cd_ccusto IN ({placeholders_ccusto})"
            params_ccusto = CCUSTOS_ECOMMERCE
        else:
            placeholders_ccusto = ','.join(['%s'] * len(ccustos_filtro)) if filtrar_ccusto else ''
            filtro_ccusto_sql = f"AND d.cd_ccusto IN ({placeholders_ccusto})" if filtrar_ccusto else ""
            params_ccusto = ccustos_filtro if filtrar_ccusto else []
        placeholders_emp_excluidas = ','.join(['%s'] * len(EMPRESAS_EXCLUIDAS))

        # Se ainda nao tem itens, buscar todas as despesas e filtrar depois
        if not itens:
            query = f"""
                SELECT
                    d.nr_duplicata as nr_duplicata,
                    d.cd_despesaitem,
                    i.ds_despesaitem as ds_despesaitem,
                    d.dt_emissao,
                    d.dt_vencimento,
                    ABS(d.vl_rateio) as vl_rateio,
                    d.cd_ccusto,
                    d.cd_empresa,
                    d.cd_fornecedor,
                    COALESCE(c.ds_ccusto, '') as nome_ccusto,
                    CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
                FROM vr_fcp_despduplicatai d
                JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                LEFT JOIN vr_gec_ccusto c ON c.cd_ccusto = d.cd_ccusto
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                WHERE d.dt_emissao >= %s
                  AND d.dt_emissao <= %s
                  AND d.tp_situacao = 'N'
                  {filtro_ccusto_sql}
                  AND d.cd_empresa NOT IN ({placeholders_emp_excluidas})
                ORDER BY d.dt_emissao
            """
            despesas = execute_query(query, (dataInicio, dataFim, *params_ccusto, *EMPRESAS_EXCLUIDAS))
        else:
            # Buscar apenas os itens identificados
            placeholders_itens = ','.join(['%s'] * len(itens))
            query = f"""
                SELECT
                    d.nr_duplicata as nr_duplicata,
                    d.cd_despesaitem,
                    i.ds_despesaitem as ds_despesaitem,
                    d.dt_emissao,
                    d.dt_vencimento,
                    ABS(d.vl_rateio) as vl_rateio,
                    d.cd_ccusto,
                    d.cd_empresa,
                    d.cd_fornecedor,
                    COALESCE(c.ds_ccusto, '') as nome_ccusto,
                    CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
                FROM vr_fcp_despduplicatai d
                JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                LEFT JOIN vr_gec_ccusto c ON c.cd_ccusto = d.cd_ccusto
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                WHERE d.dt_emissao >= %s
                  AND d.dt_emissao <= %s
                  AND d.tp_situacao = 'N'
                  {filtro_ccusto_sql}
                  AND d.cd_empresa NOT IN ({placeholders_emp_excluidas})
                  AND d.cd_despesaitem IN ({placeholders_itens})
                ORDER BY d.dt_emissao
            """
            despesas = execute_query(query, (dataInicio, dataFim, *params_ccusto, *EMPRESAS_EXCLUIDAS, *itens))

        # Filtrar e processar duplicatas
        duplicatas = []
        total = 0
        contas_encontradas = set()

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao = d.get('ds_despesaitem')
            conta_classificada = _classificar_conta_dre(cd_despesaitem, descricao, classificacoes_db)
            contas_encontradas.add(f"{conta_classificada}:{descricao}")

            # Verificar se a conta classificada corresponde a conta solicitada
            if conta_classificada == conta or conta_classificada.startswith(conta + '.') or conta.startswith(conta_classificada + '.'):
                valor = float(d['vl_rateio'] or 0)
                total += valor
                # Formato compativel com interface Duplicata do frontend
                duplicatas.append({
                    "id": d['nr_duplicata'],
                    "nrDuplicata": d['nr_duplicata'],
                    "cdDespesaItem": cd_despesaitem,
                    "descricao": descricao,
                    "dtEmissao": d['dt_emissao'].strftime('%Y-%m-%d') if d['dt_emissao'] else None,
                    "dtVencimento": d['dt_vencimento'].strftime('%Y-%m-%d') if d.get('dt_vencimento') else None,
                    "valor": -valor,  # Negativo pois é despesa
                    "cdCCusto": d['cd_ccusto'],
                    "nomeCCusto": d['nome_ccusto'],
                    "cdFornecedor": d.get('cd_fornecedor'),
                    "nmFornecedor": d.get('nm_fantasia', 'N/A')
                })

        print(f"[DUPLICATAS-EMP] Conta buscada: {conta}")
        print(f"[DUPLICATAS-EMP] Todas contas encontradas: {sorted(contas_encontradas)[:15]}")
        print(f"[DUPLICATAS-EMP] Encontradas {len(duplicatas)} duplicatas, total: R$ {total:.2f}")

        return {
            "duplicatas": duplicatas,
            "total": -total,  # Negativo pois é despesa
            "conta": conta,
            "cdEmpresa": cdEmpresa
        }

    except Exception as e:
        print(f"[ERROR] Erro ao buscar duplicatas por empresa: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

