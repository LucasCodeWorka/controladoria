from fastapi import APIRouter, HTTPException, BackgroundTasks, Query
from database import execute_query, execute_insert
import unicodedata

router = APIRouter()


# ============================================================================
# CLASSIFICADOR INTELIGENTE DRE - ANALISTA FINANCEIRO SÊNIOR
# ============================================================================
# Este módulo simula o raciocínio de um analista financeiro sênior ao
# classificar despesas para a DRE. Ele analisa:
# 1. Código da despesa (mapeamento direto)
# 2. Sufixos especiais (- CO, PROD, ADM, etc.)
# 3. Palavras-chave com contexto
# 4. Padrões de nomenclatura contábil
# 5. Hierarquia de especificidade (mais específico primeiro)
# ============================================================================

def _normalizar_texto(value):
    """Normaliza texto removendo acentos e convertendo para maiúsculas"""
    if not value:
        return ""
    text = str(value).strip().upper()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(text.split())


def _extrair_contexto(nome_despesa):
    """
    Extrai informações contextuais do nome da despesa.
    Retorna um dicionário com flags de contexto.
    """
    nome = _normalizar_texto(nome_despesa)
    return {
        'eh_custo_operacional': '- CO' in nome or '-CO' in nome,
        'eh_producao': 'PROD' in nome or 'PRODUCAO' in nome or 'INDUSTRIAL' in nome,
        'eh_administrativo': 'ADM' in nome or 'ADMINISTRATIVA' in nome or 'ADMINISTRATIVO' in nome,
        'eh_investimento': nome.startswith('INV.') or nome.startswith('INV ') or 'INVESTIMENTO' in nome,
        'eh_retirada': 'RETIRADA' in nome,
        'eh_emprestimo': 'EMPRESTIMO' in nome or 'FINANCIAMENTO' in nome,
        'eh_imposto': 'ICMS' in nome or 'PIS' in nome or 'COFINS' in nome or 'IRPJ' in nome or 'CSLL' in nome or 'ISS' in nome or 'IRRF' in nome,
        'eh_pessoal': 'SALARIO' in nome or 'FGTS' in nome or 'INSS' in nome or 'FERIAS' in nome or '13' in nome or 'RESCISAO' in nome or 'VALE' in nome,
        'eh_marketing': 'MKT' in nome or 'MARKETING' in nome or 'PROPAGANDA' in nome or 'CAMPANHA' in nome,
        'eh_tarifa': 'TARIFA' in nome,
        'eh_manutencao': 'MANUTENCAO' in nome or 'MANUT' in nome,
        'eh_comissao': 'COMISSAO' in nome,
        'nome_normalizado': nome
    }


# Mapeamento por código de despesa (prioridade máxima - quando temos certeza)
MAPEAMENTO_POR_CODIGO = {
    # 08.01 - DESPESAS COM OCUPAÇÃO
    80: '08.01.07',   # TAXAS E EMOLUMENTO - CO
    85: '08.01.02',   # ALUGUEL MINIMO - CO
    110: '08.01.06',  # IPTU - CO
    145: '08.01.03',  # FUNDO DE PROMOCAO - CO
    40: '08.01.04',   # ENERGIA - CO
    50: '08.01.01',   # CONDOMINIO - CO
    146: '08.01.05',  # AR CONDICIONADO - CO
    225: '08.01.04',  # ENERGIA (sem CO)
    45: '08.01.09',   # AGUA E ESGOTO
    56: '08.01.10',   # SEGUROS DE IMOVEIS
    228: '08.01.07',  # TAXAS E EMOLUMENTO
    227: '08.01.06',  # IPTU ADM

    # 08.02 - DESPESAS ADMINISTRATIVAS
    4: '08.02.01',    # ASSESSORIA JURIDICA
    17: '08.02.02',   # ASSESSORIA CONTABIL
    18: '08.02.03',   # MONIT/SEGURANCA
    35: '08.02.04',   # ASSOCIACAO
    51: '08.02.05',   # MATERIAL DE LIMPEZA
    61: '08.02.06',   # MAT DE CONSUMO
    62: '08.02.07',   # AGUA MINERAL
    77: '08.02.09',   # TELEFONIA FIXA
    78: '08.02.10',   # CONSULTORIA
    89: '08.02.11',   # ALUGUEL MAQUINETA
    90: '08.02.12',   # ESTACIONAMENTO DE VEICULO
    108: '08.02.13',  # SERV PRESTADO
    111: '08.02.14',  # DESPESA DE CARTORIO
    133: '08.02.15',  # SERV DEDETIZACAO
    134: '08.02.16',  # TELEFONIA MOVEL
    155: '08.02.17',  # SERV INTERNET
    158: '08.02.18',  # CORREIOS E MALOTES
    184: '08.02.19',  # MATERIAL DE ESCRITORIO
    185: '08.02.20',  # MANUT DE SOFTWARE
    186: '08.02.21',  # CONTRIB/ANUIDADES
    219: '08.02.23',  # ENDOMARKETING
    231: '08.02.25',  # ISS RET FONTE
    238: '08.02.28',  # TAXAS DE ALVARAS
    240: '08.02.29',  # CONFRATERNIZACOES

    # 08.03 - MANUTENCAO
    52: '08.03.01',   # MANUTENCAO INSTALACOES
    53: '08.03.02',   # MANUTENCAO EDIFICACOES
    54: '08.03.03',   # MANUTENCAO EQP INFORMATICA
    55: '08.03.04',   # MANUTENCAO MAQ
    144: '08.03.05',  # MANUTENCAO AR CONDICIONADO

    # 08.04 - PESSOAL
    2: '08.04.02',    # ALIMENTACAO PROD
    3: '08.04.03',    # RESCISAO PROD
    10: '08.04.04',   # INSS PROD
    12: '08.04.05',   # CONTRIBUICAO SINDICAL
    13: '08.04.06',   # EXAMES MEDICOS
    14: '08.04.07',   # VALE TRANSPORTE PROD
    16: '08.04.08',   # ESTAGIOS E TREINAMENTOS
    26: '08.04.10',   # HORAS EXTRAS
    27: '08.04.11',   # FARMACIA PROD
    28: '08.04.12',   # FARDAMENTO
    32: '08.04.14',   # PLANO ODONTOLOGICO
    38: '08.04.16',   # IRRF SOBRE SALARIO
    46: '08.04.18',   # MULTA RESCISORIA FGTS
    69: '08.04.21',   # FGTS PROD
    72: '08.04.22',   # SALARIO
    120: '08.04.25',  # VALE ALIMENTACAO
    121: '08.04.26',  # FERIAS
    124: '08.04.27',  # VALE COMBUSTIVEL
    127: '08.04.28',  # 13 SALARIO
    188: '08.04.29',  # ASSIST MEDICA EMP
    189: '08.04.30',  # ASSIST MEDICA FUNC

    # 08.05 - MARKETING
    63: '08.05.05',   # MKT PROD GRAFICA
    65: '08.05.04',   # MKT AGENCIA BV
    66: '08.05.01',   # MKT VEICUL/MIDIA

    # 08.07 - DESPESAS BANCARIAS
    75: '08.07.01',   # TARIFA DOC
    76: '08.07.01',   # TARIFA TED

    # 08.10 - VENDAS
    9: '08.10.01',    # FRETES VENDAS
    20: '08.10.02',   # COMISSAO GERENTE
    21: '08.10.03',   # COMISSAO REPRESENTANTE

    # 10.03 - DESPESAS FINANCEIRAS
    47: '10.03.01',   # MULTA/JUROS
    48: '10.03.02',   # IOF

    # 13.01 - IMPOSTOS
    190: '13.01.01',  # CSLL APURACAO
    191: '13.01.02',  # IRPJ APURACAO

    # 17.01 - INVESTIMENTOS
    174: '17.01.10',  # INV. IMOVEIS
    122: '17.01.02',  # INV. TITULO DE CAPITALIZACAO
    143: '17.01.05',  # INV. VEICULOS
    130: '17.01.06',  # INVESTIMENTOS -> REFORMAS

    # 08.08 - RETIRADAS DE SÓCIOS (Diretoria)
    30: '08.08.06',   # RETIRADA - CAIRO

    # 18 - FINANCIAMENTOS
    125: '18.02',     # EMPRESTIMO PRINCIPAL
    126: '18.04',     # EMPRESTIMO MUTUO
}

