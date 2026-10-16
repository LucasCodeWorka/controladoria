"""
Fluxo de Caixa - saidas (duplicatas a pagar) e entradas (cartao, boleto,
cheque, projecao de lojas, multimarcas) projetadas e realizadas, com saldo
diario acumulado. Portado do app_controladoria (routes/fluxo-caixa.js), que
ja roda em producao contra o mesmo banco (mesmo host/schema) - mesma logica
de calculo, so traduzida de Node/Express pra Python/FastAPI.

Duas tabelas proprias (criadas sob demanda, mesmo padrao do giro_snapshot em
giro.py): fcp_lojas_projecao (projecao manual de recebimento das lojas,
colada pelo usuario) e fcp_faturas_descontadas (faturas da empresa 001 que
ja foram descontadas junto ao banco, e por isso saem do Boleto futuro).
"""
from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
import time
from database import execute_query, execute_insert
from routers.indicadores import OPERACOES_EXCLUIDAS, OPERACOES_EXCLUIDAS_LOJAS, REPRESENTANTES_EXCLUIDOS

router = APIRouter()

CACHE_TTL_SEGUNDOS = 10 * 60
_kpi_cache: Optional[dict] = None
_kpi_ts: float = 0.0

# Lojas-projecao/faturas-descontadas: tamanho do lote pro INSERT em massa
# (usuario cola listas de milhares de linhas direto de planilha) - evita
# montar um unico INSERT gigante de uma vez.
TAMANHO_LOTE_INSERT = 500


def _criar_tabelas_fluxo_caixa():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_faturas_descontadas (
            nr_fat BIGINT NOT NULL,
            nr_parcela BIGINT NOT NULL,
            dt_atualizacao TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (nr_fat, nr_parcela)
        )
    """, ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_lojas_projecao (
            dt_dia DATE PRIMARY KEY,
            vl_lojas NUMERIC(14,2) NOT NULL DEFAULT 0,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """, ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_outras_entradas_projecao (
            dt_dia DATE PRIMARY KEY,
            vl_outras_entradas NUMERIC(14,2) NOT NULL DEFAULT 0,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """, ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_feriados_bancarios (
            dt_feriado DATE PRIMARY KEY,
            descr TEXT
        )
    """, ())
    execute_insert("""
        CREATE OR REPLACE FUNCTION fn_fc_proximo_dia_util_bancario(p_data DATE)
        RETURNS DATE AS $$
        DECLARE
            v_data DATE := p_data;
        BEGIN
            LOOP
                IF EXTRACT(DOW FROM v_data) NOT IN (0, 6)
                   AND NOT EXISTS (SELECT 1 FROM fcp_feriados_bancarios WHERE dt_feriado = v_data) THEN
                    RETURN v_data;
                END IF;
                v_data := v_data + 1;
            END LOOP;
        END;
        $$ LANGUAGE plpgsql STABLE
    """, ())
    execute_insert("""
        CREATE OR REPLACE FUNCTION fn_fc_dt_boleto_efetiva(p_vencimento DATE)
        RETURNS DATE AS $$
        DECLARE
            v_dow INT := EXTRACT(DOW FROM p_vencimento);
            v_base DATE;
        BEGIN
            v_base := CASE
                WHEN v_dow IN (1, 2, 3, 4) THEN p_vencimento + 1
                WHEN v_dow = 5 THEN p_vencimento + 3
                WHEN v_dow = 6 THEN p_vencimento + 3
                ELSE p_vencimento + 2
            END;
            RETURN fn_fc_proximo_dia_util_bancario(v_base);
        END;
        $$ LANGUAGE plpgsql STABLE
    """, ())
    execute_insert("""
        CREATE OR REPLACE FUNCTION fn_fc_dt_cheque_efetiva(p_vencimento DATE)
        RETURNS DATE AS $$
        BEGIN
            IF EXTRACT(DOW FROM p_vencimento) IN (0, 6) THEN
                RETURN fn_fc_proximo_dia_util_bancario(p_vencimento + 1);
            END IF;
            RETURN p_vencimento;
        END;
        $$ LANGUAGE plpgsql STABLE
    """, ())
    _seed_feriados_bancarios()


def _calcular_pascoa(ano: int) -> date:
    """Domingo de Pascoa pelo algoritmo de Gauss/Meeus (anonymous Gregorian)."""
    a = ano % 19
    b = ano // 100
    c = ano % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes = (h + l - 7 * m + 114) // 31
    dia = ((h + l - 7 * m + 114) % 31) + 1
    return date(ano, mes, dia)


def _feriados_bancarios_do_ano(ano: int) -> list:
    """Feriados bancarios nacionais (fixos + moveis a partir da Pascoa) -
    sao os dias em que a compensacao bancaria (boletos) nao ocorre."""
    pascoa = _calcular_pascoa(ano)
    return [
        (date(ano, 1, 1), "Confraternização Universal"),
        (pascoa - timedelta(days=48), "Carnaval (segunda-feira)"),
        (pascoa - timedelta(days=47), "Carnaval (terça-feira)"),
        (pascoa - timedelta(days=2), "Sexta-feira Santa"),
        (date(ano, 4, 21), "Tiradentes"),
        (date(ano, 5, 1), "Dia do Trabalho"),
        (pascoa + timedelta(days=60), "Corpus Christi"),
        (date(ano, 9, 7), "Independência do Brasil"),
        (date(ano, 10, 12), "Nossa Senhora Aparecida"),
        (date(ano, 11, 2), "Finados"),
        (date(ano, 11, 15), "Proclamação da República"),
        (date(ano, 11, 20), "Dia da Consciência Negra"),
        (date(ano, 12, 25), "Natal"),
    ]


def _seed_feriados_bancarios():
    """Garante os feriados bancarios nacionais cadastrados de um ano atras
    a seis anos pra frente (cobre qualquer periodo projetado no fluxo)."""
    ano_atual = date.today().year
    linhas = []
    for ano in range(ano_atual - 1, ano_atual + 7):
        linhas.extend(_feriados_bancarios_do_ano(ano))
    valores_sql = ", ".join(["(%s, %s)"] * len(linhas))
    params: list = []
    for dt_feriado, descr in linhas:
        params.extend([dt_feriado, descr])
    execute_insert(
        f"""INSERT INTO fcp_feriados_bancarios (dt_feriado, descr) VALUES {valores_sql}
            ON CONFLICT (dt_feriado) DO NOTHING""",
        tuple(params),
    )


def _parse_empresas(empresas: Optional[str]) -> list:
    if not empresas:
        return []
    return [int(e) for e in empresas.split(",") if e.strip()]


def _dia_str(valor) -> str:
    if isinstance(valor, (date, datetime)):
        return valor.isoformat()[:10]
    return str(valor)[:10]


