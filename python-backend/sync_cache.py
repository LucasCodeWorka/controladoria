#!/usr/bin/env python3
"""
Sincronizador de cache — standalone, sem dependências do projeto.

Instalar dependências (uma vez):
    pip install psycopg2-binary python-dotenv

Agendar no Windows (Task Scheduler):
    Programa  : python.exe
    Argumentos: C:\\caminho\\para\\sync_cache.py
    Iniciar em: C:\\caminho\\para\\  (pasta onde está o .env)

Agendar no Mac/Linux (crontab -e):
    0 6 * * * cd /caminho/para && python3 sync_cache.py >> sync.log 2>&1
"""

import sys
import json
import time
import calendar
import psycopg2
import psycopg2.extras
from pathlib import Path
from datetime import date, datetime
from dotenv import load_dotenv
import os

load_dotenv(Path(__file__).parent / '.env')

# ─── Constantes ───────────────────────────────────────────────────────────────

EMPRESAS_LOJAS         = [2, 3, 4, 5, 6, 7, 8, 10, 14, 15, 17, 19, 20, 21, 22, 120]
OPERACOES_EXCLUIDAS    = (24, 25, 26, 27, 273, 44, 58, 76, 85, 109, 118, 140, 173, 175, 221, 240, 241, 242, 243, 244, 245, 239, 238, 237, 236, 440)
REPRESENTANTES_EXCL    = (43923, 30193, 4135)
OPERACOES_EXCL_LOJAS   = (140, 76, 25, 26, 27, 273, 44, 240, 241, 242, 243, 244, 245, 239, 238, 237, 236)
OPERACOES_ECOMMERCE    = (24, 25, 26, 27, 240, 241, 242, 243, 244, 239, 238, 237, 236)


# ─── Conexões ─────────────────────────────────────────────────────────────────

def conn_principal():
    return psycopg2.connect(
        host=os.getenv('DB_HOST'),
        port=int(os.getenv('DB_PORT', 5432)),
        database=os.getenv('DB_NAME'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD', '').strip('\'"'),
    )

def conn_neon():
    return psycopg2.connect(dsn=os.getenv('NEON_DATABASE_URL'))

def query(conn, sql, params=None):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return cur.fetchall()

def upsert(conn, mes: str, indicador: str, dados: dict):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO indicadores_historico (mes, indicador, dados, atualizado_em)
            VALUES (%s, %s, %s::jsonb, NOW())
            ON CONFLICT (mes, indicador) DO UPDATE
            SET dados = EXCLUDED.dados, atualizado_em = NOW()
        """, (mes, indicador, json.dumps(dados)))
    conn.commit()

def criar_tabela(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS indicadores_historico (
                mes          DATE NOT NULL,
                indicador    TEXT NOT NULL,
                dados        JSONB NOT NULL,
                atualizado_em TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (mes, indicador)
            )
        """)
    conn.commit()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def ultimo_dia(ref: date) -> str:
    return date(ref.year, ref.month, calendar.monthrange(ref.year, ref.month)[1]).isoformat()

def meses_2026_ate_hoje():
    hoje = date.today()
    return [date(2026, m, 1) for m in range(1, 13) if date(2026, m, 1) <= hoje.replace(day=1)]

def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# ─── Indicadores — banco principal ────────────────────────────────────────────

