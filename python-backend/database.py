import psycopg2
from psycopg2 import pool
import os
from dotenv import load_dotenv
from typing import List, Dict, Any
from pathlib import Path

# Carregar .env do diretório python-backend primeiro
env_local_path = Path(__file__).parent / '.env'
load_dotenv(env_local_path)

# Carregar .env.local do diretório raiz do projeto (pode sobrescrever)
env_path = Path(__file__).parent.parent / '.env.local'
load_dotenv(env_path)

# Configuração do pool de conexões PostgreSQL
connection_pool = None

def get_connection_pool():
    """Cria e retorna pool de conexões PostgreSQL"""
    global connection_pool

    if connection_pool is None:
        try:
            # Remover aspas se existirem na senha
            password = os.getenv('DB_PASSWORD', '').strip('\'"')

            # Conexão PostgreSQL vCenter
            connection_pool = psycopg2.pool.SimpleConnectionPool(
                1,  # Min connections
                10,  # Max connections
                host=os.getenv('DB_HOST', 'dbexp.vcenter.com.br'),
                port=int(os.getenv('DB_PORT', '20168')),
                database=os.getenv('DB_NAME', 'liebe'),
                user=os.getenv('DB_USER', 'liebe_ro'),
                password=password
            )
            print("[OK] PostgreSQL connection pool created successfully")
        except Exception as e:
            print(f"[ERROR] Error creating connection pool: {e}")
            raise

    return connection_pool

def execute_query(query: str, params: tuple = None) -> List[Dict[str, Any]]:
    """Executa query e retorna resultados como lista de dicts"""
    pool = get_connection_pool()
    conn = None

    try:
        conn = pool.getconn()
        cursor = conn.cursor()

        print(f"[QUERY] Executing: {query[:100]}...")
        if params and len(params) > 0:
            print(f"[PARAMS] {params}")
            cursor.execute(query, params)
        else:
            cursor.execute(query)

        # Pegar nomes das colunas
        columns = [desc[0] for desc in cursor.description] if cursor.description else []

        # Converter resultados em lista de dicts
        results = []
        for row in cursor.fetchall():
            results.append(dict(zip(columns, row)))

        print(f"[OK] Query executed successfully. Rows: {len(results)}")

        cursor.close()
        return results

    except Exception as e:
        print(f"[ERROR] Query execution failed: {e}")
        raise
    finally:
        if conn:
            pool.putconn(conn)

def execute_insert(query: str, params: tuple = None) -> List[Dict[str, Any]]:
    """Executa INSERT/UPDATE e faz commit"""
    pool = get_connection_pool()
    conn = None

    try:
        conn = pool.getconn()
        cursor = conn.cursor()

        print(f"[INSERT] Executing: {query[:100]}...")
        if params and len(params) > 0:
            print(f"[PARAMS] {params}")
            cursor.execute(query, params)
        else:
            cursor.execute(query)

        conn.commit()  # Fazer commit

        # Pegar nomes das colunas se houver resultado (ex: RETURNING)
        columns = [desc[0] for desc in cursor.description] if cursor.description else []

        # Converter resultados em lista de dicts
        results = []
        if columns:
            for row in cursor.fetchall():
                results.append(dict(zip(columns, row)))

        print(f"[OK] Insert executed successfully. Rows affected: {cursor.rowcount}")

        cursor.close()
        return results

    except Exception as e:
        if conn:
            conn.rollback()
        print(f"[ERROR] Insert execution failed: {e}")
        raise
    finally:
        if conn:
            pool.putconn(conn)

def close_all_connections():
    """Fecha todas as conexões do pool"""
    global connection_pool
    if connection_pool:
        connection_pool.closeall()
        print("[INFO] All PostgreSQL connections closed")


# ─── Pool Neon (GA4 / e-commerce) ────────────────────────────────────────────

_neon_pool = None

def _get_neon_pool():
    global _neon_pool
    if _neon_pool is None:
        url = os.getenv('NEON_DATABASE_URL')
        if not url:
            raise RuntimeError("NEON_DATABASE_URL não configurada")
        _neon_pool = psycopg2.pool.SimpleConnectionPool(1, 5, dsn=url)
        print("[OK] Neon connection pool created")
    return _neon_pool


def execute_neon_query(query: str, params: tuple = None) -> List[Dict[str, Any]]:
    pool = _get_neon_pool()
    conn = None
    try:
        conn = pool.getconn()
        cursor = conn.cursor()
        if params and len(params) > 0:
            cursor.execute(query, params)
        else:
            cursor.execute(query)
        columns = [desc[0] for desc in cursor.description] if cursor.description else []
        results = [dict(zip(columns, row)) for row in cursor.fetchall()]
        cursor.close()
        return results
    except Exception as e:
        print(f"[ERROR] Neon query failed: {e}")
        raise
    finally:
        if conn:
            pool.putconn(conn)