def _expr_dt_efetiva(coluna: str, dias_sabado: int, dias_domingo: int) -> str:
    """Expressao SQL que desloca uma data que cai em sabado/domingo pro dia
    util seguinte (pedido explicito do usuario - 3 regras de projecao):
    EXTRACT(DOW ...) = 6 e sabado, = 0 e domingo (convencao Postgres). Usada
    tanto no filtro de periodo (BETWEEN) quanto no agrupamento por mes/dia -
    a data ORIGINAL da duplicata/fatura nunca e alterada, so a data
    CONSIDERADA no fluxo de caixa."""
    return (
        f"(CASE EXTRACT(DOW FROM {coluna}) "
        f"WHEN 6 THEN {coluna} + interval '{dias_sabado} days' "
        f"WHEN 0 THEN {coluna} + interval '{dias_domingo} days' "
        f"ELSE {coluna} END)"
    )


# Duplicatas a pagar (saidas) com vencimento em fim de semana -> projetadas
# pra segunda-feira seguinte (regra 2).
_EXPR_DT_SAIDA_EFETIVA = _expr_dt_efetiva("dt_vencimento", 2, 1)

# Boleto (entrada) - compensacao bancaria: seg a qui vence -> D+1, sexta ->
# proxima segunda, sabado/domingo -> proxima terca; se a data resultante cair
# em feriado bancario, avanca pro proximo dia util (fn_fc_dt_boleto_efetiva,
# criada em _criar_tabelas_fluxo_caixa). Regra pedida explicitamente pelo
# usuario, diferente da regra de Lojas/Outras Entradas abaixo (que so troca
# fim de semana por terca, sem D+1 em dia util nem checagem de feriado).
_EXPR_DT_BOLETO_EFETIVA = "fn_fc_dt_boleto_efetiva(dt_vencimento::date)"

# Lojas e Outras Entradas (entradas) com data em fim de semana -> projetadas
# pra terca-feira seguinte (regra 3) - mantida como estava, sem D+1 nem
# feriado bancario (nao pedido pelo usuario pra essas colunas).
_EXPR_DT_LOJAS_EFETIVA = _expr_dt_efetiva("dt_dia", 3, 2)

# Cheque (entrada) - vencimento em dia util fica como esta (sem D+1); so
# sabado/domingo avanca pro proximo dia util bancario de verdade (pulando
# feriado em cadeia, igual o Boleto) - pedido explicito do usuario.
_EXPR_DT_CHEQUE_EFETIVA = "fn_fc_dt_cheque_efetiva(dt_vencimento::date)"


# ── Saldos bancarios (posicao de caixa cadastrada manualmente) ───────────
# Tabela de saldo por dia (fin_disponibilidade_caixa, pode ter mais de uma
# posicao por conta ao longo do tempo) - pega sempre a posicao mais recente
# de cada conta (DISTINCT ON), nao soma o historico inteiro. Sem filtro de
# empresa (a tabela nao tem cd_empresa - e posicao de caixa da empresa
# como um todo, nao por loja).
SQL_SALDOS_BANCARIOS = """
    SELECT DISTINCT ON (fdc.cd_conta_bancaria)
        fdc.cd_conta_bancaria, fcb.nm_banco, fcb.nr_agencia, fcb.nr_conta,
        fdc.vl_saldo, fdc.dt_posicao
    FROM fin_disponibilidade_caixa fdc
    JOIN fin_contas_bancarias fcb ON fcb.id = fdc.cd_conta_bancaria
    ORDER BY fdc.cd_conta_bancaria, fdc.dt_posicao DESC
"""


def _obter_saldos_bancarios() -> dict:
    """Conta cuja ultima posicao nao e de HOJE (horario de Brasilia) entra
    com saldo 0 e semDados=True - saldo de dias anteriores nao vale como
    posicao de caixa atual (pedido explicito do usuario). Vale pra tabela,
    pro total e pro saldo inicial do fluxo, que usam todos este total."""
    hoje = datetime.now(ZoneInfo("America/Sao_Paulo")).date().isoformat()
    rows = execute_query(SQL_SALDOS_BANCARIOS) or []
    contas = []
    for r in rows:
        dt_posicao = _dia_str(r["dt_posicao"])
        sem_dados = dt_posicao != hoje
        contas.append({
            "nmBanco": r["nm_banco"], "nrAgencia": r["nr_agencia"], "nrConta": r["nr_conta"],
            "vlSaldo": 0.0 if sem_dados else float(r["vl_saldo"]),
            "dtPosicao": dt_posicao, "semDados": sem_dados,
        })
    total = sum(c["vlSaldo"] for c in contas)
    return {"contas": contas, "total": total}


# ── Empresas presentes nas duplicatas ────────────────────────────────────
SQL_EMPRESAS = """
    SELECT idempresa AS cd_empresa, REPLACE(empresa, 'LIEBE ', '') AS nome
    FROM "dEMPRESA"
    ORDER BY 2
"""

# ── KPIs fixos (sem filtro de data/empresa, cacheados) ───────────────────
SQL_KPI_VENCIDOS = """
    SELECT
        LEFT(TRIM(cd_componente), 3) AS prefixo,
        COUNT(*)::int AS qtd,
        ROUND(SUM(vl_duplicata - vl_pago)::numeric, 2) AS valor
    FROM vr_fcp_duplicatai
    WHERE tp_situacao = 'N'
      AND (vl_duplicata - vl_pago) > 0
      AND dt_vencimento < CURRENT_DATE
    GROUP BY 1
"""

SQL_KPI_FUTUROS = """
    SELECT
        to_char(dt_vencimento, 'YYYY-MM') AS mes,
        ROUND(SUM(vl_duplicata - vl_pago)::numeric, 2) AS valor
    FROM vr_fcp_duplicatai
    WHERE tp_situacao = 'N'
      AND (vl_duplicata - vl_pago) > 0
      AND LEFT(TRIM(cd_componente), 3) != 'FCR'
      AND dt_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + interval '12 months'
    GROUP BY 1
    ORDER BY 1
"""


def _obter_kpis() -> dict:
    global _kpi_cache, _kpi_ts
    if _kpi_cache is not None and time.time() - _kpi_ts < CACHE_TTL_SEGUNDOS:
        return _kpi_cache

    r_vencidos = execute_query(SQL_KPI_VENCIDOS) or []
    r_futuros = execute_query(SQL_KPI_FUTUROS) or []

    vencidos = [{"prefixo": r["prefixo"], "qtd": r["qtd"], "valor": float(r["valor"])} for r in r_vencidos]
    total_vencido = sum(r["valor"] for r in vencidos)

    agora = datetime.now()
    d30 = (agora + timedelta(days=30)).strftime("%Y-%m")
    d90 = (agora + timedelta(days=90)).strftime("%Y-%m")

    kpi30 = kpi90 = kpi180 = 0.0
    for r in r_futuros:
        v = float(r["valor"])
        if r["mes"] <= d30:
            kpi30 += v
        if r["mes"] <= d90:
            kpi90 += v
        kpi180 += v

    _kpi_cache = {"vencidos": vencidos, "totalVencido": total_vencido, "kpi30": kpi30, "kpi90": kpi90, "kpi180": kpi180}
    _kpi_ts = time.time()
    return _kpi_cache


