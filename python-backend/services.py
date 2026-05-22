from database import execute_query
from typing import List, Dict, Any, Tuple
from datetime import datetime
from collections import defaultdict

# =============================================================================
# MAPEAMENTO DE CATEGORIAS PARA ESTRUTURA DRE
# =============================================================================

# A) DEDUÇÕES DA RECEITA (Impostos sobre vendas)
DEDUCOES_RECEITA = [
    'icms sobre vendas', 'pis sobre receita', 'cofins sobre receita',
    'icms antecipado', 'icms substituicao', 'difal gnre', 'difal',
    'iss ret fonte', 'iss retido', 'devolucoes de vendas', 'devoluções',
    'abatimentos', 'descontos concedidos'
]

# B) CPV/CMV - Custo de Produção/Mercadoria Vendida
CPV_MATERIAS_PRIMAS = [
    'elastico', 'lycra', 'malha', 'manta', 'bojo', 'tule', 'tecido',
    'cadarco', 'arco', 'linhas e fios', 'linhas', 'fios', 'renda', 'cotton',
    'etiqueta composicao', 'tags m prima', 'acessorios', 'aviamento',
    'elastico mp', 'lycra mp', 'materia prima', 'matéria prima', 'mp',
    'insumo', 'componente'
]

CPV_SERVICOS_INDUSTRIAIS = [
    'serv faccao', 'faccao', 'facção', 'serv faccao producao',
    'serv faccao / alcas', 'abotoador', 'terceirizacao', 'terceirização',
    'industrializacao', 'industrialização', 'beneficiamento'
]

CPV_EMBALAGENS = [
    'embalagens', 'embalagem', 'caixa', 'sacola', 'tags m uso consumo'
]

CPV_MERCADORIA_REVENDA = [
    'merc p/ revenda', 'mercadoria revenda', 'mercadorias', 'cmv'
]

# Pessoal de Produção (vai em CPV)
CPV_PESSOAL_PRODUCAO = [
    'salario prod', 'salários prod', 'fgts prod', 'inss prod',
    'irrf sobre salario prod', 'vale transporte prod', 'vale alimentacao prod',
    'alimentacao prod', 'alimentação prod', 'assist medica func prod',
    'assist medica emp prod', 'plano odontologico prod', 'exames medicos prod',
    'premiacoes funcionarios prod', 'premiações funcionários prod',
    '13 salario prod', '13 salário prod', '13 salario provisao prod',
    'ferias prod', 'férias prod', 'rescisao prod', 'rescisão prod'
]

# C) DESPESAS COM VENDAS (Comercial)
DESPESAS_VENDAS_COMISSOES = [
    'comissao representante', 'comissão representante', 'comissao gerente',
    'comissao vendedor', 'comissao supervisor', 'comissao coordenador',
    'comissao corretor', 'comissões', 'comissoes', 'irrf representantes',
    'irrf 8045'
]

DESPESAS_VENDAS_MARKETING = [
    'propagandas', 'propaganda', 'midias digitais', 'mídias digitais',
    'marketing', 'consultorias e assessorias de marketing', 'bs design',
    'materiais graficos', 'materiais gráficos', 'promocionais',
    'merchandising', 'ponto de vendas'
]

DESPESAS_VENDAS_OUTRAS = [
    'fretes vendas', 'frete venda', 'ajuda de custo de deslocamento comerciais',
    'ajuda de custo de viagens comerciais', 'combustivel comercial',
    'lubrificante comercial', 'premiacoes comerciais', 'premiações comerciais',
    'viagem comercial', 'despesa comercial'
]

# D) DESPESAS GERAIS E ADMINISTRATIVAS (G&A)
GA_OCUPACAO = [
    'aluguel minimo', 'aluguel mínimo', 'aluguel', 'condominio', 'condomínio',
    'fundo de promocao', 'ar condicionado', 'energia', 'iptu', 'agua e esgoto',
    'água e esgoto', 'manutencao edificacoes', 'manutenção edificações',
    'manutencao instalacoes', 'manutenção instalações', 'casa maua',
    'aluguel imoveis', 'aluguel imóveis'
]

GA_TAXAS_MULTAS = [
    'multas e taxas', 'multas sefaz', 'taxas e emolumento', 'taxas',
    'associacao', 'associação', 'contrib', 'anuidades', 'contribuicao sindical',
    'contribuição sindical'
]

GA_SERVICOS = [
    'correios', 'malotes', 'serv internet', 'internet', 'telefonia fixa',
    'telefonia movel', 'telefonia móvel', 'monit', 'seguranca', 'segurança',
    'dedetizacao', 'dedetização', 'consulta cadastral', 'assessoria contabil',
    'assessoria contábil', 'assessoria juridica', 'assessoria jurídica',
    'consultoria', 'manut de software', 'manutenção software', 'endomarketing',
    'limpeza', 'conservacao', 'conservação', 'vigilancia', 'vigilância'
]

GA_PESSOAL_ADM = [
    'salarios a pagar', 'salários a pagar', 'salario adm', 'salário adm',
    'fgts adm', 'fgts', 'inss adm', 'inss', 'irrf sobre salario',
    'vale transporte', 'vale alimentacao', 'vale alimentação', 'alimentacao',
    'alimentação', 'assist medica', 'assistência médica', 'plano odontologico',
    'plano odontológico', 'exames medicos', 'exames médicos', 'estagios',
    'estágios', 'treinamentos', 'premiacoes funcionarios', 'premiações funcionários',
    'ferias', 'férias', '13 salario', '13 salário', 'rescisao', 'rescisão',
    'provisao ferias', 'provisão férias', 'provisao 13', 'provisão 13'
]

GA_MATERIAIS = [
    'material de escritorio', 'material de escritório', 'material de limpeza',
    'material de consumo', 'copa e cozinha', 'descartaveis', 'descartáveis'
]

# E) RESULTADO FINANCEIRO
RESULTADO_FINANCEIRO_DESPESAS = [
    'juros s/emprest', 'juros emprestimo', 'juros empréstimo',
    'tarifa manut', 'tarifa manutenção', 'tarifa bancaria', 'tarifa bancária',
    'iof', 'juros mora', 'juros de mora', 'multa atraso', 'despesa bancaria',
    'despesa bancária', 'taxas bancarias', 'taxas bancárias', 'ted', 'doc',
    'anuidade cartao', 'anuidade cartão'
]

RESULTADO_FINANCEIRO_RECEITAS = [
    'juros recebidos', 'rendimento', 'aplicacao', 'aplicação',
    'desconto obtido', 'descontos obtidos'
]

INADIMPLENCIA = [
    'resgate inadimplencia', 'inadimplência', 'pdd', 'provisao devedores',
    'provisão devedores', 'perdas credito', 'perdas crédito'
]

# F) ITENS NÃO OPERACIONAIS / RETIRADAS DE SÓCIOS
NAO_OPERACIONAL_RETIRADAS = [
    'retirada', 'cairo', 'gerlano', 'shenia', 'thais', 'pro-labore',
    'pró-labore', 'prolabore', 'distribuicao lucros', 'distribuição lucros',
    'dividendos', 'adiantamento socios', 'adiantamento sócios'
]

NAO_OPERACIONAL_OUTROS = [
    'casamento', 'pessoal', 'particular', 'nao operacional', 'não operacional',
    'extraordinario', 'extraordinário'
]

# G) INVESTIMENTOS (CAPEX) - Não vai na DRE operacional
INVESTIMENTOS_CAPEX = [
    'inv.', 'investimento', 'moveis e utensilios', 'móveis e utensílios',
    'computadores', 'perifericos', 'periféricos', 'softwares',
    'cessao de direitos', 'cessão de direitos', 'fabrica', 'fábrica',
    'imobilizado', 'ativo fixo', 'capex'
]


