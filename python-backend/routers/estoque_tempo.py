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

Cache por empresa+dia (estoque_tempo_produto_cache): a query e pesada
(prd_prdsaldo e uma tabela de milhoes de linhas, sem indice ideal pra esse
padrao de acesso - varios minutos por empresa quando o banco remoto esta
lento) e o resultado so muda quando ha nova movimentacao, entao nao faz
sentido recalcular a cada consulta. Guarda o saldo bruto (qt_saldo,
dt_saldo) por empresa+produto+dia do calculo - "dias parado" e sempre
recalculado na leitura (hoje - dt_saldo), nunca fica desatualizado mesmo
lendo do cache. Uma empresa so e recalculada se ainda nao tiver cache pro
dia de hoje (o dia muda, o saldo pode ter mudado, cache expira sozinho).
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date
from database import execute_query, execute_insert
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


def _criar_tabela_cache():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS estoque_tempo_produto_cache (
            cd_empresa INTEGER NOT NULL,
            cd_produto INTEGER NOT NULL,
            dt_calculo DATE NOT NULL,
            qt_saldo NUMERIC NOT NULL,
            dt_saldo TIMESTAMP NOT NULL,
            PRIMARY KEY (cd_empresa, cd_produto, dt_calculo)
        )
    """, ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS estoque_tempo_cache_status (
            cd_empresa INTEGER NOT NULL,
            dt_calculo DATE NOT NULL,
            linhas INTEGER NOT NULL,
            dt_calculado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (cd_empresa, dt_calculo)
        )
    """, ())


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


def _calcular_e_cachear(empresas_faltantes: list, hoje: date):
    """Roda a query pesada SO pras empresas ainda sem cache de hoje, e
    guarda o resultado (saldo bruto, nao a "idade" ja calculada - ver
    docstring do modulo)."""
    if not empresas_faltantes:
        return
    _criar_tabela_cache()
    linhas = execute_query(_QUERY_ESTOQUE_COM_IDADE, (empresas_faltantes, _padroes_produto_excluidos())) or []

    linhas_por_empresa: dict = {e: [] for e in empresas_faltantes}
    for r in linhas:
        linhas_por_empresa[r["cd_empresa"]].append(r)

    for cd_empresa in empresas_faltantes:
        rows_empresa = linhas_por_empresa[cd_empresa]
        execute_insert("DELETE FROM estoque_tempo_produto_cache WHERE cd_empresa = %s AND dt_calculo = %s", (cd_empresa, hoje))
        for i in range(0, len(rows_empresa), 500):
            lote = rows_empresa[i:i + 500]
            valores_sql = ",".join(["(%s, %s, %s, %s, %s)"] * len(lote))
            params = [v for r in lote for v in (cd_empresa, r["cd_produto"], hoje, float(r["qt_saldo"]), r["dt_saldo"])]
            execute_insert(
                f"INSERT INTO estoque_tempo_produto_cache (cd_empresa, cd_produto, dt_calculo, qt_saldo, dt_saldo) VALUES {valores_sql}",
                tuple(params)
            )
        execute_insert("""
            INSERT INTO estoque_tempo_cache_status (cd_empresa, dt_calculo, linhas, dt_calculado_em)
            VALUES (%s, %s, %s, NOW())
            ON CONFLICT (cd_empresa, dt_calculo) DO UPDATE SET linhas = EXCLUDED.linhas, dt_calculado_em = NOW()
        """, (cd_empresa, hoje, len(rows_empresa)))


@router.get("/api/estoque-tempo/dados")
def obter_estoque_tempo(
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """Estoque parado ha mais de 3 e mais de 6 meses (sem movimentacao),
    por empresa e top 10 produtos melhor/pior nesse quesito. Empresas sem
    cache pro dia de hoje sao calculadas na hora (mesmo comportamento de
    antes - so muda que uma segunda consulta no mesmo dia, com as mesmas
    empresas, sai do cache, instantanea)."""
    try:
        cd_empresas = _parse_empresas(empresas)
        hoje = date.today()
        _criar_tabela_cache()

        calculadas = {
            r["cd_empresa"] for r in execute_query(
                f"SELECT cd_empresa FROM estoque_tempo_cache_status WHERE dt_calculo = %s AND cd_empresa IN ({','.join(['%s'] * len(cd_empresas))})",
                (hoje, *cd_empresas)
            ) or []
        }
        faltantes = [e for e in cd_empresas if e not in calculadas]
        _calcular_e_cachear(faltantes, hoje)

        placeholders = ",".join(["%s"] * len(cd_empresas))
        linhas = execute_query(
            f"SELECT cd_empresa, cd_produto, qt_saldo, dt_saldo FROM estoque_tempo_produto_cache WHERE dt_calculo = %s AND cd_empresa IN ({placeholders})",
            (hoje, *cd_empresas)
        ) or []

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

        produtos_lista = [
            {"cdProduto": cd_produto, "qtdAtual": dados["qtd"], "diasParado": dados["diasParadoMin"]}
            for cd_produto, dados in por_produto.items()
        ]
        top_piores = sorted(produtos_lista, key=lambda i: i["diasParado"], reverse=True)[:TOP_N_PRODUTOS]
        top_melhores = sorted(produtos_lista, key=lambda i: i["diasParado"])[:TOP_N_PRODUTOS]

        # So busca nome/referencia dos ~20 produtos que aparecem no top 10,
        # nao de todo mundo - view rapida, mas nao ha por que buscar mais
        # que o necessario.
        ids_top = list({i["cdProduto"] for i in top_piores + top_melhores})
        nomes_produto = {}
        if ids_top:
            info_rows = execute_query(
                "SELECT cd_produto, referencia, produto FROM mv_prd_referencia_produto WHERE cd_produto = ANY(%s)",
                (ids_top,)
            ) or []
            nomes_produto = {p["cd_produto"]: p for p in info_rows}

        def _com_nome(item):
            info = nomes_produto.get(item["cdProduto"], {})
            return {
                **item,
                "referencia": info.get("referencia") or str(item["cdProduto"]),
                "nome": info.get("produto") or "(sem cadastro)",
            }

        return {
            "itens": itens,
            "consolidadoFabrica": _consolidar(itens_fabrica),
            "consolidadoLojas": _consolidar(itens_lojas),
            "consolidadoGeral": _consolidar(itens),
            "topPiores": [_com_nome(i) for i in top_piores],
            "topMelhores": [_com_nome(i) for i in top_melhores],
            "dtReferencia": hoje.isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar estoque por tempo: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar estoque por tempo: {str(e)}")