def calc_giro_lojas(conn, ref: date) -> dict:
    empresas = ", ".join(str(e) for e in EMPRESAS_LOJAS)
    r = ref.isoformat()
    rows = query(conn, f"""
        WITH estoque AS (
            SELECT sum(s.qt_saldo) AS estoque_total
            FROM (
                SELECT DISTINCT ON (s1.cd_empresa, s1.cd_produto)
                    s1.cd_empresa, s1.cd_produto, s1.qt_saldo
                FROM prd_prdsaldo s1
                WHERE s1.cd_empresa = ANY (ARRAY[{empresas}])
                  AND s1.cd_saldo = 1
                  AND s1.dt_saldo < '{r}'::date
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
              AND t.dt_transacao >= '{r}'::date - INTERVAL '11 months'
              AND t.dt_transacao <  '{r}'::date + INTERVAL '1 month'
        )
        SELECT
            COALESCE(estoque.estoque_total, 0) AS estoque_total,
            COALESCE(media.media_mensal, 0)    AS media_mensal,
            CASE
                WHEN COALESCE(estoque.estoque_total, 0) > 0
                THEN ROUND((media.media_mensal / estoque.estoque_total)::numeric, 2)
                ELSE 0
            END AS giro
        FROM estoque, media
    """)
    row = rows[0] if rows else {}
    return {
        "dt_referencia": ultimo_dia(ref),
        "estoque_total": float(row.get("estoque_total") or 0),
        "media_mensal":  float(row.get("media_mensal") or 0),
        "giro":          float(row.get("giro") or 0),
    }


def calc_giro_mp(conn, ref: date) -> dict:
    r = ref.isoformat()
    rows = query(conn, f"""
        WITH consumo AS (
            SELECT SUM(a.vl_totalliquido) AS consumo_valor
            FROM vr_tra_transitem a
            INNER JOIN vr_tra_transacao b
                ON a.nr_transacao = b.nr_transacao AND a.cd_empresa = b.cd_empresa
            WHERE a.tp_situacao = 4
              AND b.cd_operacao IN (100, 150, 210, 219)
              AND a.tp_operacao = 'S'
              AND a.dt_transacao >= '{r}'::date
              AND a.dt_transacao <  '{r}'::date + INTERVAL '1 month'
        ),
        tipos_saldo AS (
            SELECT ts.cd_saldof AS cd_saldo FROM prd_tiposaldof ts WHERE ts.cd_saldo = 1
            UNION SELECT 1
        ),
        ultimas_datas AS (
            SELECT ps.cd_empresa, ps.cd_produto, ps.cd_saldo, MAX(ps.dt_saldo) AS dt_saldo
            FROM prd_prdsaldo ps
            INNER JOIN tipos_saldo t  ON t.cd_saldo  = ps.cd_saldo
            INNER JOIN prd_prdinfo pi ON pi.cd_produto = ps.cd_produto
            WHERE ps.cd_empresa = 1
              AND ps.dt_saldo < '{r}'::date
              AND pi.in_matprima = 'T'
              AND ps.cd_produto > 1000000
              AND ps.cd_produto < 5000000
            GROUP BY ps.cd_empresa, ps.cd_produto, ps.cd_saldo
        ),
        saldo_produto AS (
            SELECT ps.cd_empresa, ps.cd_produto, SUM(ps.qt_saldo) AS qt_saldo
            FROM prd_prdsaldo ps
            INNER JOIN ultimas_datas ud
                ON ud.cd_empresa = ps.cd_empresa AND ud.cd_produto = ps.cd_produto
               AND ud.cd_saldo   = ps.cd_saldo   AND ud.dt_saldo   = ps.dt_saldo
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
            COALESCE(c.consumo_valor, 0)        AS consumo_valor,
            COALESCE(e.valor_estoque_inicial, 0) AS estoque_valor,
            CASE
                WHEN COALESCE(c.consumo_valor, 0) = 0 THEN NULL
                ELSE ROUND((e.valor_estoque_inicial / c.consumo_valor)::numeric, 2)
            END AS giro
        FROM consumo c, estoque e
    """)
    row = rows[0] if rows else {}
    giro = row.get("giro")
    return {
        "dt_referencia": ultimo_dia(ref),
        "consumo_valor": float(row.get("consumo_valor") or 0),
        "estoque_valor": float(row.get("estoque_valor") or 0),
        "giro":          float(giro) if giro is not None else None,
    }