# Regras por palavra-chave no nome (ordem de prioridade - mais específico primeiro)
REGRAS_POR_PALAVRACHAVE = [
    # === INVESTIMENTOS (17.xx) ===
    ('INV. COMPUTADORES', '17.01.01'),
    ('INV. PERIFERICOS', '17.01.01'),
    ('INV. MAQUINAS', '17.01.03'),
    ('INV. EQUIPAMENTOS', '17.01.03'),
    ('INV. MOVEIS', '17.01.04'),
    ('INV. UTENSILIOS', '17.01.04'),
    ('INV. REFORMAS', '17.01.06'),
    ('INV. OBRAS', '17.01.06'),
    ('INV. SOFTWARES', '17.01.07'),
    ('INV. SOFTWARE', '17.01.07'),
    ('INV. CDU', '17.01.08'),
    ('INV. CESSAO', '17.01.08'),
    ('INV. IMOVEIS', '17.01.06'),
    ('INV. IMOBILIZADO', '17.01.06'),
    ('INV. VEICULOS', '17.01.03'),
    ('INV. EXPANSAO', '17.01.06'),
    ('INV. FABRICA', '17.01.06'),
    ('INV. TITULO', '17.01.07'),
    ('INV.', '17.01.06'),  # Genérico para INV.
    ('INVESTIMENTO', '17.01.06'),

    # === RETIRADAS DE SÓCIOS (08.08 - Diretoria) ===
    ('RETIRADA - CAIRO', '08.08.06'),
    ('RETIRADA-CAIRO', '08.08.06'),
    ('RETIRADA - THAIS', '08.08.01'),
    ('RETIRADA-THAIS', '08.08.01'),
    ('RETIRADA - GERLANO', '08.08.05'),
    ('RETIRADA-GERLANO', '08.08.05'),
    ('RETIRADA - SHENIA', '08.04.30'),
    ('RETIRADA-SHENIA', '08.04.30'),
    ('RETIRADA', '08.08.06'),  # Genérico -> Cairo como default

    # === EMPRESTIMOS (18.xx) ===
    ('EMPRESTIMO PRINCIPAL', '18.02'),
    ('EMPRESTIMO MUTUO', '18.04'),
    ('EMPRESTIMO', '18.02'),
    ('PARCELAMENTO', '18.05'),
    ('ICMS PARCELAMENTO', '18.05'),
    ('MULTA SEFAZ', '18.07'),
    ('MULTAS SEFAZ', '18.07'),

    # === OCUPAÇÃO (08.01) ===
    ('CONDOMINIO', '08.01.01'),
    ('ALUGUEL MINIMO', '08.01.02'),
    ('FUNDO DE PROMOCAO', '08.01.03'),
    ('ENERGIA - CO', '08.01.04'),
    ('ENERGIA', '08.01.04'),
    ('AR CONDICIONADO', '08.01.05'),
    ('IPTU - CO', '08.01.06'),
    ('IPTU ADM', '08.01.06'),
    ('IPTU', '08.01.06'),
    ('TAXAS E EMOLUMENTO', '08.01.07'),
    ('IRRF SOBRE ALUGUEL', '08.01.08'),
    ('DESCONTOS FINANCEIROS OBTIDOS', '08.01.09'),
    ('AGUA E ESGOTO', '08.01.09'),
    ('SEGUROS DE IMOVEIS', '08.01.10'),
    ('OUTRAS DESPESAS DE OCUPACAO', '08.01.10'),

    # === ADMINISTRATIVAS (08.02) ===
    ('ASSESSORIA JURIDICA', '08.02.01'),
    ('ASSESSORIA CONTABIL', '08.02.02'),
    ('MONIT/SEGURANCA', '08.02.03'),
    ('SEGURANCA', '08.02.03'),
    ('ASSOCIACAO', '08.02.04'),
    ('MATERIAL DE LIMPEZA', '08.02.05'),
    ('MAT DE CONSUMO', '08.02.06'),
    ('AGUA MINERAL', '08.02.07'),
    ('TELEFONIA FIXA', '08.02.09'),
    ('CONSULTORIA', '08.02.10'),
    ('ALUGUEL MAQUINETA', '08.02.11'),
    ('ESTACIONAMENTO', '08.02.12'),
    ('SERV PRESTADO', '08.02.13'),
    ('SERVICOS PRESTADOS', '08.02.13'),
    ('DESPESA DE CARTORIO', '08.02.14'),
    ('CARTORIO', '08.02.14'),
    ('SERV DEDETIZACAO', '08.02.15'),
    ('DEDETIZACAO', '08.02.15'),
    ('TELEFONIA MOVEL', '08.02.16'),
    ('CELULAR', '08.02.16'),
    ('SERV INTERNET', '08.02.17'),
    ('INTERNET', '08.02.17'),
    ('CORREIOS', '08.02.18'),
    ('MALOTES', '08.02.18'),
    ('MATERIAL DE ESCRITORIO', '08.02.19'),
    ('MANUT DE SOFTWARE', '08.02.20'),
    ('MANUTENCAO SOFTWARE', '08.02.20'),
    ('CONTRIB/ANUIDADES', '08.02.21'),
    ('ANUIDADES', '08.02.21'),
    ('ENDOMARKETING', '08.02.23'),
    ('ISS RET FONTE', '08.02.25'),
    ('TAXAS DE ALVARAS', '08.02.28'),
    ('ALVARA', '08.02.28'),
    ('CONFRATERNIZACOES', '08.02.29'),
    ('CONFRATERNIZACAO', '08.02.29'),
    ('MARCAS E PATENTES', '08.02.30'),
    ('CUSTAS PROCESSUAIS', '08.02.31'),
    ('ALUGUEL IMOVEIS ADM', '08.02.32'),
    ('IRRF OUTROS SERVICOS', '08.02.33'),
    ('CONDUCOES', '08.02.34'),
    ('SERVICOS DE INVENTARIOS', '08.02.35'),
    ('INVENTARIOS', '08.02.35'),
    ('ALUGUEL MAQ E EQUIPAMENTOS', '08.02.36'),
    ('ALUGUEL EQUIP INFORMATICA', '08.02.37'),
    ('MULTAS E TAXAS ADMINISTRATIVAS', '08.02.38'),

    # === MANUTENCAO (08.03) ===
    ('MANUTENCAO INSTALACOES', '08.03.01'),
    ('MANUTENCAO EDIFICACOES', '08.03.02'),
    ('MANUTENCAO EQP INFORMATICA', '08.03.03'),
    ('MANUTENCAO MAQ', '08.03.04'),
    ('MANUTENCOES DE MAQUINAS', '08.03.04'),
    ('MANUTENCAO AR CONDICIONADO', '08.03.05'),
    ('MANUTENCAO', '08.03.01'),  # Genérico

    # === PESSOAL (08.04) ===
    ('ALIMENTACAO PROD', '08.04.02'),
    ('ALIMENTACAO', '08.04.02'),
    ('RESCISAO PROD', '08.04.03'),
    ('RESCISAO', '08.04.03'),
    ('INSS PROD', '08.04.04'),
    ('INSS', '08.04.04'),
    ('CONTRIBUICAO SINDICAL', '08.04.05'),
    ('EXAMES MEDICOS', '08.04.06'),
    ('VALE TRANSPORTE', '08.04.07'),
    ('ESTAGIOS', '08.04.08'),
    ('TREINAMENTOS', '08.04.08'),
    ('HORAS EXTRAS', '08.04.10'),
    ('FARMACIA', '08.04.11'),
    ('FARDAMENTO', '08.04.12'),
    ('PLANO ODONTOLOGICO', '08.04.14'),
    ('IRRF SOBRE SALARIO', '08.04.16'),
    ('MULTA RESCISORIA', '08.04.18'),
    ('FGTS PROD', '08.04.21'),
    ('FGTS', '08.04.21'),
    ('SALARIO', '08.04.22'),
    ('FOLHA', '08.04.22'),
    ('VALE ALIMENTACAO', '08.04.25'),
    ('FERIAS', '08.04.26'),
    ('VALE COMBUSTIVEL', '08.04.27'),
    ('13 SALARIO', '08.04.28'),
    ('DECIMO TERCEIRO', '08.04.28'),
    ('ASSIST MEDICA', '08.04.29'),
    ('ASSISTENCIA MEDICA', '08.04.29'),
    ('PLANO DE SAUDE', '08.04.29'),

    # === MARKETING (08.05) ===
    ('MKT PROD GRAFICA', '08.05.05'),
    ('MATERIAIS GRAFICOS', '08.05.05'),
    ('MKT AGENCIA', '08.05.04'),
    ('MKT AG CONTRATO', '08.05.04'),
    ('MKT VEICUL', '08.05.01'),
    ('PROPAGANDA', '08.05.02'),
    ('MERCHANDISING', '08.05.03'),
    ('ACOES DE RELACIONAMENTO', '08.05.06'),
    ('MKT EVENTOS', '08.05.07'),
    ('WORKSHOPS', '08.05.07'),
    ('EVENTOS', '08.05.07'),
    ('MKT PROD CATALOGO', '08.05.08'),
    ('CAMPANHAS', '08.05.08'),
    ('MKT', '08.05.01'),  # Genérico
    ('MARKETING', '08.05.01'),

    # === COMERCIAL (08.06) ===
    ('CAMPANHAS COMERCIAIS', '08.06.01'),
    ('BRINDES', '08.06.02'),

    # === BANCARIAS (08.07) ===
    ('TARIFA DOC', '08.07.01'),
    ('TARIFA TED', '08.07.01'),
    ('TARIFA PIX', '08.07.01'),
    ('TARIFA NEGATIVACAO', '08.07.03'),
    ('TARIFA MANUT DE CONTA', '08.07.04'),
    ('TARIFAS DE BAIXAS', '08.07.06'),
    ('TARIFAS BANCARIAS', '08.07.09'),
    ('TARIFA', '08.07.09'),  # Genérico

    # === PROLABORE (08.08) ===
    ('INSS SOBRE PROLABORE', '08.08.02'),
    ('IRRF SOBRE PROLABORE', '08.08.03'),
    ('PROLABORE', '08.08.01'),

    # === VENDAS (08.10) ===
    ('FRETES VENDAS', '08.10.01'),
    ('FRETE', '08.10.01'),
    ('COMISSAO GERENTE', '08.10.02'),
    ('COMISSAO REPRESENTANTE', '08.10.03'),
    ('TAXAS CARTAO', '08.10.05'),
    ('RESCISAO REPRESENTANTES', '08.10.06'),
    ('COMISSAO VENDEDOR', '08.10.07'),
    ('COMISSAO CORRETOR', '08.10.08'),
    ('COMISSAO COORDENADOR', '08.10.09'),
    ('PREMIACOES COMERCIAIS', '08.10.11'),
    ('COMISSAO SUPERVISOR', '08.10.12'),
    ('COMISSAO', '08.10.07'),  # Genérico

    # === CONSULTAS (08.11) ===
    ('CONSULTA CADASTRAL', '08.11.01'),

    # === VEICULOS (08.12) ===
    ('COMBUSTIVEL', '08.12.01'),
    ('LUBRIFICANTE', '08.12.01'),
    ('MANUTENCAO DE VEICULOS', '08.12.02'),
    ('SEGURO VEICULOS', '08.12.03'),
    ('SEGURO VEICULO', '08.12.03'),
    ('TX DETRAN', '08.12.05'),
    ('IPVA', '08.12.05'),
    ('LICENCIAMENTO', '08.12.05'),

    # === DESPESAS FINANCEIRAS (10.03) ===
    ('MULTA/JUROS', '10.03.01'),
    ('MULTAS E JUROS', '10.03.01'),
    ('IOF', '10.03.02'),
    ('JUROS S/EMPREST', '10.03.04'),
    ('JUROS EMPRESTIMO', '10.03.04'),
    ('JUROS S/ ANTECIPACAO', '10.03.05'),
    ('SEGURO SOBRE EMPRESTIMOS', '10.03.06'),
    ('RECOMPRA DE TITULOS', '10.03.07'),
    ('JUROS', '10.03.01'),  # Genérico

    # === IMPOSTOS SOBRE VENDAS (02.02) ===
    ('ICMS SOBRE VENDAS', '02.02.01'),
    ('PIS SOBRE RECEITA', '02.02.02'),
    ('PIS', '02.02.02'),
    ('COFINS SOBRE RECEITA', '02.02.03'),
    ('COFINS', '02.02.03'),
    ('DIFAL GNRE', '02.02.05'),
    ('DIFAL', '02.02.05'),

    # === CUSTOS VARIAVEIS (04.01) ===
    ('ICMS ANTECIPADO', '04.01.01'),
    ('ICMS SUBSTITUICAO', '04.01.02'),
    ('ICMS ST', '04.01.02'),

    # === IMPOSTOS SOBRE LUCRO (13.01) ===
    ('CSLL APURACAO', '13.01.01'),
    ('CSLL PROVISAO', '13.01.01'),
    ('CSLL', '13.01.01'),
    ('IRPJ APURACAO', '13.01.02'),
    ('IRPJ PROVISAO', '13.01.02'),
    ('IRPJ', '13.01.02'),
]