def classificar_despesa_dre(ds_despesaitem: str) -> Tuple[str, str]:
    """
    Classifica uma despesa na estrutura DRE padrão.

    Retorna:
        Tuple[grupo_dre, subgrupo_dre]

    Grupos DRE:
        - A) Deduções da Receita
        - B) CPV/CMV
        - C) Despesas com Vendas
        - D) Despesas G&A
        - E) Resultado Financeiro
        - F) Não Operacional
        - G) Investimentos (CAPEX)
    """
    if not ds_despesaitem:
        return "D) Despesas G&A", "Outros"

    despesa_lower = ds_despesaitem.lower().strip()

    # A) Deduções da Receita
    for kw in DEDUCOES_RECEITA:
        if kw in despesa_lower:
            return "A) Deduções da Receita", "Impostos sobre Vendas"

    # G) Investimentos (CAPEX) - verificar primeiro pois tem keywords específicas
    for kw in INVESTIMENTOS_CAPEX:
        if kw in despesa_lower:
            return "G) Investimentos (CAPEX)", "Imobilizado"

    # B) CPV/CMV - Matérias-primas
    for kw in CPV_MATERIAS_PRIMAS:
        if kw in despesa_lower:
            return "B) CPV/CMV", "Matérias-Primas e Insumos"

    # B) CPV/CMV - Serviços Industriais
    for kw in CPV_SERVICOS_INDUSTRIAIS:
        if kw in despesa_lower:
            return "B) CPV/CMV", "Serviços Industriais/Facção"

    # B) CPV/CMV - Embalagens
    for kw in CPV_EMBALAGENS:
        if kw in despesa_lower:
            return "B) CPV/CMV", "Embalagens"

    # B) CPV/CMV - Mercadoria para Revenda
    for kw in CPV_MERCADORIA_REVENDA:
        if kw in despesa_lower:
            return "B) CPV/CMV", "Mercadoria p/ Revenda"

    # B) CPV/CMV - Pessoal de Produção
    for kw in CPV_PESSOAL_PRODUCAO:
        if kw in despesa_lower:
            return "B) CPV/CMV", "Pessoal de Produção"

    # C) Despesas com Vendas - Comissões
    for kw in DESPESAS_VENDAS_COMISSOES:
        if kw in despesa_lower:
            return "C) Despesas com Vendas", "Comissões"

    # C) Despesas com Vendas - Marketing
    for kw in DESPESAS_VENDAS_MARKETING:
        if kw in despesa_lower:
            return "C) Despesas com Vendas", "Marketing e Publicidade"

    # C) Despesas com Vendas - Outras
    for kw in DESPESAS_VENDAS_OUTRAS:
        if kw in despesa_lower:
            return "C) Despesas com Vendas", "Outras Despesas Comerciais"

    # E) Resultado Financeiro - Despesas
    for kw in RESULTADO_FINANCEIRO_DESPESAS:
        if kw in despesa_lower:
            return "E) Resultado Financeiro", "Despesas Financeiras"

    # E) Resultado Financeiro - Inadimplência
    for kw in INADIMPLENCIA:
        if kw in despesa_lower:
            return "E) Resultado Financeiro", "PDD/Inadimplência"

    # F) Não Operacional - Retiradas
    for kw in NAO_OPERACIONAL_RETIRADAS:
        if kw in despesa_lower:
            return "F) Não Operacional", "Retiradas de Sócios"

    # F) Não Operacional - Outros
    for kw in NAO_OPERACIONAL_OUTROS:
        if kw in despesa_lower:
            return "F) Não Operacional", "Outros Não Operacionais"

    # D) Despesas G&A - Ocupação
    for kw in GA_OCUPACAO:
        if kw in despesa_lower:
            return "D) Despesas G&A", "Ocupação/Infraestrutura"

    # D) Despesas G&A - Taxas e Multas
    for kw in GA_TAXAS_MULTAS:
        if kw in despesa_lower:
            return "D) Despesas G&A", "Taxas e Multas"

    # D) Despesas G&A - Serviços
    for kw in GA_SERVICOS:
        if kw in despesa_lower:
            return "D) Despesas G&A", "Serviços Terceirizados"

    # D) Despesas G&A - Pessoal ADM
    for kw in GA_PESSOAL_ADM:
        if kw in despesa_lower:
            return "D) Despesas G&A", "Pessoal Administrativo"

    # D) Despesas G&A - Materiais
    for kw in GA_MATERIAIS:
        if kw in despesa_lower:
            return "D) Despesas G&A", "Materiais de Consumo"

    # Padrão: G&A Outros
    return "D) Despesas G&A", "Outros"


# =============================================================================
# MAPEAMENTO LEGADO PARA ATIVIDADES DO DFC (mantido para compatibilidade)
# =============================================================================

# Mapeamento de categorias para atividades do DFC
def mapear_atividade_dfc(ds_despesaitem: str = None, tp_documento: int = None, is_receita: bool = False) -> str:
    """
    Mapeia despesas/receitas para as 3 atividades do DFC segundo CPC 03:
    - Atividades Operacionais: Fluxos de caixa da produção e entrega de bens/serviços
    - Atividades de Investimento: Aquisição/alienação de ativos de longo prazo
    - Atividades de Financiamento: Empréstimos e pagamentos de empréstimos, transações de capital
    """

    if is_receita:
        # Recebimentos - maioria é operacional
        if tp_documento in [1, 3, 6, 8]:  # Fatura, Duplicata, Carteira, Boleto
            return "Atividades Operacionais"
        elif tp_documento in [2, 5]:  # Cheques
            return "Atividades Operacionais"
        elif tp_documento in [4, 9]:  # Cartão Crédito/Débito
            return "Atividades Operacionais"
        else:
            return "Atividades Operacionais"
    else:
        # Despesas - categorização baseada no tipo
        if not ds_despesaitem:
            return "Atividades Operacionais"

        despesa_lower = ds_despesaitem.lower()

        # Atividades de Investimento
        investimento_keywords = [
            'ativo', 'imobilizado', 'equipamento', 'veículo', 'veiculo',
            'máquina', 'maquina', 'imóvel', 'imovel', 'terreno', 'construção', 'construcao',
            'software permanente', 'licença perpétua', 'licenca perpetua',
            'investimento', 'aquisição', 'aquisicao', 'compra de ativo'
        ]
        for keyword in investimento_keywords:
            if keyword in despesa_lower:
                return "Atividades de Investimento"

        # Atividades de Financiamento
        financiamento_keywords = [
            'empréstimo', 'emprestimo', 'financiamento', 'juros de empréstimo', 'juros de emprestimo',
            'amortização', 'amortizacao', 'dívida', 'divida', 'capital social',
            'distribuição de lucro', 'distribuicao de lucro', 'dividendo',
            'leasing financeiro', 'arrendamento mercantil'
        ]
        for keyword in financiamento_keywords:
            if keyword in despesa_lower:
                return "Atividades de Financiamento"

        # Padrão: Atividades Operacionais
        # Inclui: fornecedores, salários, impostos, aluguel, utilities, despesas administrativas, etc.
        return "Atividades Operacionais"

def fetch_despesas(data_inicio: str, data_fim: str, duplicatas_excluidas: List[int] = None, tipo_data: str = "emissao", centro_custo: str = None) -> List[Dict]:
    """Busca despesas do banco de dados"""

    if duplicatas_excluidas is None:
        duplicatas_excluidas = [220425, 150525, 180325, 100425]

    # Construir cláusula NOT IN
    exclude_clause = ""
    if duplicatas_excluidas:
        ids = ','.join(map(str, duplicatas_excluidas))
        exclude_clause = f"AND di.nr_duplicata NOT IN ({ids})"

    # Construir filtro de centro de custo
    centro_custo_clause = ""
    if centro_custo and centro_custo != 'todos':
        try:
            cc_int = int(centro_custo)
            centro_custo_clause = f"AND di.cd_ccusto = {cc_int}"
        except ValueError:
            pass  # Ignora se não for um número válido

    # Determinar qual campo de data usar
    campo_data = {
        "emissao": "di.dt_emissao",
        "vencimento": "di.dt_vencimento",
        "baixa": "di.dt_baixa"
    }.get(tipo_data, "di.dt_emissao")

    # Consulta otimizada - JOIN com vr_pes_pessoa em vez de funcoes
    query = f"""
        SELECT
            di.cd_fornecedor,
            COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
            COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia,
            di.nr_duplicata,
            di.dt_emissao,
            di.dt_vencimento,
            di.dt_baixa,
            di.vl_rateio,
            di.cd_despesaitem,
            b.ds_despesaitem,
            di.cd_ccusto
        FROM
            vr_fcp_despduplicatai di
            INNER JOIN vr_fcp_despesaitem b ON b.cd_despesaitem = di.cd_despesaitem
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = di.cd_fornecedor
        WHERE
            di.tp_situacao = 'N'
            AND di.dt_baixa IS NULL
            AND {campo_data} >= %s
            AND {campo_data} <= %s
            {exclude_clause}
            {centro_custo_clause}
        ORDER BY
            {campo_data}
    """

    return execute_query(query, (data_inicio, data_fim))

