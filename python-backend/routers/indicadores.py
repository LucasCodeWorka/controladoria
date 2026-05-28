from fastapi import APIRouter, BackgroundTasks
from database import execute_query, execute_insert, execute_neon_query
from datetime import date, datetime
import json
import time

router = APIRouter()

EMPRESAS_LOJAS = [2, 3, 4, 5, 6, 7, 8, 10, 14, 15, 17, 19, 20, 21, 22, 120]

# Operações excluídas do faturamento fábrica
OPERACOES_EXCLUIDAS = (24, 25, 26, 27, 273, 44, 58, 76, 85, 109, 118, 140, 173, 175, 221, 240, 241, 242, 243, 244, 245, 239, 238, 237, 236, 440)
REPRESENTANTES_EXCLUIDOS = (43923, 30193, 4135)

# Operações excluídas do faturamento lojas
OPERACOES_EXCLUIDAS_LOJAS = (140, 76, 25, 26, 27, 273, 44, 240, 241, 242, 243, 244, 245, 239, 238, 237, 236)

# Operações inclusas no faturamento e-commerce
OPERACOES_ECOMMERCE = (24, 25, 26, 27, 240, 241, 242, 243, 244, 239, 238, 237, 236)

_sync_status: dict = {
    "rodando": False,
    "progresso": 0,
    "total": 0,
    "iniciado_em": None,
    "finalizado_em": None,
    "duracao_segundos": None,
}


def _meses_2026_ate_hoje():
    hoje = date.today()
    return [
        date(2026, m, 1)
        for m in range(1, 13)
        if date(2026, m, 1) <= hoje.replace(day=1)
    ]


# ─── Giro Lojas ───────────────────────────────────────────────────────────────

def _calcular_giro_lojas(ref_month: date) -> dict:
    empresas = ", ".join(str(e) for e in EMPRESAS_LOJAS)
    ref = ref_month.isoformat()
    query = f"""
        WITH estoque AS (
            SELECT sum(s.qt_saldo) AS estoque_total
            FROM (
                SELECT DISTINCT ON (s1.cd_empresa, s1.cd_produto)
                    s1.cd_empresa, s1.cd_produto, s1.qt_saldo
                FROM prd_prdsaldo s1
                WHERE s1.cd_empresa = ANY (ARRAY[{empresas}])
                  AND s1.cd_saldo = 1
                  AND s1.dt_saldo < '{ref}'::date
                  AND EXISTS (
                      SELECT 1 FROM prd_produtoclas pc
                      WHERE pc.cd_produto = s1.cd_produto AND pc.cd_tipoclas = '20'
                  )
                ORDER BY s1.cd_empresa, s1.cd_produto, s1.dt_saldo DESC
            ) s
        ),
        media AS (
            SELECT sum(t.qt_solicitada) / 12.0 AS media_mensal
            FROM vr_tra_transitem t
            WHERE t.cd_empresa = ANY (ARRAY[{empresas}])
              AND t.tp_situacao = '4'
              AND t.tp_modalidade::text = '4'
              AND t.tp_operacao::text = 'S'
              AND t.dt_transacao >= '{ref}'::date - INTERVAL '11 months'
              AND t.dt_transacao < '{ref}'::date + INTERVAL '1 month'
        )
        SELECT
            ('{ref}'::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS dt_referencia,
            COALESCE(estoque.estoque_total, 0) AS estoque_total,
            COALESCE(media.media_mensal, 0) AS media_mensal,
            CASE
                WHEN COALESCE(estoque.estoque_total, 0) > 0
                THEN ROUND((media.media_mensal / estoque.estoque_total)::numeric, 2)
                ELSE 0
            END AS giro
        FROM estoque, media
    """
    rows = execute_query(query)
    if not rows:
        return {"giro": 0, "estoque_total": 0, "media_mensal": 0, "dt_referencia": None}
    row = rows[0]
    return {
        "dt_referencia": row["dt_referencia"].isoformat(),
        "estoque_total": float(row["estoque_total"]),
        "media_mensal": float(row["media_mensal"]),
        "giro": float(row["giro"]),
    }


# ─── Giro MP ─────────────────────────────────────────────────────────────────