def _classificar_despesa_automatica(cd_despesaitem, ds_despesaitem):
    """
    CLASSIFICADOR INTELIGENTE - Pensa como um Analista Financeiro Sênior

    Etapas de análise:
    1. Mapeamento direto por código (certeza absoluta)
    2. Análise de contexto (sufixos, prefixos)
    3. Regras específicas com alta precisão
    4. Regras genéricas como fallback

    Retorna o código da conta DRE ou None se não conseguir classificar.
    """
    # 1. PRIORIDADE MÁXIMA: Mapeamento direto por código
    if cd_despesaitem in MAPEAMENTO_POR_CODIGO:
        return MAPEAMENTO_POR_CODIGO[cd_despesaitem]

    # 2. Extrair contexto do nome
    ctx = _extrair_contexto(ds_despesaitem)
    nome = ctx['nome_normalizado']

    if not nome:
        return None

    # ========================================================================
    # ANÁLISE INTELIGENTE POR CATEGORIA
    # ========================================================================

    # --- INVESTIMENTOS (17.xx) ---
    # Analista: "Tudo que começa com INV. é investimento/imobilizado"
    if ctx['eh_investimento']:
        # Mapeamento específico de investimentos
        if 'COMPUTADOR' in nome or 'PERIFERICO' in nome:
            return '17.01.01'
        if 'TITULO' in nome or 'CAPITALIZACAO' in nome:
            return '17.01.02'
        if 'MAQUINA' in nome or 'EQUIPAMENTO' in nome:
            return '17.01.03'
        if 'MOVEIS' in nome or 'MOVEL' in nome or 'UTENSILIO' in nome:
            return '17.01.04'
        if 'VEICULO' in nome:
            return '17.01.05'
        if 'REFORMA' in nome or 'OBRA' in nome:
            return '17.01.06'
        if 'SOFTWARE' in nome:
            return '17.01.07'
        if 'CDU' in nome or 'CSU' in nome or 'CESSAO' in nome or 'DIREITO' in nome:
            return '17.01.08'
        if 'EXPANSAO' in nome and 'IMOVEL' in nome:
            return '17.01.09'
        if 'IMOVEL' in nome or 'IMOVEIS' in nome or 'IMOBILIZADO' in nome:
            return '17.01.10'
        if 'FABRICA' in nome and 'MURO' in nome and '2' in nome:
            return '17.01.13'
        if 'FABRICA' in nome and 'MURO' in nome:
            return '17.01.12'
        if 'FABRICA' in nome or 'EXPANSAO' in nome:
            return '17.01.11'
        if 'CASTELAO' in nome and 'MURO 2' in nome:
            return '17.01.13'
        if 'CASTELAO' in nome and 'MURO' in nome:
            return '17.01.12'
        if 'CASTELAO' in nome:
            return '17.01.11'
        if 'CAIRO' in nome:
            return '17.01.17'
        # Default para investimentos não específicos
        return '17.01.06'  # Reformas e obras como fallback

    # --- RETIRADAS DE SÓCIOS (08.08.xx) ---
    # Analista: "Retiradas são distribuições para sócios"
    if ctx['eh_retirada']:
        if 'THAIS' in nome:
            return '08.08.01'
        if 'GERLANO' in nome:
            return '08.08.05'
        if 'CAIRO' in nome:
            return '08.08.06'
        if 'SHENIA' in nome:
            return '08.04.30'
        return '08.08.06'  # Default para retiradas

    # --- EMPRÉSTIMOS E DÍVIDAS (18.xx) ---
    # Analista: "Amortização de dívidas vai no grupo 18"
    if ctx['eh_emprestimo'] or 'PARCELAMENTO' in nome:
        if 'MUTUO' in nome:
            return '18.04'
        if 'PRINCIPAL' in nome:
            return '18.02'
        if 'PARCELAMENTO' in nome and 'ICMS' in nome:
            return '18.05'
        if 'PARCELAMENTO' in nome:
            return '18.05'
        if 'AUTO INFRACAO' in nome and 'ICMS' in nome:
            return '18.03'
        if 'AUTO INFRACAO' in nome and 'INSS' in nome:
            return '18.06'
        if 'MULTA' in nome and 'SEFAZ' in nome:
            return '18.07'
        return '18.02'  # Default empréstimo principal

    # --- IMPOSTOS SOBRE VENDAS (02.02.xx) ---
    if 'ICMS SOBRE VENDA' in nome:
        return '02.02.01'
    if 'PIS SOBRE RECEITA' in nome or (nome == 'PIS'):
        return '02.02.02'
    if 'COFINS SOBRE RECEITA' in nome or (nome == 'COFINS'):
        return '02.02.03'
    if 'DIFAL' in nome or 'GNRE' in nome:
        return '02.02.05'
    if 'SIMPLES NACIONAL' in nome:
        return '02.02.06'
    if 'ICMS DIF' in nome and 'ALIQUOTA' in nome:
        return '02.02.07'

    # --- CUSTOS VARIÁVEIS (04.xx) ---
    if 'ICMS ANTECIPADO' in nome:
        return '04.01.01'
    if 'ICMS SUBSTITUICAO' in nome or 'ICMS ST' in nome:
        return '04.01.02'

    # --- CUSTOS FIXOS / PRODUÇÃO (06.xx) ---
    if ctx['eh_producao'] and 'AGUA' in nome:
        return '06.01.01'
    if ctx['eh_producao'] and ('CONSULTORIA' in nome or 'ASSESSORIA' in nome):
        return '06.01.02'
    if ctx['eh_producao'] and 'MANUTENCAO' in nome and 'INSTALAC' in nome:
        return '06.01.03'
    if ctx['eh_producao'] and 'MANUTENCAO' in nome and 'MAQUINA' in nome:
        return '06.01.04'
    if ctx['eh_producao'] and 'MATERIAL' in nome and 'AUXILIAR' in nome:
        return '06.01.05'
    if ctx['eh_producao'] and 'COLETA' in nome:
        return '06.01.06'

    # --- DESPESAS COM OCUPAÇÃO (08.01.xx) ---
    # Analista: "Sufixo - CO indica Custo de Ocupação da loja"
    if ctx['eh_custo_operacional'] or 'CONDOMINIO' in nome:
        if 'CONDOMINIO' in nome:
            return '08.01.01'
        if 'ALUGUEL' in nome and 'MINIMO' in nome:
            return '08.01.02'
        if 'FUNDO' in nome and 'PROMOCAO' in nome:
            return '08.01.03'
        if 'ENERGIA' in nome:
            return '08.01.04'
        if 'AR CONDICIONADO' in nome:
            return '08.01.05'
        if 'IPTU' in nome:
            return '08.01.06'
        if 'TAXA' in nome or 'EMOLUMENTO' in nome:
            return '08.01.07'
        if 'IRRF' in nome and 'ALUGUEL' in nome:
            return '08.01.08'
        if 'DESCONTO' in nome and 'FINANCEIRO' in nome:
            return '08.01.09'
        return '08.01.10'  # Outras despesas de ocupação

    # --- DESPESAS ADMINISTRATIVAS (08.02.xx) ---
    if 'ASSESSORIA JURIDICA' in nome or 'JURIDICA' in nome:
        return '08.02.01'
    if 'ASSESSORIA CONTABIL' in nome or 'CONTABIL' in nome:
        return '08.02.02'
    if 'SEGURANCA' in nome or 'MONIT' in nome:
        return '08.02.03'
    if 'ASSOCIACAO' in nome:
        return '08.02.04'
    if 'MATERIAL' in nome and 'LIMPEZA' in nome:
        return '08.02.05'
    if 'MAT DE CONSUMO' in nome or 'MATERIAL DE CONSUMO' in nome:
        return '08.02.06'
    if 'AGUA MINERAL' in nome:
        return '08.02.07'
    if 'ENERGIA' in nome and not ctx['eh_custo_operacional']:
        return '08.02.08'
    if 'TELEFONIA FIXA' in nome:
        return '08.02.09'
    if 'CAGECE' in nome:
        return '08.02.10'
    if 'DEDETIZACAO' in nome:
        return '08.02.11'
    if 'CARTORIO' in nome:
        return '08.02.12'
    if 'CONSULTORIA' in nome and not ctx['eh_producao']:
        return '08.02.13'
    if 'SEGUROS DE IMOVEIS' in nome or ('SEGURO' in nome and 'IMOVEL' in nome):
        return '08.02.14'
    if 'ALUGUEL' in nome and 'MAQUINETA' in nome:
        return '08.02.15'
    if 'TELEFONIA MOVEL' in nome or 'CELULAR' in nome:
        return '08.02.16'
    if 'INTERNET' in nome:
        return '08.02.17'
    if 'CORREIO' in nome or 'MALOTE' in nome:
        return '08.02.18'
    if 'MATERIAL' in nome and 'ESCRITORIO' in nome:
        return '08.02.19'
    if 'SOFTWARE' in nome and 'MANUT' in nome:
        return '08.02.20'
    if 'ANUIDADE' in nome or 'CONTRIB' in nome:
        return '08.02.21'
    if 'TAXA' in nome and 'EMOLUMENTO' in nome and not ctx['eh_custo_operacional']:
        return '08.02.22'
    if 'ENDOMARKETING' in nome:
        return '08.02.23'
    if 'IPTU' in nome and 'ADM' in nome:
        return '08.02.24'
    if 'ISS RET' in nome:
        return '08.02.25'
    if 'CSRF' in nome:
        return '08.02.26'
    if 'CARTAO DE CREDITO' in nome:
        return '08.02.27'
    if 'ALVARA' in nome:
        return '08.02.28'
    if 'CONFRATERNIZA' in nome:
        return '08.02.29'
    if 'MARCA' in nome and 'PATENTE' in nome:
        return '08.02.30'
    if 'CUSTAS PROCESSUAIS' in nome:
        return '08.02.31'
    if 'ALUGUEL' in nome and 'IMOVEL' in nome and 'ADM' in nome:
        return '08.02.32'
    if 'IRRF OUTROS SERVICOS' in nome or 'IRRF' in nome and '1708' in nome:
        return '08.02.33'
    if 'CONDUCOES' in nome or 'CONDUCAO' in nome:
        return '08.02.34'
    if 'INVENTARIO' in nome:
        return '08.02.35'
    if 'ALUGUEL' in nome and 'MAQ' in nome and 'EQUIPAMENTO' in nome:
        return '08.02.36'
    if 'ALUGUEL' in nome and 'EQUIP' in nome and 'INFORMATICA' in nome:
        return '08.02.37'
    if 'MULTA' in nome and 'TAXA' in nome and 'ADMINISTRATIVA' in nome:
        return '08.02.38'

    # --- MANUTENÇÃO (08.03.xx) ---
    if ctx['eh_manutencao']:
        if 'INSTALAC' in nome:
            return '08.03.01'
        if 'EDIFICAC' in nome:
            return '08.03.02'
        if 'INFORMATICA' in nome or 'EQP INFORMATICA' in nome:
            return '08.03.03'
        if 'MAQ' in nome or 'EQUIPAMENTO' in nome:
            return '08.03.04'
        if 'AR CONDICIONADO' in nome:
            return '08.03.05'
        if 'VEICULO' in nome:
            return '08.12.02'  # Veículos tem conta própria
        return '08.03.01'  # Default manutenção

    # --- PESSOAL (08.04.xx) ---
    if ctx['eh_pessoal'] or 'FUNCIONARIO' in nome:
        if 'PREMIACAO' in nome and 'FUNCIONARIO' in nome:
            return '08.04.01'
        if 'ALIMENTACAO' in nome:
            return '08.04.02'
        if 'RESCISAO' in nome and 'REPRESENTANTE' not in nome:
            return '08.04.03'
        if 'INSS' in nome and 'PROLABORE' not in nome:
            return '08.04.04'
        if 'SINDICAL' in nome:
            return '08.04.05'
        if 'EXAME' in nome and 'MEDICO' in nome:
            return '08.04.06'
        if 'VALE TRANSPORTE' in nome or 'VT' in nome:
            return '08.04.07'
        if 'ESTAGIO' in nome or 'TREINAMENTO' in nome:
            return '08.04.08'
        if 'VALE FUNCIONARIO' in nome:
            return '08.04.09'
        if 'HORAS EXTRAS' in nome or 'HORA EXTRA' in nome:
            return '08.04.10'
        if 'FARMACIA' in nome:
            return '08.04.11'
        if 'FARDAMENTO' in nome or 'UNIFORME' in nome:
            return '08.04.12'
        if 'EPI' in nome:
            return '08.04.13'
        if 'PLANO ODONTOLOGICO' in nome or 'ODONTOLOGICO' in nome:
            return '08.04.14'
        if 'CESTA' in nome and 'BASICA' in nome:
            return '08.04.15'
        if 'IRRF' in nome and 'SALARIO' in nome:
            return '08.04.16'
        if 'GRATIFICAC' in nome:
            return '08.04.17'
        if 'MULTA RESCISORIA' in nome or 'MULTA' in nome and 'FGTS' in nome:
            return '08.04.18'
        if 'ASSIST' in nome and 'MEDICA' in nome:
            return '08.04.19'
        if 'RECRUT' in nome or 'SELECAO' in nome:
            return '08.04.20'
        if 'FGTS' in nome:
            return '08.04.21'
        if 'SALARIO' in nome or 'FOLHA' in nome:
            return '08.04.22'
        if 'CO PARTICIPACAO' in nome:
            return '08.04.23'
        if 'VALE ALIMENTACAO' in nome:
            return '08.04.25'
        if 'VALE COMBUSTIVEL' in nome:
            return '08.04.27'
        if '13' in nome and 'SALARIO' in nome:
            return '08.04.28'
        if 'FERIAS' in nome:
            return '08.04.29'
        return '08.04.22'  # Default salários

    # --- MARKETING (08.05.xx) ---
    if ctx['eh_marketing']:
        if 'MIDIA TRADICION' in nome or 'VEICUL' in nome:
            return '08.05.01'
        if 'MIDIA DIGITAL' in nome or 'DIGITAL' in nome:
            return '08.05.02'
        if 'MERCHANDISING' in nome or 'PONTO DE VENDA' in nome or 'PDV' in nome:
            return '08.05.03'
        if 'CONSULTORIA' in nome or 'ASSESSORIA' in nome or 'AGENCIA' in nome:
            return '08.05.04'
        if 'GRAFICO' in nome or 'CATALOGO' in nome:
            return '08.05.05'
        if 'RELACIONAMENTO' in nome or 'CLIENTE' in nome:
            return '08.05.06'
        if 'WORKSHOP' in nome or 'EVENTO' in nome:
            return '08.05.07'
        if 'CAMPANHA' in nome or 'CONTEUDO' in nome:
            return '08.05.08'
        if 'VOUCHER' in nome or 'INFLUENCER' in nome:
            return '08.05.09'
        return '08.05.01'  # Default marketing

    # --- COMERCIAL (08.06.xx) ---
    if 'CAMPANHA COMERCIAL' in nome:
        return '08.06.01'
    if 'BRINDE' in nome:
        return '08.06.02'
    if 'AJUDA DE CUSTO' in nome and 'DESLOCAMENTO' in nome:
        return '08.06.04'
    if 'AJUDA DE CUSTO' in nome and 'VIAGEM' in nome:
        return '08.06.05'

    # --- TARIFAS BANCÁRIAS (08.07.xx) ---
    if ctx['eh_tarifa']:
        if 'DOC' in nome or 'TED' in nome or 'PIX' in nome:
            return '08.07.01'
        if 'TITULO VENCIDO' in nome:
            return '08.07.02'
        if 'NEGATIVACAO' in nome:
            return '08.07.03'
        if 'MANUT' in nome and 'CONTA' in nome:
            return '08.07.04'
        if 'SALARIO' in nome or 'PG' in nome:
            return '08.07.05'
        if 'BAIXA' in nome:
            return '08.07.06'
        if 'PRORROGACAO' in nome:
            return '08.07.07'
        if 'COBRANCA' in nome:
            return '08.07.08'
        return '08.07.09'  # Tarifas genéricas

    # --- DIRETORIA / PROLABORE (08.08.xx) ---
    if 'PROLABORE' in nome:
        if 'INSS' in nome:
            return '08.08.02'
        if 'IRRF' in nome:
            return '08.08.03'
        return '08.08.01'

    # --- PERDAS (08.09.xx) ---
    if 'DOACAO' in nome and ('PECA' in nome or 'SEM CONDICAO' in nome):
        return '08.09.01'
    if 'FURTO' in nome:
        return '08.09.02'

    # --- VENDAS / COMISSÕES (08.10.xx) ---
    if ctx['eh_comissao'] or 'FRETE' in nome and 'VENDA' in nome:
        if 'FRETE' in nome:
            return '08.10.01'
        if 'GERENTE' in nome:
            return '08.10.02'
        if 'REPRESENTANTE' in nome:
            return '08.10.03'
        if 'CARTAO' in nome or 'TAXA' in nome:
            return '08.10.05'
        if 'RESCISAO' in nome and 'REPRESENTANTE' in nome:
            return '08.10.06'
        if 'VENDEDOR' in nome:
            return '08.10.07'
        if 'CORRETOR' in nome:
            return '08.10.08'
        if 'COORDENADOR' in nome:
            return '08.10.09'
        if 'MARKET' in nome and 'PLACE' in nome:
            return '08.10.10'
        if 'PREMIACAO' in nome:
            return '08.10.11'
        if 'SUPERVISOR' in nome:
            return '08.10.12'
        return '08.10.07'  # Default comissão vendedor

    # --- CRÉDITO E COBRANÇA (08.11.xx) ---
    if 'CONSULTA CADASTRAL' in nome:
        return '08.11.01'
    if 'REGISTRO DE TITULO' in nome:
        return '08.11.02'

    # --- VEÍCULOS (08.12.xx) ---
    if 'COMBUSTIVEL' in nome or 'LUBRIFICANTE' in nome:
        return '08.12.01'
    if 'MANUTENCAO' in nome and 'VEICULO' in nome:
        return '08.12.02'
    if 'SEGURO' in nome and 'VEICULO' in nome:
        return '08.12.03'
    if 'MULTA' in nome and 'TRANSITO' in nome:
        return '08.12.04'
    if 'DETRAN' in nome or 'IPVA' in nome or 'LICENCIAMENTO' in nome:
        return '08.12.05'
    if 'ESTACIONAMENTO' in nome:
        return '08.12.06'

    # --- DESPESAS FINANCEIRAS (10.03.xx) ---
    if 'MULTA' in nome and 'JUROS' in nome:
        return '10.03.01'
    if nome == 'IOF' or 'IOF' in nome:
        return '10.03.02'
    if 'TAC' in nome and 'EMPRESTIMO' in nome:
        return '10.03.03'
    if 'JUROS' in nome and ('EMPREST' in nome or 'FINANC' in nome):
        return '10.03.04'
    if 'JUROS' in nome and 'ANTECIPACAO' in nome:
        return '10.03.05'
    if 'SEGURO' in nome and 'EMPRESTIMO' in nome:
        return '10.03.06'
    if 'DEBITO INADIMPLENCIA' in nome or 'INADIMPLENCIA' in nome:
        return '10.03.07'
    if 'TARIFA' in nome and 'CARTORIO' in nome:
        return '10.03.08'
    if 'JUROS' in nome and 'IMPORTACAO' in nome:
        return '10.03.09'
    if 'JUROS' in nome:
        return '10.03.01'

    # --- IMPOSTOS SOBRE LUCRO (13.01.xx) ---
    if 'CSLL' in nome:
        return '13.01.01'
    if 'IRPJ' in nome:
        return '13.01.02'

    # --- RECEITAS FINANCEIRAS (10.01.xx) ---
    if 'DESCONTO' in nome and 'OBTIDO' in nome:
        return '10.01.01'
    if 'MULTA' in nome and 'JUROS' in nome and 'AUFERIDO' in nome:
        return '10.01.02'
    if 'RENDIMENTO' in nome and 'APLICACAO' in nome:
        return '10.01.03'
    if 'CREDITO INADIMPLENCIA' in nome:
        return '10.01.04'

    # ========================================================================
    # FALLBACK: Tentar pelas regras de palavra-chave genéricas
    # ========================================================================
    for palavra_chave, conta_dre in REGRAS_POR_PALAVRACHAVE:
        if palavra_chave in nome:
            return conta_dre

    return None


