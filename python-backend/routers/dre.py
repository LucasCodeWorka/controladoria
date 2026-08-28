from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime, timedelta
from database import execute_query, execute_insert
import services
import unicodedata
import calendar
from plano_contas_dfc import (
    PLANO_CONTAS_DFC,
    PLANO_RECEITA_DFC,
    RECEBIMENTOS_TIPOS_DOCUMENTO,
    RECEBIMENTOS_DATA_CONSTRUIDA,
    CODIGO_DEVOLUCOES_RECEITA,
    subgrupos_validos,
    grupo_de_subgrupo,
)


def _somar_dias_uteis(data, dias: int):
    """Soma N dias UTEIS (pula sabado/domingo) a uma data."""
    restante = dias
    while restante > 0:
        data = data + timedelta(days=1)
        if data.weekday() < 5:  # 0=segunda ... 4=sexta
            restante -= 1
    return data


# ============================================================================
# PRAZO MEDIO DE ESTOCAGEM (PME)
# ============================================================================
# Estoque medio do ultimo mes do filtro (saldo do 1o dia + saldo do ultimo
# dia do mes, dividido por 2) sobre o faturamento bruto do mesmo mes (sempre
# TODAS as lojas, independente do filtro de loja/fabrica selecionado na
# tela), multiplicado pelos dias do mes.
#
# A consulta de estoque (valor de mercado de cada produto em uma data) e
# muito pesada (~20-70s por data, sem indice adequado em prd_prdsaldo) -
# por isso o resultado fica em cache por data, evitando reprocessar toda
# vez que a tela do DFC carrega.

def _criar_tabela_estoque_cache():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS dfc_estoque_cache (
            dt_referencia DATE PRIMARY KEY,
            valor_estoque NUMERIC,
            qt_estoque NUMERIC,
            dt_calculado TIMESTAMP DEFAULT NOW()
        )
    """)
    # Migracao: banco pode ja ter a tabela de uma versao anterior do PME,
    # que so guardava valor_estoque (sem quantidade).
    try:
        execute_insert("ALTER TABLE dfc_estoque_cache ADD COLUMN IF NOT EXISTS qt_estoque NUMERIC")
    except Exception as e:
        print(f"[PME] Aviso ao migrar cache de estoque: {e}")


def _buscar_estoque_total(data_referencia: str) -> dict:
    """Retorna {'valor': ..., 'quantidade': ...} do estoque total na data de
    referencia. As duas metricas vem da MESMA query (a leitura de
    prd_prdsaldo e cara - 20-70s sem cache), por isso sao calculadas e
    cacheadas juntas mesmo o PME hoje so usando quantidade."""
    _criar_tabela_estoque_cache()
    try:
        cache = execute_query(
            "SELECT valor_estoque, qt_estoque FROM dfc_estoque_cache WHERE dt_referencia = %s AND qt_estoque IS NOT NULL",
            (data_referencia,)
        )
        if cache:
            return {
                'valor': float(cache[0]['valor_estoque'] or 0),
                'quantidade': float(cache[0]['qt_estoque'] or 0),
            }
    except Exception as e:
        print(f"[PME] Aviso ao ler cache de estoque: {e}")

    query = """
        WITH saldo_final AS (
            SELECT DISTINCT ON (ps.cd_produto)
                   ps.cd_produto,
                   ps.dt_saldo,
                   ps.qt_saldo
            FROM public.prd_prdsaldo ps
            WHERE ps.cd_saldo = '1'
              AND ps.dt_saldo <= %s
              AND ps.cd_produto <= 1000000
            ORDER BY ps.cd_produto, ps.dt_saldo DESC
        ),
        base AS (
            SELECT
                p.cd_produto,
                s.qt_saldo,
                COALESCE(public.f_prd_valor_produto2('1', '1', 'P', '1', p.cd_produto, %s), 0) AS vl_produto
            FROM saldo_final s
            JOIN VR_PRD_PRDS p ON p.cd_produto = s.cd_produto
            JOIN public.prd_produtoclas pc ON pc.cd_produto = p.cd_produto AND pc.cd_tipoclas = 20
            JOIN public.prd_classificacao c ON c.cd_classificacao = pc.cd_classificacao AND c.cd_tipoclas = pc.cd_tipoclas
            WHERE s.qt_saldo > 0
              AND TRIM(c.ds_classificacao) IS NOT NULL
        )
        SELECT
            COALESCE(SUM(qt_saldo * vl_produto), 0) AS valor_total_estoque,
            COALESCE(SUM(qt_saldo), 0) AS qt_total_estoque
        FROM base
    """
    rows = execute_query(query, (data_referencia, data_referencia))
    valor = float(rows[0]['valor_total_estoque'] or 0) if rows else 0.0
    quantidade = float(rows[0]['qt_total_estoque'] or 0) if rows else 0.0

    try:
        execute_insert("""
            INSERT INTO dfc_estoque_cache (dt_referencia, valor_estoque, qt_estoque, dt_calculado)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (dt_referencia) DO UPDATE SET
                valor_estoque = EXCLUDED.valor_estoque,
                qt_estoque = EXCLUDED.qt_estoque,
                dt_calculado = CURRENT_TIMESTAMP
        """, (data_referencia, valor, quantidade))
    except Exception as e:
        print(f"[PME] Aviso ao gravar cache de estoque: {e}")

    return {'valor': valor, 'quantidade': quantidade}


def _calcular_quantidade_faturada_periodo(data_inicio: str, data_fim: str, empresas_filtro: list) -> float:
    """Quantidade de itens vendidos (qt_solicitada de vr_tra_transacao - mesma
    fonte/filtro da Receita Bruta da DRE, so que somando quantidade em vez de
    vl_transacao) num periodo e conjunto de empresas - usado pelo PME."""
    if not empresas_filtro:
        return 0.0
    empresa_placeholders = ",".join(["%s"] * len(empresas_filtro))
    query = f"""
        SELECT COALESCE(SUM(t.qt_solicitada), 0) as quantidade
        FROM vr_tra_transacao t
        WHERE t.dt_transacao >= %s
          AND t.dt_transacao <= %s
          AND t.tp_situacao = 4
          AND t.cd_empresa IN ({empresa_placeholders})
          AND t.tp_modalidade IN ('4')
          AND t.tp_operacao = 'S'
    """
    rows = execute_query(query, (data_inicio, data_fim, *empresas_filtro))
    return float(rows[0]['quantidade'] or 0) if rows else 0.0


def _calcular_prazo_medio_estocagem(dataFim: str) -> Optional[float]:
    """PME = quantidade media em estoque do ultimo mes do filtro (1o dia +
    ultimo dia, dividido por 2) / quantidade faturada no mesmo mes (todas as
    lojas, vr_tra_transacao) * dias do mes."""
    try:
        data_fim_dt = datetime.strptime(dataFim, '%Y-%m-%d')
        ano, mes = data_fim_dt.year, data_fim_dt.month
        ultimo_dia_num = calendar.monthrange(ano, mes)[1]
        primeiro_dia_mes = f"{ano:04d}-{mes:02d}-01"
        ultimo_dia_mes = f"{ano:04d}-{mes:02d}-{ultimo_dia_num:02d}"

        qtd_estoque_primeiro = _buscar_estoque_total(primeiro_dia_mes)['quantidade']
        qtd_estoque_ultimo = _buscar_estoque_total(ultimo_dia_mes)['quantidade']
        qtd_estoque_medio = (qtd_estoque_primeiro + qtd_estoque_ultimo) / 2

        empresas_todas_lojas = [e for e in ([1] + list(CCUSTOS_LOJAS.keys())) if e not in EMPRESAS_EXCLUIDAS]
        qtd_faturada_mes = _calcular_quantidade_faturada_periodo(primeiro_dia_mes, ultimo_dia_mes, empresas_todas_lojas)

        if qtd_faturada_mes <= 0:
            return None

        return (qtd_estoque_medio / qtd_faturada_mes) * ultimo_dia_num
    except Exception as e:
        print(f"[PME] Erro ao calcular prazo medio de estocagem: {e}")
        import traceback
        traceback.print_exc()
        return None

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

# Duplicatas de despesa que nao devem compor nenhum painel da DRE ou do DFC.
# Cada item e um par (cd_fornecedor, cd_despesaitem) a ignorar nas consultas.
DUPLICATAS_EXCLUIDAS_DRE_DFC = [(224131, 25)]

# Fragmento SQL a adicionar em toda consulta a vr_fcp_despduplicatai (alias "d")
# que alimenta paineis de DRE/DFC. Os parametros correspondentes (fornecedor, despesa)
# devem ser adicionados ao final da tupla de params da respectiva query.
FILTRO_DUPLICATAS_EXCLUIDAS_SQL = " AND ".join(
    "NOT (d.cd_fornecedor = %s AND d.cd_despesaitem = %s)" for _ in DUPLICATAS_EXCLUIDAS_DRE_DFC
)
PARAMS_DUPLICATAS_EXCLUIDAS = tuple(v for par in DUPLICATAS_EXCLUIDAS_DRE_DFC for v in par)

# Lancamentos manuais do DFC: despesas que nao existem na fonte do ERP mas o
# usuario pediu para incluir manualmente em todo periodo consultado, como se
# fossem uma despesa real classificada no subgrupo do DFC informado.
# cd_despesaitem usa um codigo negativo pra nunca colidir com um codigo real
# (que sempre vem do ERP como positivo).
LANCAMENTOS_MANUAIS_DFC = [
    {'subgrupo': 'OP.14', 'cd_despesaitem': -1, 'descricao': 'PROLABORE CAIRO', 'valor_mensal': 10469.93, 'ccusto': 1},
]

# Despesas que sao custo direto da antecipacao de recebiveis (juros pagos pra
# antecipar e recompra dos titulos antecipados) - na visao "sem antecipacao"
# do DFC essas linhas somem junto, ja que a antecipacao em si esta sendo
# desconsiderada.
DESPESAS_ZERADAS_SEM_ANTECIPACAO = {186, 541}  # JUROS S/ ANTECIPACAO, RECOMPRA DE TITULOS


def _buscar_credito_inadimplencia(data_inicio: str, data_fim: str, empresas_filtro: Optional[list] = None):
    """
    Conta 10.01.04 CREDITO INADIMPLENCIA da DRE: faturas (tp_documento=1,
    tp_situacao='1') pagas com mais de 365 dias de atraso em relacao ao
    vencimento (dt_baixa - dt_vencimento > 365 dias). Reconhecido no mes do
    PAGAMENTO (dt_baixa), nao no mes de vencimento/emissao.

    Retorna uma lista de linhas cruas {dt_baixa, cd_empresa, valor} ja
    filtradas pela regra dos 365 dias, pra cada endpoint agregar por
    periodo/empresa/total conforme a visao (mesmo padrao das linhas cruas
    de PMR/PMP usadas no DFC).
    """
    empresa_where = ""
    params = [data_inicio, data_fim]
    if empresas_filtro:
        empresa_where = f"AND f.cd_empresa IN ({','.join(['%s'] * len(empresas_filtro))})"
        params.extend(empresas_filtro)

    query = f"""
        SELECT f.dt_baixa, f.dt_vencimento, f.cd_empresa, f.vl_pago
        FROM vr_fcr_faturai f
        WHERE f.dt_baixa >= %s AND f.dt_baixa <= %s
          AND f.tp_documento = 1
          AND f.tp_situacao = '1'
          AND f.dt_vencimento IS NOT NULL
          {empresa_where}
    """
    rows = execute_query(query, tuple(params))

    resultado = []
    for r in rows or []:
        dt_baixa = r.get('dt_baixa')
        dt_vencimento = r.get('dt_vencimento')
        if not dt_baixa or not dt_vencimento:
            continue
        if (dt_baixa - dt_vencimento).days > 365:
            resultado.append({
                'dt_baixa': dt_baixa,
                'cd_empresa': r.get('cd_empresa'),
                'valor': float(r.get('vl_pago') or 0),
            })
    return resultado


def _buscar_debito_inadimplencia(data_inicio: str, data_fim: str, empresas_filtro: Optional[list] = None):
    """
    Conta 10.03.07 DEBITO INADIMPLENCIA da DRE: faturas (tp_documento=1,
    tp_situacao='1', nr_portador<999) que COMPLETAM 365 dias de vencidas
    (dt_vencimento + 365 dias) dentro do periodo consultado, e que AINDA
    ESTAVAM EM ABERTO nesse momento (dt_baixa nulo, ou dt_baixa posterior a
    essa data). Reconhece a perda no mes em que a fatura vira inadimplente,
    mesmo que seja paga bem mais tarde - nesse caso a recuperacao aparece
    em 10.01.04 CREDITO INADIMPLENCIA, no mes do pagamento. Por isso um mes
    ja fechado deste relatorio nunca muda depois, mesmo que a fatura seja
    paga posteriormente.
    """
    data_inicio_dt = datetime.strptime(data_inicio, '%Y-%m-%d')
    data_fim_dt = datetime.strptime(data_fim, '%Y-%m-%d')
    # dt_vencimento + 365 dias precisa cair no periodo consultado - filtra
    # dt_vencimento num range mais estreito antes de trazer as linhas.
    venc_inicio = (data_inicio_dt - timedelta(days=365)).strftime('%Y-%m-%d')
    venc_fim = (data_fim_dt - timedelta(days=365)).strftime('%Y-%m-%d')

    empresa_where = ""
    params = [venc_inicio, venc_fim]
    if empresas_filtro:
        empresa_where = f"AND f.cd_empresa IN ({','.join(['%s'] * len(empresas_filtro))})"
        params.extend(empresas_filtro)

    query = f"""
        SELECT f.dt_vencimento, f.dt_baixa, f.cd_empresa, f.vl_fatura
        FROM vr_fcr_faturai f
        WHERE f.dt_vencimento >= %s AND f.dt_vencimento <= %s
          AND f.tp_documento = 1
          AND f.tp_situacao = '1'
          AND f.nr_portador < 999
          {empresa_where}
    """
    rows = execute_query(query, tuple(params))

    resultado = []
    for r in rows or []:
        dt_vencimento = r.get('dt_vencimento')
        if not dt_vencimento:
            continue
        dt_limite = dt_vencimento + timedelta(days=365)
        if dt_limite < data_inicio_dt or dt_limite > data_fim_dt:
            continue
        dt_baixa = r.get('dt_baixa')
        if dt_baixa is not None and dt_baixa <= dt_limite:
            continue
        resultado.append({
            'dt_limite': dt_limite,
            'cd_empresa': r.get('cd_empresa'),
            'valor': float(r.get('vl_fatura') or 0),
        })
    return resultado


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


def _criar_tabela_classificacao_dfc():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS classificacao_despesas_dfc (
            cd_despesaitem INTEGER PRIMARY KEY,
            ds_despesaitem TEXT,
            conta_dfc TEXT NOT NULL,
            usuario_alteracao TEXT,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """)


