from database import execute_query
from typing import List
from datetime import datetime


def gerar_periodos(data_inicio: str, data_fim: str) -> List[str]:
    inicio = datetime.strptime(data_inicio, '%Y-%m-%d')
    fim = datetime.strptime(data_fim, '%Y-%m-%d')

    periodos = []
    atual = inicio.replace(day=1)

    while atual <= fim:
        periodos.append(atual.strftime('%Y-%m'))
        if atual.month == 12:
            atual = atual.replace(year=atual.year + 1, month=1)
        else:
            atual = atual.replace(month=atual.month + 1)

    return periodos


def formatar_label_periodo(periodo: str) -> str:
    meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
             'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
    ano, mes = periodo.split('-')
    return f"{meses[int(mes) - 1]}-{ano}"


def fetch_centros_custo() -> List[int]:
    query = """
        SELECT DISTINCT cd_ccusto
        FROM vr_fcp_despduplicatai
        WHERE cd_ccusto IS NOT NULL
        ORDER BY cd_ccusto
    """
    result = execute_query(query)
    return [row['cd_ccusto'] for row in result]