def agrupar_por_categoria_e_periodo(despesas: List[Dict]) -> Dict[int, Dict]:
    """Agrupa despesas por categoria e período (mês)"""
    categorias = defaultdict(lambda: {
        'cd_despesaitem': None,
        'ds_despesaitem': None,
        'total_geral': 0,
        'por_mes': defaultdict(float)
    })

    for despesa in despesas:
        cd_item = despesa['cd_despesaitem']

        if categorias[cd_item]['cd_despesaitem'] is None:
            categorias[cd_item]['cd_despesaitem'] = cd_item
            categorias[cd_item]['ds_despesaitem'] = despesa['ds_despesaitem']

        # Formatar mês-ano (YYYY-MM)
        dt_emissao = despesa['dt_emissao']
        mes_ano = dt_emissao.strftime('%Y-%m')

        valor = float(despesa['vl_rateio'] or 0)

        categorias[cd_item]['total_geral'] += valor
        categorias[cd_item]['por_mes'][mes_ano] += valor

    return dict(categorias)

def gerar_periodos(data_inicio: str, data_fim: str) -> List[str]:
    """Gera lista de períodos (YYYY-MM) entre duas datas"""
    inicio = datetime.strptime(data_inicio, '%Y-%m-%d')
    fim = datetime.strptime(data_fim, '%Y-%m-%d')

    periodos = []
    atual = inicio.replace(day=1)

    while atual <= fim:
        periodos.append(atual.strftime('%Y-%m'))
        # Próximo mês
        if atual.month == 12:
            atual = atual.replace(year=atual.year + 1, month=1)
        else:
            atual = atual.replace(month=atual.month + 1)

    return periodos

def gerar_datas_diarias(data_inicio: str, data_fim: str) -> List[str]:
    """Gera lista de datas (YYYY-MM-DD) entre duas datas"""
    from datetime import timedelta

    inicio = datetime.strptime(data_inicio, '%Y-%m-%d')
    fim = datetime.strptime(data_fim, '%Y-%m-%d')

    datas = []
    atual = inicio

    while atual <= fim:
        datas.append(atual.strftime('%Y-%m-%d'))
        atual += timedelta(days=1)

    return datas

def formatar_label_periodo(periodo: str) -> str:
    """Formata período YYYY-MM para 'Mês-YYYY' ou YYYY-MM-DD para 'DD/MM'"""
    # Se for data completa YYYY-MM-DD
    if len(periodo) == 10 and periodo.count('-') == 2:
        ano, mes, dia = periodo.split('-')
        return f"{dia}/{mes}"

    # Se for mês YYYY-MM
    meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
             'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
    ano, mes = periodo.split('-')
    return f"{meses[int(mes) - 1]}-{ano}"

def converter_para_dfc(despesas: List[Dict], periodos: List[str]) -> Dict:
    """Converte dados do banco para formato DFC"""
    categorias = agrupar_por_categoria_e_periodo(despesas)

    # Montar dados DFC
    data_dfc = []

    for categoria in categorias.values():
        item = {
            'label': categoria['ds_despesaitem'],
            'total': -abs(categoria['total_geral'])  # Negativo para despesas
        }

        # Adicionar valores por período usando a chave do período
        for periodo in periodos:
            valor = categoria['por_mes'].get(periodo, 0)
            item[periodo] = -abs(valor)

        data_dfc.append(item)

    return {
        'title': 'PAGAMENTOS',
        'data': data_dfc,
        'isNegative': True
    }

def calcular_totais_dfc(pagamentos_data: List[Dict], periodos: List[str]) -> Dict:
    """Calcula totais do DFC"""
    totais = {'total': 0}

    # Inicializar totais por período usando a chave do período
    for periodo in periodos:
        totais[periodo] = 0

    for item in pagamentos_data:
        totais['total'] += item.get('total', 0)
        for periodo in periodos:
            totais[periodo] += item.get(periodo, 0)

    return totais

def converter_para_dfc_hierarquico(despesas: List[Dict], periodos: List[str], tipo_data: str = "emissao", tipo_fluxo: str = "previsao", label_atividade: str = 'Atividades Operacionais') -> Dict:
    """Converte dados para formato DFC com hierarquia de 4 níveis segundo CPC 03

    Nível 1: Atividade DFC (Operacionais, Investimento, Financiamento)
    Nível 2: Grupo (baseado em ds_despesaitem - primeiras palavras)
    Nível 3: Categoria (ds_despesaitem completo)
    Nível 4: Duplicata (nr_duplicata + fornecedor)
    """

    # Determinar qual campo de data usar
    # IMPORTANTE: Quando tipoFluxo é "realizado", usar dt_emissao que contém dt_baixa (ver main.py)
    if tipo_fluxo == "realizado":
        campo_data = "dt_emissao"  # No realizado, dt_emissao é mapeado para dt_baixa em main.py
    else:
        campo_data_map = {
            "emissao": "dt_emissao",
            "vencimento": "dt_vencimento",
            "baixa": "dt_baixa"
        }
        campo_data = campo_data_map.get(tipo_data, "dt_emissao")

    # Verificar se é agrupamento mensal ou diário
    # Se período tem formato YYYY-MM (7 chars), é mensal
    # Se período tem formato YYYY-MM-DD (10 chars), é diário
    agrupamento_mensal = len(periodos[0]) == 7 if periodos else False

    # Estrutura: atividades -> grupos -> categorias -> duplicatas
    atividades = defaultdict(lambda: {
        'label': '',
        'total': 0,
        'valores_mes': defaultdict(float),
        'grupos': defaultdict(lambda: {
            'label': '',
            'total': 0,
            'valores_mes': defaultdict(float),
            'categorias': defaultdict(lambda: {
                'label': '',
                'total': 0,
                'valores_mes': defaultdict(float),
                'duplicatas': defaultdict(lambda: {
                    'label': '',
                    'total': 0,
                    'valores_mes': defaultdict(float)
                })
            })
        })
    })

    for despesa in despesas:
        # Extrair categoria e determinar atividade
        ds_categoria = despesa['ds_despesaitem'] or 'SEM CATEGORIA'
        cd_categoria = despesa['cd_despesaitem']

        # USAR categoria_personalizada do banco (configurado pelo usuário no frontend)
        categoria_config = despesa.get('categoria_personalizada', 'OPERACIONAIS')

        # Nível 1: label passado pelo caller (default: Atividades Operacionais)
        atividade_nome = label_atividade

        # Nível 2 (Grupo): Usar categoria_personalizada do banco de dados
        # Mapeamento das categorias configuradas para nomes de exibição
        mapa_grupos = {
            'MATERIA_PRIMA': 'MATÉRIA PRIMA',
            'OPERACIONAIS': 'DESPESAS OPERACIONAIS',
            'FOLHA_PAGAMENTO': 'FOLHA DE PAGAMENTO',
            'IMPOSTOS': 'IMPOSTOS E TAXAS',
            'FINANCEIRAS': 'DESPESAS FINANCEIRAS',
            'INVESTIMENTOS': 'INVESTIMENTOS',
            'FORNECEDORES': 'FORNECEDORES (Matéria Prima)',
        }
        grupo_nome = mapa_grupos.get(categoria_config, categoria_config)

        # Nível 3 (Categoria): descrição da despesa (ds_despesaitem)
        categoria_nome = ds_categoria

        # Informações da duplicata
        nr_duplicata = despesa['nr_duplicata']
        nm_fornecedor = despesa['nm_fornecedor'] or despesa['nm_fantasia'] or 'FORNECEDOR DESCONHECIDO'
        duplicata_label = f"Dup {nr_duplicata} - {nm_fornecedor}"

        # Pegar a data correta
        dt_ref = despesa[campo_data]

        if dt_ref:
            # Se agrupamento é mensal, usar apenas YYYY-MM
            # Se agrupamento é diário, usar YYYY-MM-DD completo
            if agrupamento_mensal:
                data_key = dt_ref.strftime('%Y-%m')
            else:
                data_key = dt_ref.strftime('%Y-%m-%d')

            # Verificar se data está no intervalo de períodos
            if data_key not in periodos:
                continue
        else:
            data_key = 'SEM_DATA'

        valor = float(despesa['vl_rateio'] or 0)

        # Atualizar atividade
        if not atividades[atividade_nome]['label']:
            atividades[atividade_nome]['label'] = atividade_nome
        atividades[atividade_nome]['total'] += valor
        atividades[atividade_nome]['valores_mes'][data_key] += valor

        # Atualizar grupo
        if not atividades[atividade_nome]['grupos'][grupo_nome]['label']:
            atividades[atividade_nome]['grupos'][grupo_nome]['label'] = grupo_nome
        atividades[atividade_nome]['grupos'][grupo_nome]['total'] += valor
        atividades[atividade_nome]['grupos'][grupo_nome]['valores_mes'][data_key] += valor

        # Atualizar categoria
        if not atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['label']:
            atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['label'] = ds_categoria
        atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['total'] += valor
        atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['valores_mes'][data_key] += valor

        # Atualizar duplicata
        duplicata_key = f"{nr_duplicata}_{nm_fornecedor}"
        if not atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['label']:
            atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['label'] = duplicata_label
        atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['total'] += valor
        atividades[atividade_nome]['grupos'][grupo_nome]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['valores_mes'][data_key] += valor

    # Montar dados DFC com hierarquia
    # Ordem das atividades: Operacionais, Matéria Prima, Folha Pagamento, Investimento, Financiamento
    ordem_atividades = [
        "Atividades Operacionais",
        "Custos de Matéria Prima",
        "Folha de Pagamento",
        "Atividades de Investimento",
        "Atividades de Financiamento"
    ]
    data_dfc = []

    for atividade_nome in ordem_atividades:
        if atividade_nome not in atividades:
            continue

        atividade_data = atividades[atividade_nome]

        # Nível 1: Atividade
        atividade_item = {
            'label': atividade_data['label'],
            'total': -abs(atividade_data['total']),
            'subItems': []
        }

        # Adicionar valores por período da atividade
        for periodo in periodos:
            valor = atividade_data['valores_mes'].get(periodo, 0)
            atividade_item[periodo] = -abs(valor)

        # Nível 2: Grupos da atividade
        for grupo_key, grupo_data in atividade_data['grupos'].items():
            grupo_item = {
                'label': grupo_data['label'],
                'total': -abs(grupo_data['total']),
                'subItems': []
            }

            # Adicionar valores por período do grupo
            for periodo in periodos:
                valor = grupo_data['valores_mes'].get(periodo, 0)
                grupo_item[periodo] = -abs(valor)

            # Nível 3: Categorias do grupo (nível final - modal mostra duplicatas)
            for cat_key, cat_data in grupo_data['categorias'].items():
                cat_item = {
                    'label': cat_data['label'],
                    'total': -abs(cat_data['total'])
                    # Sem subItems - clique no valor abre modal com duplicatas
                }

                # Adicionar valores por período da categoria
                for periodo in periodos:
                    valor = cat_data['valores_mes'].get(periodo, 0)
                    cat_item[periodo] = -abs(valor)

                grupo_item['subItems'].append(cat_item)

            atividade_item['subItems'].append(grupo_item)

        data_dfc.append(atividade_item)

    return {
        'title': 'PAGAMENTOS',
        'data': data_dfc,
        'isNegative': True
    }

