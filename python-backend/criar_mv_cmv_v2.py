#!/usr/bin/env python3
"""
Cria mv_cmv_loja_v2 otimizada para teste
"""

import psycopg2
import time
import os
from pathlib import Path
from dotenv import load_dotenv
from datetime import datetime

load_dotenv(Path(__file__).parent / '.env')

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def main():
    log("=" * 70)
    log("CRIANDO mv_cmv_loja_v2 OTIMIZADA PARA TESTE")
    log("=" * 70)

    conn = psycopg2.connect(
        host=os.getenv('DB_HOST'),
        port=int(os.getenv('DB_PORT', 5432)),
        database=os.getenv('DB_NAME'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD', '').strip('\'"'),
    )
    conn.autocommit = True
    cur = conn.cursor()

    # 1. Criar a view otimizada
    log("\n1. Criando view vr_cmv_lojas_v2...")
    inicio = time.time()

    cur.execute("""
        DROP VIEW IF EXISTS vr_cmv_lojas_v2 CASCADE;
    """)

    cur.execute("""
        CREATE VIEW vr_cmv_lojas_v2 AS
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
            (qt_solicitada * valor_unitario *
                CASE WHEN tp_operacao = 'S' THEN -1 ELSE 1 END *
                CASE
                    WHEN idcentrodecusto = 2 THEN 0.7
                    ELSE 0.8
                END
            ) AS valor
        FROM com_valor
    """)
    log(f"   View criada em {time.time() - inicio:.1f}s")

    # 2. Criar a materialized view
    log("\n2. Criando materialized view mv_cmv_loja_v2...")
    log("   (isso pode demorar alguns minutos...)")
    inicio = time.time()

    cur.execute("DROP MATERIALIZED VIEW IF EXISTS mv_cmv_loja_v2")
    cur.execute("CREATE MATERIALIZED VIEW mv_cmv_loja_v2 AS SELECT * FROM vr_cmv_lojas_v2")

    log(f"   MV criada em {time.time() - inicio:.1f}s")

    # 3. Criar indices
    log("\n3. Criando indices...")

    indices = [
        ("idx_mv_cmv_loja_v2_data", "CREATE INDEX idx_mv_cmv_loja_v2_data ON mv_cmv_loja_v2 (data)"),
        ("idx_mv_cmv_loja_v2_ccusto", "CREATE INDEX idx_mv_cmv_loja_v2_ccusto ON mv_cmv_loja_v2 (idcentrodecusto)"),
        ("idx_mv_cmv_loja_v2_data_ccusto", "CREATE INDEX idx_mv_cmv_loja_v2_data_ccusto ON mv_cmv_loja_v2 (data, idcentrodecusto)"),
    ]

    for nome, sql in indices:
        inicio = time.time()
        cur.execute(sql)
        log(f"   {nome} ({time.time() - inicio:.1f}s)")

    # 4. ANALYZE
    log("\n4. Atualizando estatisticas...")
    cur.execute("ANALYZE mv_cmv_loja_v2")
    log("   ANALYZE concluido")

    # 5. Comparar com original
    log("\n5. Comparando com a MV original...")
    log("-" * 50)

    cur.execute("SELECT COUNT(*) as qtd, SUM(valor) as total FROM mv_cmv_loja")
    orig = cur.fetchone()
    log(f"   ORIGINAL (mv_cmv_loja):")
    log(f"     Registros: {orig[0]:,}")
    log(f"     Soma valor: {orig[1]:,.2f}")

    cur.execute("SELECT COUNT(*) as qtd, SUM(valor) as total FROM mv_cmv_loja_v2")
    nova = cur.fetchone()
    log(f"\n   OTIMIZADA (mv_cmv_loja_v2):")
    log(f"     Registros: {nova[0]:,}")
    log(f"     Soma valor: {nova[1]:,.2f}")

    # Diferenca
    diff_qtd = nova[0] - orig[0]
    diff_val = nova[1] - orig[1] if nova[1] and orig[1] else 0
    log(f"\n   DIFERENCA:")
    log(f"     Registros: {diff_qtd:+,}")
    log(f"     Valor: {diff_val:+,.2f}")

    # 6. Comparar tamanho
    log("\n6. Comparando tamanho...")
    cur.execute("SELECT pg_size_pretty(pg_total_relation_size('mv_cmv_loja'))")
    size_orig = cur.fetchone()[0]
    cur.execute("SELECT pg_size_pretty(pg_total_relation_size('mv_cmv_loja_v2'))")
    size_nova = cur.fetchone()[0]
    log(f"   Original: {size_orig}")
    log(f"   Otimizada: {size_nova}")

    cur.close()
    conn.close()

    log("\n" + "=" * 70)
    log("CONCLUIDO! mv_cmv_loja_v2 criada para teste")
    log("=" * 70)
    log("\nPara testar nas queries da DRE, substitua:")
    log("  FROM mv_cmv_loja  -->  FROM mv_cmv_loja_v2")

if __name__ == "__main__":
    main()