def _executar_atualizacao_realizado():
    """Executa atualização da tabela pré-computada em background.
    Ignora se já estiver rodando (evita rebuilds paralelos)."""
    try:
        status_rows = execute_query("SELECT status FROM dfc_realizado_controle WHERE id = 1")
        if status_rows and status_rows[0]['status'] == 'running':
            print("[DFC-CACHE] Rebuild já em andamento, ignorando nova solicitação.")
            return
        print("[DFC-CACHE] Iniciando atualização do DFC realizado em background...")
        result = execute_insert("SELECT atualizar_dfc_realizado()")
        msg = result[0]['atualizar_dfc_realizado'] if result else 'sem retorno'
        print(f"[DFC-CACHE] Atualização concluída: {msg}")
    except Exception as e:
        print(f"[DFC-CACHE] Erro na atualização: {e}")


@router.get("/api/classificacao-despesas")
def listar_classificacao_despesas():
    """Lista todas as despesas com suas classificações"""
    try:
        query = """
            SELECT
                d.cd_despesaitem,
                d.ds_despesaitem,
                COALESCE(c.categoria, 'OPERACIONAIS') AS categoria,
                c.dt_atualizacao,
                c.usuario_alteracao
            FROM vr_fcp_despesaitem d
            LEFT JOIN classificacao_despesas c ON c.cd_despesaitem = d.cd_despesaitem
            ORDER BY d.ds_despesaitem
        """

        resultado = execute_query(query)

        return {
            "success": True,
            "data": resultado
        }

    except Exception as e:
        print(f"[ERROR] Erro ao listar classificações: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/classificacao-despesas")
