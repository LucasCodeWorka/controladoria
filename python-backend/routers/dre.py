from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime
from database import execute_query
import services
import unicodedata

router = APIRouter()


def _normalizar_texto(value: Optional[str]) -> str:
    if not value:
        return ""
    substitutions = {
        'Á': 'A', 'À': 'A', 'Ã': 'A', 'Â': 'A',
        'É': 'E', 'Ê': 'E',
        'Í': 'I',
        'Ó': 'O', 'Õ': 'O', 'Ô': 'O',
        'Ú': 'U',
        'Ç': 'C',
        'á': 'A', 'à': 'A', 'ã': 'A', 'â': 'A',
        'é': 'E', 'ê': 'E',
        'í': 'I',
        'ó': 'O', 'õ': 'O', 'ô': 'O',
        'ú': 'U',
        'ç': 'C',
    }
    text = "".join(substitutions.get(ch, ch) for ch in str(value))
    return " ".join(text.upper().strip().split())

def _normalizar_texto_v2(value: Optional[str]) -> str:
    if not value:
        return ""
    text = str(value).strip().upper()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(text.split())


_normalizar_texto = _normalizar_texto_v2


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
    ('SALARIO', '08.04.22'),
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
    ('RETIRADA - CAIRO', '17.01.09'),
    ('RETIRADA-THAIS', '17.01.10'),
    ('RETIRADA - GERLANO', '17.01.11'),
    ('RETIRADA - SHENIA', '17.01.12'),
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
    144: '08.04.22',  # SALARIOS A PAGAR
    7: '08.04.02',    # ALIMENTACAO
    9: '08.04.03',    # RESCISAO
    77: '08.04.18',   # MULTA RESCISORIA FGTS
    188: '08.04.25',  # VALE ALIMENTACAO
    90: '08.04.26',   # FERIAS
    6: '08.04.27',    # PREMIACOES FUNCIONARIOS
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
    5: '08.04.22',    # SALARIO PROD
    196: '08.04.04',  # INSS PROD
    192: '08.04.01',  # PREMIACOES FUNCIONARIOS PROD
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
    30: '17.01.09',   # RETIRADA - CAIRO
    162: '17.01.10',  # RETIRADA - THAIS
    57: '17.01.11',   # RETIRADA - GERLANO
    135: '17.01.12',  # RETIRADA - SHENIA
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
        print(f"[INFO] Buscando DRE: {dataInicio} até {dataFim}")
        import calendar

        # Gerar períodos mensais
        periodos = services.gerar_periodos(dataInicio, dataFim)

        # Buscar TODAS as despesas do período por DATA DE EMISSÃO
        # Buscamos direto da tabela vr_fcp_despduplicatai pois a view vw_fluxo_pagamentos
        # não tem a coluna dt_emissao e filtra apenas títulos não pagos
        query_despesas = """
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
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim))
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
        empresas_ids = None
        if empresas:
            try:
                empresas_ids = [int(e.strip()) for e in empresas.split(',') if e.strip()]
            except ValueError:
                raise HTTPException(status_code=400, detail="Parametro 'empresas' invalido. Use IDs separados por virgula.")
            if not empresas_ids:
                raise HTTPException(status_code=400, detail="Parametro 'empresas' invalido. Informe pelo menos um ID.")

        empresa_filter_sql = ""
        empresa_params = []
        if empresas_ids:
            placeholders = ",".join(["%s"] * len(empresas_ids))
            empresa_filter_sql = f" AND t.cd_empresa IN ({placeholders})"
            empresa_params = empresas_ids

        base_where_common = f"""
            t.dt_transacao >= %s
            AND t.dt_transacao <= %s
            AND t.tp_situacao = 4
            {empresa_filter_sql}
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

        params = [dataInicio, dataFim] + empresa_params
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
        cmv_loja_raw = execute_query("""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja WHERE data >= %s AND data <= %s
            GROUP BY DATE_TRUNC('month', data)
        """, (dataInicio, dataFim))

        cmv_fab_raw = execute_query("""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_fab WHERE data >= %s AND data <= %s
            GROUP BY DATE_TRUNC('month', data)
        """, (dataInicio, dataFim))

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
        query_despesas = """
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
            ORDER BY d.dt_emissao
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim))

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
        query_despesas = """
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
        """

        despesas = execute_query(query_despesas, (dataInicio, dataFim))
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
        query_vendas = """
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
            GROUP BY t.cd_empresa
        """

        query_devolucoes = """
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as valor
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('3')
              AND t.tp_operacao = 'E'
            GROUP BY t.cd_empresa
        """

        vendas = execute_query(query_vendas, (dataInicio, dataFim))
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim))

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
        cmv_loja_raw = execute_query("""
            SELECT idcentrodecusto AS cd_empresa, ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja WHERE data >= %s AND data <= %s
            GROUP BY idcentrodecusto
        """, (dataInicio, dataFim))

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

        # Buscar vendas por empresa (Receita Bruta)
        query_vendas = """
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as receita_bruta
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
            GROUP BY t.cd_empresa
        """
        vendas = execute_query(query_vendas, (dataInicio, dataFim))
        receita_por_empresa = {r['cd_empresa']: float(r['receita_bruta'] or 0) for r in vendas}

        # Buscar devoluções por empresa
        query_devolucoes = """
            SELECT
                t.cd_empresa,
                SUM(t.vl_transacao) as devolucoes
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('3')
              AND t.tp_operacao = 'E'
            GROUP BY t.cd_empresa
        """
        devolucoes = execute_query(query_devolucoes, (dataInicio, dataFim))
        devolucoes_por_empresa = {r['cd_empresa']: float(r['devolucoes'] or 0) for r in devolucoes}

        # Buscar CMV por empresa (lojas)
        cmv_loja_raw = execute_query("""
            SELECT idcentrodecusto AS cd_empresa, ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja WHERE data >= %s AND data <= %s
            GROUP BY idcentrodecusto
        """, (dataInicio, dataFim))
        cmv_por_empresa = {r['cd_empresa']: float(r['cmv'] or 0) for r in cmv_loja_raw}

        # Buscar despesas por empresa
        query_despesas = """
            SELECT
                d.cd_empresa,
                SUM(ABS(d.vl_rateio)) as total_despesas
            FROM vr_fcp_despduplicatai d
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
            GROUP BY d.cd_empresa
        """
        despesas = execute_query(query_despesas, (dataInicio, dataFim))
        despesas_por_empresa = {r['cd_empresa']: float(r['total_despesas'] or 0) for r in despesas}

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