def fetch_recebimentos(data_inicio: str, data_fim: str, tipo_data: str = "emissao", tipo_fluxo: str = "previsao") -> List[Dict]:
    """Busca recebimentos do banco de dados

    Args:
        data_inicio: Data inicial
        data_fim: Data final
        tipo_data: Tipo de data (emissao, vencimento, baixa)
        tipo_fluxo: Tipo de fluxo - 'realizado' (já recebidos) ou 'previsao' (a receber)
    """

    # Definir filtro e campo de data baseado no tipo_fluxo
    if tipo_fluxo == "realizado":
        # REALIZADO: Filtrar por dt_baixa (quando foi efetivamente recebido)
        campo_data = "i.dt_baixa"
        filtro_baixa = "AND i.dt_baixa IS NOT NULL"
    else:
        # PREVISÃO: Usar campo de data selecionado pelo usuário
        if tipo_data == "vencimento":
            campo_data = """CASE
                WHEN i.tp_documento = 2 THEN (i.dt_vencimento + interval '2 days')
                WHEN i.tp_documento = 4 THEN (i.dt_emissao + interval '2 days')
                ELSE i.dt_vencimento
            END"""
        elif tipo_data == "baixa":
            campo_data = "i.dt_baixa"
        else:
            campo_data = "i.dt_emissao"
        filtro_baixa = "AND i.dt_baixa IS NULL"

    # Consulta otimizada - JOIN com vr_pes_pessoa em vez de funcoes
    query = f"""
        SELECT
            i.cd_cliente,
            COALESCE(p.nm_pessoa, 'N/A') as nm_cliente,
            COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia,
            CAST(i.cd_empresa AS VARCHAR) || '-' || CAST(i.cd_cliente AS VARCHAR) as nr_fatura,
            i.nr_parcela,
            i.dt_emissao,
            i.dt_vencimento,
            i.dt_baixa,
            i.vl_fatura,
            i.tp_documento,
            CASE
                WHEN i.tp_documento = 1  THEN 'Fatura'
                WHEN i.tp_documento = 2  THEN 'Cheque'
                WHEN i.tp_documento = 3  THEN 'Dinheiro'
                WHEN i.tp_documento = 4  THEN 'Cartão Crédito'
                WHEN i.tp_documento = 5  THEN 'Cartão Débito'
                WHEN i.tp_documento = 6  THEN 'Nota Débito'
                WHEN i.tp_documento = 7  THEN 'TEF'
                WHEN i.tp_documento = 8  THEN 'Cheque TEF'
                WHEN i.tp_documento = 9  THEN 'Troco'
                WHEN i.tp_documento = 10 THEN 'Adiantamento'
                WHEN i.tp_documento = 11 THEN 'Desconto Financeiro'
                WHEN i.tp_documento = 12 THEN 'DOFNI'
                WHEN i.tp_documento = 13 THEN 'Vale'
                WHEN i.tp_documento = 14 THEN 'Nota Promissória'
                WHEN i.tp_documento = 15 THEN 'Cheque Garantido'
                WHEN i.tp_documento = 16 THEN 'TED/DOC'
                WHEN i.tp_documento = 17 THEN 'Pré-Autorização TEF'
                WHEN i.tp_documento = 18 THEN 'Cheque Presente'
                WHEN i.tp_documento = 19 THEN 'TEF/TECBAN - BANRISUL'
                WHEN i.tp_documento = 20 THEN 'CREDEV'
                WHEN i.tp_documento = 21 THEN 'Cartão Próprio'
                WHEN i.tp_documento = 22 THEN 'TEF/HYPERCARD'
                WHEN i.tp_documento = 23 THEN 'Bônus Desconto'
                WHEN i.tp_documento = 25 THEN 'Voucher'
                WHEN i.tp_documento = 26 THEN 'PIX'
                WHEN i.tp_documento = 27 THEN 'PicPay'
                WHEN i.tp_documento = 28 THEN 'Ame'
                WHEN i.tp_documento = 29 THEN 'Mercado Pago'
                WHEN i.tp_documento = 30 THEN 'Marketplace'
                WHEN i.tp_documento = 31 THEN 'PIX Estático'
                WHEN i.tp_documento = 50 THEN 'Outro Documento'
                ELSE 'Tipo Desconhecido'
            END as ds_documento
        FROM
            vr_fcr_faturai i
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = i.cd_cliente
        WHERE
            i.tp_situacao = 1
            AND i.tp_baixa NOT IN (6, 8, 11, 12)
            AND i.tp_documento NOT IN (7, 10, 11)
            AND {campo_data} >= %s
            AND {campo_data} <= %s
            {filtro_baixa}
        ORDER BY
            {campo_data}
    """

    return execute_query(query, (data_inicio, data_fim))

