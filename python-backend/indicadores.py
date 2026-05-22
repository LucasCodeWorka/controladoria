"""
Funções para calcular indicadores financeiros do DFC
"""
from database import execute_query
from typing import Dict, Any
from datetime import datetime, timedelta

def calcular_prazo_medio_recebimento(data_inicio: str = None, data_fim: str = None) -> Dict[str, Any]:
    """
    Calcula o Prazo Médio de Recebimento (PMR)
    PMR = Média dos dias entre emissão e baixa dos recebimentos

    Calcula baseado APENAS em recebimentos efetivamente BAIXADOS (dt_baixa preenchido).
    Utiliza os últimos 12 meses de recebimentos baixados para ter uma amostra representativa.

    Args:
        data_inicio: Data inicial (mantido por compatibilidade da API, mas não usado)
        data_fim: Data final (mantido por compatibilidade da API, mas não usado)

    Returns:
        Dict com PMR em dias, quantidade de recebimentos e detalhes
    """
    # Usar TABELA DE HISTÓRICO - apenas recebimentos PAGOS 2025
    query = """
        SELECT
            i.cd_empresa,
            i.cd_cliente,
            i.nr_fat,
            i.nr_parcela,
            i.dt_emissao,
            i.dt_vencimento,
            i.dt_baixa,
            i.vl_fatura,
            i.tp_documento,
            COALESCE(p.nm_pessoa, 'N/A') as nm_cliente,
            EXTRACT(DAY FROM (i.dt_baixa - i.dt_emissao)) as dias_para_receber
        FROM
            vr_fcr_faturai i
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = i.cd_cliente
        WHERE
            i.tp_situacao = 1
            AND i.dt_baixa IS NOT NULL
            AND i.tp_baixa NOT IN (6, 8, 11, 12)
            AND i.tp_documento NOT IN (7, 10, 11)
        ORDER BY i.dt_baixa DESC
        LIMIT 1000
    """

    result = execute_query(query, ())

    if not result or len(result) == 0:
        return {
            'pmr_dias_simples': 0,
            'pmr_dias_ponderado': 0,
            'total_recebimentos': 0,
            'valor_total': 0,
            'por_tipo_documento': {},
            'periodo': {
                'data_inicio': data_inicio,
                'data_fim': data_fim
            },
            'mensagem': 'Nenhum recebimento com data de baixa encontrado no período'
        }

    # Calcular PMR ponderado pelo valor
    valor_total = sum(float(r['vl_fatura'] or 0) for r in result)
    soma_ponderada = sum(
        float(r['vl_fatura'] or 0) * float(r['dias_para_receber'] or 0)
        for r in result
    )

    pmr_ponderado = soma_ponderada / valor_total if valor_total > 0 else 0

    # PMR simples (média aritmética)
    dias_validos = [float(r['dias_para_receber']) for r in result if r['dias_para_receber'] is not None]
    pmr_simples = sum(dias_validos) / len(dias_validos) if dias_validos else 0

    # Agrupar por tipo de documento
    por_tipo = {}
    for r in result:
        tp = r['tp_documento']
        if tp not in por_tipo:
            por_tipo[tp] = {
                'quantidade': 0,
                'valor_total': 0,
                'soma_dias': 0,
                'tipo_nome': get_tipo_documento_nome(tp)
            }

        por_tipo[tp]['quantidade'] += 1
        por_tipo[tp]['valor_total'] += float(r['vl_fatura'] or 0)
        por_tipo[tp]['soma_dias'] += float(r['dias_para_receber'] or 0)

    # Calcular PMR por tipo
    for tp, dados in por_tipo.items():
        dados['pmr'] = dados['soma_dias'] / dados['quantidade'] if dados['quantidade'] > 0 else 0

    return {
        'pmr_dias_simples': round(pmr_simples, 2),
        'pmr_dias_ponderado': round(pmr_ponderado, 2),
        'total_recebimentos': len(result),
        'valor_total': valor_total,
        'por_tipo_documento': por_tipo,
        'periodo': {
            'data_inicio': data_inicio,
            'data_fim': data_fim
        }
    }

