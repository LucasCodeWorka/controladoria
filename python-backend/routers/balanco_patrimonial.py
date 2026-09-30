"""
Balanco Patrimonial - Ativos e Passivo, calculados sob demanda (sem cache).

Cada conta (ex: "PC.2") e alimentada por uma lista de despesaitens que o
usuario classifica na tela de configuracao (classificacao_despesas_balanco)
e por uma janela de vencimento configuravel por conta
(configuracao_contas_balanco, em meses a partir do mes filtrado - default
12). Conta sem nenhum despesaitem classificado fica de fora do dict
devolvido (o frontend mantem o valor zerado pra ela).

Convencao de sinal: valores de conta do Passivo (codigo comecando com "P")
vem NEGATIVOS, Ativo (codigo comecando com "A") vem POSITIVO - mesmo padrao
do anexo/modelo da tela.
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date, timedelta
from database import execute_query, execute_insert
from routers.dre import FILTRO_DUPLICATAS_EXCLUIDAS_SQL, PARAMS_DUPLICATAS_EXCLUIDAS

router = APIRouter()

MESES_JANELA_PADRAO = 12


def _criar_tabelas_balanco():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS classificacao_despesas_balanco (
            cd_despesaitem INTEGER PRIMARY KEY,
            ds_despesaitem TEXT,
            conta_balanco TEXT NOT NULL,
            usuario_alteracao TEXT,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """)
    execute_insert("""
        CREATE TABLE IF NOT EXISTS configuracao_contas_balanco (
            codigo TEXT PRIMARY KEY,
            meses_janela INTEGER NOT NULL DEFAULT 12,
            usuario_alteracao TEXT,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """)


def _somar_meses(ano: int, mes: int, delta: int) -> tuple:
    m = mes - 1 + delta
    return ano + m // 12, m % 12 + 1


def _janela_vencimento(mes_referencia: str, meses_janela: int) -> tuple:
    """(data_inicio, data_fim) = "meses_janela" meses a partir do 1o dia do
    mes de referencia (inclusive) - se filtrar setembro/2026 com janela de
    12, olha de 01/09/2026 ate 31/08/2027."""
    ano_ref, mes_ref = (int(p) for p in mes_referencia.split("-"))
    data_inicio = date(ano_ref, mes_ref, 1)
    ano_fim, mes_fim = _somar_meses(ano_ref, mes_ref, meses_janela)
    data_fim = date(ano_fim, mes_fim, 1) - timedelta(days=1)
    return data_inicio.isoformat(), data_fim.isoformat()


def _somar_duplicatas_por_vencimento(despesaitens: list, data_inicio: str, data_fim: str, empresas: Optional[str]) -> float:
    """Soma ABS(vl_rateio) das duplicatas (tp_situacao = 'N') de uma lista
    de cd_despesaitem, com VENCIMENTO na janela dada - respeita o filtro de
    empresas da tela quando informado (sem ele, soma todas)."""
    if not despesaitens:
        return 0.0

    clausula_empresa = ""
    params_empresa: tuple = ()
    if empresas:
        lista_empresas = [int(e.strip()) for e in empresas.split(",") if e.strip()]
        if lista_empresas:
            clausula_empresa = " AND d.cd_ccusto = ANY(%s)"
            params_empresa = (lista_empresas,)

    row = execute_query(f"""
        SELECT SUM(ABS(d.vl_rateio)) AS total
        FROM vr_fcp_despduplicatai d
        WHERE d.dt_vencimento >= %s AND d.dt_vencimento <= %s
          AND d.tp_situacao = 'N'
          AND d.cd_despesaitem = ANY(%s)
          AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}{clausula_empresa}
    """, (data_inicio, data_fim, despesaitens, *PARAMS_DUPLICATAS_EXCLUIDAS, *params_empresa))

    return float((row[0]["total"] if row else 0) or 0)