def _calcular_giro_mp(ref_month: date) -> dict:
    ref = ref_month.isoformat()
    query = f"""
        WITH consumo AS (
            SELECT SUM(a.vl_totalliquido) AS consumo_valor
            FROM vr_tra_transitem a
            INNER JOIN vr_tra_transacao b
                ON a.nr_transacao = b.nr_transacao AND a.cd_empresa = b.cd_empresa
            WHERE a.tp_situacao = 4
              AND b.cd_operacao IN (100, 150, 210, 219)
              AND a.tp_operacao = 'S'
              AND a.dt_transacao >= '{ref}'::date
              AND a.dt_transacao < '{ref}'::date + INTERVAL '1 month'
        ),
        tipos_saldo AS (
            SELECT ts.cd_saldof AS cd_saldo FROM prd_tiposaldof ts WHERE ts.cd_saldo = 1
            UNION
            SELECT 1 AS cd_saldo
        ),
        ultimas_datas AS (
            SELECT ps.cd_empresa, ps.cd_produto, ps.cd_saldo, MAX(ps.dt_saldo) AS dt_saldo
            FROM prd_prdsaldo ps
            INNER JOIN tipos_saldo t ON t.cd_saldo = ps.cd_saldo
            INNER JOIN prd_prdinfo pi ON pi.cd_produto = ps.cd_produto
            WHERE ps.cd_empresa = 1
              AND ps.dt_saldo < '{ref}'::date
              AND pi.in_matprima = 'T'
              AND ps.cd_produto > 1000000
              AND ps.cd_produto < 5000000
            GROUP BY ps.cd_empresa, ps.cd_produto, ps.cd_saldo
        ),
        saldo_produto AS (
            SELECT ps.cd_empresa, ps.cd_produto, SUM(ps.qt_saldo) AS qt_saldo
            FROM prd_prdsaldo ps
            INNER JOIN ultimas_datas ud
                ON ud.cd_empresa = ps.cd_empresa
               AND ud.cd_produto = ps.cd_produto
               AND ud.cd_saldo   = ps.cd_saldo
               AND ud.dt_saldo   = ps.dt_saldo
            GROUP BY ps.cd_empresa, ps.cd_produto
        ),
        estoque AS (
            SELECT SUM(
                COALESCE(sp.qt_saldo, 0) *
                COALESCE(f_prd_valor_produto2(1, 1, 'C', 2, sp.cd_produto, NULL), 0)
            ) AS valor_estoque_inicial
            FROM saldo_produto sp
        )
        SELECT
            ('{ref}'::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS dt_referencia,
            COALESCE(c.consumo_valor, 0) AS consumo_valor,
            COALESCE(e.valor_estoque_inicial, 0) AS estoque_valor,
            CASE
                WHEN COALESCE(c.consumo_valor, 0) = 0 THEN NULL
                ELSE ROUND((e.valor_estoque_inicial / c.consumo_valor)::numeric, 2)
            END AS giro
        FROM consumo c, estoque e
    """
    rows = execute_query(query)
    if not rows:
        return {"giro": None, "consumo_valor": 0, "estoque_valor": 0, "dt_referencia": None}
    row = rows[0]
    return {
        "dt_referencia": row["dt_referencia"].isoformat(),
        "consumo_valor": float(row["consumo_valor"]),
        "estoque_valor": float(row["estoque_valor"]),
        "giro": float(row["giro"]) if row["giro"] is not None else None,
    }


# ─── Giro Fábrica ─────────────────────────────────────────────────────────────

def _calcular_giro_fabrica(ref_month: date) -> dict:
    ref = ref_month.isoformat()
    query = f"""
        WITH media AS (
            SELECT SUM(t.qt_solicitada) / 12.0 AS media_mensal
            FROM vr_tra_transitem t
            WHERE t.cd_empresa = '1'
              AND t.tp_situacao = '4'
              AND t.cd_operacao IN (1, 52)
              AND t.dt_transacao >= '{ref}'::date - INTERVAL '11 months'
              AND t.dt_transacao <  '{ref}'::date + INTERVAL '1 month'
        ),
        estoque AS (
            SELECT SUM(s.qt_saldo) AS estoque_total
            FROM (
                SELECT DISTINCT ON (s.cd_produto)
                    s.cd_produto, s.qt_saldo
                FROM prd_prdsaldo s
                WHERE s.cd_empresa = 1
                  AND s.cd_saldo   = 1
                  AND s.cd_produto < 1000000
                  AND s.cd_produto <> 37051
                  AND s.dt_saldo < '{ref}'::date
                  AND EXISTS (
                      SELECT 1 FROM prd_produtoclas pc
                      WHERE pc.cd_produto = s.cd_produto AND pc.cd_tipoclas = '20'
                  )
                ORDER BY s.cd_produto, s.dt_saldo DESC
            ) s
        )
        SELECT
            ('{ref}'::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS dt_referencia,
            COALESCE(e.estoque_total, 0) AS estoque_total,
            COALESCE(m.media_mensal, 0) AS media_mensal,
            CASE
                WHEN COALESCE(m.media_mensal, 0) = 0 THEN NULL
                ELSE ROUND((e.estoque_total / m.media_mensal)::numeric, 1)
            END AS giro
        FROM estoque e, media m
    """
    rows = execute_query(query)
    if not rows:
        return {"giro": None, "estoque_total": 0, "media_mensal": 0, "dt_referencia": None}
    row = rows[0]
    return {
        "dt_referencia": row["dt_referencia"].isoformat(),
        "estoque_total": float(row["estoque_total"]),
        "media_mensal": float(row["media_mensal"]),
        "giro": float(row["giro"]) if row["giro"] is not None else None,
    }


# ─── Faturamento Fábrica + Lojas ─────────────────────────────────────────────