def salvar_classificacao_despesas(data: dict, background_tasks: BackgroundTasks):
    """Salva classificação de uma ou mais despesas"""
    try:
        classificacoes = data.get('classificacoes', [])
        usuario = data.get('usuario', 'sistema')

        if not classificacoes:
            raise HTTPException(status_code=400, detail="Nenhuma classificação fornecida")

        salvos = 0
        for item in classificacoes:
            cd_despesaitem = item.get('cd_despesaitem')
            ds_despesaitem = item.get('ds_despesaitem', '')
            categoria = item.get('categoria')

            if not cd_despesaitem or not categoria:
                continue

            query = """
                INSERT INTO classificacao_despesas
                    (cd_despesaitem, ds_despesaitem, categoria, usuario_alteracao, dt_atualizacao)
                VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (cd_despesaitem)
                DO UPDATE SET
                    categoria = EXCLUDED.categoria,
                    usuario_alteracao = EXCLUDED.usuario_alteracao,
                    dt_atualizacao = CURRENT_TIMESTAMP
            """

            execute_insert(query, (cd_despesaitem, ds_despesaitem, categoria, usuario))
            salvos += 1

        # Atualiza cache do DFC realizado em background para refletir novas classificações
        background_tasks.add_task(_executar_atualizacao_realizado)

        return {
            "success": True,
            "salvos": salvos,
            "message": f"{salvos} classificações salvas com sucesso"
        }

    except Exception as e:
        print(f"[ERROR] Erro ao salvar classificações: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/classificacao-despesas")