def calc_giro_fabrica(conn, ref: date) -> dict:
    r = ref.isoformat()
    rows = query(conn, f"""
        WITH media AS (
            SELECT SUM(t.qt_solicitada) / 12.0 AS media_mensal
            FROM vr_tra_transitem t
            WHERE t.cd_empresa = '1'
              AND t.tp_situacao = '4'
              AND t.cd_operacao IN (1, 52)
              AND t.dt_transacao >= '{r}'::date - INTERVAL '11 months'
              AND t.dt_transacao <  '{r}'::date + INTERVAL '1 month'
        ),
        estoque AS (
            SELECT SUM(s.qt_saldo) AS estoque_total
            FROM (
                SELECT DISTINCT ON (s.cd_produto) s.cd_produto, s.qt_saldo
                FROM prd_prdsaldo s
                WHERE s.cd_empresa = 1
                  AND s.cd_saldo   = 1
                  AND s.cd_produto < 1000000
                  AND s.cd_produto <> 37051
                  AND s.dt_saldo < '{r}'::date
                  AND EXISTS (
                      SELECT 1 FROM prd_produtoclas pc
                      WHERE pc.cd_produto = s.cd_produto AND pc.cd_tipoclas = '20'
                  )
                ORDER BY s.cd_produto, s.dt_saldo DESC
            ) s
        )
        SELECT
            COALESCE(e.estoque_total, 0) AS estoque_total,
            COALESCE(m.media_mensal, 0)  AS media_mensal,
            CASE
                WHEN COALESCE(m.media_mensal, 0) = 0 THEN NULL
                ELSE ROUND((e.estoque_total / m.media_mensal)::numeric, 1)
            END AS giro
        FROM estoque e, media m
    """)
    row = rows[0] if rows else {}
    giro = row.get("giro")
    return {
        "dt_referencia": ultimo_dia(ref),
        "estoque_total": float(row.get("estoque_total") or 0),
        "media_mensal":  float(row.get("media_mensal") or 0),
        "giro":          float(giro) if giro is not None else None,
    }


def calc_faturamento_fabrica(conn, ref: date) -> dict:
    ops_fab   = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS)
    reps_excl = ", ".join(str(r) for r in REPRESENTANTES_EXCL)
    ops_lojas = ", ".join(str(o) for o in OPERACOES_EXCL_LOJAS)
    r   = ref.isoformat()
    ini = f"{ref.year}-01-01"
    ini_ant = f"{ref.year - 1}-01-01"

    def sub(de, ate):
        return f"""
            SELECT SUM(liquido) AS liquido FROM (
                SELECT COALESCE(SUM(
                    CASE WHEN t.tp_operacao='S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
                ),0) AS liquido
                FROM vr_tra_transacao t
                LEFT JOIN vr_tra_transitem i
                    ON i.cd_empresa=t.cd_empresa AND i.dt_transacao=t.dt_transacao AND i.nr_transacao=t.nr_transacao
                WHERE t.cd_empresa = 1
                  AND t.tp_situacao = 4
                  AND t.cd_representant IS NOT NULL
                  AND t.cd_representant <> ALL (ARRAY[{reps_excl}])
                  AND t.cd_operacao NOT IN ({ops_fab})
                  AND t.dt_transacao >= '{de}'
                  AND t.dt_transacao <  {ate}
                  AND ((t.tp_modalidade IN ('4','8') AND t.tp_operacao='S')
                       OR (t.tp_modalidade='3' AND t.tp_operacao='E'))
                UNION ALL
                SELECT COALESCE(SUM(
                    CASE WHEN t.tp_operacao='S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
                ),0) AS liquido
                FROM vr_tra_transacao t
                LEFT JOIN vr_tra_transitem i
                    ON i.cd_empresa=t.cd_empresa AND i.dt_transacao=t.dt_transacao AND i.nr_transacao=t.nr_transacao
                WHERE t.cd_empresa <> ALL (ARRAY[1, 120])
                  AND t.cd_operacao <> ALL (ARRAY[{ops_lojas}])
                  AND i.cd_compvend <> 1
                  AND t.tp_situacao <> 6
                  AND t.tp_modalidade IN ('2','3','4','8')
                  AND t.dt_transacao >= '{de}'
                  AND t.dt_transacao <  {ate}
            ) combined
        """

    rows = query(conn, f"""
        WITH
        acum_ano AS ({sub(ini,     f"'{r}'::date + INTERVAL '1 month'")}),
        acum_ant AS ({sub(ini_ant, f"'{r}'::date + INTERVAL '1 month' - INTERVAL '1 year'")})
        SELECT
            a26.liquido AS acum_2026,
            a25.liquido AS acum_2025,
            CASE WHEN a25.liquido = 0 THEN NULL
                 ELSE ROUND(((a26.liquido - a25.liquido) / a25.liquido * 100)::numeric, 1)
            END AS crescimento_pct
        FROM acum_ano a26, acum_ant a25
    """)
    row = rows[0] if rows else {}
    pct = row.get("crescimento_pct")
    return {
        "dt_referencia":  ultimo_dia(ref),
        "acum_2026":      float(row.get("acum_2026") or 0),
        "acum_2025":      float(row.get("acum_2025") or 0),
        "crescimento_pct": float(pct) if pct is not None else None,
    }


