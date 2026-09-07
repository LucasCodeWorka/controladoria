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


# Agrupado por empresa+produto (nao so empresa) - alimenta tanto o
# consolidado por empresa quanto o top 10 melhor/pior giro por produto, sem
# precisar de uma segunda query pesada.
_QUERY_ESTOQUE_ATUAL = """
    SELECT cd_empresa, cd_produto, SUM(qt_saldo) AS estoque_total
    FROM (
        SELECT DISTINCT ON (s.cd_empresa, s.cd_produto) s.cd_empresa, s.cd_produto, s.qt_saldo
        FROM prd_prdsaldo s
        LEFT JOIN mv_prd_referencia_produto p ON p.cd_produto = s.cd_produto
        WHERE s.cd_saldo = 1 AND s.dt_saldo < %s
          AND s.cd_empresa = ANY(%s)
          AND s.cd_produto < 1000000
          AND (p.produto IS NULL OR p.produto NOT ILIKE ALL(%s))
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
    WHERE t.tp_situacao = 4
      AND t.cd_empresa = ANY(%s)
      AND t.dt_transacao >= %s AND t.dt_transacao <= %s
      AND ((t.tp_modalidade::text IN ('4','8') AND t.tp_operacao::text = 'S') OR (t.tp_modalidade::text = '3' AND t.tp_operacao::text = 'E'))
      AND i.cd_produto < 1000000
      AND (p.produto IS NULL OR p.produto NOT ILIKE ALL(%s))
    GROUP BY 1, 2
"""


def _calcular_giro(mes_referencia: str, cd_empresas: list) -> dict:
    _criar_tabela_giro()
    dt_corte_estoque, data_inicio, data_fim, mes_ini, mes_fim = _datas_periodo(mes_referencia)

    padroes_excluidos = _padroes_produto_excluidos()
    linhas_estoque = execute_query(_QUERY_ESTOQUE_ATUAL, (dt_corte_estoque, cd_empresas, padroes_excluidos)) or []
    linhas_venda = execute_query(_QUERY_QTD_VENDIDA, (cd_empresas, data_inicio, data_fim, padroes_excluidos)) or []

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

    return _montar_resposta(mes_referencia, cd_empresas)


TOP_N_PRODUTOS_GIRO = 10


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
