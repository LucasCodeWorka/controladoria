#!/usr/bin/env python3
import os
import time
from datetime import datetime
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def connect():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=int(os.getenv("DB_PORT", 5432)),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD", "").strip("'\""),
    )


VIEW_SQL = """
CREATE OR REPLACE VIEW public.vr_cmv_lojas_v2 AS
WITH base AS (
    SELECT
        t.cd_empresa AS idcentrodecusto,
        t.dt_transacao AS data,
        i.qt_solicitada,
        i.cd_produto AS idproduto,
        t.tp_operacao,
        TRIM(pc_marca.cd_classificacao) AS idmarca,
        TRIM(pc_status.cd_classificacao) AS idstatus
    FROM vr_tra_transacao t
    JOIN vr_tra_transitem i
        ON t.nr_transacao = i.nr_transacao
        AND t.cd_empresa = i.cd_empresa
    LEFT JOIN prd_produtoclas pc_marca
        ON pc_marca.cd_produto = i.cd_produto
        AND pc_marca.cd_tipoclas = 20
    LEFT JOIN prd_produtoclas pc_status
        ON pc_status.cd_produto = i.cd_produto
        AND pc_status.cd_tipoclas = 27
    WHERE t.tp_situacao = 4
      AND t.cd_empresa NOT IN (1, 50)
      AND t.dt_transacao >= '2024-01-01'
      AND t.dt_transacao <= '2026-12-31'
      AND (
          (t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
          OR (t.tp_modalidade = '3' AND t.tp_operacao = 'E')
      )
),
com_valor AS (
    SELECT
        b.idcentrodecusto,
        b.data,
        b.qt_solicitada,
        b.tp_operacao,
        b.idmarca,
        b.idstatus,
        CASE
            WHEN b.idmarca IN ('0001', '0002', '0009') THEN
                COALESCE(
                    NULLIF(f_prd_valor_produto2(1, 1, 'P', 1, b.idproduto, b.data), 0),
                    NULLIF(f_prd_valor_produto2(1, 1, 'P', 1, b.idproduto, NULL), 0),
                    21.9
                )
            ELSE
                COALESCE(
                    NULLIF(f_prd_valor_produto2(1, 1, 'C', 2, b.idproduto, b.data), 0),
                    NULLIF(f_prd_valor_produto2(1, 1, 'C', 2, b.idproduto, NULL), 0),
                    21.9
                )
        END AS valor_unitario
    FROM base b
    WHERE b.idmarca IS NOT NULL
      AND b.idmarca <> ''
)
SELECT
    CASE
        WHEN idmarca IN ('0001', '0002', '0009') THEN '04.02.01'
        ELSE '04.02.02'
    END AS idconta,
    idcentrodecusto,
    data,
    (
        qt_solicitada * valor_unitario *
        CASE WHEN tp_operacao = 'S' THEN -1 ELSE 1 END *
        CASE WHEN idcentrodecusto = 2 THEN 0.7 ELSE 0.8 END
    ) AS valor
FROM com_valor
"""


def cancelar_travados(cur):
    log("Verificando operacoes CMV/view travadas...")
    cur.execute(
        """
        SELECT pid, state, wait_event_type, now() - query_start AS duracao, left(query, 140) AS query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND (
            query ILIKE '%vr_cmv_lojas_v2%'
            OR query ILIKE '%mv_cmv_loja%'
            OR query ILIKE '%mv_cmv_loja_v2%'
            OR query ILIKE '%0402 CMV Lojas%'
          )
        ORDER BY query_start NULLS LAST
        """
    )
    rows = cur.fetchall()
    for pid, state, wait_event_type, duracao, query in rows:
        log(f"Cancelando pid={pid} state={state} wait={wait_event_type} duracao={duracao} query={query!r}")
        cur.execute("SELECT pg_cancel_backend(%s)", (pid,))
        log(f"  cancel enviado: {cur.fetchone()[0]}")

    if rows:
        time.sleep(5)


def main():
    log("Recriando vr_cmv_lojas_v2 e mv_cmv_loja_v2 com dados desde 2024")
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()

    cancelar_travados(cur)

    inicio = time.time()
    log("Criando/atualizando view public.vr_cmv_lojas_v2...")
    cur.execute("SET lock_timeout = '30s'")
    cur.execute(VIEW_SQL)
    log(f"View atualizada em {time.time() - inicio:.1f}s")

    inicio = time.time()
    log("Recriando materialized view public.mv_cmv_loja_v2 a partir da view...")
    cur.execute("SET lock_timeout = 0")
    cur.execute("DROP MATERIALIZED VIEW IF EXISTS public.mv_cmv_loja_v2")
    cur.execute("CREATE MATERIALIZED VIEW public.mv_cmv_loja_v2 AS SELECT * FROM public.vr_cmv_lojas_v2")
    log(f"Materialized view recriada em {time.time() - inicio:.1f}s")

    log("Criando indices...")
    indices = [
        "CREATE INDEX IF NOT EXISTS idx_mv_cmv_loja_v2_data ON public.mv_cmv_loja_v2 (data)",
        "CREATE INDEX IF NOT EXISTS idx_mv_cmv_loja_v2_ccusto ON public.mv_cmv_loja_v2 (idcentrodecusto)",
        "CREATE INDEX IF NOT EXISTS idx_mv_cmv_loja_v2_data_ccusto ON public.mv_cmv_loja_v2 (data, idcentrodecusto)",
    ]
    for sql in indices:
        inicio = time.time()
        cur.execute(sql)
        log(f"  indice ok em {time.time() - inicio:.1f}s")

    log("Rodando ANALYZE...")
    cur.execute("ANALYZE public.mv_cmv_loja_v2")

    cur.execute(
        """
        SELECT
            COUNT(*) AS registros,
            MIN(data)::date AS data_min,
            MAX(data)::date AS data_max,
            SUM(valor) AS valor_total
        FROM public.mv_cmv_loja_v2
        """
    )
    registros, data_min, data_max, valor_total = cur.fetchone()
    log(f"OK: registros={registros:,} data_min={data_min} data_max={data_max} valor_total={valor_total}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
