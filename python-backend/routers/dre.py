from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime
from database import execute_query
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


def _normalizar_texto(value: Optional[str]) -> str:
    if not value:
        return ""
    text = str(value).strip().upper()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(text.split())


REGRAS_DESCRICAO_DRE = [
    ('CONDOMINIO', '08.01.01'),
    ('ALUGUEL MINIMO', '08.01.02'),
    ('FUNDO DE PROMOCAO', '08.01.03'),
    ('ENERGIA - CO', '08.01.04'),
    ('ENERGIA', '08.01.04'),
    ('AR CONDICIONADO', '08.01.05'),
    ('IPTU - CO', '08.01.06'),
    ('IPTU ADM', '08.01.06'),
    ('TAXAS E EMOLUMENTO', '08.01.07'),
    ('IRRF SOBRE ALUGUEL 3208 - CO', '08.01.08'),
    ('IRRF SOBRE ALUGUEL', '08.01.08'),
    ('DESCONTOS FINANCEIROS OBTIDOS - CO', '08.01.09'),
    ('DESCONTOS FINANCEIROS OBTIDOS', '08.01.09'),
    ('OUTRAS DESPESAS DE OCUPACAO', '08.01.10'),
    ('AGUA E ESGOTO', '08.01.09'),
    ('SEGUROS DE IMOVEIS', '08.01.10'),

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
    ('ESTACIONAMENTO DE VEICULO', '08.02.12'),
    ('SERV PRESTADO', '08.02.13'),
    ('DESPESA DE CARTORIO', '08.02.14'),
    ('SERV DEDETIZACAO', '08.02.15'),
    ('TELEFONIA MOVEL', '08.02.16'),
    ('SERV INTERNET', '08.02.17'),
    ('CORREIOS E MALOTES', '08.02.18'),
    ('MATERIAL DE ESCRITORIO', '08.02.19'),
    ('MANUT DE SOFTWARE', '08.02.20'),
    ('CONTRIB/ANUIDADES', '08.02.21'),
    ('ENDOMARKETING', '08.02.23'),
    ('ISS RET FONTE', '08.02.25'),
    ('TAXAS DE ALVARAS', '08.02.28'),
    ('CONFRATERNIZACOES', '08.02.29'),
    ('MARCAS E PATENTES', '08.02.30'),
    ('CUSTAS PROCESSUAIS', '08.02.31'),
    ('ALUGUEL IMOVEIS ADM', '08.02.32'),
    ('IRRF OUTROS SERVICOS 1708', '08.02.33'),
    ('CONDUCOES ADMINISTRATIVA', '08.02.34'),
    ('SERVICOS DE INVENTARIOS', '08.02.35'),
    ('ALUGUEL MAQ E EQUIPAMENTOS', '08.02.36'),
    ('ALUGUEL EQUIP INFORMATICA', '08.02.37'),
    ('MULTAS E TAXAS ADMINISTRATIVAS', '08.02.38'),

    ('MANUTENCAO INSTALACOES', '08.03.01'),
    ('MANUTENCAO EDIFICACOES', '08.03.02'),
    ('MANUTENCAO EQP INFORMATICA', '08.03.03'),
    ('MANUTENCAO MAQ', '08.03.04'),
    ('MANUTENCOES DE MAQUINAS INDUSTRIAIS', '08.03.04'),
    ('MANUTENCAO AR CONDICIONADO', '08.03.05'),

    ('ALIMENTACAO PROD', '08.04.02'),
    ('ALIMENTACAO', '08.04.02'),
    ('RESCISAO PROD', '08.04.03'),
    ('RESCISAO', '08.04.03'),
    ('INSS PROD', '08.04.04'),
    ('INSS', '08.04.04'),
    ('CONTRIBUICAO SINDICAL', '08.04.05'),
    ('EXAMES MEDICOS', '08.04.06'),
    ('VALE TRANSPORTE PROD', '08.04.07'),
    ('VALE TRANSPORTE', '08.04.07'),
    ('ESTAGIOS E TREINAMENTOS', '08.04.08'),
    ('HORAS EXTRAS', '08.04.10'),
    ('FARMACIA PROD', '08.04.11'),
    ('FARDAMENTO', '08.04.12'),
    ('PLANO ODONTOLOGICO', '08.04.14'),
    ('IRRF SOBRE SALARIO', '08.04.16'),
    ('MULTA RESCISORIA FGTS', '08.04.18'),
    ('FGTS PROD', '08.04.21'),
    ('FGTS', '08.04.21'),
    # REMOVIDO: ('SALARIO', '08.04.22') - usar apenas mapeamento do banco (cd_despesaitem=144)
    ('VALE ALIMENTACAO', '08.04.25'),
    ('FERIAS', '08.04.26'),
    ('VALE COMBUSTIVEL', '08.04.27'),
    ('13 SALARIO', '08.04.28'),
    ('ASSIST MEDICA EMP', '08.04.29'),
    ('ASSIST MEDICA FUNC', '08.04.30'),
    ('PLANO ODONTOLOGICO PROD', '08.04.31'),
    ('FARDAMENTO PROD', '08.04.32'),
    ('HORAS EXTRAS PROD', '08.04.34'),
    ('EXAMES MEDICOS PROD', '08.04.38'),

    ('MKT PROD GRAFICA', '08.05.05'),
    ('MATERIAIS GRAFICOS', '08.05.05'),
    ('MKT AGENCIA BV', '08.05.04'),
    ('MKT AG CONTRATO', '08.05.04'),
    ('MKT VEICUL/MIDIA', '08.05.01'),
    ('PROPAGANDAS EM MIDIAS DIGITAIS', '08.05.02'),
    ('MERCHANDISING EM PONTO DE VENDAS', '08.05.03'),
    ('ACOES DE RELACIONAMENTO COM CLIENTES', '08.05.06'),
    ('MKT EVENTOS', '08.05.07'),
    ('WORKSHOPS E EVENTOS', '08.05.07'),
    ('MKT PROD CATALOGO', '08.05.08'),
    ('CAMPANHAS E CONTEUDOS', '08.05.08'),
    ('CAMPANHAS COMERCIAIS', '08.06.01'),
    ('BRINDES', '08.06.02'),

    ('TARIFA DOC', '08.07.01'),
    ('TARIFA TED', '08.07.01'),
    ('TARIFA NEGATIVACAO', '08.07.03'),
    ('TARIFA MANUT DE CONTA', '08.07.04'),
    ('TARIFAS DE BAIXAS DE TITULOS', '08.07.06'),
    ('TARIFAS BANCARIAS', '08.07.09'),

    ('INSS SOBRE PROLABORE', '08.08.02'),
    ('IRRF SOBRE PROLABORE', '08.08.03'),

    ('FRETES VENDAS', '08.10.01'),
    ('COMISSAO GERENTE', '08.10.02'),
    ('COMISSAO REPRESENTANTE', '08.10.03'),
    ('TAXAS CARTAO', '08.10.05'),
    ('RESCISAO REPRESENTANTES', '08.10.06'),
    ('COMISSAO VENDEDOR', '08.10.07'),
    ('COMISSAO CORRETOR', '08.10.08'),
    ('COMISSAO COORDENADOR', '08.10.09'),
    ('PREMIACOES COMERCIAIS', '08.10.11'),
    ('COMISSAO SUPERVISOR', '08.10.12'),

    ('CONSULTA CADASTRAL', '08.11.01'),
    ('COMBUSTIVEL/LUBRIFICANTE', '08.12.01'),
    ('MANUTENCAO DE VEICULOS', '08.12.02'),
    ('SEGURO VEICULOS', '08.12.03'),
    ('TX DETRAN/IPVA', '08.12.05'),

    ('MULTA/JUROS', '10.03.01'),
    ('IOF', '10.03.02'),
    ('JUROS S/EMPREST', '10.03.04'),
    ('JUROS S/ ANTECIPACAO', '10.03.05'),
    ('SEGURO SOBRE EMPRESTIMOS', '10.03.06'),
    ('RECOMPRA DE TITULOS', '10.03.07'),

    ('ICMS SOBRE VENDAS', '02.02.01'),
    ('PIS SOBRE RECEITA', '02.02.02'),
    ('COFINS SOBRE RECEITA', '02.02.03'),
    ('DIFAL GNRE', '02.02.05'),
    ('ICMS ANTECIPADO', '04.01.01'),
    ('ICMS SUBSTITUICAO', '04.01.02'),
    ('CSLL APURACAO', '13.01.01'),
    ('CSLL PROVISAO', '13.01.01'),
    ('IRPJ APURACAO', '13.01.02'),
    ('IRPJ PROVISAO', '13.01.02'),

    ('INV. COMPUTADORES E PERIFERICOS', '17.01.01'),
    ('INV. MAQUINAS E EQUIPAMENTOS', '17.01.03'),
    ('INV. MOVEIS E UTENSILIOS', '17.01.04'),
    ('INV. REFORMAS E OBRAS', '17.01.06'),
    ('INV. SOFTWARES', '17.01.07'),
    ('INV. CDU - CESSAO DE DIREITOS', '17.01.08'),
    ('RETIRADA - CAIRO', '17.01.17'),
    ('RETIRADA-THAIS', '08.08.01'),
    ('RETIRADA - GERLANO', '08.08.05'),
    ('RETIRADA - SHENIA', '08.08.06'),
    ('EMPRESTIMO PRINCIPAL', '18.02'),
    ('EMPRESTIMO MUTUO', '18.04'),
    ('MULTAS SEFAZ', '18.07'),
]