# ── Saidas (duplicatas a pagar) ───────────────────────────────────────────
# Vencimento em fim de semana conta pra segunda-feira seguinte no fluxo de
# caixa (regra 2) - tanto no filtro de periodo quanto no agrupamento abaixo,
# via _EXPR_DT_SAIDA_EFETIVA. A data original de vencimento nunca e tocada.
def _filtros_saidas(dt_inicio: str, dt_fim: str, empresas: list) -> tuple:
    where = f"WHERE tp_situacao = 'N' AND (vl_duplicata - vl_pago) > 0 AND {_EXPR_DT_SAIDA_EFETIVA} BETWEEN %s AND %s"
    params: list = [dt_inicio, dt_fim]
    if empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(empresas)
    return where, params


def _sql_saidas_mensal(where: str) -> str:
    return f"""
        SELECT to_char({_EXPR_DT_SAIDA_EFETIVA}, 'YYYY-MM') AS mes, tp_previsaoreal,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_duplicata - vl_pago)::numeric, 2) AS valor
        FROM vr_fcp_duplicatai
        {where}
        GROUP BY 1, 2
        ORDER BY 1, 2
    """


def _sql_saidas_diario(where: str) -> str:
    return f"""
        SELECT {_EXPR_DT_SAIDA_EFETIVA}::date AS dia, tp_previsaoreal,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_duplicata - vl_pago)::numeric, 2) AS valor
        FROM vr_fcp_duplicatai
        {where}
        GROUP BY 1, 2
        ORDER BY 1, 2
    """


# Mesmo nome de fornecedor usado no resto do app (dre.py) - nm_fantasia
# quando preenchido e nao for so asteriscos (cadastro mal feito), senao cai
# pra nm_pessoa (PJ) ou nm_pessoa de pessoa fisica.
def _sql_saidas_por_fornecedor(where: str) -> str:
    return f"""
        SELECT d.cd_fornecedor,
            CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\\*+$'
                 THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'Fornecedor ' || d.cd_fornecedor::text)
                 ELSE p.nm_fantasia END AS nome,
            ROUND(SUM(d.vl_duplicata - d.vl_pago)::numeric, 2) AS valor,
            COUNT(*)::int AS qtd
        FROM vr_fcp_duplicatai d
        LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
        LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
        {where}
        GROUP BY 1, 2
        ORDER BY 3 DESC
    """


# Saidas por despesa - precisa da tabela de rateio (vr_fcp_despduplicatai),
# que e a unica que carrega cd_despesaitem (vr_fcp_duplicatai, usada no
# resto da tela, so tem cd_componente, um codigo interno sem nome
# legivel). Uma parcela pode ter o valor rateado entre varias despesas -
# vl_rateio e a fatia de CADA despesa no valor TOTAL da parcela
# (vl_duplicata), entao pra chegar no valor ainda EM ABERTO daquela fatia e
# preciso aplicar a mesma proporcao aberta da parcela toda:
# vl_rateio * (vl_duplicata - vl_pago) / vl_duplicata. Mesmo filtro (where)
# de _filtros_saidas serve aqui tambem - as duas tabelas tem as mesmas
# colunas de filtro (tp_situacao/vl_duplicata/vl_pago/dt_vencimento/
# cd_empresa).
def _sql_saidas_por_despesa(where: str) -> str:
    return f"""
        SELECT d.cd_despesaitem, i.ds_despesaitem AS nome,
            ROUND(SUM(d.vl_rateio * (d.vl_duplicata - d.vl_pago) / NULLIF(d.vl_duplicata, 0))::numeric, 2) AS valor,
            COUNT(*)::int AS qtd
        FROM vr_fcp_despduplicatai d
        JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
        {where}
        GROUP BY 1, 2
        ORDER BY 3 DESC
    """


# ── Saidas - pedidos de compra (parcela simulada: dt_basepgto + qt_dia) ──
# Mesma regra 2 das duplicatas (fim de semana -> segunda-feira) - pedido
# explicito do usuario: pedidos tambem e saida, nao pode ter valor caindo
# em sabado/domingo.
_EXPR_DT_PEDIDOS_EFETIVA = _expr_dt_efetiva(
    "(p.dt_basepgto::date + (c.qt_dia || ' days')::interval)::date", 2, 1
)


def _filtros_pedidos(dt_inicio: str, dt_fim: str, empresas: list) -> tuple:
    params: list = [dt_inicio, dt_fim]
    empresa_clause = ""
    if empresas:
        empresa_clause = "AND p.cd_empresa = ANY(%s)"
        params.append(empresas)
    where = f"""
        FROM vr_cmp_pedidoc2 p
        JOIN vr_ger_condpgtoi c ON c.cd_condpgto = p.cd_condpgto
        WHERE p.tp_situacao IN (1, 3, 5)
          AND p.vl_pendente > 0
          AND p.dt_basepgto IS NOT NULL
          AND {_EXPR_DT_PEDIDOS_EFETIVA} BETWEEN %s AND %s
          {empresa_clause}
    """
    return where, params


def _sql_pedidos_mensal(where: str) -> str:
    return f"""
        SELECT to_char({_EXPR_DT_PEDIDOS_EFETIVA}, 'YYYY-MM') AS mes,
            COUNT(DISTINCT p.cd_pedido)::int AS qtd,
            ROUND(SUM(p.vl_pendente / NULLIF(c.qt_parcela, 0))::numeric, 2) AS valor
        {where}
        GROUP BY 1
        ORDER BY 1
    """


def _sql_pedidos_diario(where: str) -> str:
    return f"""
        SELECT {_EXPR_DT_PEDIDOS_EFETIVA} AS dia,
            COUNT(DISTINCT p.cd_pedido)::int AS qtd,
            ROUND(SUM(p.vl_pendente / NULLIF(c.qt_parcela, 0))::numeric, 2) AS valor
        {where}
        GROUP BY 1
        ORDER BY 1
    """


# ── Entradas - cartao (vr_fcr_faturai) ────────────────────────────────────
# Entrada so conta se for data FUTURA (regra 1) - tudo ate hoje ja esta no
# saldo bancario inicial, contar de novo aqui duplicaria o valor.
def _filtros_cartao(dt_inicio: str, dt_fim: str, empresas: list) -> tuple:
    where = """WHERE tp_documento IN (4, 5) AND tp_cobranca = '14' AND tp_situacao = '1'
        AND dt_vencimento BETWEEN %s AND %s
        AND dt_vencimento > CURRENT_DATE"""
    params: list = [dt_inicio, dt_fim]
    if empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(empresas)
    return where, params