def deletar_classificacao_despesa(background_tasks: BackgroundTasks, cd_despesaitem: int = Query(...)):
    """Remove classificação de uma despesa"""
    try:
        query = "DELETE FROM classificacao_despesas WHERE cd_despesaitem = %s"
        execute_insert(query, (cd_despesaitem,))

        # Atualiza cache do DFC realizado em background para refletir remoção
        background_tasks.add_task(_executar_atualizacao_realizado)

        return {
            "success": True,
            "message": "Classificação removida com sucesso"
        }

    except Exception as e:
        print(f"[ERROR] Erro ao deletar classificação: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/classificacao-despesas-dre")
def listar_classificacao_despesas_dre():
    """Lista todas as despesas com suas classificações DRE"""
    try:
        query = """
            SELECT
                d.cd_despesaitem,
                d.ds_despesaitem,
                COALESCE(c.conta_dre, 'NAO_CLASSIFICADO') AS conta_dre,
                c.dt_atualizacao,
                c.usuario_alteracao
            FROM vr_fcp_despesaitem d
            LEFT JOIN classificacao_despesas_dre c ON c.cd_despesaitem = d.cd_despesaitem
            ORDER BY d.ds_despesaitem
        """

        resultado = execute_query(query)

        return {
            "success": True,
            "data": resultado
        }

    except Exception as e:
        print(f"[ERROR] Erro ao listar classificações DRE: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/classificacao-despesas-dre")
def salvar_classificacao_despesas_dre(data: dict):
    """Salva classificação DRE de uma ou mais despesas"""
    try:
        classificacoes = data.get('classificacoes', [])
        usuario = data.get('usuario', 'sistema')

        if not classificacoes:
            raise HTTPException(status_code=400, detail="Nenhuma classificação fornecida")

        print(f"[SALVAR-DRE] Recebidas {len(classificacoes)} classificações para salvar")

        salvos = 0
        removidos = 0
        for item in classificacoes:
            cd_despesaitem = item.get('cd_despesaitem')
            ds_despesaitem = item.get('ds_despesaitem', '')
            conta_dre = item.get('conta_dre')

            if not cd_despesaitem:
                continue

            # Se conta_dre é NAO_CLASSIFICADO ou vazio, REMOVER a classificação existente
            if not conta_dre or conta_dre == 'NAO_CLASSIFICADO':
                query_delete = """
                    DELETE FROM classificacao_despesas_dre
                    WHERE cd_despesaitem = %s
                """
                execute_insert(query_delete, (cd_despesaitem,))
                removidos += 1
                print(f"[SALVAR-DRE] Removida classificação de {cd_despesaitem}")
                continue

            # Inserir ou atualizar classificação
            query = """
                INSERT INTO classificacao_despesas_dre
                    (cd_despesaitem, ds_despesaitem, conta_dre, usuario_alteracao, dt_atualizacao)
                VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (cd_despesaitem)
                DO UPDATE SET
                    conta_dre = EXCLUDED.conta_dre,
                    usuario_alteracao = EXCLUDED.usuario_alteracao,
                    dt_atualizacao = CURRENT_TIMESTAMP
            """

            execute_insert(query, (cd_despesaitem, ds_despesaitem, conta_dre, usuario))
            salvos += 1
            print(f"[SALVAR-DRE] Salva classificação {cd_despesaitem} -> {conta_dre}")

        print(f"[SALVAR-DRE] Concluído: {salvos} salvas, {removidos} removidas")

        return {
            "success": True,
            "salvos": salvos,
            "removidos": removidos,
            "message": f"{salvos} classificações DRE salvas com sucesso" + (f" ({removidos} removidas)" if removidos > 0 else "")
        }

    except Exception as e:
        print(f"[ERROR] Erro ao salvar classificações DRE: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/classificacao-despesas-dre/automatica")
def classificar_despesas_dre_automatica(data: dict = None):
    """
    Classifica AUTOMATICAMENTE todas as despesas não classificadas
    usando regras inteligentes baseadas no código e nome da despesa.

    Parâmetros opcionais (via body JSON):
    - sobrescrever: bool - Se True, reclassifica mesmo as já classificadas (default: False)
    - usuario: str - Nome do usuário (default: 'sistema_auto')

    Retorna estatísticas detalhadas da classificação.
    """
    try:
        data = data or {}
        sobrescrever = data.get('sobrescrever', False)
        usuario = data.get('usuario', 'sistema_auto')

        print(f"[AUTO-CLASSIFICACAO] Iniciando classificação automática DRE...")
        print(f"[AUTO-CLASSIFICACAO] Sobrescrever existentes: {sobrescrever}")

        # Buscar todas as despesas COM categoria do DFC
        # NOTA: Matéria Prima é excluída pois é tratada separadamente no CMV
        query_despesas = """
            SELECT
                d.cd_despesaitem,
                d.ds_despesaitem,
                cdre.conta_dre as conta_atual,
                COALESCE(cdfc.categoria, 'OPERACIONAIS') as categoria_dfc
            FROM vr_fcp_despesaitem d
            LEFT JOIN classificacao_despesas_dre cdre ON cdre.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN classificacao_despesas cdfc ON cdfc.cd_despesaitem = d.cd_despesaitem
            ORDER BY d.ds_despesaitem
        """
        despesas = execute_query(query_despesas)

        if not despesas:
            return {
                "success": True,
                "message": "Nenhuma despesa encontrada",
                "estatisticas": {
                    "total": 0,
                    "classificadas": 0,
                    "ja_tinham": 0,
                    "nao_classificadas": 0,
                    "ignoradas_mp": 0
                }
            }

        total = len(despesas)
        classificadas = 0
        ja_tinham = 0
        nao_classificadas = 0
        ignoradas_mp = 0
        detalhes = []

        for despesa in despesas:
            cd = despesa['cd_despesaitem']
            nome = despesa['ds_despesaitem'] or ''
            conta_atual = despesa.get('conta_atual')
            categoria_dfc = (despesa.get('categoria_dfc') or '').upper()

            # IGNORAR Matéria Prima - tratado separadamente no CMV
            if 'MATERIA' in categoria_dfc or 'PRIMA' in categoria_dfc or categoria_dfc == 'MATERIA_PRIMA':
                ignoradas_mp += 1
                continue

            # Se já tem classificação e não é para sobrescrever, pula
            if conta_atual and not sobrescrever:
                ja_tinham += 1
                continue

            # Tenta classificar automaticamente
            conta_nova = _classificar_despesa_automatica(cd, nome)

            if conta_nova:
                # Salvar no banco
                query_insert = """
                    INSERT INTO classificacao_despesas_dre
                        (cd_despesaitem, ds_despesaitem, conta_dre, usuario_alteracao, dt_atualizacao)
                    VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                    ON CONFLICT (cd_despesaitem)
                    DO UPDATE SET
                        conta_dre = EXCLUDED.conta_dre,
                        usuario_alteracao = EXCLUDED.usuario_alteracao,
                        dt_atualizacao = CURRENT_TIMESTAMP
                """
                execute_insert(query_insert, (cd, nome, conta_nova, usuario))
                classificadas += 1
                detalhes.append({
                    "cd": cd,
                    "nome": nome,
                    "conta": conta_nova,
                    "anterior": conta_atual
                })
            else:
                nao_classificadas += 1

        print(f"[AUTO-CLASSIFICACAO] Concluído!")
        print(f"[AUTO-CLASSIFICACAO] Total: {total}, Classificadas: {classificadas}, Já tinham: {ja_tinham}, Não classificadas: {nao_classificadas}, Ignoradas (MP): {ignoradas_mp}")

        return {
            "success": True,
            "message": f"Classificação automática concluída! {classificadas} despesas classificadas.",
            "estatisticas": {
                "total": total,
                "classificadas": classificadas,
                "ja_tinham": ja_tinham,
                "nao_classificadas": nao_classificadas,
                "ignoradas_mp": ignoradas_mp
            },
            "detalhes": detalhes[:50]  # Primeiros 50 para não sobrecarregar
        }

    except Exception as e:
        print(f"[ERROR] Erro na classificação automática: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/classificacao-despesas-dre/preview")
