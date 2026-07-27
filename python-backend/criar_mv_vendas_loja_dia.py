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


def main():
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=int(os.getenv("DB_PORT", 5432)),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD", "").strip("'\""),
    )
    conn.autocommit = True
    cur = conn.cursor()

    log("Recriando public.mv_vendas_loja_dia...")
    inicio = time.time()
    cur.execute("DROP MATERIALIZED VIEW IF EXISTS public.mv_vendas_loja_dia")
    cur.execute(
        """
        CREATE MATERIALIZED VIEW public.mv_vendas_loja_dia AS
        SELECT
            t.dt_transacao::date AS data,
            t.cd_empresa,
            SUM(
                CASE
                    WHEN t.tp_modalidade = '4' AND t.tp_operacao = 'S'
                    THEN t.vl_transacao
                    ELSE 0
                END
            ) AS receita_bruta,
            SUM(
                CASE
                    WHEN t.tp_modalidade = '3' AND t.tp_operacao = 'E'
                    THEN ABS(t.vl_transacao)
                    ELSE 0
                END
            ) AS devolucoes
        FROM vr_tra_transacao t
        WHERE t.dt_transacao >= '2024-01-01'
          AND t.dt_transacao < '2027-01-01'
          AND t.tp_situacao = 4
          AND t.tp_modalidade IN ('3', '4')
          AND (
            (t.tp_modalidade = '4' AND t.tp_operacao = 'S')
            OR (t.tp_modalidade = '3' AND t.tp_operacao = 'E')
          )
        GROUP BY t.dt_transacao::date, t.cd_empresa
        """
    )
    log(f"MV criada em {time.time() - inicio:.1f}s")

    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_mv_vendas_loja_dia_data ON public.mv_vendas_loja_dia (data)",
        "CREATE INDEX IF NOT EXISTS idx_mv_vendas_loja_dia_empresa ON public.mv_vendas_loja_dia (cd_empresa)",
        "CREATE INDEX IF NOT EXISTS idx_mv_vendas_loja_dia_data_empresa ON public.mv_vendas_loja_dia (data, cd_empresa)",
    ]:
        inicio = time.time()
        cur.execute(sql)
        log(f"Indice ok em {time.time() - inicio:.1f}s")

    cur.execute("ANALYZE public.mv_vendas_loja_dia")
    cur.execute(
        """
        SELECT COUNT(*), MIN(data), MAX(data), SUM(receita_bruta), SUM(devolucoes)
        FROM public.mv_vendas_loja_dia
        """
    )
    qtd, data_min, data_max, receita, devolucoes = cur.fetchone()
    log(f"OK: registros={qtd:,} data_min={data_min} data_max={data_max} receita={receita} devolucoes={devolucoes}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