def _sql_cartao_mensal(where: str) -> str:
    return f"""
        SELECT to_char(dt_vencimento, 'YYYY-MM') AS mes,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_fatura - COALESCE(vl_desconto, 0))::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        GROUP BY 1
        ORDER BY 1
    """


def _sql_cartao_diario(where: str) -> str:
    return f"""
        SELECT dt_vencimento::date AS dia,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_fatura - COALESCE(vl_desconto, 0))::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        GROUP BY 1
        ORDER BY 1
    """


# ── Entradas - cheque (vr_fcr_faturai) ────────────────────────────────────
# Regra 1 (so data futura) + fim de semana avanca pro proximo dia util
# bancario (_EXPR_DT_CHEQUE_EFETIVA).
def _filtros_cheque(dt_inicio: str, dt_fim: str, empresas: list) -> tuple:
    where = f"""WHERE tp_documento IN (2) AND tp_situacao = '1' AND (vl_fatura - vl_pago) > 0
        AND {_EXPR_DT_CHEQUE_EFETIVA} BETWEEN %s AND %s
        AND {_EXPR_DT_CHEQUE_EFETIVA} > CURRENT_DATE"""
    params: list = [dt_inicio, dt_fim]
    if empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(empresas)
    return where, params


def _sql_cheque_mensal(where: str) -> str:
    return f"""
        SELECT to_char({_EXPR_DT_CHEQUE_EFETIVA}, 'YYYY-MM') AS mes,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_fatura - vl_pago)::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        GROUP BY 1
        ORDER BY 1
    """


def _sql_cheque_diario(where: str) -> str:
    return f"""
        SELECT {_EXPR_DT_CHEQUE_EFETIVA}::date AS dia,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_fatura - vl_pago)::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        GROUP BY 1
        ORDER BY 1
    """


# ── Entradas - boleto (vr_fcr_faturai), excluindo faturas ja descontadas
# junto ao banco (empresa 001 - ver fcp_faturas_descontadas) ──────────────
# Fim de semana -> terca-feira seguinte (regra 3) e so data futura (regra 1),
# tanto no filtro de periodo quanto no agrupamento abaixo.
def _filtros_boleto(dt_inicio: str, dt_fim: str, empresas: list) -> tuple:
    where = f"""WHERE tp_documento IN (1) AND tp_situacao = '1' AND nr_portador < 999
        AND tp_cobranca <> 2
        AND (vl_fatura - vl_pago) > 0
        AND {_EXPR_DT_BOLETO_EFETIVA} BETWEEN %s AND %s
        AND {_EXPR_DT_BOLETO_EFETIVA} > CURRENT_DATE
        AND NOT (
            cd_empresa = 1 AND EXISTS (
                SELECT 1 FROM fcp_faturas_descontadas fd
                WHERE fd.nr_fat = vr_fcr_faturai.nr_fat AND fd.nr_parcela = vr_fcr_faturai.nr_parcela
            )
        )"""
    params: list = [dt_inicio, dt_fim]
    if empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(empresas)
    return where, params


def _sql_boleto_mensal(where: str) -> str:
    return f"""
        SELECT to_char({_EXPR_DT_BOLETO_EFETIVA}, 'YYYY-MM') AS mes,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_fatura - vl_pago)::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        GROUP BY 1
        ORDER BY 1
    """


def _sql_boleto_diario(where: str) -> str:
    return f"""
        SELECT {_EXPR_DT_BOLETO_EFETIVA}::date AS dia,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_fatura - vl_pago)::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        GROUP BY 1
        ORDER BY 1
    """


@router.get("/api/fluxo-caixa/boleto-detalhe")
def obter_boleto_detalhe(
    dia: str = Query(..., description="Dia efetivo (YYYY-MM-DD), mesma data mostrada na coluna Boleto"),
    empresas: Optional[str] = Query(None),
):
    """Lista as faturas (boletos) individuais cuja data EFETIVA (ja com a
    regra de compensacao bancaria/feriado - ver fn_fc_dt_boleto_efetiva) cai
    exatamente no dia pedido - mesmo filtro de _filtros_boleto, so trocando
    o BETWEEN por um dia unico, pra bater exatamente com o total mostrado na
    celula clicada da Visao Diaria."""
    _criar_tabelas_fluxo_caixa()
    cd_empresas = _parse_empresas(empresas)
    where = f"""WHERE tp_documento IN (1) AND tp_situacao = '1' AND nr_portador < 999
        AND tp_cobranca <> 2
        AND (vl_fatura - vl_pago) > 0
        AND {_EXPR_DT_BOLETO_EFETIVA} = %s
        AND {_EXPR_DT_BOLETO_EFETIVA} > CURRENT_DATE
        AND NOT (
            cd_empresa = 1 AND EXISTS (
                SELECT 1 FROM fcp_faturas_descontadas fd
                WHERE fd.nr_fat = vr_fcr_faturai.nr_fat AND fd.nr_parcela = vr_fcr_faturai.nr_parcela
            )
        )"""
    params: list = [dia]
    if cd_empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(cd_empresas)
    sql = f"""
        SELECT nm_cliente, nr_fat, nr_parcela, dt_vencimento::date AS dt_vencimento_original,
               ROUND((vl_fatura - vl_pago)::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        ORDER BY nm_cliente, nr_fat, nr_parcela
    """
    rows = execute_query(sql, tuple(params)) or []
    return [
        {
            "cliente": r["nm_cliente"],
            "nrFat": r["nr_fat"],
            "nrParcela": r["nr_parcela"],
            "dtVencimentoOriginal": _dia_str(r["dt_vencimento_original"]),
            "valor": float(r["valor"]),
        }
        for r in rows
    ]


# ── Entradas - projecao manual de lojas (fcp_lojas_projecao) ─────────────
# Mesma regra 3 do boleto (fim de semana -> terca-feira) e regra 1 (so
# futuro) - como mais de um dia original pode cair na mesma terca-feira
# projetada (ex: sexta + sabado + domingo todos ficando pra terca nao, mas
# sabado+domingo sim), precisa agregar (SUM) em vez do SELECT direto de
# antes, que supunha 1 linha por dia (dt_dia e PK da tabela).
def _sql_lojas_mensal(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        f"""SELECT to_char({_EXPR_DT_LOJAS_EFETIVA}, 'YYYY-MM') AS mes, ROUND(SUM(vl_lojas)::numeric, 2) AS valor
           FROM fcp_lojas_projecao
           WHERE {_EXPR_DT_LOJAS_EFETIVA} BETWEEN %s AND %s AND {_EXPR_DT_LOJAS_EFETIVA} > CURRENT_DATE
           GROUP BY 1 ORDER BY 1""",
        (dt_inicio, dt_fim),
    )