def preview_classificacao_automatica():
    """
    Mostra uma PRÉVIA de como as despesas seriam classificadas automaticamente,
    SEM salvar no banco. Útil para revisar antes de aplicar.
    """
    try:
        print(f"[AUTO-CLASSIFICACAO] Gerando prévia...")

        # Buscar todas as despesas não classificadas
        query_despesas = """
            SELECT
                d.cd_despesaitem,
                d.ds_despesaitem,
                c.conta_dre as conta_atual
            FROM vr_fcp_despesaitem d
            LEFT JOIN classificacao_despesas_dre c ON c.cd_despesaitem = d.cd_despesaitem
            ORDER BY d.ds_despesaitem
        """
        despesas = execute_query(query_despesas)

        if not despesas:
            return {
                "success": True,
                "message": "Nenhuma despesa encontrada",
                "preview": []
            }

        preview = []
        classificaveis = 0
        nao_classificaveis = 0

        for despesa in despesas:
            cd = despesa['cd_despesaitem']
            nome = despesa['ds_despesaitem'] or ''
            conta_atual = despesa.get('conta_atual')

            conta_sugerida = _classificar_despesa_automatica(cd, nome)

            item = {
                "cd_despesaitem": cd,
                "ds_despesaitem": nome,
                "conta_atual": conta_atual or 'NAO_CLASSIFICADO',
                "conta_sugerida": conta_sugerida or 'NAO_CLASSIFICADO',
                "mudanca": conta_sugerida and conta_sugerida != conta_atual
            }
            preview.append(item)

            if conta_sugerida:
                classificaveis += 1
            else:
                nao_classificaveis += 1

        return {
            "success": True,
            "message": f"Prévia gerada: {classificaveis} podem ser classificadas automaticamente",
            "estatisticas": {
                "total": len(despesas),
                "classificaveis": classificaveis,
                "nao_classificaveis": nao_classificaveis
            },
            "preview": preview
        }

    except Exception as e:
        print(f"[ERROR] Erro ao gerar prévia: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# Mapeamento OFICIAL de códigos de despesa para contas DRE
# Baseado no dre.py e nos dados oficiais
MAPEAMENTO_OFICIAL_DRE = {
    # 08.01 - DESPESAS COM OCUPAÇÃO
    80: '08.01.07',   # TAXAS E EMOLUMENTO - CO
    85: '08.01.02',   # ALUGUEL MINIMO - CO
    110: '08.01.06',  # IPTU - CO
    145: '08.01.03',  # FUNDO DE PROMOCAO - CO
    40: '08.01.04',   # ENERGIA - CO
    50: '08.01.01',   # CONDOMINIO - CO
    146: '08.01.05',  # AR CONDICIONADO - CO
    225: '08.01.04',  # ENERGIA (sem CO)
    45: '08.01.09',   # AGUA E ESGOTO
    56: '08.01.10',   # SEGUROS DE IMOVEIS
    228: '08.01.07',  # TAXAS E EMOLUMENTO
    227: '08.01.06',  # IPTU ADM

    # 08.02 - DESPESAS ADMINISTRATIVAS
    4: '08.02.01',    # ASSESSORIA JURIDICA
    17: '08.02.02',   # ASSESSORIA CONTABIL
    18: '08.02.03',   # MONIT/SEGURANCA
    24: '08.02.04',   # ASSOCIACAO
    31: '08.02.05',   # MATERIAL DE LIMPEZA
    37: '08.02.06',   # MAT DE CONSUMO
    39: '08.02.07',   # AGUA MINERAL
    41: '08.02.09',   # TELEFONIA FIXA
    60: '08.02.16',   # TELEFONIA MOVEL
    63: '08.02.17',   # SERV INTERNET
    70: '08.02.18',   # CORREIOS E MALOTES
    74: '08.02.19',   # MATERIAL DE ESCRITORIO
    76: '08.02.20',   # MANUT DE SOFTWARE
    79: '08.02.21',   # CONTRIB/ANUIDADES
    123: '08.02.25',  # ISS RET FONTE
    159: '08.02.28',  # TAXAS DE ALVARAS
    160: '08.02.29',  # CONFRATERNIZACOES
    161: '08.02.30',  # MARCAS E PATENTES
    167: '08.02.31',  # CUSTAS PROCESSUAIS
    229: '08.02.32',  # ALUGUEL IMOVEIS ADM
    230: '08.02.33',  # IRRF OUTROS SERVICOS 1708
    252: '08.02.34',  # CONDUCOES ADMINISTRATIVA
    259: '08.02.35',  # SERVICOS DE INVENTARIOS
    263: '08.02.36',  # ALUGUEL MAQ E EQUIPAMENTOS
    264: '08.02.37',  # ALUGUEL EQUIP INFORMATICA
    271: '08.02.38',  # MULTAS E TAXAS ADMINISTRATIVAS
    55: '08.02.10',   # CONSULTORIA
    58: '08.02.11',   # ALUGUEL MAQUINETA
    231: '08.02.12',  # ESTACIONAMENTO DE VEICULO
    20: '08.02.13',   # SERV PRESTADO
    53: '08.02.14',   # DESPESA DE CARTORIO
    52: '08.02.15',   # SERV DEDETIZACAO

    # 08.03 - DESPESAS COM MANUTENCAO
    16: '08.03.01',   # MANUTENCAO INSTALACOES
    38: '08.03.02',   # MANUTENCAO EDIFICACOES
    51: '08.03.03',   # MANUTENCAO EQP INFORMATICA
    82: '08.03.04',   # MANUTENCAO MAQ EQUIPAMENTO
    226: '08.03.05',  # MANUTENCAO AR CONDICIONADO
    222: '08.03.04',  # MANUTENCOES DE MAQUINAS INDUSTRIAIS

    # 08.04 - DESPESAS COM PESSOAL
    12: '08.04.04',   # INSS
    15: '08.04.07',   # VALE TRANSPORTE
    71: '08.04.16',   # IRRF SOBRE SALARIO
    134: '08.04.21',  # FGTS
    144: '08.04.22',  # SALARIOS A PAGAR
    7: '08.04.02',    # ALIMENTACAO
    9: '08.04.03',    # RESCISAO
    77: '08.04.18',   # MULTA RESCISORIA FGTS
    188: '08.04.25',  # VALE ALIMENTACAO
    90: '08.04.26',   # FERIAS
    6: '08.04.01',    # PREMIACOES FUNCIONARIOS
    10: '08.04.28',   # 13 SALARIO ADM
    86: '08.04.29',   # ASSIST MEDICA EMP ADM -> corrigir para 08.04.19
    254: '08.04.30',  # ASSIST MEDICA FUNC
    132: '08.10.11',  # PREMIACOES COMERCIAIS
    47: '08.04.14',   # V. FUNC. PLANO ODONTOLOGICO
    44: '08.04.12',   # FARDAMENTO
    13: '08.04.05',   # CONTRIBUICAO SINDICAL
    42: '08.04.10',   # HORAS EXTRAS
    246: '08.08.02',  # INSS SOBRE PROLABORE
    247: '08.08.03',  # IRRF SOBRE PROLABORE
    23: '08.04.08',   # ESTAGIOS E TREINAMENTOS
    14: '08.04.06',   # EXAMES MEDICOS
    268: '08.04.27',  # VALE COMBUSTIVEL
    489: '08.10.06',  # RESCISAO REPRESENTANTES
    5: '08.04.22',    # SALARIO PROD
    196: '08.04.04',  # INSS PROD
    # REMOVIDO: 192 - PREMIACOES FUNCIONARIOS PROD ja entra no custo do produto
    214: '08.04.21',  # FGTS PROD
    212: '08.04.26',  # FERIAS PROD
    202: '08.04.34',  # HORAS EXTRAS PROD -> não existe no oficial, usar 08.04.10
    199: '08.04.07',  # VALE TRANSPORTE PROD
    267: '08.04.27',  # VALE COMBUSTIVEL PROD
    211: '08.04.19',  # ASSIST MEDICA EMP PROD
    253: '08.04.30',  # ASSIST MEDICA FUNC PROD
    208: '08.04.16',  # IRRF SOBRE SALARIO PROD
    210: '08.04.18',  # MULTA RESCISORIA FGTS PROD
    216: '08.04.25',  # VALE ALIMENTACAO PROD
    193: '08.04.02',  # ALIMENTACAO PROD
    194: '08.04.03',  # RESCISAO PROD
    195: '08.04.28',  # 13 SALARIO PROD
    198: '08.04.06',  # EXAMES MEDICOS PROD -> usar 08.04.06
    204: '08.04.12',  # FARDAMENTO PROD
    203: '08.04.11',  # FARMACIA PROD
    206: '08.04.14',  # V. FUNC. PLANO ODONTOLOGICO PROD

    # 08.05 - DESPESAS COM MARKETING
    94: '08.05.05',   # MKT PROD GRAFICA
    95: '08.05.04',   # MKT AGENCIA BV
    96: '08.05.04',   # MKT AG CONTRATO
    98: '08.05.01',   # MKT VEICUL/MIDIA
    102: '08.05.08',  # MKT PROD CATALOGO
    103: '08.05.07',  # MKT EVENTOS
    104: '08.05.07',  # MKT BUFFET/COQUETEL
    105: '08.05.03',  # MKT AMBIENTACAO LOJAS
    234: '08.05.02',  # PROPAGANDAS EM MIDIAS DIGITAIS
    237: '08.05.05',  # MATERIAIS GRAFICOS PROMOCIONAIS
    544: '08.05.05',  # MATERIAIS GRAFICOS
    240: '08.05.08',  # CAMPANHAS E CONTEUDOS
    235: '08.05.03',  # MERCHANDISING EM PONTO DE VENDAS
    238: '08.05.06',  # ACOES DE RELACIONAMENTO COM CLIENTES
    100: '08.02.23',  # ENDOMARKETING
    239: '08.05.07',  # WORKSHOPS E EVENTOS
    236: '08.05.04',  # CONSULTORIAS E ASSESSORIAS DE MARKETING
    241: '08.06.01',  # CAMPANHAS COMERCIAIS
    242: '08.06.02',  # BRINDES

    # 08.06 - DESPESAS COMERCIAIS
    245: '08.06.05',  # AJUDA DE CUSTO DE VIAGENS COMERCIAIS
    244: '08.06.04',  # AJUDA DE CUSTO DE DESLOCAMENTO COMERCIAIS

    # 08.07 - TARIFAS BANCARIAS
    147: '08.07.06',  # TARIFAS DE BAIXAS DE TITULOS
    68: '08.07.04',   # TARIFA MANUT DE CONTA
    65: '08.07.01',   # TARIFA DOC/TED
    67: '08.07.03',   # TARIFA NEGATIVACAO
    275: '08.07.09',  # TARIFAS BANCARIAS

    # 08.08 - DIRETORIA/PROLABORE
    30: '08.08.05',   # RETIRADA - CAIRO -> antes era 17.01.09, mas se tem valor em 08.08 deve ser prolabore

    # 08.10 - DESPESAS COM VENDAS
    27: '08.10.01',   # FRETES VENDAS
    34: '08.10.07',   # COMISSAO VENDEDOR
    35: '08.10.03',   # COMISSAO REPRESENTANTE
    33: '08.10.02',   # COMISSAO GERENTE
    140: '08.10.12',  # COMISSAO SUPERVISOR
    272: '08.10.09',  # COMISSAO COORDENADOR
    59: '08.10.05',   # TAXAS CARTAO
    32: '08.10.08',   # COMISSAO CORRETOR

    # 08.11 - DESPESAS COM CREDITO E COBRANCA
    49: '08.11.01',   # CONSULTA CADASTRAL

    # 08.12 - DESPESAS COM VEICULOS
    22: '08.12.01',   # COMBUSTIVEL/LUBRIFICANTE
    73: '08.12.02',   # MANUTENCAO DE VEICULOS
    83: '08.12.03',   # SEGURO VEICULOS
    87: '08.12.05',   # TX DETRAN/IPVA
    232: '08.12.06',  # ESTACIONAMENTO

    # 10.03 - DESPESAS FINANCEIRAS
    48: '10.03.02',   # IOF
    121: '10.03.02',  # IOF S/ EMPRESTIMO
    25: '10.03.01',   # MULTA/JUROS
    137: '10.03.04',  # JUROS S/EMPREST. E FINANCIAM.
    186: '10.03.05',  # JUROS S/ ANTECIPACAO
    258: '10.03.06',  # SEGURO SOBRE EMPRESTIMOS
    541: '10.03.07',  # RECOMPRA DE TITULOS

    # 13.01 - DESPESAS TRIBUTARIAS
    124: '13.01.01',  # CSLL APURACAO
    125: '13.01.02',  # IRPJ APURACAO
    260: '13.01.01',  # CSLL PROVISAO
    261: '13.01.02',  # IRPJ PROVISAO

    # 02.02 - IMPOSTOS SOBRE VENDAS
    127: '02.02.03',  # COFINS SOBRE RECEITA
    126: '02.02.02',  # PIS SOBRE RECEITA
    111: '02.02.01',  # ICMS SOBRE VENDAS
    250: '02.02.05',  # DIFAL GNRE

    # 04.01 - CUSTOS VARIAVEIS
    119: '04.01.02',  # ICMS SUBSTITUICAO
    117: '04.01.01',  # ICMS ANTECIPADO

    # 17.01 - INVESTIMENTOS
    11: '17.01.01',   # INV. COMPUTADORES E PERIFERICOS
    138: '17.01.03',  # INV. MAQUINAS E EQUIPAMENTOS
    139: '17.01.04',  # INV. MOVEIS E UTENSILIOS
    150: '17.01.06',  # INV. REFORMAS E OBRAS
    164: '17.01.07',  # INV. SOFTWARES
    169: '17.01.08',  # INV. CDU - CESSAO DE DIREITOS
    993: '17.01.06',  # REFORMA VICENTE 2025
    162: '17.01.10',  # RETIRADA - THAIS
    57: '17.01.11',   # RETIRADA - GERLANO
    135: '17.01.12',  # RETIRADA - SHENIA
    282: '17.01.17',  # INV CAIRO

    # 18 - AMORTIZAÇÃO E DÍVIDAS
    114: '18.02',     # EMPRESTIMO PRINCIPAL
    148: '18.04',     # EMPRESTIMO MUTUO
    158: '18.07',     # MULTAS SEFAZ
}


@router.post("/api/classificacao-despesas-dre/sincronizar-oficial")
def sincronizar_classificacoes_com_oficial():
    """
    Sincroniza as classificações DRE com o mapeamento oficial.
    Analisa todas as despesas e corrige aquelas que estão classificadas
    de forma diferente do mapeamento oficial.

    Salva automaticamente no banco.
    """
    try:
        print(f"[SINCRONIZAR] Iniciando sincronização com mapeamento oficial...")

        # Buscar todas as classificações atuais do banco
        query_atuais = """
            SELECT cd_despesaitem, ds_despesaitem, conta_dre
            FROM classificacao_despesas_dre
        """
        classificacoes_atuais = execute_query(query_atuais)

        # Criar mapa das classificações atuais
        mapa_atual = {}
        for c in classificacoes_atuais or []:
            mapa_atual[c['cd_despesaitem']] = c['conta_dre']

        # Buscar todas as despesas
        query_despesas = """
            SELECT cd_despesaitem, ds_despesaitem
            FROM vr_fcp_despesaitem
        """
        despesas = execute_query(query_despesas)

        corrigidas = []
        inseridas = []
        ja_corretas = 0
        sem_mapeamento = 0

        for d in despesas or []:
            cd = d['cd_despesaitem']
            nome = d['ds_despesaitem']

            # Verificar se tem mapeamento oficial
            if cd not in MAPEAMENTO_OFICIAL_DRE:
                sem_mapeamento += 1
                continue

            conta_oficial = MAPEAMENTO_OFICIAL_DRE[cd]
            conta_atual = mapa_atual.get(cd)

            # Se já está correta, pula
            if conta_atual == conta_oficial:
                ja_corretas += 1
                continue

            # Precisa corrigir ou inserir
            query_upsert = """
                INSERT INTO classificacao_despesas_dre
                    (cd_despesaitem, ds_despesaitem, conta_dre, usuario_alteracao, dt_atualizacao)
                VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (cd_despesaitem)
                DO UPDATE SET
                    conta_dre = EXCLUDED.conta_dre,
                    usuario_alteracao = EXCLUDED.usuario_alteracao,
                    dt_atualizacao = CURRENT_TIMESTAMP
            """
            execute_insert(query_upsert, (cd, nome, conta_oficial, 'sincronizacao_oficial'))

            if conta_atual:
                corrigidas.append({
                    'cd': cd,
                    'nome': nome,
                    'de': conta_atual,
                    'para': conta_oficial
                })
            else:
                inseridas.append({
                    'cd': cd,
                    'nome': nome,
                    'conta': conta_oficial
                })

        print(f"[SINCRONIZAR] Concluído!")
        print(f"  - Já corretas: {ja_corretas}")
        print(f"  - Corrigidas: {len(corrigidas)}")
        print(f"  - Inseridas: {len(inseridas)}")
        print(f"  - Sem mapeamento oficial: {sem_mapeamento}")

        return {
            "success": True,
            "message": f"Sincronização concluída! {len(corrigidas)} corrigidas, {len(inseridas)} inseridas.",
            "estatisticas": {
                "ja_corretas": ja_corretas,
                "corrigidas": len(corrigidas),
                "inseridas": len(inseridas),
                "sem_mapeamento": sem_mapeamento
            },
            "corrigidas": corrigidas[:100],  # Primeiras 100
            "inseridas": inseridas[:100]
        }

    except Exception as e:
        print(f"[ERROR] Erro na sincronização: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
