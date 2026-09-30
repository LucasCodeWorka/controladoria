"""
Balanco Patrimonial - Ativos e Passivo, calculados sob demanda (sem cache),
ja que ainda esta em construcao (cada linha vai sendo ligada aqui aos poucos,
por pedido do usuario - ate la o resto fica zerado no frontend).

Convencao de sinal: valores do Passivo vem NEGATIVOS (mesmo padrao do
anexo/modelo da tela), Ativo vem POSITIVO.
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date, timedelta
from database import execute_query
from routers.dre import FILTRO_DUPLICATAS_EXCLUIDAS_SQL, PARAMS_DUPLICATAS_EXCLUIDAS

router = APIRouter()


def _somar_meses(ano: int, mes: int, delta: int) -> tuple:
    m = mes - 1 + delta
    return ano + m // 12, m % 12 + 1


def _janela_12_meses(mes_referencia: str) -> tuple:
    """(data_inicio, data_fim) = os proximos 12 meses a partir do 1o dia do
    mes de referencia (inclusive) - "Circulante ate 12 meses": se filtrar
    setembro/2026, olha de 01/09/2026 ate 31/08/2027."""
    ano_ref, mes_ref = (int(p) for p in mes_referencia.split("-"))
    data_inicio = date(ano_ref, mes_ref, 1)
    ano_fim, mes_fim = _somar_meses(ano_ref, mes_ref, 12)
    data_fim = date(ano_fim, mes_fim, 1) - timedelta(days=1)
    return data_inicio.isoformat(), data_fim.isoformat()


def _somar_duplicatas_por_vencimento(despesaitens: list, data_inicio: str, data_fim: str, empresas: Optional[str]) -> float:
    """Soma ABS(vl_rateio) das duplicatas (tp_situacao = 'N') de uma lista
    de cd_despesaitem, com VENCIMENTO na janela dada - respeita o filtro de
    empresas da tela quando informado (sem ele, soma todas)."""
    if not despesaitens:
        return 0.0

    clausula_empresa = ""
    params_empresa: tuple = ()
    if empresas:
        lista_empresas = [int(e.strip()) for e in empresas.split(",") if e.strip()]
        if lista_empresas:
            clausula_empresa = " AND d.cd_ccusto = ANY(%s)"
            params_empresa = (lista_empresas,)

    row = execute_query(f"""
        SELECT SUM(ABS(d.vl_rateio)) AS total
        FROM vr_fcp_despduplicatai d
        WHERE d.dt_vencimento >= %s AND d.dt_vencimento <= %s
          AND d.tp_situacao = 'N'
          AND d.cd_despesaitem = ANY(%s)
          AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}{clausula_empresa}
    """, (data_inicio, data_fim, despesaitens, *PARAMS_DUPLICATAS_EXCLUIDAS, *params_empresa))

    return float((row[0]["total"] if row else 0) or 0)


@router.get("/api/balanco-patrimonial/dados")
def get_balanco_patrimonial(
    mesReferencia: str = Query(..., description="Mes de referencia YYYY-MM"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa/cd_ccusto separados por virgula (default: todas)")
):
    """
    Valores ja calculados do Balanco Patrimonial - so as linhas ja ligadas
    aparecem no dict devolvido (o resto continua zerado no frontend). Cada
    nova linha vai sendo adicionada aqui aos poucos.
    """
    try:
        valores: dict = {}

        data_inicio, data_fim = _janela_12_meses(mesReferencia)

        # PC.2 - Obrigacoes de Compra de MP. e Serv. (Passivo Circulante,
        # ate 12 meses): duplicatas de despesa classificadas como "Custos
        # com Materia Prima" (OP.01) ou "Custo com Mercadoria" (OP.02) no
        # plano de contas do DFC, com VENCIMENTO dentro da janela de 12
        # meses a partir do mes filtrado (nao emissao, que e o que a DRE
        # usa - aqui e o que ainda esta/vai ficar em aberto pra pagar).
        rows_classificacao = execute_query(
            "SELECT cd_despesaitem FROM classificacao_despesas_dfc WHERE conta_dfc IN ('OP.01', 'OP.02')", ()
        ) or []
        despesaitens_mp_mercadoria = [r["cd_despesaitem"] for r in rows_classificacao]
        total_mp_mercadoria = _somar_duplicatas_por_vencimento(despesaitens_mp_mercadoria, data_inicio, data_fim, empresas)
        if despesaitens_mp_mercadoria:
            valores["PC.2"] = -total_mp_mercadoria

        # PC.3 - Emprestimos, Financiamentos e Debentures (Passivo
        # Circulante, ate 12 meses): so o cd_despesaitem 114 (EMPRESTIMO
        # PRINCIPAL) - confirmado com o usuario que e so esse, NAO o 148
        # (EMPRESTIMO MUTUO, classificado junto em FIN.02 no DFC) nem o
        # FIN.01 (que apesar do nome "FINANCIAMENTO" no plano de contas do
        # DFC, na pratica so tem despesa pessoal de socio classificada la -
        # "CASAMENTO CIVIL/RELIGIOSO THAIS", "REFORMA VICENTE 2025"). Nao
        # existe nenhum item de despesa com "DEBENTURE" no cadastro.
        DESPESAITEM_EMPRESTIMO_PRINCIPAL = [114]
        total_emprestimo = _somar_duplicatas_por_vencimento(DESPESAITEM_EMPRESTIMO_PRINCIPAL, data_inicio, data_fim, empresas)
        valores["PC.3"] = -total_emprestimo

        return {"valores": valores, "mesReferencia": mesReferencia}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar balanco patrimonial: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar balanco patrimonial: {str(e)}")