def _sql_lojas_diario(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        f"""SELECT {_EXPR_DT_LOJAS_EFETIVA}::date AS dia, ROUND(SUM(vl_lojas)::numeric, 2) AS valor
           FROM fcp_lojas_projecao
           WHERE {_EXPR_DT_LOJAS_EFETIVA} BETWEEN %s AND %s AND {_EXPR_DT_LOJAS_EFETIVA} > CURRENT_DATE
           GROUP BY 1 ORDER BY 1""",
        (dt_inicio, dt_fim),
    )


# ── Entradas - outras entradas (fcp_outras_entradas_projecao, projecao
# manual colada pelo usuario) - mesma regra 1/3 (so futuro, fim de semana
# vai pra terca) e mesmo cuidado de agregar (SUM) do _sql_lojas_* acima.
_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA = _expr_dt_efetiva("dt_dia", 3, 2)


def _sql_outras_entradas_mensal(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        f"""SELECT to_char({_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA}, 'YYYY-MM') AS mes, ROUND(SUM(vl_outras_entradas)::numeric, 2) AS valor
           FROM fcp_outras_entradas_projecao
           WHERE {_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA} BETWEEN %s AND %s AND {_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA} > CURRENT_DATE
           GROUP BY 1 ORDER BY 1""",
        (dt_inicio, dt_fim),
    )


def _sql_outras_entradas_diario(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        f"""SELECT {_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA}::date AS dia, ROUND(SUM(vl_outras_entradas)::numeric, 2) AS valor
           FROM fcp_outras_entradas_projecao
           WHERE {_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA} BETWEEN %s AND %s AND {_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA} > CURRENT_DATE
           GROUP BY 1 ORDER BY 1""",
        (dt_inicio, dt_fim),
    )


# ── Entradas - multimarcas (ano anterior deslocado +1 ano) ────────────────
def _sql_multimarcas_mensal(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        """
        SELECT to_char((dt_transacao::date + interval '1 year')::date, 'YYYY-MM') AS mes,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_transacao)::numeric, 2) AS valor
        FROM vr_tra_transacao
        WHERE cd_empresa = 1 AND tp_modalidade = '4' AND tp_operacao = 'S'
          AND cd_operacao IN (1, 52) AND tp_situacao = 4
          AND dt_transacao::date BETWEEN (%s::date - interval '1 year')::date AND (%s::date - interval '1 year')::date
          AND (dt_transacao::date + interval '1 year')::date > CURRENT_DATE
        GROUP BY 1
        ORDER BY 1
        """,
        (dt_inicio, dt_fim),
    )


def _sql_multimarcas_diario(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        """
        SELECT (dt_transacao::date + interval '1 year')::date AS dia,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_transacao)::numeric, 2) AS valor
        FROM vr_tra_transacao
        WHERE cd_empresa = 1 AND tp_modalidade = '4' AND tp_operacao = 'S'
          AND cd_operacao IN (1, 52) AND tp_situacao = 4
          AND dt_transacao::date BETWEEN (%s::date - interval '1 year')::date AND (%s::date - interval '1 year')::date
          AND (dt_transacao::date + interval '1 year')::date > CURRENT_DATE
        GROUP BY 1
        ORDER BY 1
        """,
        (dt_inicio, dt_fim),
    )


@router.get("/api/fluxo-caixa/empresas")
def listar_empresas_fluxo_caixa():
    _criar_tabelas_fluxo_caixa()
    rows = execute_query(SQL_EMPRESAS) or []
    return [{"id": int(r["cd_empresa"]), "nome": r["nome"]} for r in rows]


@router.get("/api/fluxo-caixa/saldos-bancarios")
def saldos_bancarios_fluxo_caixa():
    try:
        return _obter_saldos_bancarios()
    except Exception as e:
        print(f"[ERROR] Erro ao buscar saldos bancarios: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar saldos bancários")


# Faturamento da fabrica (empresa 1) - mesma regra do indicador
# "faturamento_fabrica" do painel de Indicadores (_calcular_faturamento_fabrica):
# venda liquida = saidas (modalidade 4/8) menos devolucoes (modalidade 3, E),
# excluindo as mesmas operacoes e representantes. Reaproveita as constantes de
# la pra continuar batendo se a regra mudar.
SQL_FATURAMENTO_FABRICA_DIARIO = """
    SELECT t.dt_transacao::date AS dia,
        COALESCE(SUM(CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END), 0) AS liquido
    FROM vr_tra_transacao t
    LEFT JOIN vr_tra_transitem i
        ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
    WHERE t.cd_empresa = 1
      AND t.tp_situacao = 4
      AND t.cd_representant IS NOT NULL
      AND t.cd_representant <> ALL (%s)
      AND t.cd_operacao <> ALL (%s)
      AND t.dt_transacao >= %s
      AND t.dt_transacao < %s
      AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
           OR (t.tp_modalidade IN ('3') AND t.tp_operacao = 'E'))
    GROUP BY 1
    ORDER BY 1
"""


# Faturamento das lojas (empresas 002 a 120, a pedido do usuario - inclui a
# 120/e-commerce, que o painel de Indicadores calcula a parte). Base na regra
# de lojas do indicador faturamento_fabrica (sem as operacoes excluidas de
# lojas, sem comprovante de venda 1, sem transacao cancelada), mas SEM a
# modalidade 2: no indicador ela entra porque fabrica e lojas sao somadas e
# a entrada da mercadoria na loja anula a venda fabrica->loja; sozinha, ela
# descontava compra da venda da loja e deixava dia com faturamento negativo.
# Aqui: vendas (modalidade 4/8, saida) menos devolucoes (modalidade 3).
SQL_FATURAMENTO_LOJAS_DIARIO = """
    SELECT t.dt_transacao::date AS dia,
        COALESCE(SUM(CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END), 0) AS liquido
    FROM vr_tra_transacao t
    LEFT JOIN vr_tra_transitem i
        ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
    WHERE t.cd_empresa BETWEEN 2 AND 120
      AND t.cd_operacao <> ALL (%s)
      AND i.cd_compvend <> 1
      AND t.tp_situacao <> 6
      AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
           OR t.tp_modalidade = '3')
      AND t.dt_transacao >= %s
      AND t.dt_transacao < %s
    GROUP BY 1
    ORDER BY 1
"""