def _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db):
    conta = classificacoes_db.get(cd_despesaitem)
    if conta:
        return conta

    descricao_normalizada = _normalizar_texto(descricao_despesa)

    conta = classificacoes_desc_db.get(descricao_normalizada)
    if conta:
        return conta

    conta = MAPEAMENTO_DESPESA_DRE.get(cd_despesaitem)
    if conta:
        return conta

    for palavra_chave, conta_dre in REGRAS_DESCRICAO_DRE:
        if palavra_chave in descricao_normalizada:
            return conta_dre

    return 'NAO_CLASSIFICADO'

MAPEAMENTO_DESPESA_DRE = {
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

    # 08.04 - DESPESAS COM PESSOAL ADM E LOJAS
    12: '08.04.04',   # INSS
    15: '08.04.07',   # VALE TRANSPORTE
    71: '08.04.16',   # IRRF SOBRE SALARIO
    134: '08.04.21',  # FGTS
    # REMOVIDO: 144: '08.04.22' - usar mapeamento do banco
    7: '08.04.02',    # ALIMENTACAO
    9: '08.04.03',    # RESCISAO
    77: '08.04.18',   # MULTA RESCISORIA FGTS
    188: '08.04.25',  # VALE ALIMENTACAO
    90: '08.04.26',   # FERIAS
    6: '08.04.01',    # PREMIACOES FUNCIONARIOS
    10: '08.04.28',   # 13 SALARIO ADM
    86: '08.04.29',   # ASSIST MEDICA EMP ADM
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

    # 08.04 - DESPESAS COM PESSOAL PRODUCAO (FABRICA)
    # REMOVIDO: 5: '08.04.22' - SALARIO PROD nao deve ir para 08.04.22
    196: '08.04.04',  # INSS PROD
    # REMOVIDO: 192 - PREMIACOES FUNCIONARIOS PROD ja entra no custo do produto
    214: '08.04.21',  # FGTS PROD
    212: '08.04.26',  # FERIAS PROD
    202: '08.04.34',  # HORAS EXTRAS PROD
    199: '08.04.07',  # VALE TRANSPORTE PROD
    267: '08.04.27',  # VALE COMBUSTIVEL PROD
    211: '08.04.29',  # ASSIST MEDICA EMP PROD
    253: '08.04.30',  # ASSIST MEDICA FUNC PROD
    208: '08.04.16',  # IRRF SOBRE SALARIO PROD
    210: '08.04.18',  # MULTA RESCISORIA FGTS PROD
    216: '08.04.25',  # VALE ALIMENTACAO PROD
    193: '08.04.02',  # ALIMENTACAO PROD
    194: '08.04.03',  # RESCISAO PROD
    195: '08.04.28',  # 13 SALARIO PROD
    198: '08.04.38',  # EXAMES MEDICOS PROD
    204: '08.04.32',  # FARDAMENTO PROD
    203: '08.04.11',  # FARMACIA PROD
    206: '08.04.31',  # V. FUNC. PLANO ODONTOLOGICO PROD

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

    # 08.10 - DESPESAS COM VENDAS
    27: '08.10.01',   # FRETES VENDAS
    34: '08.10.07',   # COMISSAO VENDEDOR
    35: '08.10.03',   # COMISSAO REPRESENTANTE
    33: '08.10.02',   # COMISSAO GERENTE
    140: '08.10.12',  # COMISSAO SUPERVISOR
    272: '08.10.09',  # COMISSAO COORDENADOR
    59: '08.10.05',   # TAXAS CARTAO
    245: '08.06.05',  # AJUDA DE CUSTO DE VIAGENS COMERCIAIS
    244: '08.06.04',  # AJUDA DE CUSTO DE DESLOCAMENTO COMERCIAIS
    32: '08.10.08',   # COMISSAO CORRETOR

    # 08.11 - DESPESAS COM CREDITO E COBRANCA
    49: '08.11.01',   # CONSULTA CADASTRAL

    # 08.12 - DESPESAS COM VEICULOS
    22: '08.12.01',   # COMBUSTIVEL/LUBRIFICANTE
    73: '08.12.02',   # MANUTENCAO DE VEICULOS
    83: '08.12.03',   # SEGURO VEICULOS
    87: '08.12.05',   # TX DETRAN/IPVA

    # 10.03 - DESPESAS FINANCEIRAS
    48: '10.03.02',   # IOF
    121: '10.03.02',  # IOF S/ EMPRESTIMO
    25: '10.03.01',   # MULTA/JUROS
    137: '10.03.04',  # JUROS S/EMPREST. E FINANCIAM.
    186: '10.03.05',  # JUROS S/ ANTECIPACAO
    258: '10.03.06',  # SEGURO SOBRE EMPRESTIMOS
    147: '08.07.06',  # TARIFAS DE BAIXAS DE TITULOS
    68: '08.07.04',   # TARIFA MANUT DE CONTA
    65: '08.07.01',   # TARIFA DOC/TED
    67: '08.07.03',   # TARIFA NEGATIVACAO
    275: '08.07.09',  # TARIFAS BANCARIAS
    541: '10.03.07',  # RECOMPRA DE TITULOS

    # 13.01 - DESPESAS TRIBUTARIAS
    124: '13.01.01',  # CSLL APURACAO
    125: '13.01.02',  # IRPJ APURACAO
    260: '13.01.01',  # CSLL PROVISAO
    261: '13.01.02',  # IRPJ PROVISAO
    119: '04.01.02',  # ICMS SUBSTITUICAO
    127: '02.02.03',  # COFINS SOBRE RECEITA
    117: '04.01.01',  # ICMS ANTECIPADO
    111: '02.02.01',  # ICMS SOBRE VENDAS
    126: '02.02.02',  # PIS SOBRE RECEITA
    250: '02.02.05',  # DIFAL GNRE
    158: '18.07',     # MULTAS SEFAZ

    # 17.01 - INVESTIMENTOS - IMOBILIZADOS (excluídos do lucro líquido)
    11: '17.01.01',   # INV. COMPUTADORES E PERIFERICOS
    138: '17.01.03',  # INV. MAQUINAS E EQUIPAMENTOS
    139: '17.01.04',  # INV. MOVEIS E UTENSILIOS
    150: '17.01.06',  # INV. REFORMAS E OBRAS
    164: '17.01.07',  # INV. SOFTWARES
    169: '17.01.08',  # INV. CDU - CESSAO DE DIREITOS
    30: '17.01.17',   # RETIRADA - CAIRO -> INVESTIMENTOS CAIRO
    162: '08.08.01',  # RETIRADA - THAIS
    57: '08.08.05',   # RETIRADA - GERLANO
    135: '08.08.06',  # RETIRADA - SHENIA
    993: '17.01.06',  # REFORMA VICENTE 2025

    # 18 - AMORTIZAÇÃO E DÍVIDAS
    114: '18.02',     # EMPRESTIMO PRINCIPAL
    148: '18.04',     # EMPRESTIMO MUTUO
}


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
        if codigo == 'NAO_CLASSIFICADO':
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
        # Buscamos direto da tabela vr_fcp_despduplicatai pois a view vw_fluxo_pagamentos
        # não tem a coluna dt_emissao e filtra apenas títulos não pagos
        # EXCLUINDO empresas específicas (CORPO SEXY, CAIRO BENEVIDES, CB EMPREENDIMENTOS)
        exclusao_placeholders = ",".join(["%s"] * len(EMPRESAS_EXCLUIDAS))

        # Filtro de empresa específica (se informado)
        empresa_desp_filter = ""
        empresa_desp_params = []
        if empresas_ids:
            empresa_desp_placeholders = ",".join(["%s"] * len(empresas_ids))
            empresa_desp_filter = f" AND d.cd_empresa IN ({empresa_desp_placeholders})"
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
              AND d.cd_empresa NOT IN ({exclusao_placeholders})
              {empresa_desp_filter}
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS, *empresa_desp_params))
        print(f"[DRE] Total de despesas: {len(despesas)}")

        # Buscar classificações do banco de dados (prioridade) e depois usar mapeamento fixo como fallback
        classificacoes_db = {}
        classificacoes_desc_db = {}
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
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
            print(f"[DRE] Classificações carregadas do banco: {len(classificacoes_db)}")
        except Exception as e:
            print(f"[DRE] Aviso: não foi possível carregar classificações do banco: {e}")

        # Agrupar despesas por conta_dre e período
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

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
            FROM mv_cmv_loja
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
# Centros de custo excluidos das despesas (lojas/outras empresas)
CCUSTOS_EXCLUIDOS_FABRICA = [50, 100, 110]


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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
            print(f"[DRE FABRICA] Classificacoes carregadas: {len(classificacoes_db)}")
        except Exception as e:
            print(f"[DRE FABRICA] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Agrupar despesas por conta_dre e periodo
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

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
        # CMV - APENAS mv_cmv_fab (sem mv_cmv_loja)
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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception as e:
            print(f"[DRE LOJAS] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Agrupar despesas por conta_dre e periodo
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

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
        # CMV - mv_cmv_loja para lojas
        # =========================================================================
        cmv_loja_raw = execute_query("""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_loja
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

        # Resolver cd_despesaitem associados a conta
        conta_prefixo = f"{conta}."
        itens_db = [
            cd for cd, c in classificacoes_db.items()
            if c == conta or c.startswith(conta_prefixo)
        ]

        if itens_db:
            itens = itens_db
        else:
            itens_mapa = [
                cd for cd, c in MAPEAMENTO_DESPESA_DRE.items()
                if c == conta or c.startswith(conta_prefixo)
            ]
            itens = itens_mapa

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
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia
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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception:
            pass

        # Resolver cd_despesaitem associados a conta (exato ou por prefixo)
        # PRIORIDADE: banco de dados primeiro, mapeamento fixo como fallback
        conta_prefixo = f"{conta}."

        # Buscar do banco de dados (prioridade)
        itens_db = [
            cd for cd, c in classificacoes_db.items()
            if c == conta or c.startswith(conta_prefixo)
        ]

        # Se tem no banco, usar APENAS o banco (ignora mapeamento fixo)
        # Isso garante que a tabela classificacao_despesas_dre tem controle total
        if itens_db:
            itens = itens_db
        else:
            # Fallback para mapeamento fixo se nao tem no banco
            itens_mapa = [
                cd for cd, c in MAPEAMENTO_DESPESA_DRE.items()
                if c == conta or c.startswith(conta_prefixo)
            ]
            itens = itens_mapa

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
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia
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
        classificacoes_desc_db = {}
        try:
            rows_cls = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows_cls or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception:
            pass

        # Somar despesas operacionais (08.xx) por centro de custo
        despesas_por_ccusto = {}
        for d in despesas_raw:
            conta = _classificar_conta_dre(
                d['cd_despesaitem'], d.get('descricao_despesa'),
                classificacoes_db, classificacoes_desc_db
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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception as e:
            print(f"[DRE-FAB-CCUSTO] Aviso: não foi possível carregar classificações: {e}")

        # Agrupar despesas por conta_dre e centro de custo
        valores_por_conta = {}
        ccustos_encontrados = set()

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
            valor = -abs(float(d['valor'] or 0))
            cd_ccusto = d['cd_ccusto']

            if conta == 'NAO_CLASSIFICADO':
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
            if codigo == 'NAO_CLASSIFICADO':
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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
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
            conta = _classificar_conta_dre(cd, d.get("descricao_despesa"), classificacoes_db, classificacoes_desc_db)
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
    Usa o mesmo mapeamento fixo da DRE para manter consistência com os totais.
    """
    try:
        import calendar

        if len(periodo) != 7 or '-' not in periodo:
            raise HTTPException(status_code=400, detail="Período inválido. Use YYYY-MM.")

        ano, mes = periodo.split('-')
        primeiro_dia = f"{periodo}-01"
        ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]
        data_fim = f"{periodo}-{ultimo_dia:02d}"

        # Resolver cd_despesaitem associados à conta (exato ou por prefixo)
        conta_prefixo = f"{conta}."
        itens = [
            cd for cd, c in MAPEAMENTO_DESPESA_DRE.items()
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
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia
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
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'N/A') as nm_fantasia
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
    Retorna dados da DRE agrupados por empresa (centro de custo).
    Cada coluna representa uma empresa diferente.
    """
    try:
        print(f"[INFO] Buscando DRE por Empresa: {dataInicio} até {dataFim}")

        # Buscar despesas agrupadas por empresa
        # EXCLUINDO empresas específicas (CORPO SEXY, CAIRO BENEVIDES, CB EMPREENDIMENTOS)
        exclusao_emp_placeholders = ",".join(["%s"] * len(EMPRESAS_EXCLUIDAS))
        query_despesas = f"""
            SELECT
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                d.cd_empresa,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_empresa NOT IN ({exclusao_emp_placeholders})
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))
        print(f"[DRE-EMP] Total de despesas: {len(despesas)}")

        # Buscar classificações do banco
        classificacoes_db = {}
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception as e:
            print(f"[DRE-EMP] Aviso: não foi possível carregar classificações: {e}")

        # Buscar nomes das empresas
        query_empresas = """
            SELECT e.cd_empresa, COALESCE(p.nm_fantasia, p.nm_pessoa, 'Empresa ' || e.cd_empresa::text) AS nome
            FROM vr_ger_empresa e
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = e.cd_pessoa
        """
        empresas_raw = execute_query(query_empresas, ())
        nomes_empresas = {r['cd_empresa']: r['nome'] for r in empresas_raw}

        # Agrupar despesas por conta_dre e empresa
        valores_por_conta = {}
        empresas_encontradas = set()

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
            valor = -abs(float(d['valor'] or 0))
            cd_empresa = d['cd_empresa']

            if conta == 'NAO_CLASSIFICADO':
                continue

            empresas_encontradas.add(cd_empresa)

            if conta not in valores_por_conta:
                valores_por_conta[conta] = {'total': 0}

            emp_key = str(cd_empresa)
            if emp_key not in valores_por_conta[conta]:
                valores_por_conta[conta][emp_key] = 0

            valores_por_conta[conta][emp_key] += valor
            valores_por_conta[conta]['total'] += valor

        # Buscar vendas por empresa
        # EXCLUINDO empresas específicas (CORPO SEXY, CAIRO BENEVIDES, CB EMPREENDIMENTOS)
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
              AND t.cd_empresa NOT IN ({exclusao_emp_placeholders})
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
              AND t.cd_empresa NOT IN ({exclusao_emp_placeholders})
            GROUP BY t.cd_empresa
        """

        vendas = execute_query(query_vendas, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))

        # Adicionar vendas por empresa
        receita_bruta = {'total': 0}
        for v in vendas:
            cd_emp = v['cd_empresa']
            valor = float(v['valor'] or 0)
            empresas_encontradas.add(cd_emp)
            emp_key = str(cd_emp)
            receita_bruta[emp_key] = valor
            receita_bruta['total'] += valor

        valores_por_conta['01.01.02'] = receita_bruta

        # Adicionar devoluções por empresa
        devolucoes_brutas = {'total': 0}
        for d in devolucoes:
            cd_emp = d['cd_empresa']
            valor = -abs(float(d['valor'] or 0))
            emp_key = str(cd_emp)
            devolucoes_brutas[emp_key] = valor
            devolucoes_brutas['total'] += valor

        valores_por_conta['02.01.03'] = devolucoes_brutas

        # CMV por empresa (lojas)
        # EXCLUINDO empresas específicas (CORPO SEXY, CAIRO BENEVIDES, CB EMPREENDIMENTOS)
        cmv_loja_raw = execute_query(f"""
            SELECT idcentrodecusto AS cd_empresa, ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja
            WHERE data >= %s AND data <= %s
              AND idcentrodecusto NOT IN ({exclusao_emp_placeholders})
            GROUP BY idcentrodecusto
        """, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))

        cmv_valores = {'total': 0}
        for r in (cmv_loja_raw or []):
            cd_emp = r['cd_empresa']
            empresas_encontradas.add(cd_emp)
            v = -abs(float(r['cmv'] or 0))
            emp_key = str(cd_emp)
            cmv_valores[emp_key] = v
            cmv_valores['total'] += v

        valores_por_conta['04.02.02'] = cmv_valores

        # Somar hierarquia para cada empresa
        empresas_list = sorted(empresas_encontradas)
        for codigo, valores in list(valores_por_conta.items()):
            if codigo == 'NAO_CLASSIFICADO':
                continue
            partes = codigo.split('.')
            if len(partes) <= 1:
                continue
            for nivel in range(1, len(partes)):
                codigo_pai = '.'.join(partes[:nivel])
                if codigo_pai not in valores_por_conta:
                    valores_por_conta[codigo_pai] = {'total': 0}
                for emp in empresas_list:
                    emp_key = str(emp)
                    if emp_key not in valores_por_conta[codigo_pai]:
                        valores_por_conta[codigo_pai][emp_key] = 0
                    valores_por_conta[codigo_pai][emp_key] += valores.get(emp_key, 0)
                valores_por_conta[codigo_pai]['total'] += valores.get('total', 0)

        # Montar lista de empresas com nomes
        empresas_info = []
        for cd_emp in empresas_list:
            empresas_info.append({
                "cd_empresa": cd_emp,
                "nome": nomes_empresas.get(cd_emp, f"Empresa {cd_emp}")
            })

        response = {
            "empresas": empresas_info,
            "valores": valores_por_conta,
            "metadata": {
                "totalEmpresas": len(empresas_list),
                "dataInicio": dataInicio,
                "dataFim": dataFim,
                "dataConsulta": datetime.now().isoformat()
            }
        }

        print(f"[OK] DRE por Empresa gerado com {len(empresas_list)} empresas.")
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
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna visão sintética da DRE com métricas principais por empresa.
    Métricas: Receita Líquida, CMV, Despesas Operacionais, Lucro Líquido, Margem %
    """
    try:
        print(f"[INFO] Buscando DRE Sintético: {dataInicio} até {dataFim}")

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
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
              AND t.cd_empresa NOT IN ({exclusao_sint_placeholders})
            GROUP BY t.cd_empresa
        """
        vendas = execute_query(query_vendas, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))
        receita_por_empresa = {r['cd_empresa']: float(r['receita_bruta'] or 0) for r in vendas}

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
              AND t.cd_empresa NOT IN ({exclusao_sint_placeholders})
            GROUP BY t.cd_empresa
        """
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))
        devolucoes_por_empresa = {r['cd_empresa']: float(r['devolucoes'] or 0) for r in devolucoes}

        # Buscar CMV por empresa (lojas)
        cmv_loja_raw = execute_query(f"""
            SELECT idcentrodecusto AS cd_empresa, ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja
            WHERE data >= %s AND data <= %s
              AND idcentrodecusto NOT IN ({exclusao_sint_placeholders})
            GROUP BY idcentrodecusto
        """, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))
        cmv_por_empresa = {r['cd_empresa']: float(r['cmv'] or 0) for r in cmv_loja_raw}

        # Buscar despesas por empresa — com cd_despesaitem para classificar
        query_despesas = f"""
            SELECT
                d.cd_empresa,
                d.cd_despesaitem,
                i.ds_despesaitem as descricao_despesa,
                ABS(d.vl_rateio) as valor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_empresa NOT IN ({exclusao_sint_placeholders})
        """
        despesas_raw = execute_query(query_despesas, (dataInicio, dataFim, *EMPRESAS_EXCLUIDAS))

        # Carregar classificações do banco (mesma lógica da DRE analítica)
        classificacoes_db = {}
        classificacoes_desc_db = {}
        try:
            rows_cls = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows_cls or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception:
            pass

        # Somar apenas despesas operacionais (08.xx) por empresa
        despesas_por_empresa = {}
        for d in despesas_raw:
            conta = _classificar_conta_dre(
                d['cd_despesaitem'], d.get('descricao_despesa'),
                classificacoes_db, classificacoes_desc_db
            )
            # Só contar como despesa operacional contas 08.xx
            if not conta.startswith('08.'):
                continue
            cd_emp = d['cd_empresa']
            despesas_por_empresa[cd_emp] = despesas_por_empresa.get(cd_emp, 0) + float(d['valor'] or 0)

        # Consolidar empresas
        todas_empresas = set(receita_por_empresa.keys()) | set(cmv_por_empresa.keys()) | set(despesas_por_empresa.keys())

        resultados = []
        totais = {
            "receita_bruta": 0,
            "devolucoes": 0,
            "receita_liquida": 0,
            "cmv": 0,
            "lucro_bruto": 0,
            "despesas_operacionais": 0,
            "lucro_liquido": 0
        }

        for cd_emp in sorted(todas_empresas):
            receita_bruta = receita_por_empresa.get(cd_emp, 0)
            devolucoes_val = devolucoes_por_empresa.get(cd_emp, 0)
            receita_liquida = receita_bruta - devolucoes_val
            cmv = cmv_por_empresa.get(cd_emp, 0)
            lucro_bruto = receita_liquida - cmv
            despesas_op = despesas_por_empresa.get(cd_emp, 0)
            lucro_liquido = lucro_bruto - despesas_op
            margem = (lucro_liquido / receita_liquida * 100) if receita_liquida > 0 else 0

            resultados.append({
                "cd_empresa": cd_emp,
                "nome": nomes_empresas.get(cd_emp, f"Empresa {cd_emp}"),
                "receita_bruta": receita_bruta,
                "devolucoes": devolucoes_val,
                "receita_liquida": receita_liquida,
                "cmv": cmv,
                "lucro_bruto": lucro_bruto,
                "despesas_operacionais": despesas_op,
                "lucro_liquido": lucro_liquido,
                "margem_percentual": round(margem, 2)
            })

            totais["receita_bruta"] += receita_bruta
            totais["devolucoes"] += devolucoes_val
            totais["receita_liquida"] += receita_liquida
            totais["cmv"] += cmv
            totais["lucro_bruto"] += lucro_bruto
            totais["despesas_operacionais"] += despesas_op
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
    2: "LIEBE MARAPONGA",
    3: "LIEBE IGUATEMI",
    4: "LIEBE TABOSA",
    5: "LIEBE NORTH",
    6: "LIEBE DOM LUIS",
    7: "LIEBE PARANGABA",
    8: "LIEBE RIO MAR",
    10: "LIEBE BARRA SHOPPING - RJ",
    14: "LIEBE SALVADOR SHOPPING - BA",
    15: "LIEBE MORUMBI SHOPPING",
    17: "LIEBE RIO MAR RECIFE",
    19: "LIEBE NORTH JOQUEI",
    20: "LIEBE PORTO ALEGRE",
    21: "LIEBE RIOMAR KENNEDY",
    22: "LIEBE INTIMATES",
    120: "LIEBE ECOMMERCE ANGELICA",
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
            # Todos: fabrica + lojas
            ccustos = CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys())
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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception as e:
            print(f"[DRE UNIFICADA] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Agrupar despesas por conta_dre e periodo
        valores_por_conta = {}
        nao_classificados = 0

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao_despesa = d.get('descricao_despesa')
            conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
            valor = -abs(float(d['valor'] or 0))
            dt_emissao = d['dt_emissao']

            if conta == 'NAO_CLASSIFICADO':
                nao_classificados += 1

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

        # CMV Lojas (mv_cmv_loja) - AGREGADO por mes
        if usar_cmv_loja:
            try:
                ccustos_lojas_filtro = [c for c in ccustos if c in CCUSTOS_LOJAS]
                if ccustos_lojas_filtro:
                    ccusto_placeholders_loja = ",".join(["%s"] * len(ccustos_lojas_filtro))
                    query_cmv_loja = f"""
                        SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
                        FROM mv_cmv_loja
                        WHERE data >= %s
                          AND data <= %s
                          AND idcentrodecusto IN ({ccusto_placeholders_loja})
                        GROUP BY DATE_TRUNC('month', data)
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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception as e:
            print(f"[DRE UNIFICADA DUPLICATAS] Aviso: {e}")

        # Encontrar cd_despesaitem que mapeiam para esta conta
        itens_conta = []
        for cd_item, cd_conta in MAPEAMENTO_DESPESA_DRE.items():
            if cd_conta == conta or cd_conta.startswith(conta + '.'):
                itens_conta.append(cd_item)
        for cd_item, cd_conta in classificacoes_db.items():
            if cd_conta == conta or cd_conta.startswith(conta + '.'):
                if cd_item not in itens_conta:
                    itens_conta.append(cd_item)

        # Verificar se ha regras de descricao que mapeiam para esta conta
        # Se sim, precisamos buscar por descricao tambem (nao apenas por cd_despesaitem)
        tem_regra_descricao = False
        for desc, cd_conta in REGRAS_DESCRICAO_DRE:
            if cd_conta == conta or cd_conta.startswith(conta + '.'):
                tem_regra_descricao = True
                break

        # Se nao tem itens e nao tem regra de descricao, retorna vazio
        if not itens_conta and not tem_regra_descricao:
            return {"duplicatas": [], "total": 0, "conta": conta, "periodo": periodo}

        # Coletar descricoes que mapeiam para esta conta (para busca por LIKE)
        descricoes_conta = []
        for desc, cd_conta in REGRAS_DESCRICAO_DRE:
            if cd_conta == conta or cd_conta.startswith(conta + '.'):
                descricoes_conta.append(desc)

        # Buscar duplicatas
        ccusto_placeholders = ",".join(["%s"] * len(ccustos))

        # Construir clausula WHERE dinamicamente
        where_conditions = []
        params = [primeiro_dia, data_fim]

        if itens_conta:
            itens_placeholders = ",".join(["%s"] * len(itens_conta))
            where_conditions.append(f"d.cd_despesaitem IN ({itens_placeholders})")
            params.extend(itens_conta)

        if descricoes_conta:
            desc_conditions = []
            for desc in descricoes_conta:
                desc_conditions.append("UPPER(i.ds_despesaitem) LIKE %s")
                params.append(f"%{desc}%")
            where_conditions.append(f"({' OR '.join(desc_conditions)})")

        if not where_conditions:
            return {"duplicatas": [], "total": 0, "conta": conta, "periodo": periodo}

        # Unir condicoes com OR (itens OU descricoes)
        items_or_desc = " OR ".join(where_conditions) if len(where_conditions) > 1 else where_conditions[0]

        params.extend(ccustos)

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
                d.cd_fornecedor
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN vr_gec_ccusto cc ON cc.cd_ccusto = d.cd_ccusto
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND ({items_or_desc})
              AND d.cd_ccusto IN ({ccusto_placeholders})
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
                classificacoes_db,
                classificacoes_desc_db
            )

            # Verificar se este registro realmente pertence a conta solicitada
            if conta_classificada != conta and not conta_classificada.startswith(conta + '.'):
                # Este registro foi reclassificado para outra conta, ignorar
                continue

            total += valor
            duplicatas.append({
                "id": row['nr_duplicata'],
                "cdDespesaItem": row['cd_despesaitem'],
                "descricao": descricao,
                "dtEmissao": row['dt_emissao'].strftime('%Y-%m-%d') if row['dt_emissao'] else None,
                "dtVencimento": row['dt_vencimento'].strftime('%Y-%m-%d') if row['dt_vencimento'] else None,
                "valor": valor,
                "cdCCusto": row['cd_ccusto'],
                "nomeCCusto": row['nome_ccusto'],
                "cdFornecedor": row['cd_fornecedor']
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


@router.get("/api/dre/unificada/sintetico")
def get_dre_unificada_sintetico(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna visao sintetica da DRE com metricas principais por centro de custo.
    Mostra: Receita Liquida, CMV, Margem de Contribuicao, EBITDA, Lucro Liquido
    """
    try:
        print(f"[INFO] Buscando DRE SINTETICO: {dataInicio} ate {dataFim}")

        # Lista de todos os centros de custo (fabrica + lojas)
        todos_ccustos = []

        # Adicionar fabrica como um unico item
        todos_ccustos.append({
            "codigo": "fabrica",
            "nome": "FABRICA",
            "ccustos": CCUSTOS_FABRICA,
            "tipo": "fabrica"
        })

        # Adicionar cada loja individualmente
        for cd_ccusto in sorted(CCUSTOS_LOJAS.keys()):
            todos_ccustos.append({
                "codigo": str(cd_ccusto),
                "nome": CCUSTOS_LOJAS[cd_ccusto],
                "ccustos": [cd_ccusto],
                "tipo": "loja"
            })

        resultados = []
        totais = {
            "receitaLiquida": 0,
            "cmv": 0,
            "margemContribuicao": 0,
            "despesasOperacionais": 0,
            "ebitda": 0,
            "lucroLiquido": 0
        }

        # Buscar classificacoes uma vez
        classificacoes_db = {}
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception as e:
            print(f"[SINTETICO] Aviso: {e}")

        # Processar cada centro de custo
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
                  AND d.dt_emissao <= %s
                  AND d.tp_situacao = 'N'
                  AND d.cd_ccusto IN ({ccusto_placeholders})
                  AND d.cd_ccusto NOT IN ({",".join(["%s"] * len(CCUSTOS_EXCLUIDOS_FABRICA))})
                GROUP BY d.cd_despesaitem, i.ds_despesaitem
            """
            despesas = execute_query(query_despesas, (dataInicio, dataFim, *ccustos, *CCUSTOS_EXCLUIDOS_FABRICA))

            # Agrupar despesas por grupo
            despesas_operacionais = 0
            despesas_financeiras = 0
            despesas_tributarias = 0

            for d in despesas:
                cd_despesaitem = d['cd_despesaitem']
                descricao_despesa = d.get('descricao_despesa')
                conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
                valor = float(d['valor'] or 0)

                if conta.startswith('08'):
                    despesas_operacionais += valor
                elif conta.startswith('10'):
                    despesas_financeiras += valor
                elif conta.startswith('13'):
                    despesas_tributarias += valor

            # Vendas
            receita_bruta = 0
            devolucoes = 0

            # IMPORTANTE: Para lojas, cd_empresa = idcentrodecusto (mesmos codigos)
            if item["tipo"] == "fabrica":
                empresas_filtro = [1]
            else:
                # Usar os proprios ccustos como cd_empresa (pois sao iguais para lojas)
                empresas_filtro = [c for c in ccustos if c not in EMPRESAS_EXCLUIDAS]

            if empresas_filtro:
                empresa_placeholders = ",".join(["%s"] * len(empresas_filtro))

                # Vendas
                query_vendas = f"""
                    SELECT SUM(t.vl_transacao) as valor
                    FROM vr_tra_transacao t
                    WHERE t.dt_transacao >= %s
                      AND t.dt_transacao <= %s
                      AND t.tp_situacao = 4
                      AND t.cd_empresa IN ({empresa_placeholders})
                      AND t.tp_modalidade IN ('4')
                      AND t.tp_operacao = 'S'
                """
                result_vendas = execute_query(query_vendas, (dataInicio, dataFim, *empresas_filtro))
                if result_vendas and result_vendas[0]['valor']:
                    receita_bruta = float(result_vendas[0]['valor'])

                # Devolucoes
                query_devolucoes = f"""
                    SELECT SUM(t.vl_transacao) as valor
                    FROM vr_tra_transacao t
                    WHERE t.dt_transacao >= %s
                      AND t.dt_transacao <= %s
                      AND t.tp_situacao = 4
                      AND t.cd_empresa IN ({empresa_placeholders})
                      AND t.tp_modalidade IN ('3')
                      AND t.tp_operacao = 'E'
                """
                result_devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim, *empresas_filtro))
                if result_devolucoes and result_devolucoes[0]['valor']:
                    devolucoes = abs(float(result_devolucoes[0]['valor']))

            # CMV
            cmv = 0
            if item["tipo"] == "fabrica":
                try:
                    query_cmv = """
                        SELECT SUM(ABS(valor)) as total
                        FROM mv_cmv_fab
                        WHERE data >= %s AND data <= %s
                    """
                    result = execute_query(query_cmv, (dataInicio, dataFim))
                    if result and result[0]['total']:
                        cmv = abs(float(result[0]['total']))
                except:
                    pass
            else:
                try:
                    ccusto_ph = ",".join(["%s"] * len(ccustos))
                    query_cmv = f"""
                        SELECT SUM(ABS(valor)) as total
                        FROM mv_cmv_loja
                        WHERE data >= %s
                          AND data <= %s
                          AND idcentrodecusto IN ({ccusto_ph})
                    """
                    result = execute_query(query_cmv, (dataInicio, dataFim, *ccustos))
                    if result and result[0]['total']:
                        cmv = abs(float(result[0]['total']))
                except:
                    pass

            # Calcular metricas
            receita_liquida = receita_bruta - devolucoes
            margem_contribuicao = receita_liquida - cmv
            ebitda = margem_contribuicao - despesas_operacionais
            lucro_liquido = ebitda - despesas_financeiras - despesas_tributarias

            # Calcular percentuais
            margem_pct = (margem_contribuicao / receita_liquida * 100) if receita_liquida > 0 else 0
            ebitda_pct = (ebitda / receita_liquida * 100) if receita_liquida > 0 else 0

            resultado = {
                "codigo": item["codigo"],
                "nome": item["nome"],
                "tipo": item["tipo"],
                "receitaBruta": receita_bruta,
                "devolucoes": devolucoes,
                "receitaLiquida": receita_liquida,
                "cmv": cmv,
                "margemContribuicao": margem_contribuicao,
                "margemPct": round(margem_pct, 1),
                "despesasOperacionais": despesas_operacionais,
                "ebitda": ebitda,
                "ebitdaPct": round(ebitda_pct, 1),
                "despesasFinanceiras": despesas_financeiras,
                "despesasTributarias": despesas_tributarias,
                "lucroLiquido": lucro_liquido
            }

            resultados.append(resultado)

            # Acumular totais
            totais["receitaLiquida"] += receita_liquida
            totais["cmv"] += cmv
            totais["margemContribuicao"] += margem_contribuicao
            totais["despesasOperacionais"] += despesas_operacionais
            totais["ebitda"] += ebitda
            totais["lucroLiquido"] += lucro_liquido

        # Calcular percentuais dos totais
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
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
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
                conta = _classificar_conta_dre(cd_despesaitem, descricao_despesa, classificacoes_db, classificacoes_desc_db)
                valor = -float(d['valor'] or 0)

                if conta not in valores_conta:
                    valores_conta[conta] = 0
                valores_conta[conta] += valor

            # CMV
            try:
                query_cmv = """
                    SELECT SUM(ABS(valor)) as total
                    FROM mv_cmv_loja
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
    cdEmpresa: int = Query(..., description="Codigo da empresa")
):
    """
    Retorna duplicatas de uma conta DRE especifica para uma empresa.
    """
    try:
        print(f"[DUPLICATAS] Buscando conta={conta}, empresa={cdEmpresa}, periodo={dataInicio} a {dataFim}")

        # Carregar classificacoes do banco
        classificacoes_db = {}
        classificacoes_desc_db = {}
        try:
            rows = execute_query("SELECT cd_despesaitem, ds_despesaitem, conta_dre FROM classificacao_despesas_dre", ())
            for row in rows or []:
                cd = row.get('cd_despesaitem')
                ds = row.get('ds_despesaitem')
                conta_dre = row.get('conta_dre', '')
                if cd and conta_dre:
                    codigo = conta_dre.split(' ')[0] if ' ' in conta_dre else conta_dre
                    classificacoes_db[cd] = codigo
                    if ds:
                        classificacoes_desc_db[_normalizar_texto(ds)] = codigo
        except Exception as e:
            print(f"[DUPLICATAS] Aviso: nao foi possivel carregar classificacoes: {e}")

        # Filtrar por cd_empresa (igual ao endpoint /api/dre/por-empresa)
        # Buscar despesas que se encaixam na conta solicitada
        query = """
            SELECT
                d.cd_despesaduplicata as id,
                d.cd_despesaitem,
                i.ds_despesaitem as descricao,
                d.dt_emissao,
                d.dt_vencimento,
                ABS(d.vl_rateio) as valor,
                d.cd_ccusto,
                d.cd_empresa,
                COALESCE(c.ds_ccusto, '') as nome_ccusto
            FROM vr_fcp_despduplicatai d
            JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
            LEFT JOIN vr_gec_ccusto c ON c.cd_ccusto = d.cd_ccusto
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_empresa = %s
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query, (dataInicio, dataFim, cdEmpresa))
        print(f"[DUPLICATAS] Total despesas encontradas para empresa {cdEmpresa}: {len(despesas)}")

        # Filtrar apenas despesas que correspondem a conta solicitada
        duplicatas = []
        total = 0
        contas_encontradas = set()

        for d in despesas:
            cd_despesaitem = d['cd_despesaitem']
            descricao = d.get('descricao')
            conta_classificada = _classificar_conta_dre(cd_despesaitem, descricao, classificacoes_db, classificacoes_desc_db)
            contas_encontradas.add(conta_classificada)

            # Verificar se a conta classificada corresponde a conta solicitada
            # Aceitar conta exata OU conta que comeca com o codigo solicitado
            if conta_classificada == conta or conta_classificada.startswith(conta + '.') or conta.startswith(conta_classificada + '.'):
                valor = float(d['valor'] or 0)
                total += valor
                duplicatas.append({
                    "id": d['id'],
                    "cdDespesaItem": cd_despesaitem,
                    "descricao": descricao,
                    "dtEmissao": d['dt_emissao'].isoformat() if d['dt_emissao'] else None,
                    "dtVencimento": d['dt_vencimento'].isoformat() if d.get('dt_vencimento') else None,
                    "valor": -valor,
                    "cdCCusto": d['cd_ccusto'],
                    "nomeCCusto": d['nome_ccusto']
                })

        # Log para debug - mostrar contas encontradas que contem o prefixo buscado
        contas_relevantes = [c for c in contas_encontradas if c.startswith(conta[:5]) or conta.startswith(c[:5])]
        print(f"[DUPLICATAS] Conta buscada: {conta}")
        print(f"[DUPLICATAS] Contas relevantes encontradas: {sorted(contas_relevantes)[:20]}")
        print(f"[DUPLICATAS] Encontradas {len(duplicatas)} duplicatas, total: {total:.2f}")

        return {
            "duplicatas": duplicatas,
            "total": -total,
            "conta": conta,
            "cdEmpresa": cdEmpresa
        }

    except Exception as e:
        print(f"[ERROR] Erro ao buscar duplicatas por empresa: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