def converter_recebimentos_para_dfc_hierarquico(recebimentos: List[Dict], periodos: List[str], tipo_data: str = "emissao", tipo_fluxo: str = "previsao") -> Dict:
    """Converte recebimentos para formato DFC com hierarquia de 4 níveis segundo CPC 03

    Nível 1: Atividade DFC (Operacionais, Investimento, Financiamento)
    Nível 2: Tipo de Documento (Fatura, Cheque, Cartão, etc.)
    Nível 3: Cliente (nome do cliente)
    Nível 4: Fatura (nr_fatura + parcela)
    """

    # Determinar qual campo de data usar
    # IMPORTANTE: Quando tipoFluxo é "realizado", SEMPRE usar dt_baixa para agrupar
    if tipo_fluxo == "realizado":
        campo_data = "dt_baixa"
    else:
        campo_data_map = {
            "emissao": "dt_emissao",
            "vencimento": "dt_vencimento",
            "baixa": "dt_baixa"
        }
        campo_data = campo_data_map.get(tipo_data, "dt_emissao")

    # Verificar se é agrupamento mensal ou diário
    agrupamento_mensal = len(periodos[0]) == 7 if periodos else False

    # Estrutura: atividades -> tipos_documento -> clientes -> faturas
    atividades = defaultdict(lambda: {
        'label': '',
        'total': 0,
        'valores_mes': defaultdict(float),
        'tipos_documento': defaultdict(lambda: {
            'label': '',
            'total': 0,
            'valores_mes': defaultdict(float),
            'clientes': defaultdict(lambda: {
                'label': '',
                'total': 0,
                'valores_mes': defaultdict(float),
                'faturas': defaultdict(lambda: {
                    'label': '',
                    'total': 0,
                    'valores_mes': defaultdict(float)
                })
            })
        })
    })

    for recebimento in recebimentos:
        # Tipo de documento
        tp_documento = recebimento['tp_documento']
        ds_documento = recebimento['ds_documento'] or 'Outros'

        # Mapear para atividade DFC
        atividade_nome = mapear_atividade_dfc(tp_documento=tp_documento, is_receita=True)

        # Informações do cliente
        cd_cliente = recebimento['cd_cliente']
        nm_cliente = recebimento['nm_cliente'] or recebimento['nm_fantasia'] or 'CLIENTE DESCONHECIDO'

        # Informações da fatura
        nr_fatura = recebimento['nr_fatura']
        nr_parcela = recebimento['nr_parcela']
        fatura_label = f"Fatura {nr_fatura}/{nr_parcela} - {nm_cliente}"
        fatura_key = f"{nr_fatura}_{nr_parcela}_{nm_cliente}"

        # Pegar a data correta
        dt_ref = recebimento[campo_data]
        if dt_ref:
            # Se agrupamento é mensal, usar apenas YYYY-MM
            # Se agrupamento é diário, usar YYYY-MM-DD completo
            if agrupamento_mensal:
                data_key = dt_ref.strftime('%Y-%m')
            else:
                data_key = dt_ref.strftime('%Y-%m-%d')

            # Verificar se data está no intervalo de períodos
            if data_key not in periodos:
                continue
        else:
            data_key = 'SEM_DATA'

        valor = float(recebimento['vl_fatura'] or 0)

        # Atualizar atividade
        if not atividades[atividade_nome]['label']:
            atividades[atividade_nome]['label'] = atividade_nome
        atividades[atividade_nome]['total'] += valor
        atividades[atividade_nome]['valores_mes'][data_key] += valor

        # Atualizar tipo de documento
        if not atividades[atividade_nome]['tipos_documento'][tp_documento]['label']:
            atividades[atividade_nome]['tipos_documento'][tp_documento]['label'] = ds_documento
        atividades[atividade_nome]['tipos_documento'][tp_documento]['total'] += valor
        atividades[atividade_nome]['tipos_documento'][tp_documento]['valores_mes'][data_key] += valor

        # Atualizar cliente
        if not atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['label']:
            atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['label'] = nm_cliente
        atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['total'] += valor
        atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['valores_mes'][data_key] += valor

        # Atualizar fatura
        if not atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['faturas'][fatura_key]['label']:
            atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['faturas'][fatura_key]['label'] = fatura_label
        atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['faturas'][fatura_key]['total'] += valor
        atividades[atividade_nome]['tipos_documento'][tp_documento]['clientes'][cd_cliente]['faturas'][fatura_key]['valores_mes'][data_key] += valor

    # Montar dados DFC com hierarquia
    # Ordem das atividades: Operacionais, Investimento, Financiamento
    ordem_atividades = ["Atividades Operacionais", "Atividades de Investimento", "Atividades de Financiamento"]
    data_dfc = []

    for atividade_nome in ordem_atividades:
        if atividade_nome not in atividades:
            continue

        atividade_data = atividades[atividade_nome]

        # Nível 1: Atividade
        atividade_item = {
            'label': atividade_data['label'],
            'total': abs(atividade_data['total']),
            'subItems': []
        }

        # Adicionar valores por período da atividade
        for periodo in periodos:
            valor = atividade_data['valores_mes'].get(periodo, 0)
            atividade_item[periodo] = abs(valor)

        # Nível 2: Tipos de documento da atividade
        for tipo_key, tipo_data in atividade_data['tipos_documento'].items():
            tipo_item = {
                'label': tipo_data['label'],
                'total': abs(tipo_data['total']),
                'subItems': []
            }

            # Adicionar valores por período do tipo
            for periodo in periodos:
                valor = tipo_data['valores_mes'].get(periodo, 0)
                tipo_item[periodo] = abs(valor)

            # Nível 3: Clientes do tipo (nível final - modal mostra faturas)
            for cliente_key, cliente_data in tipo_data['clientes'].items():
                cliente_item = {
                    'label': cliente_data['label'],
                    'total': abs(cliente_data['total'])
                    # Sem subItems - clique no valor abre modal com faturas
                }

                # Adicionar valores por período do cliente
                for periodo in periodos:
                    valor = cliente_data['valores_mes'].get(periodo, 0)
                    cliente_item[periodo] = abs(valor)

                tipo_item['subItems'].append(cliente_item)

            atividade_item['subItems'].append(tipo_item)

        data_dfc.append(atividade_item)

    return {
        'title': 'RECEBIMENTOS',
        'data': data_dfc,
        'isNegative': False
    }

def converter_para_visao_diaria(despesas: List[Dict], recebimentos: List[Dict], datas: List[str], tipo_data: str = "emissao") -> Dict:
    """Converte dados para visão diária onde linhas=datas e colunas=categorias

    Args:
        despesas: Lista de despesas
        recebimentos: Lista de recebimentos
        datas: Lista de datas diárias (YYYY-MM-DD)
        tipo_data: Campo de data a usar (emissao, vencimento, baixa)

    Returns:
        Dict com estrutura: {
            'datas': [{'data': 'YYYY-MM-DD', 'label': 'DD/MM', 'categorias': {...}, 'saldo_dia': valor}],
            'categorias': ['Cat1', 'Cat2', ...]
        }
    """

    # Determinar qual campo de data usar
    campo_data_map = {
        "emissao": "dt_emissao",
        "vencimento": "dt_vencimento",
        "baixa": "dt_baixa"
    }
    campo_data = campo_data_map.get(tipo_data, "dt_emissao")

    # Estrutura: data -> categoria -> valor
    dados_por_data = defaultdict(lambda: {
        'recebimentos': defaultdict(float),
        'pagamentos': defaultdict(float)
    })

    # Processar despesas
    for despesa in despesas:
        dt_ref = despesa[campo_data]
        if not dt_ref:
            continue

        data_str = dt_ref.strftime('%Y-%m-%d')
        if data_str not in datas:
            continue

        # Mapear para atividade DFC
        ds_categoria = despesa['ds_despesaitem'] or 'SEM CATEGORIA'
        atividade = mapear_atividade_dfc(ds_despesaitem=ds_categoria, is_receita=False)
        categoria_completa = f"{atividade} - {ds_categoria}"

        valor = float(despesa['vl_rateio'] or 0)
        dados_por_data[data_str]['pagamentos'][categoria_completa] += valor

    # Processar recebimentos
    for recebimento in recebimentos:
        dt_ref = recebimento[campo_data]
        if not dt_ref:
            continue

        data_str = dt_ref.strftime('%Y-%m-%d')
        if data_str not in datas:
            continue

        # Mapear para atividade DFC
        tp_documento = recebimento['tp_documento']
        ds_documento = recebimento['ds_documento'] or 'Outros'
        atividade = mapear_atividade_dfc(tp_documento=tp_documento, is_receita=True)
        categoria_completa = f"{atividade} - {ds_documento}"

        valor = float(recebimento['vl_fatura'] or 0)
        dados_por_data[data_str]['recebimentos'][categoria_completa] += valor

    # Coletar todas as categorias únicas
    categorias_set = set()
    for data_info in dados_por_data.values():
        categorias_set.update(data_info['recebimentos'].keys())
        categorias_set.update(data_info['pagamentos'].keys())

    categorias = sorted(list(categorias_set))

    # Montar resultado
    resultado = []
    saldo_acumulado = 0

    for data_str in datas:
        # Formatar label da data
        dt = datetime.strptime(data_str, '%Y-%m-%d')
        label_data = dt.strftime('%d/%m/%Y')

        # Preparar categorias desta data
        categorias_dia = {}
        saldo_dia = 0

        for categoria in categorias:
            # Valor de recebimentos (positivo)
            valor_recebimento = dados_por_data[data_str]['recebimentos'].get(categoria, 0)
            # Valor de pagamentos (negativo)
            valor_pagamento = dados_por_data[data_str]['pagamentos'].get(categoria, 0)

            # Somar tudo
            valor_total = valor_recebimento - valor_pagamento
            categorias_dia[categoria] = valor_total
            saldo_dia += valor_total

        saldo_acumulado += saldo_dia

        resultado.append({
            'data': data_str,
            'label': label_data,
            'categorias': categorias_dia,
            'saldo_dia': saldo_dia,
            'saldo_acumulado': saldo_acumulado
        })

    return {
        'datas': resultado,
        'categorias': categorias
    }