def _faturamento_diario_mes_atual(sql: str, params_extra: tuple) -> dict:
    """Mes atual (horario de Brasilia), sem depender dos filtros da tela.
    Dias futuros vem com valor None (sem barra); dias passados sem venda, 0."""
    hoje = datetime.now(ZoneInfo("America/Sao_Paulo")).date()
    inicio = hoje.replace(day=1)
    proximo = (inicio + timedelta(days=32)).replace(day=1)
    rows = execute_query(sql, (*params_extra, inicio.isoformat(), proximo.isoformat())) or []
    por_dia = {_dia_str(r["dia"]): float(r["liquido"]) for r in rows}
    dias = []
    d = inicio
    while d < proximo:
        iso = d.isoformat()
        dias.append({"dia": iso, "valor": por_dia.get(iso, 0.0) if d <= hoje else None})
        d += timedelta(days=1)
    return {"mes": inicio.isoformat()[:7], "hoje": hoje.isoformat(), "dias": dias, "total": sum(por_dia.values())}


@router.get("/api/fluxo-caixa/faturamento-fabrica-mes")
def faturamento_fabrica_mes():
    try:
        return _faturamento_diario_mes_atual(
            SQL_FATURAMENTO_FABRICA_DIARIO, (list(REPRESENTANTES_EXCLUIDOS), list(OPERACOES_EXCLUIDAS))
        )
    except Exception as e:
        print(f"[ERROR] Erro ao buscar faturamento da fabrica: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar faturamento da fábrica")


@router.get("/api/fluxo-caixa/faturamento-lojas-mes")
def faturamento_lojas_mes():
    try:
        return _faturamento_diario_mes_atual(SQL_FATURAMENTO_LOJAS_DIARIO, (list(OPERACOES_EXCLUIDAS_LOJAS),))
    except Exception as e:
        print(f"[ERROR] Erro ao buscar faturamento das lojas: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar faturamento das lojas")