def calc_faturamento_ecommerce(conn, ref: date) -> dict:
    ops_ecom = ", ".join(str(o) for o in OPERACOES_ECOMMERCE)
    r   = ref.isoformat()
    ini = f"{ref.year}-01-01"
    ini_ant = f"{ref.year - 1}-01-01"

    def sub(de, ate):
        return f"""
            SELECT COALESCE(SUM(
                CASE WHEN t.tp_operacao='S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
            ),0) AS liquido
            FROM vr_tra_transacao t
            LEFT JOIN vr_tra_transitem i
                ON i.cd_empresa=t.cd_empresa AND i.dt_transacao=t.dt_transacao AND i.nr_transacao=t.nr_transacao
            WHERE t.cd_empresa = 120
              AND t.tp_situacao = 4
              AND t.cd_operacao IN ({ops_ecom})
              AND t.dt_transacao >= '{de}'
              AND t.dt_transacao <  {ate}
              AND ((t.tp_modalidade IN ('4','8') AND t.tp_operacao='S')
                   OR (t.tp_modalidade='3' AND t.tp_operacao='E'))
        """

    rows = query(conn, f"""
        WITH
        acum_ano AS ({sub(ini,     f"'{r}'::date + INTERVAL '1 month'")}),
        acum_ant AS ({sub(ini_ant, f"'{r}'::date + INTERVAL '1 month' - INTERVAL '1 year'")})
        SELECT
            a26.liquido AS acum_2026,
            a25.liquido AS acum_2025,
            CASE WHEN a25.liquido = 0 THEN NULL
                 ELSE ROUND(((a26.liquido - a25.liquido) / a25.liquido * 100)::numeric, 1)
            END AS crescimento_pct
        FROM acum_ano a26, acum_ant a25
    """)
    row = rows[0] if rows else {}
    pct = row.get("crescimento_pct")
    return {
        "dt_referencia":   ultimo_dia(ref),
        "acum_2026":       float(row.get("acum_2026") or 0),
        "acum_2025":       float(row.get("acum_2025") or 0),
        "crescimento_pct": float(pct) if pct is not None else None,
    }