def _classificar_conta_dfc(cd_despesaitem, descricao_despesa, classificacoes_dfc_db, classificacoes_dre_db):
    """
    Classifica uma despesa em uma conta do DFC (regime de caixa).

    O DFC tem uma tabela de classificacao PROPRIA (classificacao_despesas_dfc),
    usada so para os casos em que o DFC precisa divergir da DRE (ex: custo de
    mercadoria vendida = despesas reais de compra de materia-prima pagas, em
    vez do calculo sintetico que a DRE usa). Qualquer despesa sem override
    especifico do DFC cai automaticamente na MESMA classificacao da DRE - o
    DFC nunca perde o que ja esta correto na DRE, so sobrescreve o que for
    configurado explicitamente.
    """
    conta_dfc = classificacoes_dfc_db.get(cd_despesaitem)
    if conta_dfc:
        return conta_dfc

    return _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_dre_db)


def _classificar_subgrupo_dfc(cd_despesaitem, classificacoes_dfc_db):
    """
    Classifica uma despesa em um SUBGRUPO do plano de contas proprio do DFC
    (ver plano_contas_dfc.py: GRUPO > SUBGRUPO, estrutura definida pela
    consultoria contabil externa). Diferente de _classificar_conta_dfc, essa
    arvore e INDEPENDENTE da DRE - nao tem fallback para classificacao_despesas_dre,
    pois o DFC agora tem seu proprio plano de contas.
    """
    conta_dfc = classificacoes_dfc_db.get(cd_despesaitem)
    if conta_dfc and conta_dfc in subgrupos_validos():
        return conta_dfc
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
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *CCUSTOS_FABRICA, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS))
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
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *CCUSTOS_FABRICA, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS))
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

        # CREDITO INADIMPLENCIA (10.01.04) - faturas pagas com mais de 365
        # dias de atraso, reconhecidas no mes do pagamento. So no total (nao
        # ha como atribuir a fatura a um ccusto interno especifico da fabrica).
        credito_inadimplencia_total = sum(
            linha['valor'] for linha in _buscar_credito_inadimplencia(dataInicio, dataFim, EMPRESAS_FABRICA)
        )
        valores_por_conta['10.01.04'] = {'total': credito_inadimplencia_total}

        # DEBITO INADIMPLENCIA (10.03.07) - faturas que completaram 365 dias
        # vencidas ainda em aberto, reconhecidas no mes em que completam.
        debito_inadimplencia_total = -abs(sum(
            linha['valor'] for linha in _buscar_debito_inadimplencia(dataInicio, dataFim, EMPRESAS_FABRICA)
        ))
        valores_por_conta['10.03.07'] = {'total': debito_inadimplencia_total}

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
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
        """
        despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos_dre, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS))
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

        # CREDITO INADIMPLENCIA (10.01.04) - faturas pagas com mais de 365
        # dias de atraso, reconhecidas no mes do pagamento (dt_baixa), por
        # empresa (cd_empresa da fatura = 1 para fabrica, ou o codigo do
        # ccusto/empresa da loja).
        for linha in _buscar_credito_inadimplencia(dataInicio, dataFim, empresas_dre):
            _somar_valor_empresa('10.01.04', linha['cd_empresa'], linha['valor'])

        # DEBITO INADIMPLENCIA (10.03.07) - faturas que completaram 365 dias
        # vencidas ainda em aberto, por empresa.
        for linha in _buscar_debito_inadimplencia(dataInicio, dataFim, empresas_dre):
            _somar_valor_empresa('10.03.07', linha['cd_empresa'], -abs(linha['valor']))

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
    120: "ECOMMERCE",
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
    return _calcular_valores_unificada(dataInicio, dataFim, filtro, campo_data_despesa='dt_emissao')


@router.get("/api/dfc/unificada")
def get_dfc_unificada(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    filtro: str = Query("consolidado", description="Filtro: 'consolidado', 'fabrica', ou codigo do centro de custo"),
    semAntecipacao: bool = Query(
        False,
        description="Se true, desconsidera o efeito de antecipacao dos recebiveis: cartao de credito (REC.04) e "
                    "reconhecido por parcela (emissao + 30*nr_parcela dias) em vez de emissao+2 dias uteis; faturas "
                    "(REC.03, tp_documento=1, nr_portador<999) ja baixadas sao alocadas no mes do VENCIMENTO "
                    "original, nao no mes da baixa (que pode vir antecipada)."
    )
):
    """
    DFC (regime de caixa) com plano de contas PROPRIO (GRUPO > SUBGRUPO,
    definido pela consultoria contabil externa - ver plano_contas_dfc.py),
    agrupando as despesas pela data de liquidacao (dt_liq, pagamento
    efetivo). Nao usa dt_baixa: em lancamentos retroativos, dt_baixa reflete
    quando o registro foi processado no sistema, nao quando o dinheiro
    realmente saiu - dt_liq e a data real do pagamento.
    Receita/devolucoes usam dt_transacao (nao regime de caixa), igual a DRE.
    """
    return _calcular_valores_dfc(dataInicio, dataFim, filtro, sem_antecipacao=semAntecipacao)


@router.get("/api/dfc/por-centro-custo")
def get_dfc_por_centro_custo(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    DFC agrupado por centro de custo: cada loja ativa e uma coluna, e todos os
    centros de custo internos da fabrica (1, 500-514) sao somados em UMA unica
    coluna "FABRICA" - mesmo padrao de agrupamento da aba "Por Empresa" da DRE.
    Valores sao o total do periodo selecionado (sem quebra por mes).
    """
    return _calcular_dfc_por_centro_custo(dataInicio, dataFim)


@router.get("/api/dre-dfc/comparativo-operacional")
def get_dre_x_dfc_operacional(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)"),
    filtro: str = Query("consolidado", description="Filtro: 'consolidado', 'fabrica', ou codigo do centro de custo")
):
    """
    Compara DRE (competencia) com DFC Operacional (caixa, base SEM
    ANTECIPACAO) - so o grupo OP/REC do DFC, sem Investimentos/Financiamento
    (sem contrapartida na DRE). Ve _calcular_dre_x_dfc_operacional para a
    logica completa.
    """
    return _calcular_dre_x_dfc_operacional(dataInicio, dataFim, filtro)


@router.get("/api/dfc/plano-contas")
def get_dfc_plano_contas():
    """Retorna a arvore GRUPO > SUBGRUPO do plano de contas do DFC (despesas)
    e, separadamente, o grupo de RECEITA (entradas de caixa)."""
    return {"grupos": PLANO_CONTAS_DFC, "gruposReceita": PLANO_RECEITA_DFC}