@router.get("/api/balanco-patrimonial/dados")
def get_balanco_patrimonial(
    mesReferencia: str = Query(..., description="Mes de referencia YYYY-MM"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa/cd_ccusto separados por virgula (default: todas)")
):
    """
    Valores do Balanco Patrimonial, uma conta de cada vez, a partir da
    classificacao de despesas configurada em /configuracoes/plano-contas-balanco
    (cada despesaitem -> uma conta) e da janela de vencimento configurada por
    conta (default 12 meses). Conta sem despesa classificada nao entra no
    dict (fica zerada no frontend).
    """
    try:
        _criar_tabelas_balanco()

        rows_classificacao = execute_query(
            "SELECT cd_despesaitem, conta_balanco FROM classificacao_despesas_balanco", ()
        ) or []
        despesaitens_por_conta: dict = {}
        for r in rows_classificacao:
            despesaitens_por_conta.setdefault(r["conta_balanco"], []).append(r["cd_despesaitem"])

        rows_janela = execute_query("SELECT codigo, meses_janela FROM configuracao_contas_balanco", ()) or []
        meses_janela_por_conta = {r["codigo"]: r["meses_janela"] for r in rows_janela}

        valores: dict = {}
        for conta, despesaitens in despesaitens_por_conta.items():
            meses_janela = meses_janela_por_conta.get(conta, MESES_JANELA_PADRAO)
            data_inicio, data_fim = _janela_vencimento(mesReferencia, meses_janela)
            total = _somar_duplicatas_por_vencimento(despesaitens, data_inicio, data_fim, empresas)
            sinal = -1 if conta.upper().startswith("P") else 1
            valores[conta] = sinal * total

        return {"valores": valores, "mesReferencia": mesReferencia}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar balanco patrimonial: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar balanco patrimonial: {str(e)}")


@router.get("/api/classificacao-despesas-balanco")
def listar_classificacao_despesas_balanco():
    """Lista todas as despesas com a classificacao do Balanco (se houver) -
    mesmo padrao da tela de Config DFC."""
    try:
        _criar_tabelas_balanco()
        rows = execute_query("""
            SELECT d.cd_despesaitem, d.ds_despesaitem, c.conta_balanco, c.dt_atualizacao, c.usuario_alteracao
            FROM vr_fcp_despesaitem d
            LEFT JOIN classificacao_despesas_balanco c ON c.cd_despesaitem = d.cd_despesaitem
            ORDER BY d.ds_despesaitem
        """, ())
        return {"success": True, "data": rows}
    except Exception as e:
        print(f"[ERROR] Erro ao listar classificacoes do balanco: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/classificacao-despesas-balanco")
def salvar_classificacao_despesas_balanco(data: dict):
    """Salva classificacao de uma ou mais despesas pro Balanco. Enviar
    conta_balanco vazio/NAO_CLASSIFICADO remove a classificacao."""
    try:
        _criar_tabelas_balanco()
        classificacoes = data.get("classificacoes", [])
        usuario = data.get("usuario", "sistema")

        if not classificacoes:
            raise HTTPException(status_code=400, detail="Nenhuma classificação fornecida")

        salvos = 0
        removidos = 0
        for item in classificacoes:
            cd_despesaitem = item.get("cd_despesaitem")
            ds_despesaitem = item.get("ds_despesaitem", "")
            conta_balanco = item.get("conta_balanco")

            if not cd_despesaitem:
                continue

            if not conta_balanco or conta_balanco == "NAO_CLASSIFICADO":
                execute_insert("DELETE FROM classificacao_despesas_balanco WHERE cd_despesaitem = %s", (cd_despesaitem,))
                removidos += 1
                continue

            execute_insert("""
                INSERT INTO classificacao_despesas_balanco
                    (cd_despesaitem, ds_despesaitem, conta_balanco, usuario_alteracao, dt_atualizacao)
                VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (cd_despesaitem)
                DO UPDATE SET
                    conta_balanco = EXCLUDED.conta_balanco,
                    usuario_alteracao = EXCLUDED.usuario_alteracao,
                    dt_atualizacao = CURRENT_TIMESTAMP
            """, (cd_despesaitem, ds_despesaitem, conta_balanco, usuario))
            salvos += 1

        return {
            "success": True,
            "salvos": salvos,
            "removidos": removidos,
            "message": f"{salvos} classificações salvas" + (f" ({removidos} removidas)" if removidos > 0 else ""),
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao salvar classificacoes do balanco: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/balanco-patrimonial/configuracao-contas")
def listar_configuracao_contas_balanco():
    """{codigo: meses_janela} de toda conta com janela configurada
    explicitamente - conta ausente aqui usa o default (12 meses)."""
    try:
        _criar_tabelas_balanco()
        rows = execute_query("SELECT codigo, meses_janela FROM configuracao_contas_balanco", ())
        return {r["codigo"]: r["meses_janela"] for r in (rows or [])}
    except Exception as e:
        print(f"[ERROR] Erro ao listar configuracao de contas do balanco: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/balanco-patrimonial/configuracao-contas")
def salvar_configuracao_conta_balanco(data: dict):
    """Salva a janela (em meses, a partir do mes filtrado) de UMA conta."""
    try:
        _criar_tabelas_balanco()
        codigo = data.get("codigo")
        meses_janela = data.get("mesesJanela")
        usuario = data.get("usuario", "sistema")

        if not codigo or not isinstance(meses_janela, int) or meses_janela <= 0:
            raise HTTPException(status_code=400, detail="codigo e mesesJanela (inteiro > 0) são obrigatórios")

        execute_insert("""
            INSERT INTO configuracao_contas_balanco (codigo, meses_janela, usuario_alteracao, dt_atualizacao)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (codigo)
            DO UPDATE SET
                meses_janela = EXCLUDED.meses_janela,
                usuario_alteracao = EXCLUDED.usuario_alteracao,
                dt_atualizacao = CURRENT_TIMESTAMP
        """, (codigo, meses_janela, usuario))

        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao salvar configuracao de conta do balanco: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