def obter_detalhes_diarios_categoria(despesas: List[Dict], recebimentos: List[Dict], categoria: str, data_inicio: str, data_fim: str, tipo_data: str = "emissao") -> Dict:
    """Obtém detalhes diários de uma categoria específica

    Args:
        despesas: Lista de despesas
        recebimentos: Lista de recebimentos
        categoria: Nome da categoria para filtrar
        data_inicio: Data inicial
        data_fim: Data final
        tipo_data: Campo de data a usar (emissao, vencimento, baixa)

    Returns:
        Dict com detalhes diários da categoria
    """
    from datetime import timedelta

    # Determinar qual campo de data usar
    campo_data_map = {
        "emissao": "dt_emissao",
        "vencimento": "dt_vencimento",
        "baixa": "dt_baixa"
    }
    campo_data = campo_data_map.get(tipo_data, "dt_emissao")

    # Gerar datas
    datas = gerar_datas_diarias(data_inicio, data_fim)

    # Estrutura: data -> detalhes
    dados_por_data = defaultdict(lambda: {
        'data': '',
        'itens': [],
        'total': 0
    })

    # Processar despesas da categoria
    for despesa in despesas:
        dt_ref = despesa[campo_data]
        if not dt_ref:
            continue

        data_str = dt_ref.strftime('%Y-%m-%d')
        if data_str not in datas:
            continue

        ds_categoria = despesa['ds_despesaitem'] or 'SEM CATEGORIA'

        # Verificar se é a categoria procurada (pode ser categoria completa ou parte do nome)
        if categoria not in ds_categoria and ds_categoria not in categoria:
            continue

        valor = float(despesa['vl_rateio'] or 0)
        nm_fornecedor = despesa['nm_fornecedor'] or despesa['nm_fantasia'] or 'FORNECEDOR DESCONHECIDO'

        dados_por_data[data_str]['data'] = data_str
        dados_por_data[data_str]['itens'].append({
            'tipo': 'Pagamento',
            'descricao': f"Dup {despesa['nr_duplicata']} - {nm_fornecedor}",
            'categoria': ds_categoria,
            'valor': -abs(valor),
            'fornecedor': nm_fornecedor,
            'duplicata': despesa['nr_duplicata']
        })
        dados_por_data[data_str]['total'] -= valor

    # Processar recebimentos da categoria
    for recebimento in recebimentos:
        dt_ref = recebimento[campo_data]
        if not dt_ref:
            continue

        data_str = dt_ref.strftime('%Y-%m-%d')
        if data_str not in datas:
            continue

        ds_documento = recebimento['ds_documento'] or 'Outros'

        # Verificar se é a categoria procurada
        if categoria not in ds_documento and ds_documento not in categoria:
            continue

        valor = float(recebimento['vl_fatura'] or 0)
        nm_cliente = recebimento['nm_cliente'] or recebimento['nm_fantasia'] or 'CLIENTE DESCONHECIDO'

        dados_por_data[data_str]['data'] = data_str
        dados_por_data[data_str]['itens'].append({
            'tipo': 'Recebimento',
            'descricao': f"Fatura {recebimento['nr_fatura']}/{recebimento['nr_parcela']} - {nm_cliente}",
            'categoria': ds_documento,
            'valor': abs(valor),
            'cliente': nm_cliente,
            'fatura': recebimento['nr_fatura']
        })
        dados_por_data[data_str]['total'] += valor

    # Montar resultado com todas as datas (mesmo as sem movimentação)
    resultado = []
    for data_str in datas:
        if data_str in dados_por_data:
            resultado.append(dados_por_data[data_str])
        else:
            dt = datetime.strptime(data_str, '%Y-%m-%d')
            resultado.append({
                'data': data_str,
                'label': dt.strftime('%d/%m/%Y'),
                'itens': [],
                'total': 0
            })

    return {
        'categoria': categoria,
        'dataInicio': data_inicio,
        'dataFim': data_fim,
        'detalhes': resultado
    }

def fetch_duplicatas_por_categoria(categoria: str, data: str, is_receita: bool = False, tipo_data: str = "emissao") -> List[Dict]:
    """
    Busca duplicatas de uma categoria específica em uma data específica

    Args:
        categoria: Nome da categoria (ex: "Fornecedores", "Salários")
        data: Data específica no formato YYYY-MM-DD
        is_receita: True para recebimentos, False para pagamentos
        tipo_data: Tipo de data para filtrar (emissao, vencimento, baixa)

    Returns:
        Lista de duplicatas com detalhes
    """
    # Determinar qual campo de data usar
    campo_data = {
        "emissao": "di.dt_emissao" if not is_receita else "fi.dt_emissao",
        "vencimento": "di.dt_vencimento" if not is_receita else "fi.dt_vencimento",
        "baixa": "di.dt_baixa" if not is_receita else "fi.dt_baixa"
    }.get(tipo_data, "di.dt_emissao" if not is_receita else "fi.dt_emissao")

    if is_receita:
        # Query para recebimentos - JOIN com vr_pes_pessoa
        query = f"""
            SELECT
                fi.nr_fatura as nr_duplicata,
                COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia,
                fi.dt_emissao,
                fi.dt_vencimento,
                fi.dt_baixa,
                fi.vl_parcela as vl_rateio,
                CASE fi.tp_documento
                    WHEN 1 THEN 'Fatura'
                    WHEN 2 THEN 'Cheque'
                    WHEN 3 THEN 'Duplicata'
                    WHEN 4 THEN 'Cartão de Crédito'
                    WHEN 5 THEN 'Cheque Avulso'
                    WHEN 6 THEN 'Carteira'
                    WHEN 7 THEN 'Promissória'
                    WHEN 8 THEN 'Boleto'
                    WHEN 9 THEN 'Débito'
                    ELSE 'Outros'
                END as ds_despesaitem
            FROM
                vr_fcp_fatparc fi
                INNER JOIN vr_fcp_fatura i ON i.cd_fatura = fi.cd_fatura
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = i.cd_cliente
            WHERE
                fi.tp_situacao = 'N'
                AND {campo_data} = %s
            ORDER BY
                fi.vl_parcela DESC
        """
        result = execute_query(query, (data,))
    else:
        # Query para pagamentos - filtrar por categoria - JOIN com vr_pes_pessoa
        query = f"""
            SELECT
                di.nr_duplicata,
                COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia,
                di.dt_emissao,
                di.dt_vencimento,
                di.dt_baixa,
                di.vl_rateio,
                b.ds_despesaitem
            FROM
                vr_fcp_despduplicatai di
                INNER JOIN vr_fcp_despesaitem b ON b.cd_despesaitem = di.cd_despesaitem
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = di.cd_fornecedor
            WHERE
                di.tp_situacao = 'N'
                AND {campo_data} = %s
                AND b.ds_despesaitem = %s
            ORDER BY
                di.vl_rateio DESC
        """
        result = execute_query(query, (data, categoria))

    return result


def fetch_centros_custo() -> List[int]:
    """
    Busca lista de centros de custo distintos disponíveis na base

    Returns:
        Lista de códigos de centros de custo
    """
    query = """
        SELECT DISTINCT cd_ccusto
        FROM vr_fcp_despduplicatai
        WHERE cd_ccusto IS NOT NULL
        ORDER BY cd_ccusto
    """
    result = execute_query(query)
    return [row['cd_ccusto'] for row in result]