@router.get("/api/fluxo-caixa/dados")
def dados_fluxo_caixa(
    dt_inicio: Optional[str] = Query(None, description="Data inicial YYYY-MM-DD (default: hoje)"),
    dt_fim: Optional[str] = Query(None, description="Data final YYYY-MM-DD (default: hoje + 30 dias)"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa separados por virgula (default: todas)"),
):
    try:
        _criar_tabelas_fluxo_caixa()
        hoje = date.today()
        dt_inicio = dt_inicio or hoje.isoformat()
        dt_fim = dt_fim or (hoje + timedelta(days=30)).isoformat()
        cd_empresas = _parse_empresas(empresas)

        where_saidas, p_saidas = _filtros_saidas(dt_inicio, dt_fim, cd_empresas)
        where_cartao, p_cartao = _filtros_cartao(dt_inicio, dt_fim, cd_empresas)
        where_boleto, p_boleto = _filtros_boleto(dt_inicio, dt_fim, cd_empresas)
        where_cheque, p_cheque = _filtros_cheque(dt_inicio, dt_fim, cd_empresas)
        where_pedidos, p_pedidos = _filtros_pedidos(dt_inicio, dt_fim, cd_empresas)
        sql_lojas_m, p_lojas_m = _sql_lojas_mensal(dt_inicio, dt_fim)
        sql_lojas_d, p_lojas_d = _sql_lojas_diario(dt_inicio, dt_fim)
        sql_outras_m, p_outras_m = _sql_outras_entradas_mensal(dt_inicio, dt_fim)
        sql_outras_d, p_outras_d = _sql_outras_entradas_diario(dt_inicio, dt_fim)
        sql_multi_m, p_multi_m = _sql_multimarcas_mensal(dt_inicio, dt_fim)
        sql_multi_d, p_multi_d = _sql_multimarcas_diario(dt_inicio, dt_fim)

        kpis = _obter_kpis()
        r_saidas_m = execute_query(_sql_saidas_mensal(where_saidas), tuple(p_saidas)) or []
        r_saidas_d = execute_query(_sql_saidas_diario(where_saidas), tuple(p_saidas)) or []
        r_cartao_m = execute_query(_sql_cartao_mensal(where_cartao), tuple(p_cartao)) or []
        r_cartao_d = execute_query(_sql_cartao_diario(where_cartao), tuple(p_cartao)) or []
        r_boleto_m = execute_query(_sql_boleto_mensal(where_boleto), tuple(p_boleto)) or []
        r_boleto_d = execute_query(_sql_boleto_diario(where_boleto), tuple(p_boleto)) or []
        r_cheque_m = execute_query(_sql_cheque_mensal(where_cheque), tuple(p_cheque)) or []
        r_cheque_d = execute_query(_sql_cheque_diario(where_cheque), tuple(p_cheque)) or []
        r_pedidos_m = execute_query(_sql_pedidos_mensal(where_pedidos), tuple(p_pedidos)) or []
        r_pedidos_d = execute_query(_sql_pedidos_diario(where_pedidos), tuple(p_pedidos)) or []
        r_lojas_m = execute_query(sql_lojas_m, p_lojas_m) or []
        r_lojas_d = execute_query(sql_lojas_d, p_lojas_d) or []
        r_outras_m = execute_query(sql_outras_m, p_outras_m) or []
        r_outras_d = execute_query(sql_outras_d, p_outras_d) or []
        r_multi_m = execute_query(sql_multi_m, p_multi_m) or []
        r_multi_d = execute_query(sql_multi_d, p_multi_d) or []

        cartao_mes = {r["mes"]: float(r["valor"]) for r in r_cartao_m}
        cartao_dia = {_dia_str(r["dia"]): float(r["valor"]) for r in r_cartao_d}
        boleto_mes = {r["mes"]: float(r["valor"]) for r in r_boleto_m}
        boleto_dia = {_dia_str(r["dia"]): float(r["valor"]) for r in r_boleto_d}
        cheque_mes = {r["mes"]: float(r["valor"]) for r in r_cheque_m}
        cheque_dia = {_dia_str(r["dia"]): float(r["valor"]) for r in r_cheque_d}
        pedidos_mes = {r["mes"]: float(r["valor"]) for r in r_pedidos_m}
        pedidos_dia = {_dia_str(r["dia"]): float(r["valor"]) for r in r_pedidos_d}
        lojas_mes = {r["mes"]: float(r["valor"]) for r in r_lojas_m}
        lojas_dia = {_dia_str(r["dia"]): float(r["valor"]) for r in r_lojas_d}
        outras_mes = {r["mes"]: float(r["valor"]) for r in r_outras_m}
        outras_dia = {_dia_str(r["dia"]): float(r["valor"]) for r in r_outras_d}
        multi_mes = {r["mes"]: float(r["valor"]) for r in r_multi_m}
        multi_dia = {_dia_str(r["dia"]): float(r["valor"]) for r in r_multi_d}

        meses_map: dict = {}
        for r in r_saidas_m:
            agr = meses_map.setdefault(r["mes"], {"previsao": 0.0, "real": 0.0, "qtd": 0})
            v = float(r["valor"])
            agr["qtd"] += r["qtd"]
            if int(r["tp_previsaoreal"] or 0) == 1:
                agr["previsao"] += v
            else:
                agr["real"] += v
        for outros_mes_map in (cartao_mes, boleto_mes, cheque_mes, pedidos_mes, lojas_mes, outras_mes, multi_mes):
            for mes in outros_mes_map:
                meses_map.setdefault(mes, {"previsao": 0.0, "real": 0.0, "qtd": 0})

        meses = []
        for mes in sorted(meses_map.keys()):
            agr = meses_map[mes]
            cartao = cartao_mes.get(mes, 0.0)
            boleto = boleto_mes.get(mes, 0.0)
            cheque = cheque_mes.get(mes, 0.0)
            pedidos = pedidos_mes.get(mes, 0.0)
            lojas_raw = lojas_mes.get(mes, 0.0)
            lojas = lojas_raw - cartao if lojas_raw > cartao else 0.0
            outras_entradas = outras_mes.get(mes, 0.0)
            multimarcas = multi_mes.get(mes, 0.0)
            meses.append({
                "mes": mes, "previsao": agr["previsao"], "real": agr["real"], "pedidos": pedidos,
                "totalSaidas": agr["previsao"] + agr["real"] + pedidos,
                "cartao": cartao, "boleto": boleto, "cheque": cheque, "lojas": lojas,
                "outrasEntradas": outras_entradas, "multimarcas": multimarcas, "qtd": agr["qtd"],
            })

        dias_map: dict = {}
        for r in r_saidas_d:
            dia = _dia_str(r["dia"])
            agr = dias_map.setdefault(dia, {"previsao": 0.0, "real": 0.0, "qtd": 0})
            v = float(r["valor"])
            agr["qtd"] += r["qtd"]
            if int(r["tp_previsaoreal"] or 0) == 1:
                agr["previsao"] += v
            else:
                agr["real"] += v
        for outros_dia_map in (cartao_dia, boleto_dia, cheque_dia, pedidos_dia, lojas_dia, outras_dia, multi_dia):
            for dia in outros_dia_map:
                dias_map.setdefault(dia, {"previsao": 0.0, "real": 0.0, "qtd": 0})

        # Saldo acumulado parte do saldo bancario REAL (posicao de caixa
        # atual, nao 0) - pedido explicito do usuario: a soma dos saldos
        # das contas bancarias compoe o saldo acumulado do fluxo de caixa,
        # em vez de a projecao comecar "do zero" desconectada do dinheiro
        # que de fato esta no banco hoje.
        saldos_bancarios = _obter_saldos_bancarios()
        acum = saldos_bancarios["total"]
        dias = []
        for dia in sorted(dias_map.keys()):
            agr = dias_map[dia]
            cartao = cartao_dia.get(dia, 0.0)
            boleto = boleto_dia.get(dia, 0.0)
            cheque = cheque_dia.get(dia, 0.0)
            pedidos = pedidos_dia.get(dia, 0.0)
            lojas_raw = lojas_dia.get(dia, 0.0)
            lojas = lojas_raw - cartao if lojas_raw > cartao else 0.0
            outras_entradas = outras_dia.get(dia, 0.0)
            multimarcas = multi_dia.get(dia, 0.0)
            total_saidas = agr["previsao"] + agr["real"] + pedidos
            acum += cartao + boleto + cheque + lojas + outras_entradas + multimarcas - total_saidas
            dias.append({
                "dia": dia, "previsao": agr["previsao"], "real": agr["real"], "pedidos": pedidos,
                "totalSaidas": total_saidas, "cartao": cartao, "boleto": boleto, "cheque": cheque,
                "lojas": lojas, "outrasEntradas": outras_entradas, "multimarcas": multimarcas,
                "qtd": agr["qtd"], "saldoAcum": acum,
            })

        return {"data": {
            **kpis, "meses": meses, "dias": dias, "saldoBancario": saldos_bancarios["total"],
            "geradoEm": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        }}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar fluxo de caixa: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Erro ao carregar fluxo de caixa")


@router.get("/api/fluxo-caixa/saidas-por-fornecedor")
def saidas_por_fornecedor(
    dt_inicio: Optional[str] = Query(None),
    dt_fim: Optional[str] = Query(None),
    empresas: Optional[str] = Query(None),
):
    try:
        hoje = date.today()
        dt_inicio = dt_inicio or hoje.isoformat()
        dt_fim = dt_fim or (hoje + timedelta(days=30)).isoformat()
        where, params = _filtros_saidas(dt_inicio, dt_fim, _parse_empresas(empresas))
        rows = execute_query(_sql_saidas_por_fornecedor(where), tuple(params)) or []
        return [
            {"cdFornecedor": int(r["cd_fornecedor"]) if r["cd_fornecedor"] is not None else None,
             "nome": r["nome"], "valor": float(r["valor"]), "qtd": r["qtd"]}
            for r in rows
        ]
    except Exception as e:
        print(f"[ERROR] Erro ao buscar saidas por fornecedor: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar saídas por fornecedor")


@router.get("/api/fluxo-caixa/saidas-por-despesa")
def saidas_por_despesa(
    dt_inicio: Optional[str] = Query(None),
    dt_fim: Optional[str] = Query(None),
    empresas: Optional[str] = Query(None),
):
    try:
        hoje = date.today()
        dt_inicio = dt_inicio or hoje.isoformat()
        dt_fim = dt_fim or (hoje + timedelta(days=30)).isoformat()
        where, params = _filtros_saidas(dt_inicio, dt_fim, _parse_empresas(empresas))
        rows = execute_query(_sql_saidas_por_despesa(where), tuple(params)) or []
        return [
            {"cdDespesaItem": int(r["cd_despesaitem"]) if r["cd_despesaitem"] is not None else None,
             "nome": r["nome"], "valor": float(r["valor"]), "qtd": r["qtd"]}
            for r in rows
        ]
    except Exception as e:
        print(f"[ERROR] Erro ao buscar saidas por despesa: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar saídas por despesa")


@router.get("/api/fluxo-caixa/lojas-projecao")
def obter_lojas_projecao(
    dt_inicio: Optional[str] = Query(None),
    dt_fim: Optional[str] = Query(None),
):
    _criar_tabelas_fluxo_caixa()
    hoje = date.today()
    dt_inicio = dt_inicio or hoje.isoformat()
    dt_fim = dt_fim or (hoje + timedelta(days=365)).isoformat()
    rows = execute_query(
        "SELECT dt_dia::date AS dia, vl_lojas FROM fcp_lojas_projecao WHERE dt_dia BETWEEN %s AND %s ORDER BY 1",
        (dt_inicio, dt_fim),
    ) or []
    return [{"dia": _dia_str(r["dia"]), "valor": float(r["vl_lojas"])} for r in rows]


@router.post("/api/fluxo-caixa/lojas-projecao")
def gravar_lojas_projecao(linhas: Optional[List[dict]] = None):
    try:
        _criar_tabelas_fluxo_caixa()
        linhas = linhas or []
        if not linhas:
            return {"ok": True, "count": 0}
        # Dedup por dia (fica so a ultima ocorrencia) - um INSERT com
        # ON CONFLICT DO UPDATE nao aceita a MESMA chave duplicada dentro do
        # mesmo comando (erro do Postgres: "ON CONFLICT DO UPDATE command
        # cannot affect row a second time"), e colar milhares de linhas de
        # uma planilha facilmente repete algum dia sem querer.
        por_dia = {linha["dia"]: float(linha["valor"]) for linha in linhas}
        itens = list(por_dia.items())
        for i in range(0, len(itens), TAMANHO_LOTE_INSERT):
            lote = itens[i:i + TAMANHO_LOTE_INSERT]
            valores_sql = ", ".join(["(%s, %s, NOW())"] * len(lote))
            params: list = []
            for dia, valor in lote:
                params.extend([dia, valor])
            execute_insert(
                f"""INSERT INTO fcp_lojas_projecao (dt_dia, vl_lojas, dt_atualizacao) VALUES {valores_sql}
                    ON CONFLICT (dt_dia) DO UPDATE SET vl_lojas = EXCLUDED.vl_lojas, dt_atualizacao = NOW()""",
                tuple(params),
            )
        return {"ok": True, "count": len(itens)}
    except Exception as e:
        print(f"[ERROR] Erro ao gravar projecao de lojas: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao salvar projeção de lojas: {str(e)}")


@router.get("/api/fluxo-caixa/outras-entradas-projecao")
def obter_outras_entradas_projecao(
    dt_inicio: Optional[str] = Query(None),
    dt_fim: Optional[str] = Query(None),
):
    _criar_tabelas_fluxo_caixa()
    hoje = date.today()
    dt_inicio = dt_inicio or hoje.isoformat()
    dt_fim = dt_fim or (hoje + timedelta(days=365)).isoformat()
    rows = execute_query(
        "SELECT dt_dia::date AS dia, vl_outras_entradas FROM fcp_outras_entradas_projecao WHERE dt_dia BETWEEN %s AND %s ORDER BY 1",
        (dt_inicio, dt_fim),
    ) or []
    return [{"dia": _dia_str(r["dia"]), "valor": float(r["vl_outras_entradas"])} for r in rows]


@router.post("/api/fluxo-caixa/outras-entradas-projecao")
def gravar_outras_entradas_projecao(linhas: Optional[List[dict]] = None):
    try:
        _criar_tabelas_fluxo_caixa()
        linhas = linhas or []
        if not linhas:
            return {"ok": True, "count": 0}
        por_dia = {linha["dia"]: float(linha["valor"]) for linha in linhas}
        itens = list(por_dia.items())
        for i in range(0, len(itens), TAMANHO_LOTE_INSERT):
            lote = itens[i:i + TAMANHO_LOTE_INSERT]
            valores_sql = ", ".join(["(%s, %s, NOW())"] * len(lote))
            params: list = []
            for dia, valor in lote:
                params.extend([dia, valor])
            execute_insert(
                f"""INSERT INTO fcp_outras_entradas_projecao (dt_dia, vl_outras_entradas, dt_atualizacao) VALUES {valores_sql}
                    ON CONFLICT (dt_dia) DO UPDATE SET vl_outras_entradas = EXCLUDED.vl_outras_entradas, dt_atualizacao = NOW()""",
                tuple(params),
            )
        return {"ok": True, "count": len(itens)}
    except Exception as e:
        print(f"[ERROR] Erro ao gravar outras entradas: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao salvar outras entradas: {str(e)}")


@router.get("/api/fluxo-caixa/faturas-descontadas")
def listar_faturas_descontadas():
    _criar_tabelas_fluxo_caixa()
    rows = execute_query("SELECT nr_fat, nr_parcela FROM fcp_faturas_descontadas ORDER BY nr_fat, nr_parcela") or []
    return [{"nrFat": int(r["nr_fat"]), "nrParcela": int(r["nr_parcela"])} for r in rows]


@router.post("/api/fluxo-caixa/faturas-descontadas")
def gravar_faturas_descontadas(linhas: Optional[List[dict]] = None):
    try:
        _criar_tabelas_fluxo_caixa()
        linhas = linhas or []
        if not linhas:
            return {"ok": True, "count": 0}
        # Mesmo dedup de gravar_lojas_projecao (ver comentario la) - aqui a
        # chave e (nr_fat, nr_parcela). Lista colada de uma planilha grande
        # (ja visto: ~11500 linhas) frequentemente repete alguma fatura/
        # parcela.
        pares = {(linha["nrFat"], linha["nrParcela"]) for linha in linhas}
        itens = list(pares)
        for i in range(0, len(itens), TAMANHO_LOTE_INSERT):
            lote = itens[i:i + TAMANHO_LOTE_INSERT]
            valores_sql = ", ".join(["(%s, %s, NOW())"] * len(lote))
            params: list = []
            for nr_fat, nr_parcela in lote:
                params.extend([nr_fat, nr_parcela])
            execute_insert(
                f"""INSERT INTO fcp_faturas_descontadas (nr_fat, nr_parcela, dt_atualizacao) VALUES {valores_sql}
                    ON CONFLICT (nr_fat, nr_parcela) DO UPDATE SET dt_atualizacao = NOW()""",
                tuple(params),
            )
        return {"ok": True, "count": len(itens)}
    except Exception as e:
        print(f"[ERROR] Erro ao gravar faturas descontadas: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao salvar faturas descontadas: {str(e)}")


@router.delete("/api/fluxo-caixa/faturas-descontadas")
def remover_todas_faturas_descontadas():
    _criar_tabelas_fluxo_caixa()
    linhas = execute_query("SELECT COUNT(*)::int AS total FROM fcp_faturas_descontadas") or []
    total = linhas[0]["total"] if linhas else 0
    execute_insert("DELETE FROM fcp_faturas_descontadas", ())
    return {"ok": True, "count": total}


@router.delete("/api/fluxo-caixa/faturas-descontadas/{nr_fat}/{nr_parcela}")
def remover_fatura_descontada(nr_fat: int, nr_parcela: int):
    _criar_tabelas_fluxo_caixa()
    execute_insert(
        "DELETE FROM fcp_faturas_descontadas WHERE nr_fat = %s AND nr_parcela = %s",
        (nr_fat, nr_parcela),
    )
    return {"ok": True}