def _calcular_faturamento_fabrica(ref_month: date) -> dict:
    """Fábrica (empresa 1) + Lojas (exceto 1 e 120) combinados."""
    ops_fab   = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS)
    reps_excl = ", ".join(str(r) for r in REPRESENTANTES_EXCLUIDOS)
    ops_lojas = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS_LOJAS)
    ref = ref_month.isoformat()
    ano_atual_ini = f"{ref_month.year}-01-01"
    ano_ant_ini   = f"{ref_month.year - 1}-01-01"

    def sub(de: str, ate: str) -> str:
        return f"""
            SELECT SUM(liquido) AS liquido FROM (
                SELECT COALESCE(SUM(
                    CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
                ), 0) AS liquido
                FROM vr_tra_transacao t
                LEFT JOIN vr_tra_transitem i
                    ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
                WHERE t.cd_empresa = 1
                  AND t.tp_situacao = 4
                  AND t.cd_representant IS NOT NULL
                  AND t.cd_representant <> ALL (ARRAY[{reps_excl}])
                  AND t.cd_operacao NOT IN ({ops_fab})
                  AND t.dt_transacao >= '{de}'
                  AND t.dt_transacao <  {ate}
                  AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
                       OR (t.tp_modalidade IN ('3') AND t.tp_operacao = 'E'))

                UNION ALL

                SELECT COALESCE(SUM(
                    CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
                ), 0) AS liquido
                FROM vr_tra_transacao t
                LEFT JOIN vr_tra_transitem i
                    ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
                WHERE t.cd_empresa <> ALL (ARRAY[1, 120])
                  AND t.cd_operacao <> ALL (ARRAY[{ops_lojas}])
                  AND i.cd_compvend <> 1
                  AND t.tp_situacao <> 6
                  AND t.tp_modalidade IN ('2', '3', '4', '8')
                  AND t.dt_transacao >= '{de}'
                  AND t.dt_transacao <  {ate}
            ) combined
        """

    query = f"""
        WITH
        acum_ano AS ({sub(ano_atual_ini, f"'{ref}'::date + INTERVAL '1 month'")}),
        acum_ant AS ({sub(ano_ant_ini,   f"'{ref}'::date + INTERVAL '1 month' - INTERVAL '1 year'")})
        SELECT
            ('{ref}'::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS dt_referencia,
            a26.liquido AS acum_2026,
            a25.liquido AS acum_2025,
            CASE
                WHEN a25.liquido = 0 THEN NULL
                ELSE ROUND(((a26.liquido - a25.liquido) / a25.liquido * 100)::numeric, 1)
            END AS crescimento_pct
        FROM acum_ano a26, acum_ant a25
    """
    rows = execute_query(query)
    if not rows:
        return {"dt_referencia": None, "acum_2026": 0, "acum_2025": 0, "crescimento_pct": None}
    row = rows[0]
    return {
        "dt_referencia": row["dt_referencia"].isoformat(),
        "acum_2026": float(row["acum_2026"]),
        "acum_2025": float(row["acum_2025"]),
        "crescimento_pct": float(row["crescimento_pct"]) if row["crescimento_pct"] is not None else None,
    }


# ─── Faturamento E-commerce ───────────────────────────────────────────────────

def _calcular_faturamento_ecommerce(ref_month: date) -> dict:
    """E-commerce (empresa 120) — operações inclusas."""
    ops_ecom = ", ".join(str(o) for o in OPERACOES_ECOMMERCE)
    ref = ref_month.isoformat()
    ano_atual_ini = f"{ref_month.year}-01-01"
    ano_ant_ini   = f"{ref_month.year - 1}-01-01"

    def sub(de: str, ate: str) -> str:
        return f"""
            SELECT COALESCE(SUM(
                CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
            ), 0) AS liquido
            FROM vr_tra_transacao t
            LEFT JOIN vr_tra_transitem i
                ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
            WHERE t.cd_empresa = 120
              AND t.tp_situacao = 4
              AND t.cd_operacao IN ({ops_ecom})
              AND t.dt_transacao >= '{de}'
              AND t.dt_transacao <  {ate}
              AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
                   OR (t.tp_modalidade IN ('3') AND t.tp_operacao = 'E'))
        """

    query = f"""
        WITH
        acum_ano AS ({sub(ano_atual_ini, f"'{ref}'::date + INTERVAL '1 month'")}),
        acum_ant AS ({sub(ano_ant_ini,   f"'{ref}'::date + INTERVAL '1 month' - INTERVAL '1 year'")})
        SELECT
            ('{ref}'::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS dt_referencia,
            a26.liquido AS acum_2026,
            a25.liquido AS acum_2025,
            CASE
                WHEN a25.liquido = 0 THEN NULL
                ELSE ROUND(((a26.liquido - a25.liquido) / a25.liquido * 100)::numeric, 1)
            END AS crescimento_pct
        FROM acum_ano a26, acum_ant a25
    """
    rows = execute_query(query)
    if not rows:
        return {"dt_referencia": None, "acum_2026": 0, "acum_2025": 0, "crescimento_pct": None}
    row = rows[0]
    return {
        "dt_referencia": row["dt_referencia"].isoformat(),
        "acum_2026": float(row["acum_2026"]),
        "acum_2025": float(row["acum_2025"]),
        "crescimento_pct": float(row["crescimento_pct"]) if row["crescimento_pct"] is not None else None,
    }


