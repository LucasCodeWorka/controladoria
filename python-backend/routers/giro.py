"""
Giro de estoque - estoque atual (em quantidade) vs venda media dos ultimos
3 meses completos, por loja, fabrica e consolidado.

Giro = estoque / venda media mensal (mesma convencao ja usada nas tabelas
historicas mv_giro_fabrica_mensal/mv_giro_lojas_mensal deste banco: "quantos
meses o estoque cobre no ritmo medio de venda"). Nao existe fonte rapida e
fresca pra isso pronta (as tabelas historicas sao snapshots estaticos,
paradas desde fev/mar de 2026, sem quebra por loja individual e com estoque
em R$, nao em quantidade como pedido) - entao e calculado direto das tabelas
originais e guardado num snapshot local por empresa+mes de referencia,
recalculado sob demanda.

Suporta filtrar por mes de referencia e por empresa antes de calcular:
- Mes de referencia (0 custo extra): dt_saldo aceita qualquer data de corte
  no passado (historico desde 2018), entao "estoque no mes X" e tao rapido
  quanto "estoque hoje". Convencao: mes de referencia = mes atual -> estoque
  de HOJE (tempo real); mes de referencia passado -> estoque no INICIO
  daquele mes. Venda media sempre = media dos 3 meses CHEIOS antes do mes de
  referencia.
- Empresa (ajuda parcial): a query de estoque (prd_prdsaldo, tabela base) fica
  bem mais rapida filtrada (1 loja ~7s vs 17 empresas ~29s); a de venda
  (vr_tra_transacao/vr_tra_transitem) tem custo quase fixo (1 loja ~37s vs
  17 empresas ~51s - mesma limitacao ja vista noutras telas). No total,
  calcular 1 loja fica em ~40s contra ~80s de todas juntas - ajuda, mas nao
  e instantaneo.
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date, timedelta
from database import execute_query, execute_insert
from routers.cmv_detalhado import EMPRESAS_CMV_DETALHADO, _nome_empresa_cmv, _eh_fabrica

router = APIRouter()


def _criar_tabela_giro():
    # Migracao unica: a tabela antiga (so um snapshot global, sem mes de
    # referencia) nao tem como virar a nova (chave cd_empresa+mes_referencia)
    # com ALTER - e so cache derivado (recalculavel), entao recria do zero se
    # detectar o esquema antigo.
    colunas = execute_query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'giro_snapshot'", ()
    ) or []
    if colunas and not any(c["column_name"] == "mes_referencia" for c in colunas):
        execute_insert("DROP TABLE giro_snapshot", ())

    execute_insert("""
        CREATE TABLE IF NOT EXISTS giro_snapshot (
            cd_empresa INTEGER NOT NULL,
            mes_referencia VARCHAR(7) NOT NULL,
            estoque_atual NUMERIC NOT NULL,
            venda_media_3m NUMERIC NOT NULL,
            mes_ini VARCHAR(7) NOT NULL,
            mes_fim VARCHAR(7) NOT NULL,
            dt_calculado TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (cd_empresa, mes_referencia)
        )
    """, ())
    # Mesma ideia, mas por produto - base do top 10 melhor/pior giro. Guardado
    # separado (nao junto do giro_snapshot) porque e um grao bem mais fino
    # (milhares de linhas por empresa+mes, contra uma linha so no snapshot
    # por empresa).
    execute_insert("""
        CREATE TABLE IF NOT EXISTS giro_produto_snapshot (
            cd_empresa INTEGER NOT NULL,
            cd_produto INTEGER NOT NULL,
            mes_referencia VARCHAR(7) NOT NULL,
            estoque_atual NUMERIC NOT NULL,
            venda_media_3m NUMERIC NOT NULL,
            PRIMARY KEY (cd_empresa, cd_produto, mes_referencia)
        )
    """, ())


def _mes_atual() -> str:
    hoje = date.today()
    return f"{hoje.year:04d}-{hoje.month:02d}"


def _somar_meses(ano: int, mes: int, delta: int) -> tuple:
    m = mes - 1 + delta
    return ano + m // 12, m % 12 + 1


def _parse_empresas_giro(empresas: Optional[str]) -> list:
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


def _datas_periodo(mes_referencia: str) -> tuple:
    """(dt_corte_estoque, data_inicio_venda, data_fim_venda, mes_ini, mes_fim)
    pro mes de referencia pedido - "regra dos 3 meses pra tras": estoque no
    mes de referencia (hoje, se for o mes atual; inicio do mes, se for
    passado) e venda media dos 3 meses CHEIOS imediatamente antes dele."""
    ano_ref, mes_ref = (int(p) for p in mes_referencia.split("-"))

    if mes_referencia == _mes_atual():
        dt_corte_estoque = date.today().isoformat()
    else:
        dt_corte_estoque = date(ano_ref, mes_ref, 1).isoformat()

    ano_ini, mes_ini_n = _somar_meses(ano_ref, mes_ref, -3)
    ano_fim, mes_fim_n = _somar_meses(ano_ref, mes_ref, -1)
    data_inicio = date(ano_ini, mes_ini_n, 1)
    ano_prox, mes_prox = _somar_meses(ano_fim, mes_fim_n, 1)
    data_fim = date(ano_prox, mes_prox, 1) - timedelta(days=1)

    return (
        dt_corte_estoque,
        data_inicio.isoformat(),
        data_fim.isoformat(),
        f"{ano_ini:04d}-{mes_ini_n:02d}",
        f"{ano_fim:04d}-{mes_fim_n:02d}",
    )


# Produtos fora da conta de giro: codigo >= 1000000 (materia-prima/insumo -
# mesma convencao ja usada em mv_estoque_primeiro_dia_mes/vl_mp, aplicada em
# TODAS as empresas - lojas tambem tem milhares de linhas de saldo nessa
# faixa, em codigos sem cadastro de produto e quantidades enormes, claramente
# material de PDV/embalagem) e itens que nao sao mercadoria de venda - sem
# classificacao/grupo consistente no cadastro pra filtrar de outro jeito,
# entao filtrado pelo nome (ver TERMOS_PRODUTO_EXCLUIDOS). Cada termo foi
# conferido individualmente pra nao pegar produto de verdade - por isso NAO
# tem um "ADESIVO" generico aqui: a maioria dos itens com esse nome e sutia/
# bojo adesivo (produto de venda real), so os termos compostos abaixo (ex:
# "ADESIVO INSTITUCIONAL") sao material de marketing. O LEFT JOIN com a
# classificacao pode nao achar o produto (p.produto NULL) - nesse caso
# mantem o produto (so descarta quando da pra confirmar que e um desses).
TERMOS_PRODUTO_EXCLUIDOS = [
    "SACOLA", "CUPO", "GANCHEIRA", "SAQUINHO", "DISPLAY", "EXPOSITOR",
    "PORTA CALCINHA", "FARDA", "BRINDE", "CAIXA DYSPLAY", "MALA ",
    "EMBALAGEM", "CABIDE", "URNA", "BANNER", "ENCARTE", "REVISTA",
    "CATALOGO", "CATALAGO", "CARTAZ", "LOOK BOOK", "BABYLOOK",
    "ADESIVO INSTITUCIONAL", "ADESIVO DE VITRINE", "ADESIVO VERTICAL",
    "ADESIVO HORIZONTAL", "ADESIVO AQUI TEM", "ADESIVO CORTE ELETRONICO",
]


def _padroes_produto_excluidos() -> list:
    return [f"%{t}%" for t in TERMOS_PRODUTO_EXCLUIDOS]


def _produtos_sem_status_e_marca() -> list:
    """cd_produto que nao tem NEM status (classificacao 27) NEM marca
    (classificacao 20) cadastrados no dicionario de produto - conferido com
    o usuario: esse grupo concentra peca de maquina/eletronico/produto de
    terceiros sem nenhuma classificacao usavel (ex: "MOTO G04S", "MEMORIA
    NOT DDR3", "AMORTECEDOR DO ACOPLADO TRAVETE"), misturado com pouca
    mercadoria de verdade - pedido pra tirar tudo isso da analise de giro.
    status ja vem pronto na materialized view; marca (classificacao 20) nao
    esta nela, entao so chama a funcao pros produtos sem status (bem menos
    que o catalogo inteiro - ~950 contra ~40 mil)."""
    sem_status = execute_query(
        "SELECT cd_produto FROM mv_prd_referencia_produto WHERE status IS NULL AND cd_produto < 1000000", ()
    ) or []
    ids = [r["cd_produto"] for r in sem_status]
    if not ids:
        return []
    linhas = execute_query(
        """
            SELECT cd_produto FROM (SELECT DISTINCT cd_produto FROM mv_prd_referencia_produto WHERE cd_produto = ANY(%s)) t
            WHERE f_dic_prd_classificacao(cd_produto, 'DS', 20) IS NULL
        """,
        (ids,)
    ) or []
    return [r["cd_produto"] for r in linhas]


# Agrupado por empresa+produto (nao so empresa) - alimenta tanto o
# consolidado por empresa quanto o top 10 melhor/pior giro por produto, sem
# precisar de uma segunda query pesada.
_QUERY_ESTOQUE_ATUAL = """
    SELECT cd_empresa, cd_produto, SUM(qt_saldo) AS estoque_total
    FROM (
        SELECT DISTINCT ON (s.cd_empresa, s.cd_produto) s.cd_empresa, s.cd_produto, s.qt_saldo
        FROM prd_prdsaldo s
        LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = s.cd_produto
        LEFT JOIN (SELECT unnest(%s::int[]) AS cd_produto) excl ON excl.cd_produto = s.cd_produto
        WHERE s.cd_saldo = 1 AND s.dt_saldo < %s
          AND s.cd_empresa = ANY(%s)
          AND s.cd_produto < 1000000
          AND (p.produto IS NULL OR p.produto NOT ILIKE ALL(%s))
          AND excl.cd_produto IS NULL
        ORDER BY s.cd_empresa, s.cd_produto, s.dt_saldo DESC
    ) x
    GROUP BY 1, 2
"""

# Quantidade vendida por empresa+produto no periodo - mesma regra de
# modalidade/operacao/situacao ja validada (bate com a receita oficial) pro
# cache de CMV/receita por produto.
_QUERY_QTD_VENDIDA = """
    SELECT t.cd_empresa, i.cd_produto,
        SUM(
            CASE
                WHEN t.tp_modalidade::text IN ('4','8') AND t.tp_operacao::text = 'S' THEN i.qt_solicitada
                WHEN t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E' THEN -i.qt_solicitada
                ELSE 0
            END
        ) AS qt_vendida
    FROM vr_tra_transacao t
    JOIN vr_tra_transitem i ON t.nr_transacao = i.nr_transacao AND t.cd_empresa = i.cd_empresa
    LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = i.cd_produto
    LEFT JOIN (SELECT unnest(%s::int[]) AS cd_produto) excl ON excl.cd_produto = i.cd_produto
    WHERE t.tp_situacao = 4
      AND t.cd_empresa = ANY(%s)
      AND t.dt_transacao >= %s AND t.dt_transacao <= %s
      AND ((t.tp_modalidade::text IN ('4','8') AND t.tp_operacao::text = 'S') OR (t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E'))
      AND i.cd_produto < 1000000
      AND (p.produto IS NULL OR p.produto NOT ILIKE ALL(%s))
      AND excl.cd_produto IS NULL
    GROUP BY 1, 2
"""


def _calcular_giro(mes_referencia: str, cd_empresas: list) -> dict:
    _criar_tabela_giro()
    dt_corte_estoque, data_inicio, data_fim, mes_ini, mes_fim = _datas_periodo(mes_referencia)

    padroes_excluidos = _padroes_produto_excluidos()
    produtos_sem_classificacao = _produtos_sem_status_e_marca()
    linhas_estoque = execute_query(_QUERY_ESTOQUE_ATUAL, (produtos_sem_classificacao, dt_corte_estoque, cd_empresas, padroes_excluidos)) or []
    linhas_venda = execute_query(_QUERY_QTD_VENDIDA, (produtos_sem_classificacao, cd_empresas, data_inicio, data_fim, padroes_excluidos)) or []

    estoque_por_empresa: dict = {}
    estoque_por_produto: dict = {}
    for r in linhas_estoque:
        v = float(r["estoque_total"] or 0)
        estoque_por_empresa[r["cd_empresa"]] = estoque_por_empresa.get(r["cd_empresa"], 0.0) + v
        estoque_por_produto[(r["cd_empresa"], r["cd_produto"])] = v

    qtd_por_empresa: dict = {}
    qtd_por_produto: dict = {}
    for r in linhas_venda:
        v = float(r["qt_vendida"] or 0)
        qtd_por_empresa[r["cd_empresa"]] = qtd_por_empresa.get(r["cd_empresa"], 0.0) + v
        qtd_por_produto[(r["cd_empresa"], r["cd_produto"])] = v

    for cd_empresa in cd_empresas:
        estoque = estoque_por_empresa.get(cd_empresa, 0.0)
        venda_media_3m = qtd_por_empresa.get(cd_empresa, 0.0) / 3.0
        execute_insert("""
            INSERT INTO giro_snapshot (cd_empresa, mes_referencia, estoque_atual, venda_media_3m, mes_ini, mes_fim, dt_calculado)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (cd_empresa, mes_referencia) DO UPDATE SET
                estoque_atual = EXCLUDED.estoque_atual,
                venda_media_3m = EXCLUDED.venda_media_3m,
                mes_ini = EXCLUDED.mes_ini,
                mes_fim = EXCLUDED.mes_fim,
                dt_calculado = NOW()
        """, (cd_empresa, mes_referencia, estoque, venda_media_3m, mes_ini, mes_fim))

    # Por produto: so grava quem tem estoque OU venda no periodo, senao a
    # tabela cresce com zero-zero (produto nunca circulou nessa empresa).
    execute_insert(
        "DELETE FROM giro_produto_snapshot WHERE mes_referencia = %s AND cd_empresa = ANY(%s)",
        (mes_referencia, cd_empresas)
    )
    chaves_produto = set(estoque_por_produto.keys()) | set(qtd_por_produto.keys())
    linhas_para_gravar = [
        (cd_empresa, cd_produto, mes_referencia, estoque_por_produto.get((cd_empresa, cd_produto), 0.0),
         qtd_por_produto.get((cd_empresa, cd_produto), 0.0) / 3.0)
        for cd_empresa, cd_produto in chaves_produto
    ]
    lista_chaves = list(linhas_para_gravar)
    for i in range(0, len(lista_chaves), 500):
        lote = lista_chaves[i:i + 500]
        valores_sql = ",".join(["(%s, %s, %s, %s, %s)"] * len(lote))
        params = [v for linha in lote for v in linha]
        execute_insert(
            f"INSERT INTO giro_produto_snapshot (cd_empresa, cd_produto, mes_referencia, estoque_atual, venda_media_3m) VALUES {valores_sql}",
            tuple(params)
        )

    _cache_matriz_referencia.clear()
    return _montar_resposta(mes_referencia, cd_empresas)


TOP_N_PRODUTOS_GIRO = 10

# Cache em memoria (nao no banco - e derivado, barato de refazer) da matriz
# ja agregada por REFERENCIA - {(mes_referencia, tuple(cd_empresas ordenado)):
# [itens]}. Ordenar por uma coluna qualquer (loja ou total) precisa do giro
# de TODAS as referencias, nao so da pagina - buscar e agregar tudo direto
# do banco a cada clique de ordenar levaria uns 8-10s (220 mil linhas no mes
# cheio); cacheado, so a primeira vez custa isso, depois e instantaneo.
# Limpo em _calcular_giro (dado novo invalida o cache).
_cache_matriz_referencia: dict = {}


def _eh_variante_preco_desconsiderada(status: Optional[str], familia: Optional[str]) -> bool:
    """Variantes de uma referencia cujo preco nao representa o preco 'normal'
    dela - leve defeito (preco reduzido) e doacao (preco zerado) tem valores
    bem diferentes das demais cores/tamanhos da mesma referencia (confirmado:
    ref '0001' tinha varejo 59.99 nas variantes normais, 27.9 na leve defeito
    e 0.0 na doacao). Por pedido do usuario, essas ficam de fora ao escolher
    qual produto representa o preco da referencia."""
    return status == "LEVE DEFEITO" or familia == "DOACAO"


def _nome_base_referencia(produto: Optional[str], ds_cor: Optional[str], ds_tamanho: Optional[str]) -> Optional[str]:
    """O nome cadastrado (mv_prd_referencia_produto.produto) e do SKU, nao da
    referencia - sempre termina com "COR TAMANHO" (ex: "SUTIA MINI CHOCOLATE
    U"; confirmado em ~99% dos produtos com cor e tamanho cadastrados). Tira
    esse sufixo pra sobrar so a descricao comum a referencia toda ("SUTIA
    MINI"), a mesma pra qualquer cor/tamanho dela. Quando o padrao nao bate
    (sufixo raro, cor/tamanho ausente), devolve o nome original sem alterar."""
    if not produto:
        return produto
    if ds_cor and ds_tamanho:
        sufixo = f"{ds_cor} {ds_tamanho}"
        if produto.upper().endswith(sufixo.upper()):
            base = produto[:-len(sufixo)].rstrip()
            if base:
                return base
    return produto


def _obter_matriz_agregada(mes_referencia: str, cd_empresas: list) -> list:
    chave = (mes_referencia, tuple(sorted(cd_empresas)))
    if chave in _cache_matriz_referencia:
        return _cache_matriz_referencia[chave]

    placeholders = ",".join(["%s"] * len(cd_empresas))
    linhas = execute_query(f"""
        SELECT g.cd_empresa, g.cd_produto, g.estoque_atual, g.venda_media_3m,
            COALESCE(p.referencia, g.cd_produto::text) AS referencia, p.produto AS nome,
            p.ds_cor, p.ds_tamanho, p.status, p.familia
        FROM giro_produto_snapshot g
        LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = g.cd_produto
        WHERE g.mes_referencia = %s AND g.cd_empresa IN ({placeholders})
    """, (mes_referencia, *cd_empresas)) or []

    def _giro(estoque: float, venda: float):
        return (estoque / venda) if venda > 0 else None

    por_ref: dict = {}
    for r in linhas:
        ref = r["referencia"]
        if ref not in por_ref:
            por_ref[ref] = {
                "nomeBase": None, "nomeBaseFallback": None, "porLoja": {}, "estoqueTotal": 0.0, "vendaTotal": 0.0,
                "cdProdutoPreco": None, "cdProdutoFallback": None,
            }
        d = por_ref[ref]
        nome_sem_variante = _nome_base_referencia(r["nome"], r["ds_cor"], r["ds_tamanho"])
        variante_desconsiderada = _eh_variante_preco_desconsiderada(r["status"], r["familia"])
        # Descricao da referencia: tira cor/tamanho do nome do SKU (ex:
        # "SUTIA MINI CHOCOLATE U" -> "SUTIA MINI") pra nao mostrar a
        # descricao de uma unica variante como se fosse da referencia
        # inteira. Prefere um SKU "normal" (nao leve defeito/doacao), com
        # fallback pra qualquer um se so sobrar variante assim.
        if d["nomeBase"] is None and nome_sem_variante and not variante_desconsiderada:
            d["nomeBase"] = nome_sem_variante
        if d["nomeBaseFallback"] is None and nome_sem_variante:
            d["nomeBaseFallback"] = nome_sem_variante
        # Produto representativo pra buscar o preco da referencia: o primeiro
        # que nao for leve defeito/doacao (preco "normal"). Se a referencia
        # so tiver variantes assim, usa qualquer uma como ultimo recurso (pra
        # nao ficar sem preco nenhum).
        if d["cdProdutoPreco"] is None and not variante_desconsiderada:
            d["cdProdutoPreco"] = r["cd_produto"]
        if d["cdProdutoFallback"] is None:
            d["cdProdutoFallback"] = r["cd_produto"]
        estoque = float(r["estoque_atual"] or 0)
        venda = float(r["venda_media_3m"] or 0)
        estoque_prev, venda_prev = d["porLoja"].get(r["cd_empresa"], (0.0, 0.0))
        d["porLoja"][r["cd_empresa"]] = (estoque_prev + estoque, venda_prev + venda)
        d["estoqueTotal"] += estoque
        d["vendaTotal"] += venda

    # porLoja/total guardam estoque e venda media crus junto do giro (nao so
    # o resultado da divisao) pra montar o tooltip "estoque / venda = giro"
    # no frontend, sem precisar de outra consulta.
    resultado = [
        {
            "referencia": ref,
            "nome": d["nomeBase"] or d["nomeBaseFallback"] or "(sem cadastro)",
            "porLoja": {
                cd_empresa: {"estoque": estoque, "venda": venda, "giro": _giro(estoque, venda)}
                for cd_empresa, (estoque, venda) in d["porLoja"].items()
            },
            "estoqueTotal": d["estoqueTotal"],
            "vendaTotal": d["vendaTotal"],
            "giroTotal": _giro(d["estoqueTotal"], d["vendaTotal"]),
            "cdProdutoPreco": d["cdProdutoPreco"] or d["cdProdutoFallback"],
        }
        for ref, d in por_ref.items()
        # Fora as referencias totalmente mortas (zero estoque e zero venda
        # em TODAS as empresas do filtro) - nao tem giro, nem venda, nem
        # estoque pra mostrar, so linha vazia sem informacao nenhuma.
        if d["estoqueTotal"] > 0 or d["vendaTotal"] > 0
    ]
    _cache_matriz_referencia[chave] = resultado
    return resultado


# Cache em memoria de preco por cd_produto - {cd_produto: {"fabrica":...,
# "atacado":..., "varejo":...}}. Preco nao e ligado ao giro (fonte diferente,
# PRD_VALOR via f_dic_prd_valorprod), entao nao e limpo junto com o cache da
# matriz - so cresce sob demanda, evitando rebuscar preco de produtos ja
# vistos ao trocar de pagina/ordenacao.
_cache_preco_produto: dict = {}


def _obter_precos_produtos(cd_produtos: list) -> dict:
    """Preco fabrica/atacado/varejo pra uma lista de cd_produto, via a funcao
    public.f_dic_prd_valorprod(cd_produto, 'P', cd_valor) - 1=fabrica,
    2=atacado, 3=varejo (confirmado com o usuario). Busca tudo numa unica
    query (VALUES + funcao por linha, executada no servidor) em vez de uma
    chamada por produto - testado com 50 produtos x 3 precos em ~0.4s."""
    faltantes = [cd for cd in set(cd_produtos) if cd is not None and cd not in _cache_preco_produto]
    if faltantes:
        placeholders = ",".join(["(%s)"] * len(faltantes))
        linhas = execute_query(f"""
            SELECT t.cd_produto,
                public.f_dic_prd_valorprod(t.cd_produto, 'P', 1) AS preco_fabrica,
                public.f_dic_prd_valorprod(t.cd_produto, 'P', 2) AS preco_atacado,
                public.f_dic_prd_valorprod(t.cd_produto, 'P', 3) AS preco_varejo
            FROM (VALUES {placeholders}) AS t(cd_produto)
        """, tuple(faltantes)) or []
        for r in linhas:
            _cache_preco_produto[r["cd_produto"]] = {
                "precoFabrica": r["preco_fabrica"],
                "precoAtacado": r["preco_atacado"],
                "precoVarejo": r["preco_varejo"],
            }
    return {cd: _cache_preco_produto.get(cd) for cd in cd_produtos}


def _status_produto_disponiveis() -> list:
    """Valores distintos de status de produto (mv_prd_referencia_produto) -
    pro filtro de status do Giro. Rapida (materialized view)."""
    rows = execute_query(
        "SELECT DISTINCT status FROM mv_prd_referencia_produto WHERE status IS NOT NULL ORDER BY 1", ()
    ) or []
    return [r["status"] for r in rows]


def _clausula_status(status_filtro: Optional[list]) -> tuple:
    """(sql, params) pro filtro opcional de status - string vazia se nao
    tiver filtro (nenhum custo extra)."""
    if not status_filtro:
        return "", ()
    return " AND p.status = ANY(%s)", (status_filtro,)


def _top_produtos_giro(mes_referencia: str, cd_empresas: list, status_filtro: Optional[list] = None) -> dict:
    """Top 10 melhor e pior giro por produto, somando estoque/venda das
    empresas selecionadas que ja tem giro_produto_snapshot pro mes pedido.
    Produtos com venda media = 0 (sem nenhuma venda no periodo, so estoque
    parado) entram no 'pior giro' com giro null - sao o pior caso na pratica
    (estoque parado, giro indefinido), nao um caso a esconder."""
    placeholders = ",".join(["%s"] * len(cd_empresas))
    clausula_status, params_status = _clausula_status(status_filtro)
    rows = execute_query(f"""
        SELECT g.cd_produto, p.referencia, p.produto AS nome,
            SUM(g.estoque_atual) AS estoque_atual, SUM(g.venda_media_3m) AS venda_media_3m
        FROM giro_produto_snapshot g
        LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = g.cd_produto
        WHERE g.mes_referencia = %s AND g.cd_empresa IN ({placeholders}){clausula_status}
        GROUP BY 1, 2, 3
    """, (mes_referencia, *cd_empresas, *params_status)) or []

    itens = []
    for r in rows:
        estoque = float(r["estoque_atual"] or 0)
        venda_media = float(r["venda_media_3m"] or 0)
        if estoque <= 0:
            continue
        giro = (estoque / venda_media) if venda_media > 0 else None
        itens.append({
            "cdProduto": r["cd_produto"],
            "referencia": r["referencia"] or str(r["cd_produto"]),
            "nome": r["nome"] or "(sem cadastro)",
            "estoqueAtual": estoque,
            "vendaMedia3m": venda_media,
            "giro": giro,
        })

    com_venda = [i for i in itens if i["giro"] is not None]
    parados = [i for i in itens if i["giro"] is None]

    melhor_giro = sorted(com_venda, key=lambda i: i["giro"])[:TOP_N_PRODUTOS_GIRO]
    # Pior giro: primeiro os parados (estoque sem nenhuma venda - pior caso
    # possivel), depois os de maior giro numerico, ate completar o top 10.
    pior_giro = (sorted(parados, key=lambda i: i["estoqueAtual"], reverse=True) +
                 sorted(com_venda, key=lambda i: i["giro"], reverse=True))[:TOP_N_PRODUTOS_GIRO]

    return {"melhorGiro": melhor_giro, "piorGiro": pior_giro}


def _montar_resposta(mes_referencia: str, cd_empresas: list, status_filtro: Optional[list] = None) -> dict:
    _criar_tabela_giro()
    placeholders = ",".join(["%s"] * len(cd_empresas))
    rows = execute_query(
        f"SELECT * FROM giro_snapshot WHERE mes_referencia = %s AND cd_empresa IN ({placeholders}) ORDER BY cd_empresa",
        (mes_referencia, *cd_empresas)
    ) or []

    calculadas = {r["cd_empresa"] for r in rows}
    empresas_faltantes = [
        {"cdEmpresa": e, "nome": _nome_empresa_cmv(e)}
        for e in cd_empresas if e not in calculadas
    ]

    if not rows:
        return {
            "itens": [], "consolidadoFabrica": None, "consolidadoLojas": None, "consolidadoGeral": None,
            "dtCalculado": None, "mesIni": None, "mesFim": None,
            "mesReferencia": mes_referencia, "empresasFaltantes": empresas_faltantes,
            "topProdutos": {"melhorGiro": [], "piorGiro": []},
        }

    def _giro(estoque: float, venda_media: float):
        if venda_media <= 0:
            return None
        return estoque / venda_media

    # Sem filtro de status: le direto do snapshot por empresa (agregado,
    # instantaneo). Com filtro de status: agrega na hora a partir do
    # snapshot por produto (junta com o status do cadastro) - mais uma
    # consulta, mas ainda so no cache local, nao nas views lentas.
    if status_filtro:
        clausula_status, params_status = _clausula_status(status_filtro)
        linhas_status = execute_query(f"""
            SELECT g.cd_empresa, SUM(g.estoque_atual) AS estoque_atual, SUM(g.venda_media_3m) AS venda_media_3m
            FROM giro_produto_snapshot g
            LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = g.cd_produto
            WHERE g.mes_referencia = %s AND g.cd_empresa IN ({placeholders}){clausula_status}
            GROUP BY 1
        """, (mes_referencia, *cd_empresas, *params_status)) or []
        valores_por_empresa = {r["cd_empresa"]: (float(r["estoque_atual"] or 0), float(r["venda_media_3m"] or 0)) for r in linhas_status}
    else:
        valores_por_empresa = {r["cd_empresa"]: (float(r["estoque_atual"]), float(r["venda_media_3m"])) for r in rows}

    itens = []
    for cd_empresa in calculadas:
        estoque, venda_media = valores_por_empresa.get(cd_empresa, (0.0, 0.0))
        itens.append({
            "cdEmpresa": cd_empresa,
            "nome": _nome_empresa_cmv(cd_empresa),
            "tipo": "fabrica" if _eh_fabrica(cd_empresa) else "loja",
            "estoqueAtual": estoque,
            "vendaMedia3m": venda_media,
            "giro": _giro(estoque, venda_media),
        })
    itens.sort(key=lambda i: i["cdEmpresa"])

    itens_fabrica = [i for i in itens if i["tipo"] == "fabrica"]
    itens_lojas = [i for i in itens if i["tipo"] == "loja"]

    def _consolidar(lista):
        if not lista:
            return None
        estoque_total = sum(i["estoqueAtual"] for i in lista)
        venda_total = sum(i["vendaMedia3m"] for i in lista)
        return {"estoqueAtual": estoque_total, "vendaMedia3m": venda_total, "giro": _giro(estoque_total, venda_total)}

    return {
        "itens": itens,
        "consolidadoFabrica": _consolidar(itens_fabrica),
        "consolidadoLojas": _consolidar(itens_lojas),
        "consolidadoGeral": _consolidar(itens),
        "dtCalculado": max(r["dt_calculado"] for r in rows).isoformat(),
        "mesIni": rows[0]["mes_ini"],
        "mesFim": rows[0]["mes_fim"],
        "mesReferencia": mes_referencia,
        "empresasFaltantes": empresas_faltantes,
        "topProdutos": _top_produtos_giro(mes_referencia, list(calculadas), status_filtro),
    }


@router.get("/api/giro/status-produtos")
def listar_status_produtos():
    """Valores de status de produto disponiveis, pro filtro de status do
    Giro (ex: EM LINHA, OPORTUNIDADE ATE 1 ANO, LEVE DEFEITO...)."""
    try:
        return {"status": _status_produto_disponiveis()}
    except Exception as e:
        print(f"[ERROR] Erro ao listar status de produto: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao listar status de produto: {str(e)}")


@router.get("/api/giro/dados")
def obter_giro(
    mesReferencia: Optional[str] = Query(None, description="Mes de referencia YYYY-MM (default: mes atual)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)"),
    status: Optional[str] = Query(None, description="Lista de status de produto separados por virgula (default: todos)")
):
    """Snapshot de giro ja calculado pro mes de referencia + empresas
    pedidos (nao recalcula na hora - use /recalcular pra isso). Empresas
    ainda sem calculo pra esse mes voltam em 'empresasFaltantes'. Filtro de
    status e so leitura - agrega o cache por produto na hora, sem precisar
    recalcular nada."""
    try:
        mes_ref = mesReferencia or _mes_atual()
        cd_empresas = _parse_empresas_giro(empresas)
        status_filtro = [s.strip() for s in status.split(",") if s.strip()] if status else None
        return _montar_resposta(mes_ref, cd_empresas, status_filtro)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar giro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar giro: {str(e)}")


@router.post("/api/giro/recalcular")
def recalcular_giro(
    mesReferencia: Optional[str] = Query(None, description="Mes de referencia YYYY-MM (default: mes atual)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """
    Recalcula o giro pro mes de referencia + empresas pedidos. Filtrar por
    empresa reduz o tempo (1 loja ~40s contra ~80s de todas juntas - ver
    docstring do modulo pro detalhe de onde vem essa diferenca). Filtrar por
    mes de referencia nao muda o tempo (estoque historico custa o mesmo que
    estoque de hoje).
    """
    try:
        mes_ref = mesReferencia or _mes_atual()
        cd_empresas = _parse_empresas_giro(empresas)
        return _calcular_giro(mes_ref, cd_empresas)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao recalcular giro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao recalcular giro: {str(e)}")


@router.get("/api/giro/matriz-produtos")
def matriz_produtos_giro(
    mesReferencia: Optional[str] = Query(None, description="Mes de referencia YYYY-MM (default: mes atual)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)"),
    pagina: int = Query(1, ge=1, description="Pagina (comeca em 1)"),
    porPagina: int = Query(50, ge=1, le=200, description="Produtos por pagina"),
    ordenarPor: str = Query("referencia", description="'referencia', 'nome', 'total', 'estoque', 'totalVenda', 'precoFabrica', 'precoAtacado', 'precoVarejo', ou um cd_empresa (ex: '3')"),
    ordem: str = Query("asc", description="'asc' ou 'desc'"),
    giroMinimo: Optional[float] = Query(None, description="So retorna referencias com giro TOTAL maior que esse valor (referencias sem giro - SV-3M/sem estoque - ficam de fora)")
):
    """
    Giro por REFERENCIA (nao por SKU/cor/tamanho individual) e empresa, numa
    matriz: referencia/descricao + uma coluna de giro por empresa
    selecionada + giro total (soma do estoque de TODOS os produtos daquela
    referencia / soma da venda media de todos eles, de todas as empresas do
    filtro). Produtos sem referencia cadastrada viram uma "referencia" so
    deles (o proprio codigo), pra nao misturar produtos diferentes sem
    cadastro num unico grupo. Le direto do cache por produto
    (giro_produto_snapshot) - sem nenhuma query pesada, ja que os dados ja
    estao la (mesmo cache usado no top 10). Paginado por referencia (bem
    menos que por SKU - ex: 2 mil referencias contra 20+ mil produtos).

    Ordenavel por qualquer coluna (loja ou total) - ordena a base INTEIRA,
    nao so a pagina atual (senao "ordenar" so reordenaria os mesmos 50 itens
    da pagina). Isso exige o giro de todas as referencias calculado antes de
    paginar - ver _obter_matriz_agregada pro cache que evita refazer isso a
    cada clique.
    """
    try:
        mes_ref = mesReferencia or _mes_atual()
        cd_empresas = _parse_empresas_giro(empresas)
        placeholders = ",".join(["%s"] * len(cd_empresas))

        calculadas = {
            r["cd_empresa"] for r in execute_query(
                f"SELECT DISTINCT cd_empresa FROM giro_snapshot WHERE mes_referencia = %s AND cd_empresa IN ({placeholders})",
                (mes_ref, *cd_empresas)
            ) or []
        }
        empresas_faltantes = [{"cdEmpresa": e, "nome": _nome_empresa_cmv(e)} for e in cd_empresas if e not in calculadas]
        empresas_colunas = [{"cdEmpresa": e, "nome": _nome_empresa_cmv(e)} for e in cd_empresas]

        dados_completos = _obter_matriz_agregada(mes_ref, cd_empresas)
        if giroMinimo is not None:
            # Giro null (SV-3M ou sem estoque/venda nenhum) nunca passa no
            # filtro "giro maior que X" - nao da pra comparar "sem giro" com
            # um numero.
            dados_completos = [i for i in dados_completos if i["giroTotal"] is not None and i["giroTotal"] > giroMinimo]
        total_referencias = len(dados_completos)
        total_paginas = max(1, -(-total_referencias // porPagina))

        # Extrai o valor de ordenacao de cada item - nulos sempre por
        # ultimo, em qualquer direcao (senao "desc" jogaria os nulos pra
        # primeira posicao, o que nao faz sentido pra giro).
        CHAVES_PRECO = {"precoFabrica": "precoFabrica", "precoAtacado": "precoAtacado", "precoVarejo": "precoVarejo"}
        if ordenarPor == "referencia":
            extrair = lambda i: i["referencia"]
        elif ordenarPor == "nome":
            extrair = lambda i: i["nome"]
        elif ordenarPor == "total":
            extrair = lambda i: i["giroTotal"]
        elif ordenarPor == "estoque":
            extrair = lambda i: i["estoqueTotal"]
        elif ordenarPor == "totalVenda":
            extrair = lambda i: i["vendaTotal"]
        elif ordenarPor in CHAVES_PRECO:
            # Preco de ordenacao precisa de TODAS as referencias (nao so da
            # pagina), senao "ordenar" so reordenaria os 50 itens que ja
            # estavam na pagina. So busca em lote quando realmente for
            # ordenar por preco - fica no cache por cd_produto, entao trocar
            # de pagina ou reordenar de novo depois nao busca de novo.
            chave_preco = CHAVES_PRECO[ordenarPor]
            precos_completos = _obter_precos_produtos([i["cdProdutoPreco"] for i in dados_completos])
            extrair = lambda i: (precos_completos.get(i["cdProdutoPreco"]) or {}).get(chave_preco)
        else:
            try:
                cd_empresa_ord = int(ordenarPor)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"ordenarPor invalido: {ordenarPor}")
            extrair = lambda i: (i["porLoja"].get(cd_empresa_ord) or {}).get("giro")

        desc = ordem == "desc"

        def _chave_ordenacao(item):
            v = extrair(item)
            if v is None:
                return (1, 0)
            if isinstance(v, str):
                return (0, v)
            return (0, -v if desc else v)

        # Strings (referencia/nome) usam reverse= pro sentido; numeros ja
        # tem o sinal invertido em _chave_ordenacao (pra nulos ficarem
        # sempre por ultimo mesmo com reverse=True).
        reverse_str = desc and ordenarPor in ("referencia", "nome")
        itens_ordenados = sorted(dados_completos, key=_chave_ordenacao, reverse=reverse_str)

        offset = (pagina - 1) * porPagina
        itens_pagina = itens_ordenados[offset:offset + porPagina]

        # Preco (fabrica/atacado/varejo) so pra pagina atual - buscar da base
        # inteira (2 mil+ referencias) a cada consulta seria desperdicio. Os
        # itens de itens_pagina sao os MESMOS objetos cacheados em
        # _cache_matriz_referencia (dados_completos) - monta dict novo pra
        # cada linha da resposta em vez de mutar o item cacheado.
        precos = _obter_precos_produtos([i["cdProdutoPreco"] for i in itens_pagina])
        itens_resposta = []
        for item in itens_pagina:
            preco = precos.get(item["cdProdutoPreco"]) or {"precoFabrica": None, "precoAtacado": None, "precoVarejo": None}
            itens_resposta.append({
                "referencia": item["referencia"],
                "nome": item["nome"],
                "porLoja": item["porLoja"],
                "estoqueTotal": item["estoqueTotal"],
                "vendaTotal": item["vendaTotal"],
                "giroTotal": item["giroTotal"],
                "precoFabrica": preco["precoFabrica"],
                "precoAtacado": preco["precoAtacado"],
                "precoVarejo": preco["precoVarejo"],
            })

        return {
            "itens": itens_resposta,
            "empresas": empresas_colunas,
            "totalProdutos": total_referencias,
            "pagina": pagina,
            "porPagina": porPagina,
            "totalPaginas": total_paginas,
            "empresasFaltantes": empresas_faltantes,
            "mesReferencia": mes_ref,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar matriz de produtos do giro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar matriz de produtos do giro: {str(e)}")


DIMENSOES_GIRO = {
    "grupo": "grupo",
    "linha": "linha",
    "familia": "familia",
    "colecao": "colecao",
    "status": "status",
}
TOP_N_DIMENSAO_GIRO = 12


@router.get("/api/giro/por-dimensao")
def giro_por_dimensao(
    dimensao: str = Query(..., description="grupo, linha, familia, colecao ou status"),
    mesReferencia: Optional[str] = Query(None, description="Mes de referencia YYYY-MM (default: mes atual)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)")
):
    """
    Giro (estoque somado / venda media somada de TODOS os produtos daquela
    categoria) agregado por uma dimensao do produto (grupo/linha/familia/
    colecao/status) em vez de por referencia individual - mesma ideia da
    matriz por referencia, so que a chave de agrupamento e o atributo do
    produto. Le direto do cache giro_produto_snapshot (rapido - so um
    GROUP BY em cima de dado ja calculado, sem custo extra).

    Top N categorias por tamanho de estoque, resto agrupado em 'OUTROS'
    (mesmo padrao do CMV por dimensao) - sem isso, uma dimensao com muitas
    categorias pequenas (ex: familia) deixaria o grafico ilegivel.
    """
    try:
        coluna = DIMENSOES_GIRO.get(dimensao)
        if not coluna:
            raise HTTPException(status_code=400, detail=f"Dimensao invalida: {dimensao}. Use uma de: {list(DIMENSOES_GIRO.keys())}")

        mes_ref = mesReferencia or _mes_atual()
        cd_empresas = _parse_empresas_giro(empresas)
        placeholders = ",".join(["%s"] * len(cd_empresas))

        rows = execute_query(f"""
            SELECT COALESCE(p.{coluna}, 'SEM CLASSIFICACAO') AS chave,
                SUM(g.estoque_atual) AS estoque, SUM(g.venda_media_3m) AS venda
            FROM giro_produto_snapshot g
            LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = g.cd_produto
            WHERE g.mes_referencia = %s AND g.cd_empresa IN ({placeholders})
            GROUP BY 1
        """, (mes_ref, *cd_empresas)) or []

        itens = sorted(
            [
                {"chave": r["chave"], "estoqueTotal": float(r["estoque"] or 0), "vendaTotal": float(r["venda"] or 0)}
                for r in rows
                if (r["estoque"] or 0) > 0 or (r["venda"] or 0) > 0
            ],
            key=lambda i: i["estoqueTotal"],
            reverse=True,
        )

        if len(itens) > TOP_N_DIMENSAO_GIRO:
            principais = itens[:TOP_N_DIMENSAO_GIRO]
            resto = itens[TOP_N_DIMENSAO_GIRO:]
            principais.append({
                "chave": "OUTROS",
                "estoqueTotal": sum(i["estoqueTotal"] for i in resto),
                "vendaTotal": sum(i["vendaTotal"] for i in resto),
            })
            itens = principais

        for item in itens:
            item["giro"] = (item["estoqueTotal"] / item["vendaTotal"]) if item["vendaTotal"] > 0 else None

        return {"dimensao": dimensao, "itens": itens, "mesReferencia": mes_ref}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar giro por dimensao: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar giro por dimensao: {str(e)}")
