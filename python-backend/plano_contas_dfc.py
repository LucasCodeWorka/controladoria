# Plano de contas do DFC (regime de caixa), definido pela consultoria
# contabil externa da empresa (documento CONFIGDFC, agosto/2026).
#
# Estrutura de 2 niveis, independente do plano de contas da DRE:
#   Nivel 1 (GRUPO): OPERACIONAIS / INVESTIMENTOS / FINANCIAMENTO
#   Nivel 2 (SUBGRUPO): categorias de despesa/receita dentro de cada grupo
#
# Cada despesa (cd_despesaitem) e classificada em um SUBGRUPO via a tabela
# classificacao_despesas_dfc (coluna conta_dfc = codigo do subgrupo, ex: "OP.01").

PLANO_CONTAS_DFC = [
    {
        'codigo': 'OP',
        'nome': 'DESPESAS OPERACIONAIS',
        'subgrupos': [
            {'codigo': 'OP.01', 'nome': 'CUSTOS COM MATÉRIA PRIMA'},
            {'codigo': 'OP.02', 'nome': 'CUSTO COM MERCADORIA'},
            {'codigo': 'OP.03', 'nome': 'DESPESAS COM FOLHA'},
            {'codigo': 'OP.04', 'nome': 'CUSTOS COM FOLHA OPERACIONAL'},
            {'codigo': 'OP.05', 'nome': 'DESPESAS COM PESSOAL ADMINISTRAÇÃO E LOJAS'},
            {'codigo': 'OP.06', 'nome': 'DESPESAS ADMINISTRATIVAS'},
            {'codigo': 'OP.07', 'nome': 'DESPESAS COM MARKETING'},
            {'codigo': 'OP.08', 'nome': 'DESPESAS COM VENDAS'},
            {'codigo': 'OP.09', 'nome': 'GASTOS GERAIS DE FABRICAÇÃO'},
            {'codigo': 'OP.10', 'nome': 'DESPESAS FINANCEIRAS'},
            {'codigo': 'OP.11', 'nome': 'IMPOSTOS SOBRE VENDAS'},
            {'codigo': 'OP.12', 'nome': 'DESPESAS COM OCUPAÇÃO'},
            {'codigo': 'OP.13', 'nome': 'DESPESAS BANCÁRIAS'},
            {'codigo': 'OP.14', 'nome': 'DESPESAS COM DIRETORIA'},
            {'codigo': 'OP.15', 'nome': 'DESPESAS SOBRE LUCRO'},
            {'codigo': 'OP.16', 'nome': 'DESPESAS COM VEÍCULOS'},
            {'codigo': 'OP.17', 'nome': 'DESPESAS COMERCIAIS'},
            {'codigo': 'OP.18', 'nome': 'CUSTOS COM IMPOSTOS DIRETOS'},
            {'codigo': 'OP.19', 'nome': 'ENDIVIDAMENTO TRIBUTÁRIO'},
            {'codigo': 'OP.20', 'nome': 'DESPESAS COM CRÉDITO E COBRANÇA'},
            {'codigo': 'OP.21', 'nome': 'DESPESAS COM MANUTENÇÃO'},
            {'codigo': 'OP.22', 'nome': 'DESPESAS COM DEPRECIAÇÃO'},
            {'codigo': 'OP.23', 'nome': 'DEVOLUÇÕES'},
            {'codigo': 'OP.24', 'nome': 'DESPESAS COM PERDAS'},
            {'codigo': 'OP.25', 'nome': 'OFICINAS'},
        ],
    },
    {
        'codigo': 'INV',
        'nome': 'INVESTIMENTOS',
        'subgrupos': [
            {'codigo': 'INV.01', 'nome': 'INVESTIMENTOS'},
            {'codigo': 'INV.02', 'nome': 'BENS IMOBILIZADOS'},
        ],
    },
    {
        'codigo': 'FIN',
        'nome': 'FINANCIAMENTO',
        'subgrupos': [
            {'codigo': 'FIN.01', 'nome': 'FINANCIAMENTO'},
            {'codigo': 'FIN.02', 'nome': 'AMORTIZAÇÃO E DÍVIDAS'},
        ],
    },
]