def calc_quebra_pedidos(conn, ref: date) -> dict:
    ops_fab   = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS)
    reps_excl = ", ".join(str(r) for r in REPRESENTANTES_EXCL)
    r = ref.isoformat()
    rows = query(conn, f"""
        WITH ult AS (
            SELECT a.*, ROW_NUMBER() OVER (
                PARTITION BY a.cd_empresa, a.cd_pedido, a.cd_produto
                ORDER BY a.dt_cadastro DESC
            ) AS rn
            FROM vr_ped_pedidoicanc2 a
            WHERE a.dt_cadastro >= '{r}'::date
              AND a.dt_cadastro <  '{r}'::date + INTERVAL '1 month'
        ),
        quebra AS (
            SELECT COALESCE(SUM(b.vl_unitario * b.qt_cancelada), 0) AS quebra_valor
            FROM ult u
            JOIN vr_ped_pedidoi b
                ON u.cd_pedido = b.cd_pedido AND u.cd_empresa = b.cd_empresa AND u.cd_produto = b.cd_produto
            WHERE u.rn = 1 AND u.cd_motivocanc = 6 AND b.cd_operacao IN (52, 1)
        ),
        fat_mes AS (
            SELECT COALESCE(SUM(
                CASE WHEN t.tp_operacao='S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END
            ),0) AS faturamento_mes
            FROM vr_tra_transacao t
            LEFT JOIN vr_tra_transitem i
                ON i.cd_empresa=t.cd_empresa AND i.dt_transacao=t.dt_transacao AND i.nr_transacao=t.nr_transacao
            WHERE t.cd_empresa = 1
              AND t.tp_situacao = 4
              AND t.cd_representant IS NOT NULL
              AND t.cd_representant <> ALL (ARRAY[{reps_excl}])
              AND t.cd_operacao NOT IN ({ops_fab})
              AND t.dt_transacao >= '{r}'::date
              AND t.dt_transacao <  '{r}'::date + INTERVAL '1 month'
              AND ((t.tp_modalidade IN ('4','8') AND t.tp_operacao='S')
                   OR (t.tp_modalidade='3' AND t.tp_operacao='E'))
        )
        SELECT
            q.quebra_valor,
            f.faturamento_mes,
            CASE WHEN f.faturamento_mes = 0 THEN NULL
                 ELSE ROUND((q.quebra_valor / f.faturamento_mes * 100)::numeric, 2)
            END AS quebra_pct
        FROM quebra q, fat_mes f
    """)
    row = rows[0] if rows else {}
    pct = row.get("quebra_pct")
    return {
        "dt_referencia":  ultimo_dia(ref),
        "quebra_valor":   float(row.get("quebra_valor") or 0),
        "faturamento_mes": float(row.get("faturamento_mes") or 0),
        "quebra_pct":     float(pct) if pct is not None else None,
    }


def calc_vendas_volume_varejo(conn, ref: date) -> dict:
    r = ref.isoformat()
    rows = query(conn, f"""
        WITH vendas AS (
            SELECT
                t.ds_sigla AS tipo_tabela,
                COALESCE(SUM(i.vl_solicitado), 0) AS valor_total
            FROM vr_ped_pedidoc2 c
            LEFT JOIN vr_ped_pedidoi i
                ON c.cd_empresa = i.cd_empresa AND i.cd_pedido = c.cd_pedido
            LEFT JOIN vr_ped_tabprecoc t ON i.cd_tabpreco = t.cd_tabpreco
            WHERE c.dt_pedido >= '{r}'::date
              AND c.dt_pedido <  '{r}'::date + INTERVAL '1 month'
              AND c.cd_cliente <> 110000001
              AND c.cd_representant <> 32098
              AND c.tp_situacao <> 6
              AND c.cd_empresa = 1
              AND c.cd_operacao IN (1,18,52,166,148,98,55,97,30,79,93,
                                    137,141,142,156,159,310,598,180,58,69,85,124,182)
              AND t.ds_sigla IN ('VAREJO','VOLUME')
            GROUP BY t.ds_sigla
        ),
        total AS (SELECT SUM(valor_total) AS total_valor FROM vendas)
        SELECT v.tipo_tabela, v.valor_total,
               ROUND((v.valor_total / NULLIF(t.total_valor,0) * 100)::numeric, 2) AS percentual
        FROM vendas v, total t
        ORDER BY v.tipo_tabela
    """)
    result = {
        "dt_referencia": ultimo_dia(ref),
        "volume_valor": 0.0, "varejo_valor": 0.0, "total_valor": 0.0,
        "volume_pct": None, "varejo_pct": None,
    }
    total_val = 0.0
    for row in rows:
        val = float(row["valor_total"])
        pct = float(row["percentual"]) if row["percentual"] is not None else None
        total_val += val
        if row["tipo_tabela"] == "VOLUME":
            result["volume_valor"] = val
            result["volume_pct"]   = pct
        elif row["tipo_tabela"] == "VAREJO":
            result["varejo_valor"] = val
            result["varejo_pct"]   = pct
    result["total_valor"] = total_val
    return result