def _criar_tabela_grupos_ocultos_dfc():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS plano_contas_dfc_grupos_ocultos (
            codigo TEXT PRIMARY KEY,
            usuario_alteracao TEXT,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """)


@router.get("/api/dfc/grupos-ocultos")
def get_dfc_grupos_ocultos():
    """Lista os codigos de GRUPO (OP, INV, FIN, REC) que o usuario escondeu
    da tela do DFC. Ausencia da lista = visivel (padrao)."""
    try:
        _criar_tabela_grupos_ocultos_dfc()
        rows = execute_query("SELECT codigo FROM plano_contas_dfc_grupos_ocultos", ())
        return {"ocultos": [r['codigo'] for r in rows or []]}
    except Exception as e:
        print(f"[ERROR] Erro ao listar grupos ocultos do DFC: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/dfc/grupos-ocultos")
def salvar_dfc_grupo_oculto(data: dict):
    """Marca ou desmarca um GRUPO como oculto na tela do DFC."""
    try:
        codigo = (data.get('codigo') or '').strip()
        oculto = bool(data.get('oculto'))
        usuario = data.get('usuario', 'sistema')

        if not codigo:
            raise HTTPException(status_code=400, detail="codigo e obrigatorio")

        _criar_tabela_grupos_ocultos_dfc()
        if oculto:
            execute_insert("""
                INSERT INTO plano_contas_dfc_grupos_ocultos (codigo, usuario_alteracao, dt_atualizacao)
                VALUES (%s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (codigo) DO UPDATE SET
                    usuario_alteracao = EXCLUDED.usuario_alteracao,
                    dt_atualizacao = CURRENT_TIMESTAMP
            """, (codigo, usuario))
        else:
            execute_insert("DELETE FROM plano_contas_dfc_grupos_ocultos WHERE codigo = %s", (codigo,))

        return {"success": True, "codigo": codigo, "oculto": oculto}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao salvar grupo oculto do DFC: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _calcular_valores_dfc(dataInicio: str, dataFim: str, filtro: str, sem_antecipacao: bool = False):
    try:
        print(f"[INFO] Buscando DFC (plano proprio): {dataInicio} ate {dataFim}, filtro={filtro}")

        if filtro == "consolidado":
            ccustos = list(set(CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys()) + CCUSTOS_ECOMMERCE + [515]))
            nome_filtro = "CONSOLIDADO"
            tipo_filtro = "consolidado"
        elif filtro == "fabrica":
            ccustos = CCUSTOS_FABRICA
            nome_filtro = "FABRICA"
            tipo_filtro = "fabrica"
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
        else:
            try:
                cd_ccusto = int(filtro)
                if cd_ccusto in CCUSTOS_LOJAS:
                    ccustos = [cd_ccusto]
                    nome_filtro = CCUSTOS_LOJAS[cd_ccusto]
                    tipo_filtro = "loja"
                elif cd_ccusto in CCUSTOS_FABRICA:
                    ccustos = [cd_ccusto]
                    nome_filtro = f"FABRICA CC {cd_ccusto}"
                    tipo_filtro = "fabrica"
                else:
                    raise HTTPException(status_code=400, detail=f"Centro de custo {cd_ccusto} nao encontrado")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

        periodos = services.gerar_periodos(dataInicio, dataFim)
        ccusto_placeholders = ",".join(["%s"] * len(ccustos))

        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.dt_liq as dt_referencia,
                d.dt_emissao as dt_emissao,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_liq >= %s
              AND d.dt_liq <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
        """
        despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS))
        print(f"[DFC] Total de despesas: {len(despesas)}")

        classificacoes_dfc_db = {}
        try:
            _criar_tabela_classificacao_dfc()
            rows_dfc = execute_query("SELECT cd_despesaitem, conta_dfc FROM classificacao_despesas_dfc", ())
            for row in rows_dfc or []:
                cd = row.get('cd_despesaitem')
                conta_dfc = row.get('conta_dfc', '')
                if cd and conta_dfc:
                    classificacoes_dfc_db[cd] = conta_dfc
        except Exception as e:
            print(f"[DFC] Aviso: nao foi possivel carregar classificacoes: {e}")

        valores_por_conta = {}
        nao_classificados = 0

        # Terceiro nivel (despesa individual) dentro de cada subgrupo/NAO_CLASSIFICADO
        despesas_por_subgrupo = {}  # subgrupo -> {cd_despesaitem -> valores}

        # Prazo Medio de Pagamento (PMP): media de (dt_baixa - dt_emissao) de
        # cada duplicata paga no periodo, ponderada pelo valor. pmp_por_subgrupo
        # guarda o mesmo calculo quebrado por subgrupo (OP.01, OP.02...).
        pmp_acc = {'dias': 0.0, 'valor': 0.0}
        pmp_por_subgrupo = {}

        def _pmp_subgrupo(scodigo):
            return pmp_por_subgrupo.setdefault(scodigo, {'dias': 0.0, 'valor': 0.0})
        # Prazo Medio de Recebimento (PMR): mesma logica, do lado da receita
        # (vr_fcr_faturai) - preenchido mais abaixo. pmr_por_subgrupo guarda
        # o mesmo calculo quebrado por tipo de documento (REC.01, REC.02...).
        pmr_acc = {'dias': 0.0, 'valor': 0.0}
        pmr_por_subgrupo = {}

        def _pmr_subgrupo(scodigo):
            return pmr_por_subgrupo.setdefault(scodigo, {'dias': 0.0, 'valor': 0.0})

        def _add_valor(codigo, periodo, valor):
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = {'total': 0}
                for p in periodos:
                    valores_por_conta[codigo][p] = 0
            valores_por_conta[codigo][periodo] += valor
            valores_por_conta[codigo]['total'] += valor

        def _add_valor_despesa(subgrupo, cd_despesaitem, descricao, periodo, valor):
            grupo_despesas = despesas_por_subgrupo.setdefault(subgrupo, {})
            if cd_despesaitem not in grupo_despesas:
                item = {'cdDespesaitem': cd_despesaitem, 'descricao': descricao or '', 'total': 0}
                for p in periodos:
                    item[p] = 0
                grupo_despesas[cd_despesaitem] = item
            grupo_despesas[cd_despesaitem][periodo] += valor
            grupo_despesas[cd_despesaitem]['total'] += valor

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            if sem_antecipacao and cd_despesaitem in DESPESAS_ZERADAS_SEM_ANTECIPACAO:
                continue
            descricao_despesa = d.get('descricao_despesa')
            subgrupo = _classificar_subgrupo_dfc(cd_despesaitem, classificacoes_dfc_db)
            valor = -abs(float(d['valor'] or 0))
            dt_referencia = d['dt_referencia']
            if not dt_referencia:
                continue
            periodo = dt_referencia.strftime('%Y-%m')
            if periodo not in periodos:
                continue

            if subgrupo == 'NAO_CLASSIFICADO':
                nao_classificados += 1

            _add_valor(subgrupo, periodo, valor)
            _add_valor_despesa(subgrupo, cd_despesaitem, descricao_despesa, periodo, valor)

            dt_emissao_despesa = d.get('dt_emissao')
            if dt_emissao_despesa:
                dias = (dt_referencia - dt_emissao_despesa).days
                if dias >= 0:
                    peso = abs(valor)
                    pmp_acc['dias'] += dias * peso
                    pmp_acc['valor'] += peso
                    if subgrupo != 'NAO_CLASSIFICADO':
                        pmp_sub = _pmp_subgrupo(subgrupo)
                        pmp_sub['dias'] += dias * peso
                        pmp_sub['valor'] += peso

        print(f"[DFC] Despesas nao classificadas: {nao_classificados}")

        # Lancamentos manuais (ex: pro-labore nao registrado no ERP) - entram
        # em todo periodo do range consultado, apenas se o ccusto do
        # lancamento estiver dentro do filtro selecionado.
        for lanc in LANCAMENTOS_MANUAIS_DFC:
            if lanc['ccusto'] not in ccustos:
                continue
            valor_lanc = -abs(lanc['valor_mensal'])
            for periodo in periodos:
                _add_valor(lanc['subgrupo'], periodo, valor_lanc)
                _add_valor_despesa(lanc['subgrupo'], lanc['cd_despesaitem'], lanc['descricao'], periodo, valor_lanc)

        despesas_por_subgrupo_resp = {
            subgrupo: list(itens.values()) for subgrupo, itens in despesas_por_subgrupo.items()
        }

        # Somar subgrupos -> grupo (OP / INV / FIN)
        for grupo in PLANO_CONTAS_DFC:
            gcodigo = grupo['codigo']
            valores_por_conta[gcodigo] = {'total': 0}
            for p in periodos:
                valores_por_conta[gcodigo][p] = 0
            for sub in grupo['subgrupos']:
                scodigo = sub['codigo']
                if scodigo not in valores_por_conta:
                    continue
                for p in periodos:
                    valores_por_conta[gcodigo][p] += valores_por_conta[scodigo][p]
                valores_por_conta[gcodigo]['total'] += valores_por_conta[scodigo]['total']

        # DEVOLUCOES: mesma fonte/logica de sempre (vr_tra_transacao, dt_transacao)
        devolucoes_brutas = _init_valores_periodo(periodos)

        # Pre-inicializa os subgrupos de recebimento com zero - garante que
        # existam em valores_por_conta mesmo se empresas_filtro ficar vazio.
        for scodigo in RECEBIMENTOS_TIPOS_DOCUMENTO:
            valores_por_conta[scodigo] = _init_valores_periodo(periodos)
        for scodigo in RECEBIMENTOS_DATA_CONSTRUIDA:
            valores_por_conta[scodigo] = _init_valores_periodo(periodos)

        empresas_filtro = []
        if tipo_filtro == "fabrica":
            empresas_filtro = [1]
        elif tipo_filtro == "loja":
            empresas_filtro = [c for c in ccustos if c in CCUSTOS_LOJAS]
        elif tipo_filtro == "consolidado":
            empresas_filtro = [1] + [c for c in ccustos if c in CCUSTOS_LOJAS]
        empresas_filtro = [e for e in set(empresas_filtro) if e not in EMPRESAS_EXCLUIDAS]

        if empresas_filtro:
            empresa_placeholders = ",".join(["%s"] * len(empresas_filtro))

            query_devolucoes = f"""
                SELECT t.dt_transacao, SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
                GROUP BY t.dt_transacao
            """
            devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *empresas_filtro))
            for dv in devolucoes:
                dt_transacao = dv['dt_transacao']
                if not dt_transacao:
                    continue
                periodo = dt_transacao.strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                valor = float(dv['valor'] or 0)
                devolucoes_brutas[periodo] -= abs(valor)
                devolucoes_brutas['total'] -= abs(valor)

            for scodigo in RECEBIMENTOS_TIPOS_DOCUMENTO:
                valores_por_conta[scodigo] = _init_valores_periodo(periodos)

            if sem_antecipacao:
                # Fatura/boleto SEM antecipacao: uma fatura antecipada tem
                # dt_baixa bem antes do dt_vencimento real (ex: vencimento
                # 10/03/2026 baixada em 31/12/2025) - isso distorce o mes em
                # que o caixa "deveria" ter entrado. Aqui so entram faturas
                # JA baixadas (dt_baixa IS NOT NULL), mas alocadas no mes do
                # VENCIMENTO original, nao no mes da baixa - desconsiderando
                # o efeito da antecipacao. Restrito a tp_documento=1,
                # nr_portador<999. Roda separado do resto (dt_vencimento em
                # vez de dt_baixa como recorte de periodo).
                query_fatura_sem_antecipacao = f"""
                    SELECT f.dt_vencimento, f.dt_emissao, f.vl_pago
                    FROM vr_fcr_faturai f
                    WHERE f.dt_baixa IS NOT NULL
                      AND f.tp_situacao = '1'
                      AND f.tp_documento = 1
                      AND f.nr_portador < 999
                      AND f.cd_empresa IN ({empresa_placeholders})
                      AND f.dt_vencimento >= %s
                      AND f.dt_vencimento <= %s
                """
                rows_fatura = execute_query(
                    query_fatura_sem_antecipacao, (*empresas_filtro, dataInicio, dataFim)
                )
                valores_subgrupo = valores_por_conta['REC.03']
                for row in rows_fatura or []:
                    dt_vencimento = row['dt_vencimento']
                    if not dt_vencimento:
                        continue
                    periodo = dt_vencimento.strftime('%Y-%m')
                    if periodo not in periodos:
                        continue
                    valor = float(row['vl_pago'] or 0)
                    valores_subgrupo[periodo] += valor
                    valores_subgrupo['total'] += valor

                    dt_emissao = row['dt_emissao']
                    if dt_emissao:
                        dias = (dt_vencimento - dt_emissao).days
                        if dias >= 0:
                            pmr_acc['dias'] += dias * valor
                            pmr_acc['valor'] += valor
                            pmr_sub = _pmr_subgrupo('REC.03')
                            pmr_sub['dias'] += dias * valor
                            pmr_sub['valor'] += valor

            # RECEBIMENTOS por tp_documento (vr_fcr_faturai, regime de caixa -
            # dt_baixa). Cada subgrupo em RECEBIMENTOS_TIPOS_DOCUMENTO soma os
            # tp_documento em 'soma' e subtrai os em 'subtrai' (ex: dinheiro
            # menos troco). A consultoria vai mandando os demais tipos aos
            # poucos - o que ainda nao tiver mapeado simplesmente nao aparece.
            # Todos os tp_documento pendentes vem de UMA SO consulta (em vez
            # de uma por tipo) - vr_fcr_faturai e uma view cara de acessar
            # (cada ida custa varios segundos fixos, quase independente da
            # quantidade de linhas), entao menos idas ao banco = bem mais
            # rapido, sem mudar nenhum resultado.
            mapa_tp_documento = {}
            for scodigo, tipos in RECEBIMENTOS_TIPOS_DOCUMENTO.items():
                if scodigo == 'REC.03' and sem_antecipacao:
                    continue
                for tp in tipos.get('soma', []):
                    mapa_tp_documento[tp] = (scodigo, 1)
                for tp in tipos.get('subtrai', []):
                    mapa_tp_documento[tp] = (scodigo, -1)

            if mapa_tp_documento:
                tp_documento_placeholders = ",".join(["%s"] * len(mapa_tp_documento))
                query_tipo_documento = f"""
                    SELECT f.dt_baixa, f.dt_emissao, f.tp_documento, SUM(f.vl_pago) as valor
                    FROM vr_fcr_faturai f
                    WHERE f.dt_baixa >= %s AND f.dt_baixa <= %s
                      AND f.tp_situacao = '1'
                      AND f.tp_documento IN ({tp_documento_placeholders})
                      AND f.cd_empresa IN ({empresa_placeholders})
                    GROUP BY f.dt_baixa, f.dt_emissao, f.tp_documento
                """
                rows_tipo_documento = execute_query(
                    query_tipo_documento,
                    (dataInicio, dataFim, *mapa_tp_documento.keys(), *empresas_filtro)
                )
                for row in rows_tipo_documento or []:
                    dt_baixa = row['dt_baixa']
                    if not dt_baixa:
                        continue
                    periodo = dt_baixa.strftime('%Y-%m')
                    if periodo not in periodos:
                        continue
                    scodigo, sinal = mapa_tp_documento[row['tp_documento']]
                    valor_bruto = float(row['valor'] or 0)
                    valor = sinal * valor_bruto
                    destino = valores_por_conta[scodigo]
                    destino[periodo] += valor
                    destino['total'] += valor

                    dt_emissao = row['dt_emissao']
                    if dt_emissao and sinal > 0:
                        dias = (dt_baixa - dt_emissao).days
                        if dias >= 0:
                            pmr_acc['dias'] += dias * valor_bruto
                            pmr_acc['valor'] += valor_bruto
                            pmr_sub = _pmr_subgrupo(scodigo)
                            pmr_sub['dias'] += dias * valor_bruto
                            pmr_sub['valor'] += valor_bruto

            # RECEBIMENTOS com data de entrada no caixa CONSTRUIDA (ex: cartao
            # de credito - a dt_baixa nunca vem preenchida na fonte, entao a
            # gente estima D+N dias uteis a partir da dt_emissao). Busca por
            # dt_emissao com uma folga pra tras (pior caso: qui->seg = +4 dias
            # corridos) e filtra pela data CONSTRUIDA depois, em Python.
            data_inicio_dt = datetime.strptime(dataInicio, '%Y-%m-%d')
            data_inicio_buffer = (data_inicio_dt - timedelta(days=10)).strftime('%Y-%m-%d')

            # Buffer bem maior para o cartao de credito "sem antecipacao":
            # cada parcela pode ficar ate 30*nr_parcelas dias depois da
            # emissao (ja vimos parcelamento de ate 20x na base), entao a
            # janela de busca por dt_emissao precisa olhar bem mais pra tras.
            data_inicio_buffer_cartao = (data_inicio_dt - timedelta(days=630)).strftime('%Y-%m-%d')

            for scodigo, cfg in RECEBIMENTOS_DATA_CONSTRUIDA.items():
                valores_subgrupo = _init_valores_periodo(periodos)

                if scodigo == 'REC.04' and sem_antecipacao:
                    # Cartao de credito SEM antecipacao: em vez de D+2 dias
                    # uteis (liquidacao da adquirente, hoje tratado como
                    # totalmente antecipado), cada parcela e reconhecida na
                    # data em que o cliente efetivamente pagaria - emissao +
                    # 30 dias corridos por numero da parcela (1a = +30, 2a =
                    # +60, 3a = +90...). Mostra como seria o fluxo de caixa
                    # se o recebivel nao fosse antecipado.
                    query_sem_antecipacao = f"""
                        SELECT f.dt_emissao, f.nr_parcela, f.vl_fatura
                        FROM vr_fcr_faturai f
                        WHERE f.tp_situacao = '1'
                          AND f.tp_documento = %s
                          AND f.tp_cobranca = %s
                          AND f.cd_empresa IN ({empresa_placeholders})
                          AND f.dt_emissao >= %s
                          AND f.dt_emissao <= %s
                    """
                    rows_sem_antecipacao = execute_query(
                        query_sem_antecipacao,
                        (cfg['tp_documento'], cfg['tp_cobranca'], *empresas_filtro, data_inicio_buffer_cartao, dataFim)
                    )
                    for row in rows_sem_antecipacao or []:
                        dt_emissao = row['dt_emissao']
                        nr_parcela = row.get('nr_parcela')
                        if not dt_emissao or not nr_parcela or nr_parcela < 1:
                            continue
                        dt_construida = dt_emissao + timedelta(days=30 * nr_parcela)
                        periodo = dt_construida.strftime('%Y-%m')
                        if periodo not in periodos:
                            continue
                        valor = float(row['vl_fatura'] or 0)
                        valores_subgrupo[periodo] += valor
                        valores_subgrupo['total'] += valor

                        dias = (dt_construida - dt_emissao).days
                        if dias >= 0:
                            pmr_acc['dias'] += dias * valor
                            pmr_acc['valor'] += valor
                            pmr_sub = _pmr_subgrupo(scodigo)
                            pmr_sub['dias'] += dias * valor
                            pmr_sub['valor'] += valor
                    valores_por_conta[scodigo] = valores_subgrupo
                    continue

                where_extra = ""
                params_extra = []
                if cfg.get('tp_cobranca') is not None:
                    where_extra = "AND f.tp_cobranca = %s"
                    params_extra = [cfg['tp_cobranca']]

                query_construida = f"""
                    SELECT f.dt_emissao, f.vl_fatura
                    FROM vr_fcr_faturai f
                    WHERE f.tp_situacao = '1'
                      AND f.tp_documento = %s
                      {where_extra}
                      AND f.cd_empresa IN ({empresa_placeholders})
                      AND f.dt_emissao >= %s
                      AND f.dt_emissao <= %s
                """
                rows_construida = execute_query(
                    query_construida,
                    (cfg['tp_documento'], *params_extra, *empresas_filtro, data_inicio_buffer, dataFim)
                )
                for row in rows_construida or []:
                    dt_emissao = row['dt_emissao']
                    if not dt_emissao:
                        continue
                    dt_construida = _somar_dias_uteis(dt_emissao, cfg['dias_uteis'])
                    periodo = dt_construida.strftime('%Y-%m')
                    if periodo not in periodos:
                        continue
                    valor = float(row['vl_fatura'] or 0)
                    valores_subgrupo[periodo] += valor
                    valores_subgrupo['total'] += valor

                    dias = (dt_construida - dt_emissao).days
                    if dias >= 0:
                        pmr_acc['dias'] += dias * valor
                        pmr_acc['valor'] += valor
                        pmr_sub = _pmr_subgrupo(scodigo)
                        pmr_sub['dias'] += dias * valor
                        pmr_sub['valor'] += valor
                valores_por_conta[scodigo] = valores_subgrupo

        valores_por_conta[CODIGO_DEVOLUCOES_RECEITA] = devolucoes_brutas
        for grupo_receita in PLANO_RECEITA_DFC:
            gcodigo = grupo_receita['codigo']
            valores_por_conta[gcodigo] = {'total': 0}
            for p in periodos:
                valores_por_conta[gcodigo][p] = 0
            for sub in grupo_receita['subgrupos']:
                scodigo = sub['codigo']
                for p in periodos:
                    valores_por_conta[gcodigo][p] += valores_por_conta[scodigo][p]
                valores_por_conta[gcodigo]['total'] += valores_por_conta[scodigo]['total']

        # SALDO = receita liquida (grupo REC) + soma dos grupos de despesa (ja
        # negativos) + despesas ainda nao classificadas (tambem saida real de
        # caixa - sem isso o saldo final nao reconciliava com o caixa real).
        valores_nao_classificado = valores_por_conta.get('NAO_CLASSIFICADO', _init_valores_periodo(periodos))
        saldo = _init_valores_periodo(periodos)
        for p in periodos:
            saldo[p] = (
                valores_por_conta['REC'][p]
                + valores_por_conta['OP'][p] + valores_por_conta['INV'][p] + valores_por_conta['FIN'][p]
                + valores_nao_classificado[p]
            )
            saldo['total'] += saldo[p]
        valores_por_conta['SALDO'] = saldo

        periodos_response = [
            {"key": p, "label": f"{p.split('-')[1]}/{p.split('-')[0][2:]}"}
            for p in periodos
        ]

        prazo_medio_pagamento = (pmp_acc['dias'] / pmp_acc['valor']) if pmp_acc['valor'] > 0 else None
        prazo_medio_recebimento = (pmr_acc['dias'] / pmr_acc['valor']) if pmr_acc['valor'] > 0 else None
        prazo_medio_recebimento_por_subgrupo = {
            scodigo: (acc['dias'] / acc['valor'])
            for scodigo, acc in pmr_por_subgrupo.items()
            if acc['valor'] > 0
        }
        prazo_medio_pagamento_por_subgrupo = {
            scodigo: (acc['dias'] / acc['valor'])
            for scodigo, acc in pmp_por_subgrupo.items()
            if acc['valor'] > 0
        }
        prazo_medio_estocagem = _calcular_prazo_medio_estocagem(dataFim)

        return {
            "periodos": periodos_response,
            "valores": valores_por_conta,
            "despesasPorSubgrupo": despesas_por_subgrupo_resp,
            "metadata": {
                "filtro": filtro,
                "nomeFiltro": nome_filtro,
                "tipoFiltro": tipo_filtro,
                "centrosCusto": ccustos,
                "empresas": empresas_filtro if empresas_filtro else [],
                "naoClassificados": nao_classificados,
                "prazoMedioRecebimento": prazo_medio_recebimento,
                "prazoMedioPagamento": prazo_medio_pagamento,
                "prazoMedioRecebimentoPorSubgrupo": prazo_medio_recebimento_por_subgrupo,
                "prazoMedioPagamentoPorSubgrupo": prazo_medio_pagamento_por_subgrupo,
                "prazoMedioEstocagem": prazo_medio_estocagem,
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat()
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao processar DFC: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar dados do DFC: {str(e)}")


def _calcular_dfc_por_centro_custo(dataInicio: str, dataFim: str):
    """
    Mesma logica de _calcular_valores_dfc, mas pivotada: em vez de colunas
    serem meses, cada coluna e uma "entidade" - cada loja ativa individualmente,
    mais UMA coluna "FABRICA" agrupando todos os centros de custo internos da
    fabrica (1, 500-514). Valores sao o total do periodo inteiro (sem quebra
    por mes). PMR/PMP/PME sao calculados de forma global (nao quebrados por
    centro de custo) para manter os cards do topo sempre preenchidos.
    """
    try:
        print(f"[INFO] Buscando DFC por Centro de Custo: {dataInicio} ate {dataFim}")

        entidades = [{"codigo": "1", "nome": "FABRICA"}] + [
            {"codigo": str(cd), "nome": CCUSTOS_LOJAS[cd]} for cd in CCUSTOS_LOJAS_ATIVOS
        ]
        entidade_keys = [e["codigo"] for e in entidades]

        def _empresa_key_ccusto(cd_ccusto):
            # Mesma logica de agrupamento de _agrupar_ccusto_dre_por_empresa:
            # 49 e 515 nao tem coluna propria - 49 cai no ecommerce (120) e
            # 515 (diretoria) cai na fabrica (>120), igual a aba "Por Empresa" da DRE.
            if cd_ccusto in CCUSTOS_ECOMMERCE:
                return str(CCUSTO_ECOMMERCE_AGRUPADO)
            if cd_ccusto == 1 or cd_ccusto > 120:
                return "1"
            if cd_ccusto in CCUSTOS_LOJAS_ATIVOS:
                return str(cd_ccusto)
            return None

        ccustos_todos = list(set(CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys()) + CCUSTOS_ECOMMERCE + [515]))
        ccusto_placeholders = ",".join(["%s"] * len(ccustos_todos))
        ccusto_excluidos_placeholders = ",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))

        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                d.cd_ccusto,
                d.dt_liq as dt_referencia,
                d.dt_emissao as dt_emissao,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            WHERE d.dt_liq >= %s
              AND d.dt_liq <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({ccusto_excluidos_placeholders})
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
        """
        despesas = execute_query(
            query_despesas,
            (dataInicio, dataFim, *ccustos_todos, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS)
        )
        print(f"[DFC-CCUSTO] Total de despesas: {len(despesas)}")

        classificacoes_dfc_db = {}
        try:
            _criar_tabela_classificacao_dfc()
            rows_dfc = execute_query("SELECT cd_despesaitem, conta_dfc FROM classificacao_despesas_dfc", ())
            for row in rows_dfc or []:
                cd = row.get('cd_despesaitem')
                conta_dfc = row.get('conta_dfc', '')
                if cd and conta_dfc:
                    classificacoes_dfc_db[cd] = conta_dfc
        except Exception as e:
            print(f"[DFC-CCUSTO] Aviso: nao foi possivel carregar classificacoes: {e}")

        valores_por_conta = {}

        def _add_valor(codigo, empresa_key, valor):
            if codigo not in valores_por_conta:
                valores_por_conta[codigo] = _init_valores_periodo(entidade_keys)
            if empresa_key in valores_por_conta[codigo]:
                valores_por_conta[codigo][empresa_key] += valor
            valores_por_conta[codigo]['total'] += valor

        # PMR/PMP globais (nao quebrados por centro de custo) - mesma logica
        # de _calcular_valores_dfc, para os cards do topo continuarem
        # preenchidos mesmo nessa visao.
        pmp_acc = {'dias': 0.0, 'valor': 0.0}
        pmr_acc = {'dias': 0.0, 'valor': 0.0}

        for d in despesas:
            subgrupo = _classificar_subgrupo_dfc(d['cd_despesaitem'], classificacoes_dfc_db)
            valor = -abs(float(d['valor'] or 0))
            empresa_key = _empresa_key_ccusto(d['cd_ccusto'])
            _add_valor(subgrupo, empresa_key, valor)

            dt_referencia = d.get('dt_referencia')
            dt_emissao_despesa = d.get('dt_emissao')
            if dt_referencia and dt_emissao_despesa:
                dias = (dt_referencia - dt_emissao_despesa).days
                if dias >= 0:
                    peso = abs(valor)
                    pmp_acc['dias'] += dias * peso
                    pmp_acc['valor'] += peso

        # Lancamentos manuais (ex: pro-labore nao registrado no ERP) - o
        # valor mensal e multiplicado pela quantidade de meses do periodo
        # consultado (essa visao nao quebra por mes, so total do periodo),
        # pra reconciliar com o mesmo lancamento em _calcular_valores_dfc.
        qtd_periodos_lanc = len(services.gerar_periodos(dataInicio, dataFim))
        for lanc in LANCAMENTOS_MANUAIS_DFC:
            empresa_key_lanc = _empresa_key_ccusto(lanc['ccusto'])
            if empresa_key_lanc is None:
                continue
            _add_valor(lanc['subgrupo'], empresa_key_lanc, -abs(lanc['valor_mensal']) * qtd_periodos_lanc)

        # Somar subgrupos -> grupo (OP / INV / FIN)
        for grupo in PLANO_CONTAS_DFC:
            gcodigo = grupo['codigo']
            valores_por_conta[gcodigo] = _init_valores_periodo(entidade_keys)
            for sub in grupo['subgrupos']:
                scodigo = sub['codigo']
                if scodigo not in valores_por_conta:
                    continue
                for k in entidade_keys:
                    valores_por_conta[gcodigo][k] += valores_por_conta[scodigo][k]
                valores_por_conta[gcodigo]['total'] += valores_por_conta[scodigo]['total']

        # DEVOLUCOES e RECEBIMENTOS - mesma fonte/logica do DFC principal,
        # so que agora quebrado por cd_empresa (1 = fabrica, ou codigo da loja)
        # em vez de por periodo.
        empresas_filtro = [e for e in (int(k) for k in entidade_keys) if e not in EMPRESAS_EXCLUIDAS]
        empresa_placeholders = ",".join(["%s"] * len(empresas_filtro))

        devolucoes_brutas = _init_valores_periodo(entidade_keys)
        for scodigo in RECEBIMENTOS_TIPOS_DOCUMENTO:
            valores_por_conta[scodigo] = _init_valores_periodo(entidade_keys)
        for scodigo in RECEBIMENTOS_DATA_CONSTRUIDA:
            valores_por_conta[scodigo] = _init_valores_periodo(entidade_keys)

        if empresas_filtro:
            query_devolucoes = f"""
                SELECT t.cd_empresa, SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
                GROUP BY t.cd_empresa
            """
            devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *empresas_filtro))
            for dv in devolucoes or []:
                empresa_key = str(dv['cd_empresa'])
                if empresa_key not in entidade_keys:
                    continue
                valor = float(dv['valor'] or 0)
                devolucoes_brutas[empresa_key] -= abs(valor)
                devolucoes_brutas['total'] -= abs(valor)

            # Todos os tp_documento pendentes vem de UMA SO consulta (em vez
            # de uma por tipo) - vr_fcr_faturai e uma view cara de acessar
            # (custo quase fixo por ida ao banco, independente da quantidade
            # de linhas), entao menos idas ao banco = bem mais rapido, sem
            # mudar nenhum resultado.
            mapa_tp_documento = {}
            for scodigo, tipos in RECEBIMENTOS_TIPOS_DOCUMENTO.items():
                for tp in tipos.get('soma', []):
                    mapa_tp_documento[tp] = (scodigo, 1)
                for tp in tipos.get('subtrai', []):
                    mapa_tp_documento[tp] = (scodigo, -1)

            if mapa_tp_documento:
                tp_documento_placeholders = ",".join(["%s"] * len(mapa_tp_documento))
                query_tipo_documento = f"""
                    SELECT f.dt_baixa, f.dt_emissao, f.cd_empresa, f.tp_documento, SUM(f.vl_pago) as valor
                    FROM vr_fcr_faturai f
                    WHERE f.dt_baixa >= %s AND f.dt_baixa <= %s
                      AND f.tp_situacao = '1'
                      AND f.tp_documento IN ({tp_documento_placeholders})
                      AND f.cd_empresa IN ({empresa_placeholders})
                    GROUP BY f.dt_baixa, f.dt_emissao, f.cd_empresa, f.tp_documento
                """
                rows_tipo_documento = execute_query(
                    query_tipo_documento,
                    (dataInicio, dataFim, *mapa_tp_documento.keys(), *empresas_filtro)
                )
                for row in rows_tipo_documento or []:
                    empresa_key = str(row['cd_empresa'])
                    if empresa_key not in entidade_keys:
                        continue
                    scodigo, sinal = mapa_tp_documento[row['tp_documento']]
                    valor_bruto = float(row['valor'] or 0)
                    valor = sinal * valor_bruto
                    destino = valores_por_conta[scodigo]
                    destino[empresa_key] += valor
                    destino['total'] += valor

                    dt_baixa = row['dt_baixa']
                    dt_emissao = row['dt_emissao']
                    if dt_baixa and dt_emissao and sinal > 0:
                        dias = (dt_baixa - dt_emissao).days
                        if dias >= 0:
                            pmr_acc['dias'] += dias * valor_bruto
                            pmr_acc['valor'] += valor_bruto

            data_inicio_dt = datetime.strptime(dataInicio, '%Y-%m-%d')
            data_fim_dt = datetime.strptime(dataFim, '%Y-%m-%d')
            data_inicio_buffer = (data_inicio_dt - timedelta(days=10)).strftime('%Y-%m-%d')

            for scodigo, cfg in RECEBIMENTOS_DATA_CONSTRUIDA.items():
                valores_subgrupo = _init_valores_periodo(entidade_keys)
                where_extra = ""
                params_extra = []
                if cfg.get('tp_cobranca') is not None:
                    where_extra = "AND f.tp_cobranca = %s"
                    params_extra = [cfg['tp_cobranca']]

                query_construida = f"""
                    SELECT f.dt_emissao, f.cd_empresa, f.vl_fatura
                    FROM vr_fcr_faturai f
                    WHERE f.tp_situacao = '1'
                      AND f.tp_documento = %s
                      {where_extra}
                      AND f.cd_empresa IN ({empresa_placeholders})
                      AND f.dt_emissao >= %s
                      AND f.dt_emissao <= %s
                """
                rows_construida = execute_query(
                    query_construida,
                    (cfg['tp_documento'], *params_extra, *empresas_filtro, data_inicio_buffer, dataFim)
                )
                for row in rows_construida or []:
                    dt_emissao = row['dt_emissao']
                    if not dt_emissao:
                        continue
                    dt_construida = _somar_dias_uteis(dt_emissao, cfg['dias_uteis'])
                    if dt_construida < data_inicio_dt or dt_construida > data_fim_dt:
                        continue
                    empresa_key = str(row['cd_empresa'])
                    if empresa_key not in entidade_keys:
                        continue
                    valor = float(row['vl_fatura'] or 0)
                    valores_subgrupo[empresa_key] += valor
                    valores_subgrupo['total'] += valor

                    dias = (dt_construida - dt_emissao).days
                    if dias >= 0:
                        pmr_acc['dias'] += dias * valor
                        pmr_acc['valor'] += valor
                valores_por_conta[scodigo] = valores_subgrupo

        valores_por_conta[CODIGO_DEVOLUCOES_RECEITA] = devolucoes_brutas
        for grupo_receita in PLANO_RECEITA_DFC:
            gcodigo = grupo_receita['codigo']
            valores_por_conta[gcodigo] = _init_valores_periodo(entidade_keys)
            for sub in grupo_receita['subgrupos']:
                scodigo = sub['codigo']
                for k in entidade_keys:
                    valores_por_conta[gcodigo][k] += valores_por_conta[scodigo][k]
                valores_por_conta[gcodigo]['total'] += valores_por_conta[scodigo]['total']

        valores_nao_classificado = valores_por_conta.get('NAO_CLASSIFICADO', _init_valores_periodo(entidade_keys))
        saldo = _init_valores_periodo(entidade_keys)
        for k in entidade_keys:
            saldo[k] = (
                valores_por_conta['REC'][k]
                + valores_por_conta['OP'][k] + valores_por_conta['INV'][k] + valores_por_conta['FIN'][k]
                + valores_nao_classificado[k]
            )
            saldo['total'] += saldo[k]
        valores_por_conta['SALDO'] = saldo

        prazo_medio_pagamento = (pmp_acc['dias'] / pmp_acc['valor']) if pmp_acc['valor'] > 0 else None
        prazo_medio_recebimento = (pmr_acc['dias'] / pmr_acc['valor']) if pmr_acc['valor'] > 0 else None
        prazo_medio_estocagem = _calcular_prazo_medio_estocagem(dataFim)

        return {
            "centrosCusto": entidades,
            "valores": valores_por_conta,
            "metadata": {
                "totalCentrosCusto": len(entidades),
                "prazoMedioRecebimento": prazo_medio_recebimento,
                "prazoMedioPagamento": prazo_medio_pagamento,
                "prazoMedioEstocagem": prazo_medio_estocagem,
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat()
            }
        }
    except Exception as e:
        print(f"[ERROR] Erro ao processar DFC por Centro de Custo: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar DFC por centro de custo: {str(e)}")


def _calcular_dre_x_dfc_operacional(dataInicio: str, dataFim: str, filtro: str):
    """
    Compara DRE (regime de competencia) com DFC Operacional (regime de
    caixa, base SEM ANTECIPACAO) - so o grupo OP/REC do DFC, sem
    Investimentos/Financiamento (esses nao tem contrapartida na DRE).

    O lado caixa usa sempre a base "sem antecipacao" (mesma logica da aba
    "Mensal - Sem Antecipacao" do DFC): fatura ja baixada entra no mes do
    VENCIMENTO original (nao no mes da baixa, que pode vir antecipada), e
    cartao de credito e reconhecido por parcela (emissao + 30*parcela dias)
    em vez de tudo somado em emissao + 2 dias uteis. Faz mais sentido pra
    esse comparativo: descasamento de prazo "de verdade" (competencia x
    caixa normal), sem misturar com o efeito de antecipar recebiveis.

    A ideia central do lado despesa: toda despesa classificada no DFC
    (cd_despesaitem) ja carrega, na mesma linha, tanto dt_emissao (o que a
    DRE usa) quanto dt_liq (o que o DFC usa) - e a MESMA classificacao de
    subgrupo serve pras duas visoes (o DFC so tem override proprio quando
    precisa divergir da DRE, o resto herda a classificacao DRE). Entao em
    vez de rodar duas consultas e tentar casar por codigo de conta depois,
    a despesa e lida UMA VEZ e jogada em duas "gavetas" (competencia = mes
    de dt_emissao, caixa = mes de dt_liq) na mesma passada.

    A receita ja nao tem essa sorte: a DRE calcula venda bruta a partir de
    vr_tra_transacao (dt_transacao), o DFC calcula recebimento a partir de
    vr_fcr_faturai (dt_baixa/data construida) - sao tabelas/eventos
    diferentes, entao aqui sim rodamos duas consultas independentes.
    """
    try:
        print(f"[INFO] Buscando DRE x DFC Operacional: {dataInicio} ate {dataFim}, filtro={filtro}")

        if filtro == "consolidado":
            ccustos = list(set(CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys()) + CCUSTOS_ECOMMERCE + [515]))
            nome_filtro = "CONSOLIDADO"
            tipo_filtro = "consolidado"
        elif filtro == "fabrica":
            ccustos = CCUSTOS_FABRICA
            nome_filtro = "FABRICA"
            tipo_filtro = "fabrica"
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
        else:
            try:
                cd_ccusto = int(filtro)
                if cd_ccusto in CCUSTOS_LOJAS:
                    ccustos = [cd_ccusto]
                    nome_filtro = CCUSTOS_LOJAS[cd_ccusto]
                    tipo_filtro = "loja"
                elif cd_ccusto in CCUSTOS_FABRICA:
                    ccustos = [cd_ccusto]
                    nome_filtro = f"FABRICA CC {cd_ccusto}"
                    tipo_filtro = "fabrica"
                else:
                    raise HTTPException(status_code=400, detail=f"Centro de custo {cd_ccusto} nao encontrado")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Filtro invalido: {filtro}")

        periodos = services.gerar_periodos(dataInicio, dataFim)
        ccusto_placeholders = ",".join(["%s"] * len(ccustos))

        empresas_filtro = []
        if tipo_filtro == "fabrica":
            empresas_filtro = [1]
        elif tipo_filtro == "loja":
            empresas_filtro = [c for c in ccustos if c in CCUSTOS_LOJAS]
        elif tipo_filtro == "consolidado":
            empresas_filtro = [1] + [c for c in ccustos if c in CCUSTOS_LOJAS]
        empresas_filtro = [e for e in set(empresas_filtro) if e not in EMPRESAS_EXCLUIDAS]

        classificacoes_dfc_db = {}
        try:
            _criar_tabela_classificacao_dfc()
            rows_dfc = execute_query("SELECT cd_despesaitem, conta_dfc FROM classificacao_despesas_dfc", ())
            for row in rows_dfc or []:
                cd = row.get('cd_despesaitem')
                conta_dfc = row.get('conta_dfc', '')
                if cd and conta_dfc:
                    classificacoes_dfc_db[cd] = conta_dfc
        except Exception as e:
            print(f"[DRE-X-DFC] Aviso: nao foi possivel carregar classificacoes DFC: {e}")

        # Classificacao REAL da DRE - usada so pra saber se a despesa existe
        # de verdade na DRE (senao ela nunca aparece na Lucro Liquido da DRE,
        # so fica pendurada em NAO_CLASSIFICADO e some dos totais). Sem isso,
        # o "Resultado Competencia" contaria despesa que a DRE nunca contou.
        classificacoes_dre_db = {}
        try:
            rows_dre = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows_dre or []:
                cd = row.get('cd_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_dre_db[cd] = codigo
        except Exception as e:
            print(f"[DRE-X-DFC] Aviso: nao foi possivel carregar classificacoes DRE: {e}")

        # =====================================================================
        # DESPESAS: uma unica consulta, bucketizada por dt_emissao (DRE) e
        # por dt_liq (DFC) ao mesmo tempo, por subgrupo do OP.
        # =====================================================================
        competencia_despesa = {}
        caixa_despesa = {}

        def _add(destino, subgrupo, periodo, valor):
            if subgrupo not in destino:
                destino[subgrupo] = _init_valores_periodo(periodos)
            destino[subgrupo][periodo] += valor
            destino[subgrupo]['total'] += valor

        query_despesas = f"""
            SELECT d.cd_despesaitem, i.ds_despesaitem as descricao_despesa, d.dt_emissao, d.dt_liq, ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
              AND (
                    (d.dt_emissao >= %s AND d.dt_emissao <= %s)
                 OR (d.dt_liq >= %s AND d.dt_liq <= %s)
              )
        """
        despesas = execute_query(
            query_despesas,
            (*ccustos, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS,
             dataInicio, dataFim, dataInicio, dataFim)
        )
        print(f"[DRE-X-DFC] Total de despesas: {len(despesas)}")

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            subgrupo = _classificar_subgrupo_dfc(cd_despesaitem, classificacoes_dfc_db)
            valor = -abs(float(d['valor'] or 0))

            # OP.01 (Custos com Materia Prima) e um caso especial: no lado
            # caixa isso e a duplicata de compra realmente paga (dt_liq,
            # como o resto). Mas na competencia, a DRE NAO usa a data de
            # emissao da compra pra CMV - usa um calculo sintetico casado
            # com a VENDA (mv_cmv_fab/mv_cmv_loja_v2), sem nenhuma relacao
            # com quando a materia-prima foi comprada. Por isso a competencia
            # de OP.01 e preenchida a parte, depois deste loop - aqui so
            # populamos o lado caixa pra esse subgrupo.
            if subgrupo != 'OP.01':
                # A despesa so entra na competencia se REALMENTE existir na
                # classificacao da DRE - senao ela nunca aparece no Lucro
                # Liquido oficial da DRE (fica presa em NAO_CLASSIFICADO e
                # some dos totais, ver _somar_hierarquia). Sem esse cheque,
                # o Resultado Competencia contava despesa que a DRE nunca
                # contou (ja achamos R$26,5 milhoes so em 2025).
                conta_dre_real = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_dre_db)
                subgrupo_competencia = subgrupo if conta_dre_real not in ('NAO_CLASSIFICADO', 'EXCLUIDO') else 'NAO_CLASSIFICADO'
                dt_emissao = d.get('dt_emissao')
                if dt_emissao:
                    periodo = dt_emissao.strftime('%Y-%m')
                    if periodo in periodos:
                        _add(competencia_despesa, subgrupo_competencia, periodo, valor)

            # Lado caixa usa a base "sem antecipacao": juros e recompra de
            # titulos sao o custo direto de antecipar recebiveis - como o
            # lado caixa desconsidera a antecipacao, essas duas despesas
            # somem daqui tambem (continuam normalmente na competencia).
            if cd_despesaitem in DESPESAS_ZERADAS_SEM_ANTECIPACAO:
                continue

            dt_liq = d.get('dt_liq')
            if dt_liq:
                periodo = dt_liq.strftime('%Y-%m')
                if periodo in periodos:
                    _add(caixa_despesa, subgrupo, periodo, valor)

        # Lancamentos manuais (ex: pro-labore) - sem despesa real por tras,
        # entao nao ha "emissao" separada da "baixa": entra igual nas duas
        # gavetas, pra nao criar um descasamento artificial no resumo.
        for lanc in LANCAMENTOS_MANUAIS_DFC:
            if lanc['ccusto'] not in ccustos:
                continue
            valor_lanc = -abs(lanc['valor_mensal'])
            for periodo in periodos:
                _add(competencia_despesa, lanc['subgrupo'], periodo, valor_lanc)
                _add(caixa_despesa, lanc['subgrupo'], periodo, valor_lanc)

        # CMV (OP.01 na competencia): calculo sintetico da DRE, casado com a
        # venda (mv_cmv_fab/mv_cmv_loja_v2) - mesma logica/fonte de
        # _calcular_valores_unificada. Nao tem nenhuma relacao com dt_emissao
        # de duplicata de compra, entao e calculado a parte do loop acima.
        usar_cmv_fab = tipo_filtro in ('consolidado', 'fabrica')
        usar_cmv_loja = tipo_filtro in ('consolidado', 'loja')
        cmv_competencia = _init_valores_periodo(periodos)

        if usar_cmv_fab:
            try:
                query_cmv_fab = """
                    SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
                    FROM mv_cmv_fab
                    WHERE data >= %s AND data <= %s
                    GROUP BY DATE_TRUNC('month', data)
                """
                for c in execute_query(query_cmv_fab, (dataInicio, dataFim)) or []:
                    dt = c['mes']
                    if not dt:
                        continue
                    periodo = dt.strftime('%Y-%m')
                    if periodo not in periodos:
                        continue
                    valor = -abs(float(c['cmv'] or 0))
                    cmv_competencia[periodo] += valor
                    cmv_competencia['total'] += valor
            except Exception as e:
                print(f"[DRE-X-DFC] Erro ao buscar CMV fabrica: {e}")

        if usar_cmv_loja:
            try:
                ccustos_lojas_filtro = [c for c in ccustos if c in CCUSTOS_LOJAS]
                if ccustos_lojas_filtro:
                    ccusto_placeholders_loja = ",".join(["%s"] * len(ccustos_lojas_filtro))
                    query_cmv_loja = f"""
                        SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
                        FROM mv_cmv_loja_v2
                        WHERE data >= %s AND data <= %s
                          AND idcentrodecusto IN ({ccusto_placeholders_loja})
                        GROUP BY DATE_TRUNC('month', data)
                    """
                    for c in execute_query(query_cmv_loja, (dataInicio, dataFim, *ccustos_lojas_filtro)) or []:
                        dt = c['mes']
                        if not dt:
                            continue
                        periodo = dt.strftime('%Y-%m')
                        if periodo not in periodos:
                            continue
                        valor = -abs(float(c['cmv'] or 0))
                        cmv_competencia[periodo] += valor
                        cmv_competencia['total'] += valor
            except Exception as e:
                print(f"[DRE-X-DFC] Erro ao buscar CMV lojas: {e}")

        competencia_despesa['OP.01'] = cmv_competencia

        # Grupo OP (soma dos subgrupos) nas duas visoes
        op_competencia = _init_valores_periodo(periodos)
        op_caixa = _init_valores_periodo(periodos)
        subgrupos_op = {s['codigo'] for grupo in PLANO_CONTAS_DFC if grupo['codigo'] == 'OP' for s in grupo['subgrupos']}
        for scodigo in subgrupos_op:
            if scodigo in competencia_despesa:
                for p in periodos:
                    op_competencia[p] += competencia_despesa[scodigo][p]
                op_competencia['total'] += competencia_despesa[scodigo]['total']
            if scodigo in caixa_despesa:
                for p in periodos:
                    op_caixa[p] += caixa_despesa[scodigo][p]
                op_caixa['total'] += caixa_despesa[scodigo]['total']

        # =====================================================================
        # RECEITA: duas fontes diferentes - vendas (DRE) x recebimentos (DFC).
        # =====================================================================
        receita_competencia = _init_valores_periodo(periodos)
        receita_caixa = _init_valores_periodo(periodos)

        if empresas_filtro:
            empresa_placeholders = ",".join(["%s"] * len(empresas_filtro))

            # --- Competencia (DRE): vendas brutas - devolucoes, por dt_transacao ---
            query_vendas = f"""
                SELECT t.dt_transacao, SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('4')
                  AND t.tp_operacao = 'S'
                GROUP BY t.dt_transacao
            """
            for row in execute_query(query_vendas, (dataInicio, dataFim, *empresas_filtro)) or []:
                dt_transacao = row['dt_transacao']
                if not dt_transacao:
                    continue
                periodo = dt_transacao.strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                valor = float(row['valor'] or 0)
                receita_competencia[periodo] += valor
                receita_competencia['total'] += valor

            query_devolucoes = f"""
                SELECT t.dt_transacao, SUM(t.vl_transacao) as valor
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.cd_empresa IN ({empresa_placeholders})
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
                GROUP BY t.dt_transacao
            """
            devolucoes_rows = execute_query(query_devolucoes, (dataInicio, dataFim, *empresas_filtro)) or []
            for row in devolucoes_rows:
                dt_transacao = row['dt_transacao']
                if not dt_transacao:
                    continue
                periodo = dt_transacao.strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                valor = abs(float(row['valor'] or 0))
                receita_competencia[periodo] -= valor
                receita_competencia['total'] -= valor
                # Mesma fonte/data que a DRE usa - devolucao entra igual nas
                # duas visoes (nao e um item que "descasa" prazo).
                receita_caixa[periodo] -= valor
                receita_caixa['total'] -= valor

            # --- Caixa (DFC), base SEM ANTECIPACAO ---
            # tp_documento 3 (dinheiro) e 9 (troco) e 2 (cheque) continuam
            # por dt_baixa normal - antecipacao so existe pra fatura e cartao
            # de credito. Fatura (1) sai daqui e vira uma consulta a parte,
            # por dt_vencimento (ver abaixo).
            tp_sinal = {3: 1, 9: -1, 2: 1}
            query_tipo_documento = f"""
                SELECT f.dt_baixa, f.tp_documento, SUM(f.vl_pago) as valor
                FROM vr_fcr_faturai f
                WHERE f.dt_baixa >= %s AND f.dt_baixa <= %s
                  AND f.tp_situacao = '1'
                  AND f.tp_documento IN (3, 9, 2)
                  AND f.cd_empresa IN ({empresa_placeholders})
                GROUP BY f.dt_baixa, f.tp_documento
            """
            for row in execute_query(query_tipo_documento, (dataInicio, dataFim, *empresas_filtro)) or []:
                dt_baixa = row['dt_baixa']
                if not dt_baixa:
                    continue
                periodo = dt_baixa.strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                sinal = tp_sinal.get(row['tp_documento'], 1)
                valor = sinal * float(row['valor'] or 0)
                receita_caixa[periodo] += valor
                receita_caixa['total'] += valor

            # Fatura/boleto SEM antecipacao: so entram faturas ja baixadas,
            # alocadas no mes do VENCIMENTO original (nao no mes da baixa,
            # que pode vir antecipada) - restrito a nr_portador<999, mesma
            # regra da aba "Mensal - Sem Antecipacao" do DFC.
            query_fatura_sem_antecipacao = f"""
                SELECT f.dt_vencimento, f.vl_pago
                FROM vr_fcr_faturai f
                WHERE f.dt_baixa IS NOT NULL
                  AND f.tp_situacao = '1'
                  AND f.tp_documento = 1
                  AND f.nr_portador < 999
                  AND f.cd_empresa IN ({empresa_placeholders})
                  AND f.dt_vencimento >= %s
                  AND f.dt_vencimento <= %s
            """
            for row in execute_query(query_fatura_sem_antecipacao, (*empresas_filtro, dataInicio, dataFim)) or []:
                dt_vencimento = row['dt_vencimento']
                if not dt_vencimento:
                    continue
                periodo = dt_vencimento.strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                valor = float(row['vl_pago'] or 0)
                receita_caixa[periodo] += valor
                receita_caixa['total'] += valor

            data_inicio_dt = datetime.strptime(dataInicio, '%Y-%m-%d')
            data_fim_dt = datetime.strptime(dataFim, '%Y-%m-%d')
            data_inicio_buffer = (data_inicio_dt - timedelta(days=10)).strftime('%Y-%m-%d')
            data_inicio_buffer_cartao = (data_inicio_dt - timedelta(days=630)).strftime('%Y-%m-%d')

            for scodigo, cfg in RECEBIMENTOS_DATA_CONSTRUIDA.items():
                if scodigo == 'REC.04':
                    # Cartao de credito SEM antecipacao: cada parcela e
                    # reconhecida em emissao + 30*nr_parcela dias corridos,
                    # em vez de tudo somado em emissao + 2 dias uteis.
                    query_cartao = f"""
                        SELECT f.dt_emissao, f.nr_parcela, f.vl_fatura
                        FROM vr_fcr_faturai f
                        WHERE f.tp_situacao = '1'
                          AND f.tp_documento = %s
                          AND f.tp_cobranca = %s
                          AND f.cd_empresa IN ({empresa_placeholders})
                          AND f.dt_emissao >= %s
                          AND f.dt_emissao <= %s
                    """
                    rows_cartao = execute_query(
                        query_cartao,
                        (cfg['tp_documento'], cfg['tp_cobranca'], *empresas_filtro, data_inicio_buffer_cartao, dataFim)
                    )
                    for row in rows_cartao or []:
                        dt_emissao = row['dt_emissao']
                        nr_parcela = row.get('nr_parcela')
                        if not dt_emissao or not nr_parcela or nr_parcela < 1:
                            continue
                        dt_construida = dt_emissao + timedelta(days=30 * nr_parcela)
                        if dt_construida < data_inicio_dt or dt_construida > data_fim_dt:
                            continue
                        periodo = dt_construida.strftime('%Y-%m')
                        if periodo not in periodos:
                            continue
                        valor = float(row['vl_fatura'] or 0)
                        receita_caixa[periodo] += valor
                        receita_caixa['total'] += valor
                    continue

                where_extra = ""
                params_extra = []
                if cfg.get('tp_cobranca') is not None:
                    where_extra = "AND f.tp_cobranca = %s"
                    params_extra = [cfg['tp_cobranca']]
                query_construida = f"""
                    SELECT f.dt_emissao, f.vl_fatura
                    FROM vr_fcr_faturai f
                    WHERE f.tp_situacao = '1'
                      AND f.tp_documento = %s
                      {where_extra}
                      AND f.cd_empresa IN ({empresa_placeholders})
                      AND f.dt_emissao >= %s
                      AND f.dt_emissao <= %s
                """
                rows_construida = execute_query(
                    query_construida,
                    (cfg['tp_documento'], *params_extra, *empresas_filtro, data_inicio_buffer, dataFim)
                )
                for row in rows_construida or []:
                    dt_emissao = row['dt_emissao']
                    if not dt_emissao:
                        continue
                    dt_construida = _somar_dias_uteis(dt_emissao, cfg['dias_uteis'])
                    if dt_construida < data_inicio_dt or dt_construida > data_fim_dt:
                        continue
                    periodo = dt_construida.strftime('%Y-%m')
                    if periodo not in periodos:
                        continue
                    valor = float(row['vl_fatura'] or 0)
                    receita_caixa[periodo] += valor
                    receita_caixa['total'] += valor

        # =====================================================================
        # RESUMO EXECUTIVO (ponte): Resultado (DRE) -> ajustes -> Caixa (DFC).
        #
        # O "Resultado Competencia" e o "Resultado Caixa" do resumo tem que
        # ser EXATAMENTE o mesmo numero que aparece nas telas separadas da
        # DRE e do DFC - senao o usuario ve um numero diferente do que ja
        # conhece e desconfia (com razao) do comparativo. Por isso, em vez
        # de montar esses dois totais a partir da bucketizacao de despesas
        # feita acima (que so cobre o grupo Operacional e pode divergir do
        # Lucro Liquido real - ele inclui Receitas Financeiras, Receitas Nao
        # Operacionais e Despesas Tributarias que essa bucketizacao nao
        # cobre), eles vem DIRETO das mesmas funcoes que alimentam as telas
        # oficiais: _calcular_valores_unificada (DRE Analitica, Lucro
        # Liquido = conta '14') e _calcular_valores_dfc com sem_antecipacao
        # (aba "Mensal - Sem Antecipacao" do DFC, card "Saldo de Caixa (apos
        # Operacional)" = REC + OP + NAO_CLASSIFICADO). NAO e o 'SALDO' geral
        # dessa mesma tela - esse inclui INVESTIMENTOS e FINANCIAMENTO
        # (emprestimo, aporte, amortizacao de divida), que nao tem
        # correspondente na DRE e nao faz parte do escopo "DFC Operacional"
        # deste comparativo.
        dre_real = _calcular_valores_unificada(dataInicio, dataFim, filtro, campo_data_despesa='dt_emissao')
        resultado_competencia = dre_real['valores'].get('14', _init_valores_periodo(periodos))

        dfc_real = _calcular_valores_dfc(dataInicio, dataFim, filtro, sem_antecipacao=True)
        dfc_rec = dfc_real['valores'].get('REC', _init_valores_periodo(periodos))
        dfc_op = dfc_real['valores'].get('OP', _init_valores_periodo(periodos))
        dfc_nao_classificado = dfc_real['valores'].get('NAO_CLASSIFICADO', _init_valores_periodo(periodos))
        resultado_caixa = _init_valores_periodo(periodos)
        for p in periodos + ['total']:
            resultado_caixa[p] = dfc_rec[p] + dfc_op[p] + dfc_nao_classificado[p]

        # Ajuste de descasamento de prazo (receita/despesa), so do recorte
        # Operacional - continua util pro detalhamento por subgrupo abaixo.
        ajuste_despesa = _init_valores_periodo(periodos)
        ajuste_receita = _init_valores_periodo(periodos)
        for p in periodos + ['total']:
            # Despesa e negativa: o que foi incorrido (competencia) menos o
            # que foi pago (caixa) - positivo = pagou menos do que competiu
            # esse periodo (sobrou caixa), negativo = pagou mais do que
            # competiu (pagou coisa de outros periodos).
            ajuste_despesa[p] = op_competencia[p] - op_caixa[p]
            ajuste_receita[p] = receita_caixa[p] - receita_competencia[p]

        # Ajuste "outros": tudo que fica fora do recorte Operacional (juros e
        # receitas financeiras, receitas nao operacionais, tributos sobre o
        # lucro) mais qualquer diferenca residual de classificacao - e o que
        # falta pra ponte fechar exatamente com os totais reais da DRE/DFC.
        ajuste_outros = _init_valores_periodo(periodos)
        for p in periodos + ['total']:
            ajuste_outros[p] = (resultado_caixa[p] - resultado_competencia[p]) - (ajuste_receita[p] - ajuste_despesa[p])

        periodos_response = [
            {"key": p, "label": f"{p.split('-')[1]}/{p.split('-')[0][2:]}"}
            for p in periodos
        ]

        despesas_resp = {}
        for scodigo in subgrupos_op:
            comp = competencia_despesa.get(scodigo, _init_valores_periodo(periodos))
            cai = caixa_despesa.get(scodigo, _init_valores_periodo(periodos))
            if comp['total'] == 0 and cai['total'] == 0:
                continue
            despesas_resp[scodigo] = {"competencia": comp, "caixa": cai}

        # Linha informativa: despesa que tem classificacao no DFC (por isso
        # entra normal no lado caixa, dentro do subgrupo dela) mas NAO
        # existe na classificacao da DRE - fica de fora do Resultado
        # Competencia (igual a DRE de verdade faz), mas aparece aqui pra
        # mostrar o tamanho do buraco de classificacao.
        nao_classificado_comp = competencia_despesa.get('NAO_CLASSIFICADO')
        if nao_classificado_comp and nao_classificado_comp['total'] != 0:
            despesas_resp['NAO_CLASSIFICADO'] = {
                "competencia": nao_classificado_comp,
                "caixa": caixa_despesa.get('NAO_CLASSIFICADO', _init_valores_periodo(periodos)),
            }

        return {
            "periodos": periodos_response,
            "despesas": despesas_resp,
            "receita": {"competencia": receita_competencia, "caixa": receita_caixa},
            "grupoOP": {"competencia": op_competencia, "caixa": op_caixa},
            "resumo": {
                "resultadoCompetencia": resultado_competencia,
                "resultadoCaixa": resultado_caixa,
                "ajusteDespesa": ajuste_despesa,
                "ajusteReceita": ajuste_receita,
                "ajusteOutros": ajuste_outros,
            },
            "metadata": {
                "filtro": filtro,
                "nomeFiltro": nome_filtro,
                "tipoFiltro": tipo_filtro,
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat()
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao processar DRE x DFC Operacional: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar comparativo DRE x DFC: {str(e)}")


def _calcular_valores_unificada(
    dataInicio: str,
    dataFim: str,
    filtro: str,
    campo_data_despesa: str = 'dt_emissao',
):
    if campo_data_despesa not in ('dt_emissao', 'dt_baixa'):
        raise HTTPException(status_code=400, detail=f"campo_data_despesa invalido: {campo_data_despesa}")

    try:
        print(f"[INFO] Buscando DRE/DFC UNIFICADA ({campo_data_despesa}): {dataInicio} ate {dataFim}, filtro={filtro}")

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
                d.{campo_data_despesa} as dt_referencia,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.{campo_data_despesa} >= %s
              AND d.{campo_data_despesa} <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
            ORDER BY d.{campo_data_despesa}
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS))
        print(f"[DRE/DFC UNIFICADA] Total de despesas: {len(despesas)}")

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

        # No DFC (regime de caixa), algumas despesas podem precisar de uma
        # conta diferente da DRE (ex: custo de mercadoria vendida = despesas
        # reais de compra de materia-prima pagas, em vez do calculo sintetico
        # da DRE). Isso e um override pontual - o que nao estiver na tabela
        # do DFC cai automaticamente na mesma classificacao da DRE.
        classificacoes_dfc_db = {}
        if campo_data_despesa == 'dt_baixa':
            try:
                _criar_tabela_classificacao_dfc()
                rows_dfc = execute_query("SELECT cd_despesaitem, conta_dfc FROM classificacao_despesas_dfc", ())
                for row in rows_dfc or []:
                    cd = row.get('cd_despesaitem')
                    conta_dfc = row.get('conta_dfc', '')
                    if cd and conta_dfc:
                        classificacoes_dfc_db[cd] = conta_dfc
            except Exception as e:
                print(f"[DFC UNIFICADA] Aviso: nao foi possivel carregar classificacoes do DFC: {e}")

        # Agrupar despesas por conta_dre e periodo
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            if campo_data_despesa == 'dt_baixa':
                conta = _classificar_conta_dfc(cd_despesaitem, descricao_despesa, classificacoes_dfc_db, classificacoes_db)
            else:
                conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db)
            valor = -abs(float(d['valor'] or 0))
            dt_referencia = d['dt_referencia']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

            # Pular despesas excluidas (ex: MERC P/ REVENDA)
            if conta == 'EXCLUIDO':
                continue

            if dt_referencia:
                periodo = dt_referencia.strftime('%Y-%m')
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

            # CREDITO INADIMPLENCIA (10.01.04) - faturas pagas com mais de
            # 365 dias de atraso, reconhecidas no mes do PAGAMENTO
            # (dt_baixa), independente do regime de data usado pro resto da
            # DRE (dt_emissao das despesas).
            credito_inadimplencia = _init_valores_periodo(periodos)
            for linha in _buscar_credito_inadimplencia(dataInicio, dataFim, empresas_filtro):
                periodo = linha['dt_baixa'].strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                credito_inadimplencia[periodo] += linha['valor']
                credito_inadimplencia['total'] += linha['valor']

            # DEBITO INADIMPLENCIA (10.03.07) - faturas que completaram 365
            # dias vencidas AINDA em aberto, reconhecidas no mes em que
            # completam 365 dias (nao no mes de vencimento/emissao).
            debito_inadimplencia = _init_valores_periodo(periodos)
            for linha in _buscar_debito_inadimplencia(dataInicio, dataFim, empresas_filtro):
                periodo = linha['dt_limite'].strftime('%Y-%m')
                if periodo not in periodos:
                    continue
                valor = -abs(linha['valor'])
                debito_inadimplencia[periodo] += valor
                debito_inadimplencia['total'] += valor
        else:
            credito_inadimplencia = _init_valores_periodo(periodos)
            debito_inadimplencia = _init_valores_periodo(periodos)

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
        _merge_conta_unif('10.01.04', credito_inadimplencia)  # CREDITO INADIMPLENCIA
        _merge_conta_unif('10.03.07', debito_inadimplencia)  # DEBITO INADIMPLENCIA

        # =========================================================================
        # CMV - Custo de Mercadoria Vendida
        # =========================================================================
        # No DFC (regime de caixa) o CMV NAO vem dessa materialized view (que e
        # um calculo sintetico casado com a venda, sem relacao com pagamento
        # real) - vem das despesas de compra de materia-prima classificadas via
        # classificacao_despesas_dfc, igual as outras despesas do DFC. Por isso
        # esse bloco inteiro so roda para a DRE (dt_emissao).
        cmv = _init_valores_periodo(periodos)

        # CMV Fabrica (mv_cmv_fab) - AGREGADO por mes
        if usar_cmv_fab and campo_data_despesa == 'dt_emissao':
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
        if usar_cmv_loja and campo_data_despesa == 'dt_emissao':
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

        if campo_data_despesa == 'dt_emissao':
            _merge_conta_unif('04.02.02', cmv)  # CUSTO MERCADORIAS VENDIDAS (DRE - calculo sintetico)

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
    return _buscar_duplicatas_unificada(conta, periodo, filtro, campo_data_despesa='dt_emissao')


@router.get("/api/dfc/unificada/duplicatas")
def get_dfc_unificada_duplicatas(
    conta: str = Query(..., description="Codigo do subgrupo/grupo DFC (ex: OP.01) ou NAO_CLASSIFICADO"),
    periodo: str = Query(..., description="Periodo no formato YYYY-MM"),
    filtro: str = Query("consolidado", description="Filtro: 'consolidado', 'fabrica', ou codigo do centro de custo"),
    despesaItem: Optional[int] = Query(None, description="Restringe a uma despesa (cd_despesaitem) especifica dentro da conta")
):
    """
    Duplicatas do DFC (plano de contas proprio GRUPO > SUBGRUPO). O periodo
    se refere a data de baixa (pagamento efetivo) das duplicatas.
    """
    return _buscar_duplicatas_dfc(conta, periodo, filtro, despesa_item=despesaItem)


def _buscar_duplicatas_dfc(conta: str, periodo: str, filtro: str, despesa_item: Optional[int] = None):
    try:
        print(f"[INFO] Buscando duplicatas DFC: conta={conta}, periodo={periodo}, filtro={filtro}, despesaItem={despesa_item}")

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

        ano, mes = periodo.split('-')
        import calendar
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]
        data_fim = f"{ano}-{mes}-{ultimo_dia:02d}"

        classificacoes_dfc_db = {}
        try:
            _criar_tabela_classificacao_dfc()
            rows_dfc = execute_query("SELECT cd_despesaitem, conta_dfc FROM classificacao_despesas_dfc", ())
            for row in rows_dfc or []:
                cd = row.get('cd_despesaitem')
                conta_dfc = row.get('conta_dfc', '')
                if cd and conta_dfc:
                    classificacoes_dfc_db[cd] = conta_dfc
        except Exception as e:
            print(f"[DFC DUPLICATAS] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Se a conta pedida for um GRUPO (ex: "OP"), qualquer subgrupo "OP.xx"
        # tambem entra. Se for "NAO_CLASSIFICADO", pega quem nao tem override.
        itens_conta = []
        if conta == 'NAO_CLASSIFICADO':
            itens_conta = None  # sem pre-filtro; classificado por post-check abaixo
        else:
            for cd_item, cd_conta in classificacoes_dfc_db.items():
                if cd_conta == conta or cd_conta.startswith(conta + '.'):
                    itens_conta.append(cd_item)
            if not itens_conta:
                return {"duplicatas": [], "total": 0, "conta": conta, "periodo": periodo}

        ccusto_placeholders = ",".join(["%s"] * len(ccustos))
        ccusto_excluidos_placeholders = ",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))

        params = [primeiro_dia, data_fim]
        where_itens = ""
        if itens_conta is not None:
            itens_placeholders = ",".join(["%s"] * len(itens_conta))
            where_itens = f"AND d.cd_despesaitem IN ({itens_placeholders})"
            params.extend(itens_conta)
        params.extend(ccustos)
        params.extend(CCUSTOS_EXCLUIDOS_FABRICA)
        params.extend(PARAMS_DUPLICATAS_EXCLUIDAS)

        query = f"""
            SELECT
                d.nr_duplicata,
                d.cd_despesaitem,
                i.ds_despesaitem as descricao,
                d.dt_emissao,
                d.dt_vencimento,
                d.dt_liq as dt_baixa,
                ABS(d.vl_rateio) as valor,
                d.cd_ccusto,
                cc.ds_ccusto as nome_ccusto,
                d.cd_fornecedor,
                CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\\*+$' THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fornecedor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN vr_gec_ccusto cc ON cc.cd_ccusto = d.cd_ccusto
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
            LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
            WHERE d.dt_liq >= %s
              AND d.dt_liq <= %s
              {where_itens}
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({ccusto_excluidos_placeholders})
              AND d.tp_situacao = 'N'
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
            ORDER BY d.dt_liq DESC
        """

        rows = execute_query(query, params)

        duplicatas = []
        total = 0
        for row in (rows or []):
            valor = float(row['valor'] or 0)
            subgrupo = _classificar_subgrupo_dfc(row['cd_despesaitem'], classificacoes_dfc_db)

            if conta == 'NAO_CLASSIFICADO':
                if subgrupo != 'NAO_CLASSIFICADO':
                    continue
            elif subgrupo != conta and not subgrupo.startswith(conta + '.'):
                continue

            if despesa_item is not None and row['cd_despesaitem'] != despesa_item:
                continue

            total += valor
            duplicatas.append({
                "id": row['nr_duplicata'],
                "nrDuplicata": row['nr_duplicata'],
                "cdDespesaItem": row['cd_despesaitem'],
                "descricao": row['descricao'] or '',
                "dtEmissao": row['dt_emissao'].strftime('%Y-%m-%d') if row['dt_emissao'] else None,
                "dtVencimento": row['dt_vencimento'].strftime('%Y-%m-%d') if row['dt_vencimento'] else None,
                "dtBaixa": row['dt_baixa'].strftime('%Y-%m-%d') if row['dt_baixa'] else None,
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
        print(f"[ERROR] Erro ao buscar duplicatas DFC: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _buscar_duplicatas_unificada(conta: str, periodo: str, filtro: str, campo_data_despesa: str = 'dt_emissao'):
    if campo_data_despesa not in ('dt_emissao', 'dt_baixa'):
        raise HTTPException(status_code=400, detail=f"campo_data_despesa invalido: {campo_data_despesa}")

    try:
        print(f"[INFO] Buscando duplicatas DRE/DFC UNIFICADA ({campo_data_despesa}): conta={conta}, periodo={periodo}, filtro={filtro}")

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

        # No DFC, algumas despesas podem estar classificadas so na tabela
        # propria do DFC (ex: compras de materia-prima), sem equivalente na
        # classificacao_despesas_dre - por isso o mapeamento conta->despesas
        # tambem precisa considerar esse override quando estamos no DFC.
        classificacoes_dfc_db = {}
        if campo_data_despesa == 'dt_baixa':
            try:
                _criar_tabela_classificacao_dfc()
                rows_dfc = execute_query("SELECT cd_despesaitem, conta_dfc FROM classificacao_despesas_dfc", ())
                for row in rows_dfc or []:
                    cd = row.get('cd_despesaitem')
                    conta_dfc = row.get('conta_dfc', '')
                    if cd and conta_dfc:
                        classificacoes_dfc_db[cd] = conta_dfc
            except Exception as e:
                print(f"[DFC UNIFICADA DUPLICATAS] Aviso: nao foi possivel carregar classificacoes do DFC: {e}")

        # Encontrar cd_despesaitem que mapeiam para esta conta (APENAS do banco)
        itens_conta = []
        if campo_data_despesa == 'dt_baixa':
            todos_itens = set(classificacoes_db.keys()) | set(classificacoes_dfc_db.keys())
            for cd_item in todos_itens:
                cd_conta = _classificar_conta_dfc(cd_item, None, classificacoes_dfc_db, classificacoes_db)
                if cd_conta == conta or cd_conta.startswith(conta + '.'):
                    itens_conta.append(cd_item)
        else:
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
        params.extend(PARAMS_DUPLICATAS_EXCLUIDAS)

        ccusto_excluidos_placeholders = ",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))

        query = f"""
            SELECT
                d.nr_duplicata,
                d.cd_despesaitem,
                i.ds_despesaitem as descricao,
                d.dt_emissao,
                d.dt_vencimento,
                d.dt_baixa,
                ABS(d.vl_rateio) as valor,
                d.cd_ccusto,
                cc.ds_ccusto as nome_ccusto,
                d.cd_fornecedor,
                CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fornecedor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN vr_gec_ccusto cc ON cc.cd_ccusto = d.cd_ccusto
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
            LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
            WHERE d.{campo_data_despesa} >= %s
              AND d.{campo_data_despesa} <= %s
              AND ({items_or_desc})
              AND d.cd_ccusto IN ({ccusto_placeholders})
              AND d.cd_ccusto NOT IN ({ccusto_excluidos_placeholders})
              AND d.tp_situacao = 'N'
              AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
            ORDER BY d.{campo_data_despesa} DESC
        """

        rows = execute_query(query, params)

        duplicatas = []
        total = 0
        for row in (rows or []):
            valor = float(row['valor'] or 0)
            descricao = row['descricao'] or ''

            # Reclassificar pela descricao usando as mesmas regras da agregacao
            if campo_data_despesa == 'dt_baixa':
                conta_classificada = _classificar_conta_dfc(
                    row['cd_despesaitem'],
                    descricao,
                    classificacoes_dfc_db,
                    classificacoes_db
                )
            else:
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
                "dtBaixa": row['dt_baixa'].strftime('%Y-%m-%d') if row['dt_baixa'] else None,
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
AUDITORIA_LIMIAR_DOMINANCIA_PCT = 51
AUDITORIA_DATA_INICIO_HISTORICO = '2024-01-01'


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
              AND d.dt_emissao >= %s
            GROUP BY d.cd_despesaitem, i.ds_despesaitem
            ORDER BY quantidade DESC
        """
        rows = execute_query(query, (cdFornecedor, AUDITORIA_DATA_INICIO_HISTORICO)) or []
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
                  AND d.dt_emissao >= %s
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
            AUDITORIA_DATA_INICIO_HISTORICO,
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

        # Mesma restricao do frontend: o icone de auditoria (e por consequencia o
        # filtro "So com problema") so faz sentido para contas de despesa, nao
        # para deducoes/impostos sobre a receita (conta 02) ou outros grupos.
        prefixos_despesa = ('04', '06', '08', '10', '13')

        celulas = set()
        for row in rows:
            conta = _classificar_conta_dre(row['cd_despesaitem'], None, classificacoes_db)
            if conta in ('NAO_CLASSIFICADO', 'EXCLUIDO'):
                continue
            if not conta.startswith(prefixos_despesa):
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
                  AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
                GROUP BY DATE_TRUNC('month', d.dt_emissao), d.cd_ccusto, d.cd_despesaitem, i.ds_despesaitem
            """
            despesas_janelas = execute_query(
                query_despesas_janelas,
                (data_inicio_minimo, data_fim_janela_exclusivo, *ccustos_despesas, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS)
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
                  AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
                GROUP BY d.cd_despesaitem, i.ds_despesaitem
            """
            despesas = execute_query(query_despesas, (dataInicio, data_fim_exclusivo, *ccustos, *CCUSTOS_EXCLUIDOS_FABRICA, *PARAMS_DUPLICATAS_EXCLUIDAS))

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
                    CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
                FROM vr_fcp_despduplicatai d
                JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                LEFT JOIN vr_gec_ccusto c ON c.cd_ccusto = d.cd_ccusto
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
                WHERE d.dt_emissao >= %s
                  AND d.dt_emissao <= %s
                  AND d.tp_situacao = 'N'
                  {filtro_ccusto_sql}
                  AND d.cd_empresa NOT IN ({placeholders_emp_excluidas})
                  AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
                ORDER BY d.dt_emissao
            """
            despesas = execute_query(query, (dataInicio, dataFim, *params_ccusto, *EMPRESAS_EXCLUIDAS, *PARAMS_DUPLICATAS_EXCLUIDAS))
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
                    CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\*+$' THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'N/A') ELSE p.nm_fantasia END as nm_fantasia
                FROM vr_fcp_despduplicatai d
                JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                LEFT JOIN vr_gec_ccusto c ON c.cd_ccusto = d.cd_ccusto
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
                WHERE d.dt_emissao >= %s
                  AND d.dt_emissao <= %s
                  AND d.tp_situacao = 'N'
                  {filtro_ccusto_sql}
                  AND d.cd_empresa NOT IN ({placeholders_emp_excluidas})
                  AND d.cd_despesaitem IN ({placeholders_itens})
                  AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}
                ORDER BY d.dt_emissao
            """
            despesas = execute_query(query, (dataInicio, dataFim, *params_ccusto, *EMPRESAS_EXCLUIDAS, *itens, *PARAMS_DUPLICATAS_EXCLUIDAS))

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

