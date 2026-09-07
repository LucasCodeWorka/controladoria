"""
Estoque por tempo - quanto do estoque atual (em quantidade e em qtde de
SKUs) esta parado ha mais de 3 e mais de 6 meses, por loja/fabrica.

Complementa o Giro: giro e uma media (estoque/venda), que pode esconder
estoque morto misturado com produtos que vendem bem. Aqui a analise e
direta - qual produto esta parado e ha quanto tempo, informacao acionavel
(candidato a liquidacao/transferencia).

"Parado ha X meses" = tempo desde a ULTIMA MOVIMENTACAO do saldo
(prd_prdsaldo.dt_saldo) - nao e um controle de lote FIFO (nao sabemos se as
unidades atuais sao as mais antigas do produto), e sim "esse saldo nao
mudou - nem entrou nem saiu nada - ha X dias". E o proxy disponivel sem um
controle de lote mais profundo, e o mesmo dado ja usado (e validado) no
Giro pra estoque atual.

Sempre ao vivo, sem cache: a query e a mesma do Giro (prd_prdsaldo, tabela
base) SEM a parte de venda (que e o que precisa das views lentas no Giro) -
~15-35s pra todas as empresas de uma vez, rapido o suficiente pra rodar na
hora do "Consultar".
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date
from database import execute_query
from routers.cmv_detalhado import EMPRESAS_CMV_DETALHADO, _nome_empresa_cmv, _eh_fabrica
from routers.giro import _padroes_produto_excluidos

router = APIRouter()

DIAS_3_MESES = 91
DIAS_6_MESES = 182
TOP_N_PRODUTOS = 10


def _parse_empresas(empresas: Optional[str]) -> list:
    if not empresas:
        return list(EMPRESAS_CMV_DETALHADO)
    try:
        pedidas = [int(p.strip()) for p in empresas.split(",") if p.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Lista de empresas invalida: {empresas}")
    invalidas = [p for p in pedidas if p not in EMPRESAS_CMV_DETALHADO]
    if invalidas:
        raise HTTPException(status_code=400, detail=f"Empresa(s) invalida(s): {invalidas}")
    return pedidas


# Mesmo filtro de produto ja validado no Giro: exclui materia-prima/insumo
# sem cadastro (codigo >= 1000000) e itens que nao sao mercadoria de venda
# (sacola, cupom, gancheira, saquinho, display, expositor, farda, brinde...
# - ver TERMOS_PRODUTO_EXCLUIDOS em giro.py).
_QUERY_ESTOQUE_COM_IDADE = """
    SELECT s.cd_empresa, s.cd_produto, s.qt_saldo, s.dt_saldo
    FROM (
        SELECT DISTINCT ON (s.cd_empresa, s.cd_produto) s.cd_empresa, s.cd_produto, s.qt_saldo, s.dt_saldo
        FROM prd_prdsaldo s
        LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = s.cd_produto
        WHERE s.cd_saldo = 1 AND s.dt_saldo < CURRENT_DATE
          AND s.cd_empresa = ANY(%s)
          AND s.cd_produto < 1000000
          AND (p.produto IS NULL OR p.produto NOT ILIKE ALL(%s))
        ORDER BY s.cd_empresa, s.cd_produto, s.dt_saldo DESC
    ) s
    WHERE s.qt_saldo > 0
"""


@router.get("/api/estoque-tempo/dados")
def obter_estoque_tempo(
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """Estoque parado ha mais de 3 e mais de 6 meses (sem movimentacao),
    por empresa e top 10 produtos melhor/pior nesse quesito."""
    try:
        cd_empresas = _parse_empresas(empresas)
        hoje = date.today()

        linhas = execute_query(_QUERY_ESTOQUE_COM_IDADE, (cd_empresas, _padroes_produto_excluidos())) or []

        produtos_ids = execute_query(
            "SELECT cd_produto, referencia, produto FROM mv_prd_referencia_produto WHERE cd_produto = ANY(%s)",
            ([r["cd_produto"] for r in linhas],)
        ) if linhas else []
        nomes_produto = {p["cd_produto"]: p for p in produtos_ids}

        por_empresa: dict = {
            e: {"skusTotal": 0, "qtdTotal": 0.0, "skusAcima3m": 0, "qtdAcima3m": 0.0, "skusAcima6m": 0, "qtdAcima6m": 0.0}
            for e in cd_empresas
        }
        # Agregado por produto, somando as empresas selecionadas - base do
        # top 10 (dias parado = o mais recente entre as empresas, ou seja,
        # o produto so conta como "velho" se estiver parado em TODAS as
        # empresas onde tem estoque - mais justo que pegar o pior caso).
        por_produto: dict = {}

        for r in linhas:
            dias_parado = (hoje - r["dt_saldo"].date()).days
            qt = float(r["qt_saldo"])
            cd_empresa = r["cd_empresa"]
            cd_produto = r["cd_produto"]

            e = por_empresa[cd_empresa]
            e["skusTotal"] += 1
            e["qtdTotal"] += qt
            if dias_parado >= DIAS_3_MESES:
                e["skusAcima3m"] += 1
                e["qtdAcima3m"] += qt
            if dias_parado >= DIAS_6_MESES:
                e["skusAcima6m"] += 1
                e["qtdAcima6m"] += qt

            if cd_produto not in por_produto:
                por_produto[cd_produto] = {"qtd": 0.0, "diasParadoMin": dias_parado}
            por_produto[cd_produto]["qtd"] += qt
            por_produto[cd_produto]["diasParadoMin"] = min(por_produto[cd_produto]["diasParadoMin"], dias_parado)

        itens = []
        for cd_empresa in cd_empresas:
            e = por_empresa[cd_empresa]
            itens.append({
                "cdEmpresa": cd_empresa,
                "nome": _nome_empresa_cmv(cd_empresa),
                "tipo": "fabrica" if _eh_fabrica(cd_empresa) else "loja",
                **e,
            })

        itens_fabrica = [i for i in itens if i["tipo"] == "fabrica"]
        itens_lojas = [i for i in itens if i["tipo"] == "loja"]

        def _consolidar(lista):
            if not lista:
                return None
            return {
                "skusTotal": sum(i["skusTotal"] for i in lista),
                "qtdTotal": sum(i["qtdTotal"] for i in lista),
                "skusAcima3m": sum(i["skusAcima3m"] for i in lista),
                "qtdAcima3m": sum(i["qtdAcima3m"] for i in lista),
                "skusAcima6m": sum(i["skusAcima6m"] for i in lista),
                "qtdAcima6m": sum(i["qtdAcima6m"] for i in lista),
            }

        produtos_lista = []
        for cd_produto, dados in por_produto.items():
            info = nomes_produto.get(cd_produto, {})
            produtos_lista.append({
                "cdProduto": cd_produto,
                "referencia": info.get("referencia") or str(cd_produto),
                "nome": info.get("produto") or "(sem cadastro)",
                "qtdAtual": dados["qtd"],
                "diasParado": dados["diasParadoMin"],
            })

        top_piores = sorted(produtos_lista, key=lambda i: i["diasParado"], reverse=True)[:TOP_N_PRODUTOS]
        top_melhores = sorted(produtos_lista, key=lambda i: i["diasParado"])[:TOP_N_PRODUTOS]

        return {
            "itens": itens,
            "consolidadoFabrica": _consolidar(itens_fabrica),
            "consolidadoLojas": _consolidar(itens_lojas),
            "consolidadoGeral": _consolidar(itens),
            "topPiores": top_piores,
            "topMelhores": top_melhores,
            "dtReferencia": hoje.isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar estoque por tempo: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar estoque por tempo: {str(e)}")