# ─── Indicador — banco Neon ───────────────────────────────────────────────────

def calc_ecommerce_ads(conn_n, ref: date) -> dict:
    r = ref.isoformat()
    rows_ads = query(conn_n, """
        SELECT
            COALESCE(SUM(custo), 0)   AS custo,
            COALESCE(SUM(receita), 0) AS receita,
            COALESCE(SUM(cliques), 0) AS cliques
        FROM public.ga4_aquisicao_conversao
        WHERE meio = 'cpc'
          AND data >= %s::date
          AND data <  %s::date + INTERVAL '1 month'
    """, (r, r))

    rows_geo = query(conn_n, """
        SELECT
            COALESCE(SUM(sessoes_engajadas), 0) AS sessoes_engajadas,
            COALESCE(SUM(transacoes), 0)        AS transacoes
        FROM public.ga4_tecnologia_geolocalizacao
        WHERE pais = 'Brazil'
          AND data >= %s::date
          AND data <  %s::date + INTERVAL '1 month'
    """, (r, r))

    ads = rows_ads[0] if rows_ads else {}
    geo = rows_geo[0] if rows_geo else {}

    custo  = float(ads.get("custo") or 0)
    receita = float(ads.get("receita") or 0)
    cliques = int(ads.get("cliques") or 0)
    sess_eng = int(geo.get("sessoes_engajadas") or 0)
    transacoes = int(geo.get("transacoes") or 0)

    return {
        "dt_referencia":     ultimo_dia(ref),
        "custo":             custo,
        "receita":           receita,
        "cliques":           cliques,
        "sessoes_engajadas": sess_eng,
        "transacoes":        transacoes,
        "roas":              round(receita / custo, 2) if custo > 0 else None,
        "taxa_conv_pct":     round(transacoes / sess_eng * 100, 2) if sess_eng > 0 else None,
    }


# ─── Execução principal ───────────────────────────────────────────────────────

if __name__ == '__main__':
    log("=== Sincronização de cache iniciada ===")
    inicio = time.time()
    erros = 0

    try:
        cp = conn_principal()
        cn = conn_neon()
    except Exception as e:
        log(f"ERRO FATAL ao conectar: {e}")
        sys.exit(1)

    try:
        criar_tabela(cp)

        meses = meses_2026_ate_hoje()
        log(f"Meses a processar: {[m.isoformat() for m in meses]}")

        indicadores_principal = [
            ("giro_lojas",           calc_giro_lojas),
            ("giro_mp",              calc_giro_mp),
            ("giro_fabrica",         calc_giro_fabrica),
            ("faturamento_fabrica",  calc_faturamento_fabrica),
            ("faturamento_ecommerce", calc_faturamento_ecommerce),
            ("quebra_pedidos",       calc_quebra_pedidos),
            ("vendas_volume_varejo", calc_vendas_volume_varejo),
        ]

        for ref in meses:
            mes_str = ref.isoformat()
            for nome, fn in indicadores_principal:
                try:
                    dados = fn(cp, ref)
                    upsert(cp, mes_str, nome, dados)
                    log(f"[{mes_str}] {nome} OK")
                except Exception as e:
                    log(f"[{mes_str}] {nome} ERRO: {e}")
                    erros += 1

            try:
                dados = calc_ecommerce_ads(cn, ref)
                upsert(cp, mes_str, "ecommerce_ads", dados)
                log(f"[{mes_str}] ecommerce_ads OK")
            except Exception as e:
                log(f"[{mes_str}] ecommerce_ads ERRO: {e}")
                erros += 1

    finally:
        cp.close()
        cn.close()

    duracao = round(time.time() - inicio)
    log(f"=== Concluída em {duracao}s | Erros: {erros} ===")
    sys.exit(0 if erros == 0 else 1)