def fetch_duplicatas_por_periodo(categoria: str, data_inicio: str, data_fim: str, is_receita: bool = False, tipo_data: str = "emissao") -> List[Dict]:
    """
    Busca duplicatas de uma categoria específica em um período

    Args:
        categoria: Nome da categoria (pode ser atividade, grupo ou item de despesa)
        data_inicio: Data inicial no formato YYYY-MM-DD
        data_fim: Data final no formato YYYY-MM-DD
        is_receita: True para recebimentos, False para pagamentos
        tipo_data: Tipo de data para filtrar (emissao, vencimento, baixa)

    Returns:
        Lista de duplicatas com detalhes
    """

    if is_receita:
        # Determinar qual campo de data usar para recebimentos
        if tipo_data == "vencimento":
            campo_data = """CASE
                WHEN i.tp_documento = 2 THEN (i.dt_vencimento + interval '2 days')
                WHEN i.tp_documento = 4 THEN (i.dt_emissao + interval '2 days')
                ELSE i.dt_vencimento
            END"""
        elif tipo_data == "baixa":
            campo_data = "i.dt_baixa"
        else:
            campo_data = "i.dt_emissao"

        # Mapear categoria para tipo de documento ou atividade
        # Verificar se é uma atividade DFC
        atividade_filter = ""
        tipo_doc_filter = ""

        if "Atividades Operacionais" in categoria:
            # Todos recebimentos são operacionais por padrão
            pass
        elif "Atividades de Investimento" in categoria:
            # Não há recebimentos de investimento neste modelo
            return []
        elif "Atividades de Financiamento" in categoria:
            # Não há recebimentos de financiamento neste modelo
            return []
        else:
            # Filtrar por tipo de documento
            tipo_doc_map = {
                'Fatura': 1,
                'Cheque': 2,
                'Duplicata Mercantil': 3,
                'Cartao Credito': 4,
                'Cartão Crédito': 4,
                'Cheque Pre-Datado': 5,
                'Cheque Pré-Datado': 5,
                'Carteira de Cobranca': 6,
                'Carteira de Cobrança': 6,
                'Boleto': 8,
                'Cartao de Debito': 9,
                'Cartão de Débito': 9,
            }
            for doc_name, doc_code in tipo_doc_map.items():
                if doc_name in categoria:
                    tipo_doc_filter = f"AND i.tp_documento = {doc_code}"
                    break

        # Query para recebimentos
        query = f"""
            SELECT
                i.cd_cliente,
                COALESCE(p.nm_pessoa, 'N/A') as nm_cliente,
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia,
                CAST(i.cd_empresa AS VARCHAR) || '-' || CAST(i.cd_cliente AS VARCHAR) as nr_fatura,
                i.nr_parcela,
                i.dt_emissao,
                i.dt_vencimento,
                i.dt_baixa,
                i.vl_fatura as vl_rateio,
                i.tp_documento,
                CASE
                    WHEN i.tp_documento = 1  THEN 'Fatura'
                    WHEN i.tp_documento = 2  THEN 'Cheque'
                    WHEN i.tp_documento = 3  THEN 'Dinheiro'
                    WHEN i.tp_documento = 4  THEN 'Cartão Crédito'
                    WHEN i.tp_documento = 5  THEN 'Cartão Débito'
                    WHEN i.tp_documento = 6  THEN 'Nota Débito'
                    WHEN i.tp_documento = 7  THEN 'TEF'
                    WHEN i.tp_documento = 8  THEN 'Cheque TEF'
                    WHEN i.tp_documento = 9  THEN 'Troco'
                    WHEN i.tp_documento = 10 THEN 'Adiantamento'
                    WHEN i.tp_documento = 11 THEN 'Desconto Financeiro'
                    WHEN i.tp_documento = 12 THEN 'DOFNI'
                    WHEN i.tp_documento = 13 THEN 'Vale'
                    WHEN i.tp_documento = 14 THEN 'Nota Promissória'
                    WHEN i.tp_documento = 15 THEN 'Cheque Garantido'
                    WHEN i.tp_documento = 16 THEN 'TED/DOC'
                    WHEN i.tp_documento = 17 THEN 'Pré-Autorização TEF'
                    WHEN i.tp_documento = 18 THEN 'Cheque Presente'
                    WHEN i.tp_documento = 19 THEN 'TEF/TECBAN - BANRISUL'
                    WHEN i.tp_documento = 20 THEN 'CREDEV'
                    WHEN i.tp_documento = 21 THEN 'Cartão Próprio'
                    WHEN i.tp_documento = 22 THEN 'TEF/HYPERCARD'
                    WHEN i.tp_documento = 23 THEN 'Bônus Desconto'
                    WHEN i.tp_documento = 25 THEN 'Voucher'
                    WHEN i.tp_documento = 26 THEN 'PIX'
                    WHEN i.tp_documento = 27 THEN 'PicPay'
                    WHEN i.tp_documento = 28 THEN 'Ame'
                    WHEN i.tp_documento = 29 THEN 'Mercado Pago'
                    WHEN i.tp_documento = 30 THEN 'Marketplace'
                    WHEN i.tp_documento = 31 THEN 'PIX Estático'
                    WHEN i.tp_documento = 50 THEN 'Outro Documento'
                    ELSE 'Tipo Desconhecido'
                END as ds_documento
            FROM
                vr_fcr_faturai i
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = i.cd_cliente
            WHERE
                i.tp_situacao = 1
                AND i.tp_baixa NOT IN (6, 8, 11, 12)
                AND i.tp_documento NOT IN (7, 10, 11)
                AND {campo_data} >= %s
                AND {campo_data} <= %s
                {tipo_doc_filter}
            ORDER BY
                i.vl_fatura DESC
        """
        return execute_query(query, (data_inicio, data_fim))

    else:
        # Determinar qual campo de data usar para pagamentos
        campo_data = {
            "emissao": "di.dt_emissao",
            "vencimento": "di.dt_vencimento",
            "baixa": "di.dt_baixa"
        }.get(tipo_data, "di.dt_emissao")

        # Verificar se é uma atividade DFC ou categoria específica
        atividade_filter = ""
        categoria_filter = ""

        # Verificar se a categoria é uma atividade DFC
        if "Atividades de Investimento" in categoria:
            # Filtrar por palavras-chave de investimento
            investimento_keywords = [
                'ativo', 'imobilizado', 'equipamento', 'veículo', 'veiculo',
                'máquina', 'maquina', 'imóvel', 'imovel', 'terreno', 'construção', 'construcao',
                'software permanente', 'licença perpétua', 'licenca perpetua',
                'investimento', 'aquisição', 'aquisicao', 'compra de ativo'
            ]
            keyword_conditions = " OR ".join([f"LOWER(b.ds_despesaitem) LIKE '%%{kw}%%'" for kw in investimento_keywords])
            atividade_filter = f"AND ({keyword_conditions})"
        elif "Atividades de Financiamento" in categoria:
            # Filtrar por palavras-chave de financiamento
            financiamento_keywords = [
                'empréstimo', 'emprestimo', 'financiamento', 'juros de empréstimo', 'juros de emprestimo',
                'amortização', 'amortizacao', 'dívida', 'divida', 'capital social',
                'distribuição de lucro', 'distribuicao de lucro', 'dividendo',
                'leasing financeiro', 'arrendamento mercantil'
            ]
            keyword_conditions = " OR ".join([f"LOWER(b.ds_despesaitem) LIKE '%%{kw}%%'" for kw in financiamento_keywords])
            atividade_filter = f"AND ({keyword_conditions})"
        elif "Atividades Operacionais" in categoria:
            # Operacional é o padrão - excluir investimento e financiamento
            investimento_keywords = [
                'ativo', 'imobilizado', 'equipamento', 'veículo', 'veiculo',
                'máquina', 'maquina', 'imóvel', 'imovel', 'terreno', 'construção', 'construcao',
                'software permanente', 'licença perpétua', 'licenca perpetua',
                'investimento', 'aquisição', 'aquisicao', 'compra de ativo'
            ]
            financiamento_keywords = [
                'empréstimo', 'emprestimo', 'financiamento', 'juros de empréstimo', 'juros de emprestimo',
                'amortização', 'amortizacao', 'dívida', 'divida', 'capital social',
                'distribuição de lucro', 'distribuicao de lucro', 'dividendo',
                'leasing financeiro', 'arrendamento mercantil'
            ]
            all_keywords = investimento_keywords + financiamento_keywords
            keyword_conditions = " AND ".join([f"LOWER(b.ds_despesaitem) NOT LIKE '%%{kw}%%'" for kw in all_keywords])
            atividade_filter = f"AND ({keyword_conditions})"
        else:
            # É uma categoria específica (ds_despesaitem)
            categoria_filter = "AND b.ds_despesaitem = %s"

        # Determinar filtro de baixa baseado no tipo_data
        # IMPORTANTE: Filtrar apenas tp_baixa válidos (mesmo filtro do DFC principal)
        if tipo_data == "baixa":
            filtro_baixa = "AND di.dt_baixa IS NOT NULL AND di.tp_baixa = ANY(ARRAY[3, 6, 8, 9, 15, 18])"
        else:
            filtro_baixa = "AND di.dt_baixa IS NULL"

        # Query para pagamentos
        if categoria_filter:
            query = f"""
                SELECT
                    di.cd_fornecedor,
                    COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                    COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia,
                    di.nr_duplicata,
                    di.dt_emissao,
                    di.dt_vencimento,
                    di.dt_baixa,
                    di.vl_rateio,
                    di.cd_despesaitem,
                    b.ds_despesaitem
                FROM
                    vr_fcp_despduplicatai di
                    INNER JOIN vr_fcp_despesaitem b ON b.cd_despesaitem = di.cd_despesaitem
                    LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = di.cd_fornecedor
                WHERE
                    di.tp_situacao = 'N'
                    {filtro_baixa}
                    AND {campo_data} >= %s
                    AND {campo_data} <= %s
                    {categoria_filter}
                ORDER BY
                    di.vl_rateio DESC
            """
            print(f"[DEBUG fetch_duplicatas_por_periodo] Query: {query}")
            print(f"[DEBUG fetch_duplicatas_por_periodo] Params: ({data_inicio}, {data_fim}, {categoria})")
            results = execute_query(query, (data_inicio, data_fim, categoria))
            print(f"[DEBUG fetch_duplicatas_por_periodo] Total: {sum(r.get('vl_rateio', 0) for r in results)}")
            return results
        else:
            query = f"""
                SELECT
                    di.cd_fornecedor,
                    COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                    COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia,
                    di.nr_duplicata,
                    di.dt_emissao,
                    di.dt_vencimento,
                    di.dt_baixa,
                    di.vl_rateio,
                    di.cd_despesaitem,
                    b.ds_despesaitem
                FROM
                    vr_fcp_despduplicatai di
                    INNER JOIN vr_fcp_despesaitem b ON b.cd_despesaitem = di.cd_despesaitem
                    LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = di.cd_fornecedor
                WHERE
                    di.tp_situacao = 'N'
                    {filtro_baixa}
                    AND {campo_data} >= %s
                    AND {campo_data} <= %s
                    {atividade_filter}
                ORDER BY
                    di.vl_rateio DESC
            """
            return execute_query(query, (data_inicio, data_fim))