def subgrupos_validos() -> set:
    return {s['codigo'] for g in PLANO_CONTAS_DFC for s in g['subgrupos']}


def grupo_de_subgrupo(codigo_subgrupo: str) -> str:
    return codigo_subgrupo.split('.')[0]


# Grupo de RECEITA (entradas de caixa), separado do plano de despesas acima.
# Nao vem de classificacao de despesa (cd_despesaitem) - vem de vr_fcr_faturai
# (recebimentos por tipo de documento, regime de caixa - dt_baixa) e de
# vr_tra_transacao (devolucoes). Por isso fica fora de PLANO_CONTAS_DFC/
# subgrupos_validos: nenhuma despesa pode ser classificada nesses codigos.
#
# Os subgrupos de recebimento (DINHEIRO, e futuramente cartao/pix/boleto etc,
# um por tp_documento de vr_fcr_faturai) vao de REC.01 a REC.90 - a
# consultoria vai mandando os tp_documento aos poucos, entao o total desse
# grupo fica temporariamente MENOR que a receita bruta real ate todos os
# tipos serem mapeados. REC.99 (devolucoes) fica sempre por ultimo, fora
# dessa faixa, pra nao precisar renumerar quando um tipo novo for adicionado.
#
# RECEBIMENTOS_TIPOS_DOCUMENTO abaixo mapeia cada subgrupo aos tp_documento que
# o compoem (positivos somam, negativos subtraem - ex: troco).
RECEBIMENTOS_TIPOS_DOCUMENTO = {
    'REC.01': {'soma': [3], 'subtrai': [9]},  # 3 = dinheiro, 9 = troco
    'REC.02': {'soma': [2], 'subtrai': []},   # 2 = cheque
    'REC.03': {'soma': [1], 'subtrai': []},   # 1 = fatura/boleto
}

# Recebimentos cuja dt_baixa nunca vem preenchida na fonte (o titulo nao e
# "baixado" formalmente no sistema) - o cartao de credito e o caso: o valor
# usado e vl_fatura (nao vl_pago, que fica zerado) e a data de entrada no
# caixa e CONSTRUIDA a partir da dt_emissao, somando dias uteis (a operadora
# liquida em D+2 uteis; sabado/domingo empurram pro proximo dia util).
RECEBIMENTOS_DATA_CONSTRUIDA = {
    'REC.04': {'tp_documento': 4, 'tp_cobranca': 14, 'dias_uteis': 2},   # cartao de credito
    'REC.05': {'tp_documento': 5, 'tp_cobranca': 14, 'dias_uteis': 1},   # cartao de debito
    'REC.06': {'tp_documento': 26, 'tp_cobranca': None, 'dias_uteis': 0},  # pix (liquidacao instantanea, mesmo dia)
}

CODIGO_DEVOLUCOES_RECEITA = 'REC.99'

PLANO_RECEITA_DFC = [
    {
        'codigo': 'REC',
        'nome': 'RECEITA OPERACIONAL',
        'subgrupos': [
            {'codigo': 'REC.01', 'nome': 'DINHEIRO'},
            {'codigo': 'REC.02', 'nome': 'CHEQUE'},
            {'codigo': 'REC.03', 'nome': 'FATURA/BOLETO'},
            {'codigo': 'REC.04', 'nome': 'CARTÃO DE CRÉDITO'},
            {'codigo': 'REC.05', 'nome': 'CARTÃO DE DÉBITO'},
            {'codigo': 'REC.06', 'nome': 'PIX'},
            {'codigo': CODIGO_DEVOLUCOES_RECEITA, 'nome': 'DEVOLUÇÕES DE VENDAS'},
        ],
    },
]