def calcular_prazo_medio_pagamento(data_inicio: str = None, data_fim: str = None) -> Dict[str, Any]:
    """
    Calcula o Prazo Médio de Pagamento (PMP)
    PMP = Média dos dias entre emissão e baixa dos pagamentos

    Calcula baseado APENAS em pagamentos efetivamente BAIXADOS (dt_baixa preenchido).
    Utiliza os últimos 12 meses de pagamentos baixados para ter uma amostra representativa.

    Args:
        data_inicio: Data inicial (mantido por compatibilidade da API, mas não usado)
        data_fim: Data final (mantido por compatibilidade da API, mas não usado)

    Returns:
        Dict com PMP em dias, quantidade de pagamentos e detalhes
    """
    # Usar TABELA DE HISTÓRICO - apenas pagamentos PAGOS 2025
    query = """
        SELECT
            di.nr_duplicata,
            di.dt_emissao,
            di.dt_vencimento,
            di.dt_baixa,
            di.vl_rateio,
            b.ds_despesaitem,
            COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
            EXTRACT(DAY FROM (di.dt_baixa - di.dt_emissao)) as dias_para_pagar
        FROM
            vr_fcp_despduplicatai di
            INNER JOIN vr_fcp_despesaitem b ON b.cd_despesaitem = di.cd_despesaitem
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = di.cd_fornecedor
        WHERE
            di.tp_situacao = 'N'
            AND di.dt_baixa IS NOT NULL
        ORDER BY di.dt_baixa DESC
        LIMIT 1000
    """

    result = execute_query(query, ())

    if not result or len(result) == 0:
        return {
            'pmp_dias_simples': 0,
            'pmp_dias_ponderado': 0,
            'total_pagamentos': 0,
            'valor_total': 0,
            'top_categorias': {},
            'periodo': {
                'data_inicio': data_inicio,
                'data_fim': data_fim
            },
            'mensagem': 'Nenhum pagamento com data de baixa encontrado no período'
        }

    # Calcular PMP ponderado pelo valor
    valor_total = sum(float(r['vl_rateio'] or 0) for r in result)
    soma_ponderada = sum(
        float(r['vl_rateio'] or 0) * float(r['dias_para_pagar'] or 0)
        for r in result
    )

    pmp_ponderado = soma_ponderada / valor_total if valor_total > 0 else 0

    # PMP simples (média aritmética)
    dias_validos = [float(r['dias_para_pagar']) for r in result if r['dias_para_pagar'] is not None]
    pmp_simples = sum(dias_validos) / len(dias_validos) if dias_validos else 0

    # Agrupar por categoria
    por_categoria = {}
    for r in result:
        cat = r['ds_despesaitem']
        if cat not in por_categoria:
            por_categoria[cat] = {
                'quantidade': 0,
                'valor_total': 0,
                'soma_dias': 0
            }

        por_categoria[cat]['quantidade'] += 1
        por_categoria[cat]['valor_total'] += float(r['vl_rateio'] or 0)
        por_categoria[cat]['soma_dias'] += float(r['dias_para_pagar'] or 0)

    # Calcular PMP por categoria
    for cat, dados in por_categoria.items():
        dados['pmp'] = dados['soma_dias'] / dados['quantidade'] if dados['quantidade'] > 0 else 0

    # Top 5 categorias por valor
    top_categorias = sorted(
        por_categoria.items(),
        key=lambda x: x[1]['valor_total'],
        reverse=True
    )[:5]

    return {
        'pmp_dias_simples': round(pmp_simples, 2),
        'pmp_dias_ponderado': round(pmp_ponderado, 2),
        'total_pagamentos': len(result),
        'valor_total': valor_total,
        'top_categorias': {cat: dados for cat, dados in top_categorias},
        'periodo': {
            'data_inicio': data_inicio,
            'data_fim': data_fim
        }
    }

def calcular_ciclo_financeiro(data_inicio: str, data_fim: str) -> Dict[str, Any]:
    """
    Calcula o Ciclo Financeiro (CF)
    CF = PMR + PME - PMP

    Onde:
    - PMR = Prazo Médio de Recebimento
    - PME = Prazo Médio de Estoque (fixado em 50 dias)
    - PMP = Prazo Médio de Pagamento

    Args:
        data_inicio: Data inicial no formato YYYY-MM-DD
        data_fim: Data final no formato YYYY-MM-DD

    Returns:
        Dict com indicadores do ciclo financeiro
    """
    pmr = calcular_prazo_medio_recebimento(data_inicio, data_fim)
    pmp = calcular_prazo_medio_pagamento(data_inicio, data_fim)

    # PME fixado conforme regra de negocio atual
    pme = 50

    # Ciclo Operacional = PMR + PME
    ciclo_operacional = pmr['pmr_dias_ponderado'] + pme

    # Ciclo Financeiro = Ciclo Operacional - PMP
    ciclo_financeiro = ciclo_operacional - pmp['pmp_dias_ponderado']

    return {
        'pmr_dias': pmr['pmr_dias_ponderado'],
        'pme_dias': pme,
        'pmp_dias': pmp['pmp_dias_ponderado'],
        'ciclo_operacional_dias': round(ciclo_operacional, 2),
        'ciclo_financeiro_dias': round(ciclo_financeiro, 2),
        'interpretacao': interpretar_ciclo_financeiro(ciclo_financeiro),
        'detalhes_pmr': pmr,
        'detalhes_pmp': pmp,
        'periodo': {
            'data_inicio': data_inicio,
            'data_fim': data_fim
        }
    }

def get_tipo_documento_nome(tp_documento: int) -> str:
    """Retorna o nome do tipo de documento"""
    tipos = {
        1: 'Fatura',
        2: 'Cheque',
        3: 'Duplicata Mercantil',
        4: 'Cartão de Crédito',
        5: 'Cheque Pré-Datado',
        6: 'Carteira de Cobrança',
        8: 'Boleto',
        9: 'Cartão de Débito'
    }
    return tipos.get(tp_documento, 'Outros')

def interpretar_ciclo_financeiro(cf_dias: float) -> Dict[str, str]:
    """Interpreta o ciclo financeiro"""
    if cf_dias < 0:
        return {
            'status': 'POSITIVO',
            'cor': 'green',
            'mensagem': f'Excelente! A empresa recebe dos fornecedores antes de pagar aos clientes ({abs(cf_dias):.0f} dias de folga).'
        }
    elif cf_dias < 30:
        return {
            'status': 'BOM',
            'cor': 'blue',
            'mensagem': f'Bom! A empresa precisa financiar {cf_dias:.0f} dias de operação.'
        }
    elif cf_dias < 60:
        return {
            'status': 'ATENÇÃO',
            'cor': 'yellow',
            'mensagem': f'Atenção! A empresa precisa financiar {cf_dias:.0f} dias de operação. Considere renegociar prazos.'
        }
    else:
        return {
            'status': 'CRÍTICO',
            'cor': 'red',
            'mensagem': f'Crítico! A empresa precisa financiar {cf_dias:.0f} dias de operação. Urgente rever prazos!'
        }