def converter_para_dfc_hierarquico_dre(despesas: List[Dict], periodos: List[str], tipo_data: str = "emissao", tipo_fluxo: str = "previsao") -> Dict:
    """Converte dados para formato DFC com hierarquia baseada na estrutura DRE

    Nível 1: Grupo DRE (A-G)
    Nível 2: Subgrupo DRE (ex: Matérias-Primas, Comissões, etc.)
    Nível 3: Categoria (ds_despesaitem)
    Nível 4: Duplicata (nr_duplicata + fornecedor)
    """

    # Determinar qual campo de data usar
    # IMPORTANTE: Quando tipoFluxo é "realizado", usar dt_emissao que contém dt_baixa
    if tipo_fluxo == "realizado":
        campo_data = "dt_emissao"  # No realizado, dt_emissao é mapeado para dt_baixa em main.py
    else:
        campo_data_map = {
            "emissao": "dt_emissao",
            "vencimento": "dt_vencimento",
            "baixa": "dt_baixa"
        }
        campo_data = campo_data_map.get(tipo_data, "dt_emissao")

    # Verificar se é agrupamento mensal ou diário
    agrupamento_mensal = len(periodos[0]) == 7 if periodos else False

    # Estrutura: grupos_dre -> subgrupos -> categorias -> duplicatas
    grupos_dre = defaultdict(lambda: {
        'label': '',
        'total': 0,
        'valores_mes': defaultdict(float),
        'subgrupos': defaultdict(lambda: {
            'label': '',
            'total': 0,
            'valores_mes': defaultdict(float),
            'categorias': defaultdict(lambda: {
                'label': '',
                'total': 0,
                'valores_mes': defaultdict(float),
                'duplicatas': defaultdict(lambda: {
                    'label': '',
                    'total': 0,
                    'valores_mes': defaultdict(float)
                })
            })
        })
    })

    for despesa in despesas:
        # Extrair categoria e classificar na estrutura DRE
        ds_categoria = despesa['ds_despesaitem'] or 'SEM CATEGORIA'
        cd_categoria = despesa['cd_despesaitem']

        # Classificar na estrutura DRE
        grupo_dre, subgrupo_dre = classificar_despesa_dre(ds_categoria)

        # Informações da duplicata
        nr_duplicata = despesa['nr_duplicata']
        nm_fornecedor = despesa['nm_fornecedor'] or despesa.get('nm_fantasia') or 'FORNECEDOR DESCONHECIDO'
        duplicata_label = f"Dup {nr_duplicata} - {nm_fornecedor}"

        # Pegar a data correta
        dt_ref = despesa[campo_data]

        if dt_ref:
            if agrupamento_mensal:
                data_key = dt_ref.strftime('%Y-%m')
            else:
                data_key = dt_ref.strftime('%Y-%m-%d')

            if data_key not in periodos:
                continue
        else:
            data_key = 'SEM_DATA'

        valor = float(despesa['vl_rateio'] or 0)

        # Atualizar grupo DRE
        if not grupos_dre[grupo_dre]['label']:
            grupos_dre[grupo_dre]['label'] = grupo_dre
        grupos_dre[grupo_dre]['total'] += valor
        grupos_dre[grupo_dre]['valores_mes'][data_key] += valor

        # Atualizar subgrupo
        if not grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['label']:
            grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['label'] = subgrupo_dre
        grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['total'] += valor
        grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['valores_mes'][data_key] += valor

        # Atualizar categoria
        if not grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['label']:
            grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['label'] = ds_categoria
        grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['total'] += valor
        grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['valores_mes'][data_key] += valor

        # Atualizar duplicata
        duplicata_key = f"{nr_duplicata}_{nm_fornecedor}"
        if not grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['label']:
            grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['label'] = duplicata_label
        grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['total'] += valor
        grupos_dre[grupo_dre]['subgrupos'][subgrupo_dre]['categorias'][cd_categoria]['duplicatas'][duplicata_key]['valores_mes'][data_key] += valor

    # Montar dados DFC com hierarquia - ordem da DRE
    ordem_grupos = [
        "A) Deduções da Receita",
        "B) CPV/CMV",
        "C) Despesas com Vendas",
        "D) Despesas G&A",
        "E) Resultado Financeiro",
        "F) Não Operacional",
        "G) Investimentos (CAPEX)"
    ]

    data_dfc = []

    for grupo_nome in ordem_grupos:
        if grupo_nome not in grupos_dre:
            continue

        grupo_data = grupos_dre[grupo_nome]

        # Nível 1: Grupo DRE
        grupo_item = {
            'label': grupo_data['label'],
            'total': -abs(grupo_data['total']),
            'subItems': []
        }

        for periodo in periodos:
            valor = grupo_data['valores_mes'].get(periodo, 0)
            grupo_item[periodo] = -abs(valor)

        # Nível 2: Subgrupos
        for subgrupo_key, subgrupo_data in grupo_data['subgrupos'].items():
            subgrupo_item = {
                'label': subgrupo_data['label'],
                'total': -abs(subgrupo_data['total']),
                'subItems': []
            }

            for periodo in periodos:
                valor = subgrupo_data['valores_mes'].get(periodo, 0)
                subgrupo_item[periodo] = -abs(valor)

            # Nível 3: Categorias (nível final - modal mostra duplicatas)
            for cat_key, cat_data in subgrupo_data['categorias'].items():
                cat_item = {
                    'label': cat_data['label'],
                    'total': -abs(cat_data['total'])
                    # Sem subItems - clique no valor abre modal com duplicatas
                }

                for periodo in periodos:
                    valor = cat_data['valores_mes'].get(periodo, 0)
                    cat_item[periodo] = -abs(valor)

                subgrupo_item['subItems'].append(cat_item)

            grupo_item['subItems'].append(subgrupo_item)

        data_dfc.append(grupo_item)

    return {
        'title': 'PAGAMENTOS',
        'data': data_dfc,
        'isNegative': True
    }