def _criar_tabela_historico():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS indicadores_historico (
            mes DATE NOT NULL,
            indicador TEXT NOT NULL,
            dados JSONB NOT NULL,
            atualizado_em TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (mes, indicador)
        )
    """)


# ─── E-commerce Ads (ROAS + Taxa de Conversão) ───────────────────────────────

def _calcular_ecommerce_ads(ref_month: date) -> dict:
    ref = ref_month.isoformat()
    import calendar
    last_day = calendar.monthrange(ref_month.year, ref_month.month)[1]
    dt_ref = date(ref_month.year, ref_month.month, last_day).isoformat()

    # ROAS — ga4_aquisicao_conversao (CPC)
    rows_ads = execute_neon_query("""
        SELECT
            COALESCE(SUM(custo), 0)   AS custo,
            COALESCE(SUM(receita), 0) AS receita,
            COALESCE(SUM(cliques), 0) AS cliques
        FROM public.ga4_aquisicao_conversao
        WHERE meio = 'cpc'
          AND data >= %s::date
          AND data <  %s::date + INTERVAL '1 month'
    """, (ref, ref))

    # Taxa de conversão — ga4_tecnologia_geolocalizacao (Brasil)
    rows_geo = execute_neon_query("""
        SELECT
            COALESCE(SUM(sessoes_engajadas), 0) AS sessoes_engajadas,
            COALESCE(SUM(transacoes), 0)        AS transacoes
        FROM public.ga4_tecnologia_geolocalizacao
        WHERE pais = 'Brazil'
          AND data >= %s::date
          AND data <  %s::date + INTERVAL '1 month'
    """, (ref, ref))

    ads = rows_ads[0] if rows_ads else {}
    geo = rows_geo[0] if rows_geo else {}

    custo             = float(ads.get("custo", 0))
    receita           = float(ads.get("receita", 0))
    cliques           = int(ads.get("cliques", 0))
    sessoes_engajadas = int(geo.get("sessoes_engajadas", 0))
    transacoes        = int(geo.get("transacoes", 0))

    roas      = round(receita / custo, 2) if custo > 0 else None
    taxa_conv = round(transacoes / sessoes_engajadas * 100, 2) if sessoes_engajadas > 0 else None

    return {
        "dt_referencia":     dt_ref,
        "custo":             custo,
        "receita":           receita,
        "cliques":           cliques,
        "sessoes_engajadas": sessoes_engajadas,
        "transacoes":        transacoes,
        "roas":              roas,
        "taxa_conv_pct":     taxa_conv,
    }


# ─── Vendas Volume x Varejo ──────────────────────────────────────────────────

def _calcular_vendas_volume_varejo(ref_month: date) -> dict:
    ref = ref_month.isoformat()
    query = f"""
        WITH vendas AS (
            SELECT
                t.ds_sigla AS tipo_tabela,
                COALESCE(SUM(i.vl_solicitado), 0) AS valor_total
            FROM vr_ped_pedidoc2 c
            LEFT JOIN vr_ped_pedidoi i
                ON c.cd_empresa = i.cd_empresa AND i.cd_pedido = c.cd_pedido
            LEFT JOIN vr_ped_tabprecoc t
                ON i.cd_tabpreco = t.cd_tabpreco
            WHERE c.dt_pedido >= '{ref}'::date
              AND c.dt_pedido <  '{ref}'::date + INTERVAL '1 month'
              AND c.cd_cliente <> 110000001
              AND c.cd_representant <> 32098
              AND c.tp_situacao <> 6
              AND c.cd_empresa = 1
              AND c.cd_operacao IN (1, 18, 52, 166, 148, 98, 55, 97, 30, 79, 93,
                                    137, 141, 142, 156, 159, 310, 598, 180, 58,
                                    69, 85, 124, 182)
              AND t.ds_sigla IN ('VAREJO', 'VOLUME')
            GROUP BY t.ds_sigla
        ),
        total AS (SELECT SUM(valor_total) AS total_valor FROM vendas)
        SELECT
            v.tipo_tabela,
            v.valor_total,
            ROUND((v.valor_total / NULLIF(t.total_valor, 0) * 100)::numeric, 2) AS percentual
        FROM vendas v, total t
        ORDER BY v.tipo_tabela
    """
    rows = execute_query(query)
    import calendar
    last_day = calendar.monthrange(ref_month.year, ref_month.month)[1]
    result = {
        "dt_referencia": date(ref_month.year, ref_month.month, last_day).isoformat(),
        "volume_valor": 0.0,
        "varejo_valor": 0.0,
        "total_valor": 0.0,
        "volume_pct": None,
        "varejo_pct": None,
    }

    total_val = 0.0
    for row in rows:
        val = float(row["valor_total"])
        pct = float(row["percentual"]) if row["percentual"] is not None else None
        total_val += val
        if row["tipo_tabela"] == "VOLUME":
            result["volume_valor"] = val
            result["volume_pct"] = pct
        elif row["tipo_tabela"] == "VAREJO":
            result["varejo_valor"] = val
            result["varejo_pct"] = pct
    result["total_valor"] = total_val
    return result


# ─── Quebra de Pedidos ───────────────────────────────────────────────────────

def _calcular_quebra_pedidos(ref_month: date) -> dict:
    ops_fab   = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS)
    reps_excl = ", ".join(str(r) for r in REPRESENTANTES_EXCLUIDOS)
    ref = ref_month.isoformat()

    query = f"""
        WITH ult AS (
            SELECT a.*, ROW_NUMBER() OVER (
                PARTITION BY a.cd_empresa, a.cd_pedido, a.cd_produto
                ORDER BY a.dt_cadastro DESC
            ) AS rn
            FROM vr_ped_pedidoicanc2 a
            WHERE a.dt_cadastro >= '{ref}'::date
              AND a.dt_cadastro <  '{ref}'::date + INTERVAL '1 month'
        ),
        quebra AS (
            SELECT COALESCE(SUM(b.vl_unitario * b.qt_cancelada), 0) AS quebra_valor
            FROM ult u
            JOIN vr_ped_pedidoi b
                ON u.cd_pedido = b.cd_pedido
               AND u.cd_empresa = b.cd_empresa
               AND u.cd_produto = b.cd_produto
            WHERE u.rn = 1
              AND u.cd_motivocanc = 6
              AND b.cd_operacao IN (52, 1)
        ),
        fat_mes AS (
            SELECT COALESCE(SUM(
                CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
            ), 0) AS faturamento_mes
            FROM vr_tra_transacao t
            LEFT JOIN vr_tra_transitem i
                ON i.cd_empresa = t.cd_empresa
               AND i.dt_transacao = t.dt_transacao
               AND i.nr_transacao = t.nr_transacao
            WHERE t.cd_empresa = 1
              AND t.tp_situacao = 4
              AND t.cd_representant IS NOT NULL
              AND t.cd_representant <> ALL (ARRAY[{reps_excl}])
              AND t.cd_operacao NOT IN ({ops_fab})
              AND t.dt_transacao >= '{ref}'::date
              AND t.dt_transacao <  '{ref}'::date + INTERVAL '1 month'
              AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
                   OR (t.tp_modalidade IN ('3') AND t.tp_operacao = 'E'))
        )
        SELECT
            ('{ref}'::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS dt_referencia,
            q.quebra_valor,
            f.faturamento_mes,
            CASE
                WHEN f.faturamento_mes = 0 THEN NULL
                ELSE ROUND((q.quebra_valor / f.faturamento_mes * 100)::numeric, 2)
            END AS quebra_pct
        FROM quebra q, fat_mes f
    """
    rows = execute_query(query)
    if not rows:
        return {"dt_referencia": None, "quebra_valor": 0, "faturamento_mes": 0, "quebra_pct": None}
    row = rows[0]
    return {
        "dt_referencia": row["dt_referencia"].isoformat(),
        "quebra_valor": float(row["quebra_valor"]),
        "faturamento_mes": float(row["faturamento_mes"]),
        "quebra_pct": float(row["quebra_pct"]) if row["quebra_pct"] is not None else None,
    }


# ─── Endpoints tempo real ─────────────────────────────────────────────────────

@router.get("/api/indicadores/giro-lojas")
def get_giro_estoque_lojas():
    return _calcular_giro_lojas(date.today().replace(day=1))


@router.get("/api/indicadores/giro-mp")
def get_giro_mp():
    return _calcular_giro_mp(date.today().replace(day=1))


@router.get("/api/indicadores/giro-fabrica")
def get_giro_fabrica():
    return _calcular_giro_fabrica(date.today().replace(day=1))


@router.get("/api/indicadores/faturamento-fabrica")
def get_faturamento_fabrica():
    return _calcular_faturamento_fabrica(date.today().replace(day=1))


@router.get("/api/indicadores/faturamento-ecommerce")
def get_faturamento_ecommerce():
    return _calcular_faturamento_ecommerce(date.today().replace(day=1))


@router.get("/api/indicadores/quebra-pedidos")
def get_quebra_pedidos():
    return _calcular_quebra_pedidos(date.today().replace(day=1))


@router.get("/api/indicadores/vendas-volume-varejo")
def get_vendas_volume_varejo():
    return _calcular_vendas_volume_varejo(date.today().replace(day=1))


@router.get("/api/indicadores/ecommerce-ads")
def get_ecommerce_ads():
    return _calcular_ecommerce_ads(date.today().replace(day=1))


# ─── CMV % (Custo Mercadoria Vendida / Receita Liquida) ───────────────────────

def _calcular_cmv_pct(ref_month: date) -> dict:
    """
    Calcula o percentual de CMV sobre Receita Liquida para o mes.
    CMV % = CMV / Receita Liquida * 100
    Considera todas as empresas (consolidado).
    """
    import calendar
    ref = ref_month.isoformat()
    last_day = calendar.monthrange(ref_month.year, ref_month.month)[1]
    dt_ref = date(ref_month.year, ref_month.month, last_day).isoformat()

    # Buscar CMV da fabrica (mv_cmv_fab)
    cmv_fab = execute_query("""
        SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv
        FROM mv_cmv_fab
        WHERE data >= %s AND data < %s::date + INTERVAL '1 month'
    """, (ref, ref))

    # Buscar CMV das lojas (mv_cmv_loja)
    cmv_loja = execute_query("""
        SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv
        FROM mv_cmv_loja
        WHERE data >= %s AND data < %s::date + INTERVAL '1 month'
    """, (ref, ref))

    cmv_total = float(cmv_fab[0]['cmv'] if cmv_fab else 0) + float(cmv_loja[0]['cmv'] if cmv_loja else 0)

    # Buscar Receita Bruta (vendas)
    vendas = execute_query("""
        SELECT COALESCE(SUM(t.vl_transacao), 0) AS valor
        FROM vr_tra_transacao t
        WHERE t.dt_transacao >= %s
          AND t.dt_transacao < %s::date + INTERVAL '1 month'
          AND t.tp_situacao = 4
          AND t.tp_modalidade IN ('4')
          AND t.tp_operacao = 'S'
          AND t.cd_empresa NOT IN (50, 100, 110, 9, 11, 12, 13, 16, 18)
    """, (ref, ref))

    # Buscar Devolucoes
    devolucoes = execute_query("""
        SELECT COALESCE(SUM(t.vl_transacao), 0) AS valor
        FROM vr_tra_transacao t
        WHERE t.dt_transacao >= %s
          AND t.dt_transacao < %s::date + INTERVAL '1 month'
          AND t.tp_situacao = 4
          AND t.tp_modalidade IN ('3')
          AND t.tp_operacao = 'E'
          AND t.cd_empresa NOT IN (50, 100, 110, 9, 11, 12, 13, 16, 18)
    """, (ref, ref))

    receita_bruta = float(vendas[0]['valor'] if vendas else 0)
    devolucoes_valor = float(devolucoes[0]['valor'] if devolucoes else 0)
    receita_liquida = receita_bruta - devolucoes_valor

    cmv_pct = round((cmv_total / receita_liquida * 100), 2) if receita_liquida > 0 else None

    return {
        "dt_referencia": dt_ref,
        "cmv_valor": cmv_total,
        "receita_liquida": receita_liquida,
        "cmv_pct": cmv_pct,
    }


@router.get("/api/indicadores/cmv-pct")
def get_cmv_pct():
    return _calcular_cmv_pct(date.today().replace(day=1))


# ─── Lucro Liquido % (12 meses) ───────────────────────────────────────────────

# Centros de custo para análise (Fábrica + Lojas)
CCUSTOS_FABRICA = [1, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 514]
CCUSTOS_LOJAS = {
    2: 'LIEBE MARAPONGA',
    3: 'LIEBE IGUATEMI',
    4: 'LIEBE TABOSA',
    5: 'LIEBE NORTH',
    6: 'LIEBE DOM LUIS',
    7: 'LIEBE PARANGABA',
    8: 'LIEBE RIO MAR',
    10: 'LIEBE SALVADOR SHOPPING',
    14: 'LIEBE MORUMBI',
    15: 'LIEBE RIO MAR RECIFE',
    17: 'LIEBE NORTH JOQUEI',
    19: 'LIEBE PORTO ALEGRE',
    20: 'LIEBE RIOMAR KENNEDY',
    21: 'INTIMATES',
    22: 'ECOMMERCE',
    120: 'ECOMMERCE ANGELICA',
}

def _calcular_lucro_liq_pct(ref_month: date) -> dict:
    """
    Calcula o percentual de empresas com Lucro Liquido > 0 nos ultimos 12 meses.
    Considera todas as empresas (Fabrica + Lojas).
    """
    import calendar
    from dateutil.relativedelta import relativedelta

    # Calcular periodo dos ultimos 12 meses
    mes_fim = ref_month
    mes_inicio = ref_month - relativedelta(months=11)

    data_inicio = mes_inicio.isoformat()
    data_fim = (mes_fim + relativedelta(months=1) - relativedelta(days=1)).isoformat()
    last_day = calendar.monthrange(ref_month.year, ref_month.month)[1]
    dt_ref = date(ref_month.year, ref_month.month, last_day).isoformat()

    # Lista de todos os centros de custo para analise
    todos_ccustos = CCUSTOS_FABRICA + list(CCUSTOS_LOJAS.keys())
    ccusto_placeholders = ",".join(["%s"] * len(todos_ccustos))

    # Buscar despesas por centro de custo
    query_despesas = f"""
        SELECT
            d.cd_ccusto,
            SUM(ABS(d.vl_rateio)) as total_despesas
        FROM vr_fcp_despduplicatai d
        WHERE d.dt_emissao >= %s
          AND d.dt_emissao <= %s
          AND d.tp_situacao = 'N'
          AND d.cd_empresa NOT IN (50, 100, 110, 9, 11, 12, 13, 16, 18)
          AND d.cd_ccusto IN ({ccusto_placeholders})
          AND d.cd_ccusto NOT IN (50, 100, 110)
        GROUP BY d.cd_ccusto
    """

    despesas = execute_query(query_despesas, (data_inicio, data_fim, *todos_ccustos))

    # Montar mapa de despesas por ccusto
    despesas_por_ccusto = {}
    for d in despesas:
        despesas_por_ccusto[d['cd_ccusto']] = float(d['total_despesas'])

    # Buscar CMV por empresa (lojas)
    cmv_lojas = execute_query("""
        SELECT cd_empresa, ABS(COALESCE(SUM(valor), 0)) AS cmv
        FROM mv_cmv_loja
        WHERE data >= %s AND data <= %s
        GROUP BY cd_empresa
    """, (data_inicio, data_fim))

    cmv_por_empresa = {}
    for c in cmv_lojas:
        cmv_por_empresa[c['cd_empresa']] = float(c['cmv'])

    # CMV fabrica (total)
    cmv_fab = execute_query("""
        SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv
        FROM mv_cmv_fab
        WHERE data >= %s AND data <= %s
    """, (data_inicio, data_fim))

    cmv_fabrica_total = float(cmv_fab[0]['cmv'] if cmv_fab else 0)

    # Buscar receita por empresa
    receita_por_empresa = execute_query("""
        SELECT
            cd_empresa,
            COALESCE(SUM(CASE WHEN tp_modalidade = '4' AND tp_operacao = 'S' THEN vl_transacao ELSE 0 END), 0) AS vendas,
            COALESCE(SUM(CASE WHEN tp_modalidade = '3' AND tp_operacao = 'E' THEN vl_transacao ELSE 0 END), 0) AS devolucoes
        FROM vr_tra_transacao
        WHERE dt_transacao >= %s
          AND dt_transacao <= %s
          AND tp_situacao = 4
          AND cd_empresa NOT IN (50, 100, 110, 9, 11, 12, 13, 16, 18)
        GROUP BY cd_empresa
    """, (data_inicio, data_fim))

    receita_map = {}
    for r in receita_por_empresa:
        receita_map[r['cd_empresa']] = float(r['vendas']) - float(r['devolucoes'])

    # Calcular lucro por centro de custo
    # Para a fabrica: usar ccustos da fabrica como um grupo
    # Para lojas: cada empresa/ccusto individual

    empresas_positivas = 0
    total_empresas = 0
    detalhes = []

    # Fabrica (consolidado como uma entidade)
    despesas_fabrica = sum(despesas_por_ccusto.get(cc, 0) for cc in CCUSTOS_FABRICA)
    receita_fabrica = receita_map.get(1, 0)
    lucro_fabrica = receita_fabrica - cmv_fabrica_total - despesas_fabrica

    total_empresas += 1
    if lucro_fabrica > 0:
        empresas_positivas += 1
    detalhes.append({
        "nome": "FABRICA",
        "receita": receita_fabrica,
        "cmv": cmv_fabrica_total,
        "despesas": despesas_fabrica,
        "lucro": lucro_fabrica,
        "positivo": lucro_fabrica > 0
    })

    # Lojas (cada uma individual)
    for cd_empresa, nome in CCUSTOS_LOJAS.items():
        despesas_loja = despesas_por_ccusto.get(cd_empresa, 0)
        cmv_loja = cmv_por_empresa.get(cd_empresa, 0)
        receita_loja = receita_map.get(cd_empresa, 0)

        # Se não tiver receita, pular
        if receita_loja == 0 and despesas_loja == 0:
            continue

        lucro_loja = receita_loja - cmv_loja - despesas_loja

        total_empresas += 1
        if lucro_loja > 0:
            empresas_positivas += 1
        detalhes.append({
            "nome": nome,
            "receita": receita_loja,
            "cmv": cmv_loja,
            "despesas": despesas_loja,
            "lucro": lucro_loja,
            "positivo": lucro_loja > 0
        })

    pct_positivas = round((empresas_positivas / total_empresas * 100), 1) if total_empresas > 0 else None

    return {
        "dt_referencia": dt_ref,
        "periodo_meses": 12,
        "data_inicio": data_inicio,
        "data_fim": data_fim,
        "total_empresas": total_empresas,
        "empresas_positivas": empresas_positivas,
        "empresas_negativas": total_empresas - empresas_positivas,
        "pct_positivas": pct_positivas,
        "detalhes": detalhes,
    }


@router.get("/api/indicadores/lucro-liq-pct")
def get_lucro_liq_pct():
    return _calcular_lucro_liq_pct(date.today().replace(day=1))


# ─── Sobra de MP (Materia Prima) ──────────────────────────────────────────────

def _calcular_sobra_mp(ref_month: date) -> dict:
    """
    Calcula a sobra de MP baseado no indicador_geral.
    Formula: (sobra / solicitada) * 100
    """
    import calendar
    last_day = calendar.monthrange(ref_month.year, ref_month.month)[1]
    dt_ref = date(ref_month.year, ref_month.month, last_day).isoformat()

    query = """
        WITH produtos_classe_2 AS (
            SELECT f.cd_produtomp
            FROM vr_pcp_fcconsumo f
            LEFT JOIN prd_produtoclas cc ON cc.cd_produto = f.cd_produtopa
            WHERE cc.cd_tipoclas = 802
            GROUP BY f.cd_produtomp HAVING COUNT(DISTINCT TRIM(cc.cd_classificacao)) = 1 AND MAX(TRIM(cc.cd_classificacao)) = '2'
        ),
        consumo_mp AS (
            SELECT
                f.cd_produtopa,
                f.cd_produtomp,
                f.qt_consumo * (a.qt_lote - COALESCE(a.qt_gerouop,0)) AS consumo_plano,
                f.qt_consumo * COALESCE((SELECT SUM(COALESCE(aa.qt_real,0) - COALESCE(aa.qt_finalizada,0))
                    FROM vr_pcp_opi aa
                    JOIN vr_pcp_opc bb
                    ON aa.cd_empresa = bb.cd_empresa AND aa.nr_ciclo = bb.nr_ciclo AND aa.nr_op = bb.nr_op
                    WHERE aa.cd_empresa = 1 AND aa.cd_produto = f.cd_produtopa AND COALESCE(bb.cd_categoria,0) <> 15 AND aa.tp_situacao IN (5,10,15,20)),0) AS consumo_op
            FROM vr_pcp_fcconsumo f
            LEFT JOIN vr_pcp_lotepl2 a ON a.cd_produto = f.cd_produtopa
            LEFT JOIN pcp_lotepv p ON a.nr_lote = p.nr_lote
            LEFT JOIN prd_produtoclas cc ON cc.cd_produto = a.cd_produto
            WHERE p.tp_situacao = 1
                AND cc.cd_classificacao = '0044      '
                AND cd_auxiliar IS NOT NULL AND f.cd_produtomp IN (SELECT cd_produtomp FROM produtos_classe_2)),
        dados AS (
            SELECT
                m.cd_produtomp,
                f_dic_sld_cmp_pedido('p','1',m.cd_produtomp,NULL) AS compra_pendente,
                f_dic_sld_prd_produto('1','1',m.cd_produtomp,NULL::timestamp) AS estoque_fisico,
                f_dic_sld_prd_produto('1','2',m.cd_produtomp,NULL::timestamp) AS estoque_inspecao,
                f_dic_sld_prd_produto('1','15',m.cd_produtomp,NULL::timestamp) AS estoque_corte,
                COALESCE(SUM(m.consumo_plano),0) AS consumomp_plano,
                COALESCE(SUM(m.consumo_op),0) AS consumomp_op,
                (COALESCE(f_dic_sld_prd_produto('1','1',m.cd_produtomp,NULL::timestamp),0) +
                 COALESCE(f_dic_sld_prd_produto('1','2',m.cd_produtomp,NULL::timestamp),0) +
                 COALESCE(f_dic_sld_prd_produto('1','15',m.cd_produtomp,NULL::timestamp),0))
                    -
                (COALESCE(SUM(m.consumo_plano),0) + COALESCE(SUM(m.consumo_op),0)) AS sobra,
                COALESCE(f_dic_sld_cmp_pedido('S','1',m.cd_produtomp,NULL),0) AS solicitada
            FROM consumo_mp m
            GROUP BY m.cd_produtomp
        )
        SELECT
            SUM(sobra) AS total_sobra,
            SUM(solicitada) AS total_solicitada,
            CASE
                WHEN SUM(solicitada) > 0 THEN ROUND((SUM(sobra) / SUM(solicitada)) * 100, 2)
                ELSE 0
            END AS indicador_geral
        FROM dados
    """

    try:
        import time
        inicio = time.time()
        print(f"[SOBRA MP] Iniciando query...")
        rows = execute_query(query)
        duracao = time.time() - inicio
        print(f"[SOBRA MP] Query executada em {duracao:.2f}s. Rows: {len(rows) if rows else 0}")

        if not rows or len(rows) == 0:
            print(f"[SOBRA MP] Nenhum resultado retornado")
            return {
                "dt_referencia": dt_ref,
                "sobra_mp_pct": None,
                "total_sobra": 0,
                "total_solicitada": 0,
            }

        row = rows[0]
        print(f"[SOBRA MP] Resultado: total_sobra={row.get('total_sobra')}, total_solicitada={row.get('total_solicitada')}, indicador_geral={row.get('indicador_geral')}")

        if row['indicador_geral'] is None:
            return {
                "dt_referencia": dt_ref,
                "sobra_mp_pct": None,
                "total_sobra": 0,
                "total_solicitada": 0,
            }

        return {
            "dt_referencia": dt_ref,
            "sobra_mp_pct": float(row['indicador_geral']) if row['indicador_geral'] is not None else None,
            "total_sobra": float(row['total_sobra'] or 0),
            "total_solicitada": float(row['total_solicitada'] or 0),
        }
    except Exception as e:
        import traceback
        print(f"[SOBRA MP] Erro ao calcular: {e}")
        print(f"[SOBRA MP] Traceback: {traceback.format_exc()}")
        return {
            "dt_referencia": dt_ref,
            "sobra_mp_pct": None,
            "total_sobra": 0,
            "total_solicitada": 0,
        }


@router.get("/api/indicadores/sobra-mp")
def get_sobra_mp():
    return _calcular_sobra_mp(date.today().replace(day=1))


# ─── Cache histórico ──────────────────────────────────────────────────────────

_INDICADORES_FNS = [
    ("giro_lojas",            lambda m: _calcular_giro_lojas(m)),
    ("giro_mp",               lambda m: _calcular_giro_mp(m)),
    ("giro_fabrica",          lambda m: _calcular_giro_fabrica(m)),
    ("faturamento_fabrica",   lambda m: _calcular_faturamento_fabrica(m)),
    ("faturamento_ecommerce", lambda m: _calcular_faturamento_ecommerce(m)),
    ("quebra_pedidos",        lambda m: _calcular_quebra_pedidos(m)),
    ("vendas_volume_varejo",  lambda m: _calcular_vendas_volume_varejo(m)),
    ("ecommerce_ads",         lambda m: _calcular_ecommerce_ads(m)),
    ("cmv_pct",               lambda m: _calcular_cmv_pct(m)),
    ("lucro_liq_pct",         lambda m: _calcular_lucro_liq_pct(m)),
    ("sobra_mp",              lambda m: _calcular_sobra_mp(m)),
]


def _executar_sincronizacao():
    global _sync_status
    meses = _meses_2026_ate_hoje()
    total = len(meses) * len(_INDICADORES_FNS)
    inicio = time.time()

    _sync_status = {
        "rodando": True,
        "progresso": 0,
        "total": total,
        "iniciado_em": datetime.now().isoformat(),
        "finalizado_em": None,
        "duracao_segundos": None,
    }

    _criar_tabela_historico()

    for ref_month in meses:
        mes_str = ref_month.isoformat()
        for indicador, fn in _INDICADORES_FNS:
            try:
                dados = fn(ref_month)
                execute_insert("""
                    INSERT INTO indicadores_historico (mes, indicador, dados, atualizado_em)
                    VALUES (%s, %s, %s::jsonb, NOW())
                    ON CONFLICT (mes, indicador) DO UPDATE
                    SET dados = EXCLUDED.dados, atualizado_em = NOW()
                """, (mes_str, indicador, json.dumps(dados)))
                print(f"[SYNC] {mes_str}/{indicador} OK")
            except Exception as e:
                print(f"[SYNC] ERRO {mes_str}/{indicador}: {e}")
            finally:
                _sync_status["progresso"] += 1

    duracao = round(time.time() - inicio)
    _sync_status.update({
        "rodando": False,
        "finalizado_em": datetime.now().isoformat(),
        "duracao_segundos": duracao,
    })
    print(f"[SYNC] Concluido em {duracao}s")


@router.post("/api/indicadores/cache/sincronizar")
def sincronizar_cache(background_tasks: BackgroundTasks):
    if _sync_status.get("rodando"):
        return {"status": "ja_rodando", "mensagem": "Sincronizacao ja em andamento"}
    background_tasks.add_task(_executar_sincronizacao)
    return {"status": "iniciado"}


@router.get("/api/indicadores/cache/status")
def get_sync_status():
    return _sync_status


@router.get("/api/indicadores/historico")
def get_historico():
    _criar_tabela_historico()
    rows = execute_query("""
        SELECT mes, indicador, dados, atualizado_em
        FROM indicadores_historico
        WHERE mes >= '2026-01-01'
        ORDER BY mes, indicador
    """)

    por_mes: dict = {}
    for row in rows:
        mes = row["mes"].isoformat()
        if mes not in por_mes:
            por_mes[mes] = {"mes": mes, "atualizado_em": row["atualizado_em"].isoformat()}
        por_mes[mes][row["indicador"]] = row["dados"]

    return {"meses": list(por_mes.values())}


@router.post("/api/indicadores/cache/forcar/{indicador}")
def forcar_indicador(indicador: str):
    """Forca atualizacao de um indicador especifico para o mes atual"""
    _criar_tabela_historico()

    # Encontrar a funcao do indicador
    fn = None
    for nome, func in _INDICADORES_FNS:
        if nome == indicador:
            fn = func
            break

    if fn is None:
        return {"erro": f"Indicador '{indicador}' nao encontrado", "disponiveis": [n for n, _ in _INDICADORES_FNS]}

    ref_month = date.today().replace(day=1)
    mes_str = ref_month.isoformat()

    try:
        dados = fn(ref_month)
        execute_insert("""
            INSERT INTO indicadores_historico (mes, indicador, dados, atualizado_em)
            VALUES (%s, %s, %s::jsonb, NOW())
            ON CONFLICT (mes, indicador) DO UPDATE
            SET dados = EXCLUDED.dados, atualizado_em = NOW()
        """, (mes_str, indicador, json.dumps(dados)))

        return {"status": "ok", "indicador": indicador, "mes": mes_str, "dados": dados}
    except Exception as e:
        import traceback
        return {"status": "erro", "erro": str(e), "traceback": traceback.format_exc()}
