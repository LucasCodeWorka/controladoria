"""
Fluxo de Caixa - saidas (duplicatas a pagar) e entradas (cartao, boleto,
cheque, projecao de lojas, multimarcas) projetadas e realizadas, com saldo
diario acumulado. Portado do app_controladoria (routes/fluxo-caixa.js), que
ja roda em producao contra o mesmo banco (mesmo host/schema) - mesma logica
de calculo, so traduzida de Node/Express pra Python/FastAPI.

Tabelas proprias (criadas sob demanda, mesmo padrao do giro_snapshot em
giro.py): fcp_lojas_projecao e fcp_outras_entradas_projecao (projecoes
manuais coladas pelo usuario). Faturas da empresa 001 ja descontadas junto ao
banco (que saem do Boleto futuro) vem da tabela borderos - ver
_SQL_FATURAS_DESCONTADAS.
"""
from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
import threading
import time
from database import execute_query, execute_insert
from routers.indicadores import OPERACOES_EXCLUIDAS, OPERACOES_EXCLUIDAS_LOJAS, REPRESENTANTES_EXCLUIDOS

router = APIRouter()

CACHE_TTL_SEGUNDOS = 10 * 60
_kpi_cache: Optional[dict] = None
_kpi_ts: float = 0.0

# Lojas-projecao/outras-entradas: tamanho do lote pro INSERT em massa
# (usuario cola listas de milhares de linhas direto de planilha) - evita
# montar um unico INSERT gigante de uma vez.
TAMANHO_LOTE_INSERT = 500


_tabelas_fluxo_caixa_lock = threading.Lock()
_tabelas_fluxo_caixa_ok = False


def _criar_tabelas_fluxo_caixa():
    """Uma vez por processo, com trava: os CREATE OR REPLACE FUNCTION em
    requisicoes paralelas (a tela dispara varias juntas) falhavam com
    "tuple concurrently updated"."""
    global _tabelas_fluxo_caixa_ok
    if _tabelas_fluxo_caixa_ok:
        return
    with _tabelas_fluxo_caixa_lock:
        if _tabelas_fluxo_caixa_ok:
            return
        _criar_tabelas_fluxo_caixa_ddl()
        _tabelas_fluxo_caixa_ok = True


def _criar_tabelas_fluxo_caixa_ddl():
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
        CREATE TABLE IF NOT EXISTS fcp_simulacao_fluxo_caixa (
            id SMALLINT PRIMARY KEY DEFAULT 1,
            vl_uso_garantia NUMERIC(16,2) NOT NULL DEFAULT 0,
            dt_pagamento_garantia DATE,
            usuario TEXT,
            dt_atualizacao TIMESTAMP DEFAULT NOW(),
            CONSTRAINT fcp_simulacao_fluxo_caixa_linha_unica CHECK (id = 1)
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
    # Cartao - recebimento a partir da data da VENDA (dt_emissao), regras
    # passadas pelo usuario (Rede):
    #   debito  = venda + 1 dia corrido; caiu em sab/dom/feriado -> proximo dia util
    #             (sex/sab -> seg, dom -> seg)
    #   credito = 2o dia util bancario depois da venda (qui -> seg, sex/sab/dom -> ter)
    execute_insert("""
        CREATE OR REPLACE FUNCTION fn_fc_dt_cartao_debito(p_venda DATE)
        RETURNS DATE AS $$
        BEGIN
            RETURN fn_fc_proximo_dia_util_bancario(p_venda + 1);
        END;
        $$ LANGUAGE plpgsql STABLE
    """, ())
    execute_insert("""
        CREATE OR REPLACE FUNCTION fn_fc_dt_cartao_credito(p_venda DATE)
        RETURNS DATE AS $$
        BEGIN
            RETURN fn_fc_proximo_dia_util_bancario(fn_fc_proximo_dia_util_bancario(p_venda + 1) + 1);
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

# Pre-filtro na data ORIGINAL (usa o indice de dt_vencimento). As datas
# efetivas acima nunca sao ANTES do vencimento e no maximo alguns dias
# depois (fim de semana + feriados em cadeia) - 15 dias de folga cobre com
# sobra. Sem isso o banco roda a funcao plpgsql linha a linha na tabela de
# faturas inteira (consulta de cartao foi de ~1s pra 20-97s). Recebe
# (dt_inicio, dt_fim) e vem ANTES do filtro pela data efetiva, que continua
# decidindo o dia exato.
_FOLGA_DIAS_DT_EFETIVA = 15
_PRE_FILTRO_VENCIMENTO = (
    f"dt_vencimento >= (%s::date - {_FOLGA_DIAS_DT_EFETIVA}) AND dt_vencimento < (%s::date + 1)"
)


# ── Saldos bancarios (posicao de caixa cadastrada manualmente) ───────────
# Tabela de saldo por dia (fin_disponibilidade_caixa, pode ter mais de uma
# posicao por conta ao longo do tempo) - pega sempre a posicao mais recente
# de cada conta (DISTINCT ON), nao soma o historico inteiro. Sem filtro de
# empresa (a tabela nao tem cd_empresa - e posicao de caixa da empresa
# como um todo, nao por loja).
SQL_SALDOS_BANCARIOS = """
    SELECT DISTINCT ON (fdc.cd_conta_bancaria)
        fdc.cd_conta_bancaria, fcb.nm_banco, fcb.nr_agencia, fcb.nr_conta,
        fdc.vl_saldo, fdc.vl_limite_total_credito, fdc.qt_dias_cheque_especial,
        fcb.qt_dias_carencia, fdc.dt_posicao
    FROM fin_disponibilidade_caixa fdc
    JOIN fin_contas_bancarias fcb ON fcb.id = fdc.cd_conta_bancaria
    ORDER BY fdc.cd_conta_bancaria, fdc.dt_posicao DESC
"""


def _obter_saldos_bancarios(somente_hoje: bool = True) -> dict:
    """Conta cuja ultima posicao nao e de HOJE (horario de Brasilia) entra
    com saldo 0 e semDados=True - saldo de dias anteriores nao vale como
    posicao de caixa atual (pedido explicito do usuario). Vale pra tabela,
    pro total e pro saldo inicial do fluxo, que usam todos este total.

    Cheque especial - DUAS colunas diferentes (confirmado pelo usuario com
    uma consulta propria, apos eu ter invertido o sentido numa tentativa
    anterior):
      - fin_contas_bancarias.qt_dias_carencia = franquia TOTAL de dias de
        cheque especial contratada pela conta (fixo por conta);
      - fin_disponibilidade_caixa.qt_dias_cheque_especial = dias JA
        USADOS dessa franquia na posicao mais recente (NAO e "dias
        restantes" - e o contrario).
    dias_restantes = GREATEST(carencia - usados, 0). vlLimiteContratado
    (vl_limite_total_credito, cru) so fica "disponivel de verdade"
    (vlLimite/vlDisponivel) quando ainda sobra pelo menos 1 dia de
    franquia - senao, mesmo com limite contratado > 0, a conta ja estourou
    os dias da franquia nesse periodo (ex.: Itau 10503-6: franquia 7 dias,
    7 usados, 0 restantes - limite nao mostrado). Conta sem franquia
    contratada (qt_dias_carencia = 0, ex.: Banco do Brasil) nao mostra a
    situacao de dias (fica "-"), mesmo tendo um vl_limite_total_credito >
    0 cadastrado.

    somente_hoje=False (usado pelo Balanco Patrimonial): mantem o ultimo saldo
    de cada conta mesmo que nao seja de hoje; semDados continua indicando
    que a posicao nao e do dia."""
    hoje = datetime.now(ZoneInfo("America/Sao_Paulo")).date().isoformat()
    rows = execute_query(SQL_SALDOS_BANCARIOS) or []
    contas = []
    for r in rows:
        dt_posicao = _dia_str(r["dt_posicao"])
        sem_dados = dt_posicao != hoje
        vl_saldo = 0.0 if (sem_dados and somente_hoje) else float(r["vl_saldo"])
        qt_dias_carencia = int(r["qt_dias_carencia"] or 0)
        qt_dias_usados = int(r["qt_dias_cheque_especial"] or 0)
        qt_dias_restantes = max(qt_dias_carencia - qt_dias_usados, 0)
        vl_limite_contratado = float(r["vl_limite_total_credito"] or 0)
        vl_limite = vl_limite_contratado if qt_dias_restantes > 0 else 0.0
        contas.append({
            "nmBanco": r["nm_banco"], "nrAgencia": r["nr_agencia"], "nrConta": r["nr_conta"],
            "vlSaldo": vl_saldo, "vlLimite": vl_limite, "vlDisponivel": vl_saldo + vl_limite,
            "vlLimiteContratado": vl_limite_contratado,
            "qtDiasCarencia": qt_dias_carencia, "qtDiasUsados": qt_dias_usados, "qtDiasRestantes": qt_dias_restantes,
            "dtPosicao": dt_posicao, "semDados": sem_dados,
        })
    total = sum(c["vlSaldo"] for c in contas)
    total_limite = sum(c["vlLimite"] for c in contas)
    return {"contas": contas, "total": total, "totalLimite": total_limite, "totalDisponivel": total + total_limite}


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
        ROUND(SUM(vl_duplicata - vl_pago - COALESCE(vl_desconto, 0))::numeric, 2) AS valor
    FROM vr_fcp_duplicatai
    WHERE tp_situacao = 'N'
      AND tp_estagio <> 90
      AND (vl_duplicata - vl_pago - COALESCE(vl_desconto, 0)) > 0.005
      AND dt_vencimento < CURRENT_DATE
    GROUP BY 1
"""

SQL_KPI_FUTUROS = """
    SELECT
        to_char(dt_vencimento, 'YYYY-MM') AS mes,
        ROUND(SUM(vl_duplicata - vl_pago - COALESCE(vl_desconto, 0))::numeric, 2) AS valor
    FROM vr_fcp_duplicatai
    WHERE tp_situacao = 'N'
      AND tp_estagio <> 90
      AND (vl_duplicata - vl_pago - COALESCE(vl_desconto, 0)) > 0.005
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
    # Saldo = duplicata - pago - DESCONTO concedido: duplicata quitada com desconto
    # (ex.: 216,58 = 198,73 pago + 17,85 de desconto) tem estagio 10 e dt_liq, e sem
    # descontar vl_desconto aparecia como R$ 17,85 "em aberto" (pedido do usuario).
    # tp_estagio 90 = liquidado: o sistema deixa saldo em vl_pago/vl_duplicata
    # mesmo liquidada (10 mil duplicatas assim, ~R$ 9 mi) - conta como PAGA,
    # pedido explicito do usuario.
    where = (f"WHERE tp_situacao = 'N' AND tp_estagio <> 90 AND (vl_duplicata - vl_pago - COALESCE(vl_desconto, 0)) > 0.005 AND {_PRE_FILTRO_VENCIMENTO} "
             f"AND {_EXPR_DT_SAIDA_EFETIVA} BETWEEN %s AND %s")
    params: list = [dt_inicio, dt_fim, dt_inicio, dt_fim]
    if empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(empresas)
    return where, params


def _sql_saidas_mensal(where: str) -> str:
    return f"""
        SELECT to_char({_EXPR_DT_SAIDA_EFETIVA}, 'YYYY-MM') AS mes, tp_previsaoreal,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_duplicata - vl_pago - COALESCE(vl_desconto, 0))::numeric, 2) AS valor
        FROM vr_fcp_duplicatai
        {where}
        GROUP BY 1, 2
        ORDER BY 1, 2
    """


def _sql_saidas_diario(where: str) -> str:
    return f"""
        SELECT {_EXPR_DT_SAIDA_EFETIVA}::date AS dia, tp_previsaoreal,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_duplicata - vl_pago - COALESCE(vl_desconto, 0))::numeric, 2) AS valor
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
            ROUND(SUM(d.vl_duplicata - d.vl_pago - COALESCE(d.vl_desconto, 0))::numeric, 2) AS valor,
            COUNT(*)::int AS qtd
        FROM vr_fcp_duplicatai d
        LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
        LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
        {where}
        GROUP BY 1, 2
        ORDER BY 3 DESC
    """


# Fornecedores de uma (ou mais) despesa - clique na despesa da tela filtra
# os paineis de fornecedor. Usa a tabela de rateio (a unica com
# cd_despesaitem) com a mesma proporcao em aberto de _sql_saidas_por_despesa,
# pra soma dos fornecedores bater com o valor da despesa clicada.
def _sql_saidas_por_fornecedor_despesa(where: str) -> str:
    return f"""
        SELECT d.cd_fornecedor,
            CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\\*+$'
                 THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'Fornecedor ' || d.cd_fornecedor::text)
                 ELSE p.nm_fantasia END AS nome,
            ROUND(SUM(d.vl_rateio * (d.vl_duplicata - d.vl_pago - COALESCE(d.vl_desconto, 0)) / NULLIF(d.vl_duplicata, 0))::numeric, 2) AS valor,
            COUNT(*)::int AS qtd
        FROM vr_fcp_despduplicatai d
        LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
        LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
        {where} AND d.cd_despesaitem = ANY(%s)
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
        SELECT d.cd_despesaitem, i.ds_despesaitem AS nome, c.conta_dfc,
            ROUND(SUM(d.vl_rateio * (d.vl_duplicata - d.vl_pago - COALESCE(d.vl_desconto, 0)) / NULLIF(d.vl_duplicata, 0))::numeric, 2) AS valor,
            COUNT(*)::int AS qtd
        FROM vr_fcp_despduplicatai d
        JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
        LEFT JOIN classificacao_despesas_dfc c ON c.cd_despesaitem = d.cd_despesaitem
        {where}
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC
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
# tp_documento 4 = cartao de credito, 5 = cartao de debito (confirmado pelo
# usuario - o banco nao tem tabela de descricao dos tipos).
# Entrada so conta se for data FUTURA (regra 1) - tudo ate hoje ja esta no
# saldo bancario inicial, contar de novo aqui duplicaria o valor.
# Data de recebimento calculada pela data da VENDA (dt_emissao), nao pelo
# vencimento do ERP - regra pedida pelo usuario, diferente pra credito e
# debito (ver fn_fc_dt_cartao_credito/debito). Todas as parcelas de uma
# venda a credito caem no mesmo dia (a Rede antecipa).
_EXPR_DT_CARTAO_EFETIVA = (
    "(CASE WHEN tp_documento = 5 THEN fn_fc_dt_cartao_debito(dt_emissao::date) "
    "ELSE fn_fc_dt_cartao_credito(dt_emissao::date) END)"
)
# Mesmo pre-filtro por indice do _PRE_FILTRO_VENCIMENTO, so que na data da
# venda: o recebimento e sempre depois da venda e no maximo alguns dias.
_PRE_FILTRO_EMISSAO = (
    f"dt_emissao >= (%s::date - {_FOLGA_DIAS_DT_EFETIVA}) AND dt_emissao < (%s::date + 1)"
)


def _filtros_cartao(dt_inicio: str, dt_fim: str, empresas: list) -> tuple:
    where = f"""WHERE tp_documento IN (4, 5) AND tp_cobranca = '14' AND tp_situacao = '1'
        AND {_PRE_FILTRO_EMISSAO}
        AND {_EXPR_DT_CARTAO_EFETIVA} BETWEEN %s AND %s
        AND {_EXPR_DT_CARTAO_EFETIVA} > CURRENT_DATE"""
    params: list = [dt_inicio, dt_fim, dt_inicio, dt_fim]
    if empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(empresas)
    return where, params


def _sql_cartao_mensal(where: str) -> str:
    return f"""
        SELECT to_char({_EXPR_DT_CARTAO_EFETIVA}, 'YYYY-MM') AS mes,
            COUNT(*)::int AS qtd, ROUND(SUM(vl_fatura - COALESCE(vl_desconto, 0))::numeric, 2) AS valor
        FROM vr_fcr_faturai
        {where}
        GROUP BY 1
        ORDER BY 1
    """


def _sql_cartao_diario(where: str) -> str:
    return f"""
        SELECT {_EXPR_DT_CARTAO_EFETIVA}::date AS dia,
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
        AND {_PRE_FILTRO_VENCIMENTO}
        AND {_EXPR_DT_CHEQUE_EFETIVA} BETWEEN %s AND %s
        AND {_EXPR_DT_CHEQUE_EFETIVA} > CURRENT_DATE"""
    params: list = [dt_inicio, dt_fim, dt_inicio, dt_fim]
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
# junto ao banco (empresa 001 - ver _SQL_FATURAS_DESCONTADAS) ─────────────
# Faturas descontadas = tabela borderos (todo bordero de desconto importado
# no banco, campo dcto no formato "fatura/parcela", ex.: "102037/002").
# Antes era uma lista colada a mao no Fluxo de Caixa (fcp_faturas_descontadas)
# - substituida pelo borderos a pedido do usuario: bordero novo passa a valer
# sozinho, sem colar nada. Na troca, todas as faturas da lista colada
# estavam no borderos (nada se perdeu).
_SQL_FATURAS_DESCONTADAS = """
    SELECT split_part(dcto, '/', 1)::bigint, split_part(dcto, '/', 2)::bigint
    FROM borderos
    WHERE dcto ~ '^[0-9]+/[0-9]+$'
"""
_FILTRO_SEM_DESCONTADAS = f"""NOT (
            cd_empresa = 1 AND (nr_fat, nr_parcela) IN ({_SQL_FATURAS_DESCONTADAS})
        )"""
# Fim de semana -> terca-feira seguinte (regra 3) e so data futura (regra 1),
# tanto no filtro de periodo quanto no agrupamento abaixo.
def _filtros_boleto(dt_inicio: str, dt_fim: str, empresas: list) -> tuple:
    where = f"""WHERE tp_documento IN (1) AND tp_situacao = '1' AND nr_portador < 999
        AND tp_cobranca <> 2
        AND (vl_fatura - vl_pago) > 0
        AND {_PRE_FILTRO_VENCIMENTO}
        AND {_EXPR_DT_BOLETO_EFETIVA} BETWEEN %s AND %s
        AND {_EXPR_DT_BOLETO_EFETIVA} > CURRENT_DATE
        AND {_FILTRO_SEM_DESCONTADAS}"""
    params: list = [dt_inicio, dt_fim, dt_inicio, dt_fim]
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


# Qual banco cobra o boleto - regra confirmada pelo usuario, direto da
# faturai (nr_portador) + fcr_fatcodbar (nr_ctapes), sem tabela de bancos:
#   portador 001 = Banco do Brasil direto, a conta nao importa;
#   portador 341 (Itau) tem 3 contas de cobranca diferentes, so a nr_ctapes
#   desempata entre elas.
_PORTADOR_BANCO_DO_BRASIL = 1
_PORTADOR_ITAU = 341
_CONTAS_ITAU = {
    740907: "Itaú — Cta Garantida",
    105036: "Itaú — Cta Simples",
    16862: "Multiplike",
}


def _nome_banco_boleto(nr_portador, nr_ctapes) -> str:
    if nr_portador == _PORTADOR_BANCO_DO_BRASIL:
        return "Banco do Brasil"
    if nr_portador == _PORTADOR_ITAU:
        if nr_ctapes in _CONTAS_ITAU:
            return _CONTAS_ITAU[nr_ctapes]
        # Conta do Itau fora das 3 conhecidas - mostra o numero em vez de
        # esconder, pra nao atribuir banco errado (achado na auditoria: ha
        # poucos casos assim, nr_ctapes 10503 e 130001002).
        return f"Itaú — conta {nr_ctapes}" if nr_ctapes else "Itaú — conta não identificada"
    return f"Portador {nr_portador}"


def _chave_fatura(r) -> tuple:
    return (r["cd_empresa"], r["cd_cliente"], r["nr_fat"], r["nr_parcela"])


def _nr_ctapes_por_fatura(rows) -> dict:
    """Conta de cobranca (fcr_fatcodbar.nr_ctapes) de cada fatura, numa
    consulta separada: fcr_fatcodbar tem colunas com o MESMO nome das macros
    de filtro do boleto (cd_empresa/nr_fat/nr_parcela/tp_situacao/
    dt_vencimento) - juntar na mesma query geraria coluna ambigua. Precisa
    do cd_cliente: a PK e (cd_empresa, cd_cliente, nr_fat, nr_parcela,
    nr_seqcod) e, sem ele, o banco nao usa o indice (2 mil faturas levavam
    13s; com ele, <1s). Uma fatura pode ter mais de um codigo de barras
    (nr_seqcod) - vale o mais recente."""
    chaves = list({_chave_fatura(r) for r in rows})
    if not chaves:
        return {}
    sql = """
        SELECT DISTINCT ON (cb.cd_empresa, cb.cd_cliente, cb.nr_fat, cb.nr_parcela)
               cb.cd_empresa, cb.cd_cliente, cb.nr_fat, cb.nr_parcela, cb.nr_ctapes
        FROM unnest(%s::int[], %s::bigint[], %s::bigint[], %s::bigint[]) AS k(emp, cli, fat, par)
        JOIN fcr_fatcodbar cb
          ON cb.cd_empresa = k.emp AND cb.cd_cliente = k.cli AND cb.nr_fat = k.fat AND cb.nr_parcela = k.par
        ORDER BY cb.cd_empresa, cb.cd_cliente, cb.nr_fat, cb.nr_parcela, cb.nr_seqcod DESC
    """
    params = tuple([c[i] for c in chaves] for i in range(4))
    return {_chave_fatura(c): c["nr_ctapes"] for c in execute_query(sql, params) or []}


@router.get("/api/fluxo-caixa/boleto-por-banco")
def obter_boleto_por_banco(
    dtInicio: str = Query(...),
    dtFim: str = Query(...),
    empresas: Optional[str] = Query(None),
):
    """Total da coluna Boleto no periodo inteiro, quebrado por banco de
    cobranca (e, dentro de cada banco, por mes da data efetiva - mesmo mes
    da coluna Boleto da visao mensal) - mesmo filtro (_filtros_boleto) e
    mesma regra de banco (_nome_banco_boleto) do modal de detalhe do dia,
    entao a soma bate com o total da coluna."""
    _criar_tabelas_fluxo_caixa()
    where, params = _filtros_boleto(dtInicio, dtFim, _parse_empresas(empresas))
    rows = execute_query(
        f"""SELECT cd_empresa, cd_cliente, nr_fat, nr_parcela, nr_portador,
                   to_char({_EXPR_DT_BOLETO_EFETIVA}, 'YYYY-MM') AS mes,
                   ROUND((vl_fatura - vl_pago)::numeric, 2) AS valor
            FROM vr_fcr_faturai {where}""",
        tuple(params),
    ) or []
    # Visao "vencimento puro": mesmo universo de faturas (boleto em aberto,
    # sem descontadas), mas agrupado pelo MES DO VENCIMENTO e filtrado pelo
    # periodo no proprio vencimento, so de hoje em diante (vencidos ficam de fora,
    # como na visao por recebimento) - sem deslocamento de D+1/fim de semana/
    # feriado. Opcional no modal; a visao
    # padrao (data efetiva) continua igual.
    where_venc = f"""WHERE tp_documento IN (1) AND tp_situacao = '1' AND nr_portador < 999
        AND tp_cobranca <> 2
        AND (vl_fatura - vl_pago) > 0
        AND dt_vencimento::date BETWEEN %s AND %s
        AND dt_vencimento::date >= CURRENT_DATE
        AND {_FILTRO_SEM_DESCONTADAS}"""
    params_venc: list = [dtInicio, dtFim]
    empresas_lista = _parse_empresas(empresas)
    if empresas_lista:
        where_venc += " AND cd_empresa = ANY(%s)"
        params_venc.append(empresas_lista)
    rows_venc = execute_query(
        f"""SELECT cd_empresa, cd_cliente, nr_fat, nr_parcela, nr_portador,
                   to_char(dt_vencimento::date, 'YYYY-MM') AS mes,
                   ROUND((vl_fatura - vl_pago)::numeric, 2) AS valor
            FROM vr_fcr_faturai {where_venc}""",
        tuple(params_venc),
    ) or []
    ctapes = _nr_ctapes_por_fatura(rows + rows_venc)
    por_banco: dict = {}

    def _acumular(lista, campo_meses, campo_valor, campo_qtd):
        for r in lista:
            banco = _nome_banco_boleto(r["nr_portador"], ctapes.get(_chave_fatura(r)))
            atual = por_banco.setdefault(
                banco,
                {"banco": banco, "valor": 0.0, "qtd": 0, "valorVenc": 0.0, "qtdVenc": 0, "_meses": {}, "_mesesVenc": {}},
            )
            valor = float(r["valor"])
            atual[campo_valor] += valor
            atual[campo_qtd] += 1
            mes = atual[campo_meses].setdefault(r["mes"], {"mes": r["mes"], "valor": 0.0, "qtd": 0})
            mes["valor"] += valor
            mes["qtd"] += 1

    _acumular(rows, "_meses", "valor", "qtd")
    _acumular(rows_venc, "_mesesVenc", "valorVenc", "qtdVenc")
    for b in por_banco.values():
        b["valor"] = round(b["valor"], 2)
        b["valorVenc"] = round(b["valorVenc"], 2)
        b["meses"] = sorted(b.pop("_meses").values(), key=lambda m: m["mes"])
        b["mesesVenc"] = sorted(b.pop("_mesesVenc").values(), key=lambda m: m["mes"])
        for m in b["meses"] + b["mesesVenc"]:
            m["valor"] = round(m["valor"], 2)
    return sorted(por_banco.values(), key=lambda b: -b["valor"])


@router.get("/api/fluxo-caixa/boleto-detalhe")
def obter_boleto_detalhe(
    dia: str = Query(..., description="Dia efetivo (YYYY-MM-DD), mesma data mostrada na coluna Boleto"),
    empresas: Optional[str] = Query(None),
    incluirPagos: bool = Query(False, description="So vale pra HOJE: traz tambem os ja pagos (valor = pago + em aberto)"),
):
    """Lista as faturas (boletos) individuais cuja data EFETIVA (ja com a
    regra de compensacao bancaria/feriado - ver fn_fc_dt_boleto_efetiva) cai
    exatamente no dia pedido - mesmo filtro de _filtros_boleto, so trocando
    o BETWEEN por um dia unico, pra bater exatamente com o total mostrado na
    celula clicada da Visao Diaria."""
    _criar_tabelas_fluxo_caixa()
    cd_empresas = _parse_empresas(empresas)
    # Hoje + incluirPagos: sem o filtro de saldo > 0, pra mostrar tambem o que
    # ja foi pago (conferencia do dia atual - ver _entradas_hoje_informativo).
    so_hoje_com_pagos = incluirPagos and dia == date.today().isoformat()
    filtro_saldo = "" if so_hoje_com_pagos else "AND (vl_fatura - vl_pago) > 0"
    where = f"""WHERE tp_documento IN (1) AND tp_situacao = '1' AND nr_portador < 999
        AND tp_cobranca <> 2
        {filtro_saldo}
        AND {_PRE_FILTRO_VENCIMENTO}
        AND {_EXPR_DT_BOLETO_EFETIVA} = %s
        AND {_EXPR_DT_BOLETO_EFETIVA} >= CURRENT_DATE
        AND {_FILTRO_SEM_DESCONTADAS}"""
    params: list = [dia, dia, dia]
    if cd_empresas:
        where += " AND cd_empresa = ANY(%s)"
        params.append(cd_empresas)
    sql = f"""
        SELECT cd_empresa, cd_cliente, nm_cliente, nr_fat, nr_parcela, dt_vencimento::date AS dt_vencimento_original,
               ROUND((vl_fatura - vl_pago)::numeric, 2) AS valor, ROUND(vl_pago::numeric, 2) AS pago, nr_portador
        FROM vr_fcr_faturai
        {where}
        ORDER BY nm_cliente, nr_fat, nr_parcela
    """
    rows = execute_query(sql, tuple(params)) or []

    nr_ctapes_por_chave = _nr_ctapes_por_fatura(rows)

    return [
        {
            "cliente": r["nm_cliente"],
            "nrFat": r["nr_fat"],
            "nrParcela": r["nr_parcela"],
            "dtVencimentoOriginal": _dia_str(r["dt_vencimento_original"]),
            "valor": float(r["valor"]),
            "pago": float(r["pago"]) if so_hoje_com_pagos else 0.0,
            "banco": _nome_banco_boleto(r["nr_portador"], nr_ctapes_por_chave.get(_chave_fatura(r))),
        }
        for r in rows
    ]


_NOME_FORNECEDOR = """CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\\*+$'
                 THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'Fornecedor ' || d.cd_fornecedor::text)
                 ELSE p.nm_fantasia END"""


@router.get("/api/fluxo-caixa/saidas-detalhe")
def obter_saidas_detalhe(
    dia: str = Query(..., description="Dia efetivo (YYYY-MM-DD), mesma data da linha da Visao Diaria"),
    tipo: str = Query(..., description="previsao | real | pedidos"),
    empresas: Optional[str] = Query(None),
):
    """O que compoe a celula Prev./Real/Pedidos clicada na Visao Diaria. Usa
    os MESMOS filtros do /dados (_filtros_saidas / _filtros_pedidos) com o
    periodo travado num dia so - a soma tem que bater com a celula."""
    cd_empresas = _parse_empresas(empresas)
    try:
        if tipo in ("previsao", "real"):
            where, params = _filtros_saidas(dia, dia, cd_empresas)
            where += " AND COALESCE(d.tp_previsaoreal, 0) " + ("= 1" if tipo == "previsao" else "<> 1")
            # Uma parcela pode ser rateada entre varias despesas - lista os
            # nomes juntos (o valor e da parcela inteira, igual na celula).
            sql = f"""
                SELECT {_NOME_FORNECEDOR} AS fornecedor,
                    d.cd_empresa, d.nr_duplicata, d.nr_parcela,
                    d.dt_vencimento::date AS dt_vencimento_original,
                    ROUND((d.vl_duplicata - d.vl_pago - COALESCE(d.vl_desconto, 0))::numeric, 2) AS valor,
                    (SELECT string_agg(DISTINCT i.ds_despesaitem, ', ')
                       FROM vr_fcp_despduplicatai r
                       JOIN vr_fcp_despesaitem i ON i.cd_despesaitem = r.cd_despesaitem
                      WHERE r.cd_empresa = d.cd_empresa AND r.cd_fornecedor = d.cd_fornecedor
                        AND r.nr_duplicata = d.nr_duplicata AND r.nr_parcela = d.nr_parcela) AS despesas
                FROM vr_fcp_duplicatai d
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
                {where}
                ORDER BY valor DESC
            """
            rows = execute_query(sql, tuple(params)) or []
            return [
                {
                    "fornecedor": r["fornecedor"],
                    "documento": f"{r['nr_duplicata']}/{r['nr_parcela']}",
                    "empresa": r["cd_empresa"],
                    "dtOriginal": _dia_str(r["dt_vencimento_original"]),
                    "despesa": r["despesas"],
                    "valor": float(r["valor"]),
                }
                for r in rows
            ]
        if tipo == "pedidos":
            where, params = _filtros_pedidos(dia, dia, cd_empresas)
            sql = f"""
                SELECT p.nm_fornecedor AS fornecedor, p.cd_empresa, p.cd_pedido, c.nr_parcela, c.qt_parcela,
                    (p.dt_basepgto::date + (c.qt_dia || ' days')::interval)::date AS dt_parcela_original,
                    ROUND((p.vl_pendente / NULLIF(c.qt_parcela, 0))::numeric, 2) AS valor
                {where}
                ORDER BY valor DESC
            """
            rows = execute_query(sql, tuple(params)) or []
            return [
                {
                    "fornecedor": r["fornecedor"],
                    "documento": f"Pedido {r['cd_pedido']} — parcela {r['nr_parcela']}/{r['qt_parcela']}",
                    "empresa": r["cd_empresa"],
                    "dtOriginal": _dia_str(r["dt_parcela_original"]),
                    "despesa": None,
                    "valor": float(r["valor"] or 0),
                }
                for r in rows
            ]
        raise HTTPException(status_code=400, detail="tipo deve ser previsao, real ou pedidos")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar detalhe das saidas: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar o detalhe das saídas")


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


# ── Entradas - multimarcas (ano anterior deslocado 52 semanas) ────────────
# Data = venda do ano passado + 364 dias (52 semanas) - pedido do usuario:
# mantem o MESMO dia da semana (venda de segunda do ano passado vira segunda,
# sexta vira sexta). Com "+1 ano" o dia da semana andava uma casa (sexta
# virava sabado) e ~26% do valor caia em sab/dom, linhas que a Visao Diaria
# esconde. O que ainda cair em sab/dom (venda de sabado do ano passado, ~8%)
# ou feriado bancario em dia de semana vai pro proximo dia util bancario - a
# empresa nao trabalha sabado nem feriado. (fn_fc_dt_cheque_efetiva NAO serve
# aqui: ela so pula sab/dom, nao feriado em dia de semana.)
_DIAS_DESLOCAMENTO_MULTIMARCAS = 364
_EXPR_DT_MULTIMARCAS_EFETIVA = f"fn_fc_proximo_dia_util_bancario(dt_transacao::date + {_DIAS_DESLOCAMENTO_MULTIMARCAS})"
# Venda (modalidade 4, saida) MENOS devolucao (modalidade 3, entrada) do dia -
# liquido, igual ao que o usuario confere direto no sistema (conferido:
# 20/10/2025 venda 199.642,42 - devol 2.004,93 = 197.637,49; 21/10/2025 venda
# 290.675,72 - devol 6.475,17 = 284.200,55 - bateu exato nos dois dias). Sem
# descontar devolucao o valor projetado ficava inflado, as vezes ~5% no dia.
# cd_operacao NAO e mais restrito a (1, 52): o sistema que o usuario confere
# nao aplica esse filtro (um registro de cd_operacao=58 do dia 21/10 ficava
# de fora so por essa restricao, sem motivo de negocio identificado - se
# algum cd_operacao precisar ser excluido de verdade, e so adicionar aqui).
# Pre-filtro na data original (o efetivo e no maximo alguns dias depois do
# deslocado - mesma ideia do _PRE_FILTRO_VENCIMENTO).
_WHERE_MULTIMARCAS_BASE = f"""
          AND cd_empresa = 1 AND tp_situacao = 4
          AND dt_transacao >= (%s::date - {_DIAS_DESLOCAMENTO_MULTIMARCAS + _FOLGA_DIAS_DT_EFETIVA})
          AND dt_transacao < (%s::date - {_DIAS_DESLOCAMENTO_MULTIMARCAS - 1})
          AND {_EXPR_DT_MULTIMARCAS_EFETIVA} BETWEEN %s AND %s
          AND {_EXPR_DT_MULTIMARCAS_EFETIVA} > CURRENT_DATE"""
_SQL_MULTIMARCAS_LIQUIDO = f"""
    SELECT {{coluna_agrupamento}} AS {{nome_coluna}}, SUM(valor)::numeric AS valor
    FROM (
        SELECT {_EXPR_DT_MULTIMARCAS_EFETIVA} AS dia_efetivo, SUM(vl_transacao) AS valor
        FROM vr_tra_transacao
        WHERE tp_modalidade = '4' AND tp_operacao = 'S'
        {_WHERE_MULTIMARCAS_BASE}
        GROUP BY 1
        UNION ALL
        SELECT {_EXPR_DT_MULTIMARCAS_EFETIVA} AS dia_efetivo, -SUM(vl_transacao) AS valor
        FROM vr_tra_transacao
        WHERE tp_modalidade = '3' AND tp_operacao = 'E'
        {_WHERE_MULTIMARCAS_BASE}
        GROUP BY 1
    ) x
    GROUP BY 1
    ORDER BY 1
"""


def _sql_multimarcas_mensal(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        _SQL_MULTIMARCAS_LIQUIDO.format(coluna_agrupamento="to_char(dia_efetivo, 'YYYY-MM')", nome_coluna="mes"),
        (dt_inicio, dt_fim, dt_inicio, dt_fim, dt_inicio, dt_fim, dt_inicio, dt_fim),
    )


def _sql_multimarcas_diario(dt_inicio: str, dt_fim: str) -> tuple:
    return (
        _SQL_MULTIMARCAS_LIQUIDO.format(coluna_agrupamento="dia_efetivo::date", nome_coluna="dia"),
        (dt_inicio, dt_fim, dt_inicio, dt_fim, dt_inicio, dt_fim, dt_inicio, dt_fim),
    )


# ── Carteira de pedidos (vendas) - pedidos em andamento x bloqueados ──────
# Olha a quantidade/valor PENDENTE dos itens (vr_ped_pedidoi): em andamento =
# tp_situacao 1, 3, 7, 8; bloqueado = tp_situacao 5 (pedido explicito do
# usuario). E um retrato da carteira de HOJE (nao depende do periodo do fluxo).
# So a empresa 001 e sem o representante 32098 (Lojas Liebe).
# Representante 32098 (LOJAS LIEBE - reposicao das proprias lojas, nao venda a
# terceiros) fica FORA da carteira - pedido explicito do usuario.
_REPRESENTANTE_FORA_CARTEIRA = 32098
# Carteira restrita a empresa 001 (pedido explicito do usuario).
_EMPRESA_CARTEIRA = 1


@router.get("/api/fluxo-caixa/carteira-pedidos")
def obter_carteira_pedidos():
    try:
        rows = execute_query("""
            SELECT CASE WHEN tp_situacao IN (1, 3, 7, 8) THEN 'andamento' ELSE 'bloqueado' END AS grupo,
                   COUNT(DISTINCT (cd_empresa, cd_pedido))::int AS pedidos,
                   COUNT(*)::int AS linhas,
                   COALESCE(SUM(qt_pendente), 0) AS qt_pendente,
                   COALESCE(SUM(vl_pendente), 0) AS vl_pendente
            FROM vr_ped_pedidoi
            WHERE cd_empresa = %s AND qt_pendente > 0 AND tp_situacao IN (1, 3, 5, 7, 8)
              AND cd_representant IS DISTINCT FROM %s
            GROUP BY 1
        """, (_EMPRESA_CARTEIRA, _REPRESENTANTE_FORA_CARTEIRA)) or []
        base = {"pedidos": 0, "linhas": 0, "qtPendente": 0.0, "vlPendente": 0.0}
        res = {"andamento": dict(base), "bloqueado": dict(base)}
        for r in rows:
            res[r["grupo"]] = {
                "pedidos": r["pedidos"], "linhas": r["linhas"],
                "qtPendente": float(r["qt_pendente"] or 0), "vlPendente": float(r["vl_pendente"] or 0),
            }
        return res
    except Exception as e:
        print(f"[ERROR] Erro ao buscar carteira de pedidos: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar a carteira de pedidos")


@router.get("/api/fluxo-caixa/carteira-pedidos/lotes")
def obter_carteira_pedidos_por_lote(grupo: str = Query(..., description="andamento | bloqueado")):
    """O que compoe um dos cards da carteira, agrupado por lote (cd_lote do
    item) - mesmos filtros do card (situacao, qt_pendente > 0, sem o
    representante 32098), entao a soma bate com o valor do card."""
    if grupo == "andamento":
        situacoes = [1, 3, 7, 8]
    elif grupo == "bloqueado":
        situacoes = [5]
    else:
        raise HTTPException(status_code=400, detail="grupo deve ser andamento ou bloqueado")
    try:
        rows = execute_query("""
            SELECT i.cd_lote,
                   COUNT(DISTINCT (i.cd_empresa, i.cd_pedido))::int AS pedidos,
                   COALESCE(SUM(i.qt_pendente), 0) AS qt_pendente,
                   COALESCE(SUM(i.vl_pendente), 0) AS vl_pendente,
                   MAX(l.ds_lote) AS ds_lote,
                   MAX(l.dt_fm)::date AS dt_fm
            FROM vr_ped_pedidoi i
            LEFT JOIN vr_ped_lote l ON l.cd_lote = i.cd_lote
            WHERE i.cd_empresa = %s AND i.qt_pendente > 0 AND i.tp_situacao = ANY(%s)
              AND i.cd_representant IS DISTINCT FROM %s
            GROUP BY i.cd_lote
            ORDER BY vl_pendente DESC
        """, (_EMPRESA_CARTEIRA, situacoes, _REPRESENTANTE_FORA_CARTEIRA)) or []
        return [
            {
                "lote": r["cd_lote"] if r["cd_lote"] not in (None, "") else None,
                "descricao": r["ds_lote"],
                "dtFim": _dia_str(r["dt_fm"]) if r["dt_fm"] else None,
                "pedidos": r["pedidos"],
                "qtPendente": float(r["qt_pendente"] or 0),
                "vlPendente": float(r["vl_pendente"] or 0),
            }
            for r in rows
        ]
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar carteira de pedidos por lote: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar a carteira por lote")


@router.get("/api/fluxo-caixa/carteira-pedidos/motivos")
def obter_carteira_pedidos_por_motivo():
    """Pedidos bloqueados (situacao 5) agrupados pelo motivo do bloqueio
    (vr_ped_pedidoc2.cd_motivobloq -> vr_ped_motivobloq.ds_motivo) - mesmos
    filtros do card, entao a soma bate com o valor do card."""
    try:
        rows = execute_query("""
            SELECT c.cd_motivobloq,
                   MAX(m.ds_motivo) AS ds_motivo,
                   COUNT(DISTINCT (i.cd_empresa, i.cd_pedido))::int AS pedidos,
                   COALESCE(SUM(i.qt_pendente), 0) AS qt_pendente,
                   COALESCE(SUM(i.vl_pendente), 0) AS vl_pendente
            FROM vr_ped_pedidoi i
            LEFT JOIN vr_ped_pedidoc2 c ON c.cd_empresa = i.cd_empresa AND c.cd_pedido = i.cd_pedido
            LEFT JOIN vr_ped_motivobloq m ON m.cd_motivo = c.cd_motivobloq
            WHERE i.cd_empresa = %s AND i.qt_pendente > 0 AND i.tp_situacao = 5
              AND i.cd_representant IS DISTINCT FROM %s
            GROUP BY c.cd_motivobloq
            ORDER BY vl_pendente DESC
        """, (_EMPRESA_CARTEIRA, _REPRESENTANTE_FORA_CARTEIRA)) or []
        return [
            {
                "motivo": r["cd_motivobloq"],
                "descricao": r["ds_motivo"],
                "pedidos": r["pedidos"],
                "qtPendente": float(r["qt_pendente"] or 0),
                "vlPendente": float(r["vl_pendente"] or 0),
            }
            for r in rows
        ]
    except Exception as e:
        print(f"[ERROR] Erro ao buscar carteira de pedidos por motivo: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar a carteira por motivo")


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

    # Mesmo periodo do ano anterior (dia 1 ate o mesmo dia de hoje, um ano
    # antes) com a mesma regra - pra comparacao/variacao nos indicadores.
    # 29/02 sem par no ano anterior vira o ultimo dia de fevereiro.
    ini_ant = inicio.replace(year=inicio.year - 1)
    ultimo_dia_ant = (ini_ant + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    fim_ant = ini_ant.replace(day=min(hoje.day, ultimo_dia_ant.day))
    rows_ant = execute_query(sql, (*params_extra, ini_ant.isoformat(), (fim_ant + timedelta(days=1)).isoformat())) or []
    por_dia_ant = {_dia_str(r["dia"]): float(r["liquido"]) for r in rows_ant}
    dias_ant = []
    d = ini_ant
    while d <= fim_ant:
        dias_ant.append({"dia": d.isoformat(), "valor": por_dia_ant.get(d.isoformat(), 0.0)})
        d += timedelta(days=1)

    return {
        "mes": inicio.isoformat()[:7], "hoje": hoje.isoformat(), "dias": dias, "total": sum(por_dia.values()),
        "anoAnterior": {"inicio": ini_ant.isoformat(), "fim": fim_ant.isoformat(), "dias": dias_ant, "total": sum(por_dia_ant.values())},
    }


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


# ── Acumulado do ano (faturamento fabrica / lojas) ───────────────────────
# A consulta de faturamento e pesada (fabrica jan-set ~87s), entao cada MES
# FECHADO e calculado uma vez e guardado em fcp_faturamento_mensal. Meses do
# ano corrente sao recalculados se o calculo tiver mais de 24h (devolucao
# lancada depois); meses do ano anterior ficam fixos. O mes atual NAO entra
# aqui - a tela soma o total do mes que ja vem de faturamento-*-mes.
_SEGMENTOS_FATURAMENTO = {
    "fabrica": (SQL_FATURAMENTO_FABRICA_DIARIO, lambda: (list(REPRESENTANTES_EXCLUIDOS), list(OPERACOES_EXCLUIDAS))),
    "lojas": (SQL_FATURAMENTO_LOJAS_DIARIO, lambda: (list(OPERACOES_EXCLUIDAS_LOJAS),)),
}
_calculo_ano_lock = threading.Lock()
_calculo_ano_rodando = False


def _criar_tabela_faturamento_mensal():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_faturamento_mensal (
            segmento TEXT NOT NULL,
            mes DATE NOT NULL,
            valor NUMERIC(16,2) NOT NULL,
            dt_calculado TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (segmento, mes)
        )
    """, ())


def _meses_fechados_do_ano(hoje: date) -> tuple:
    """(meses do ano corrente ja fechados, mesmos meses do ano anterior) -
    em janeiro, os dois ficam vazios."""
    atuais = [date(hoje.year, m, 1) for m in range(1, hoje.month)]
    anteriores = [date(hoje.year - 1, m, 1) for m in range(1, hoje.month)]
    return atuais, anteriores


def _meses_pendentes(hoje: date) -> list:
    atuais, anteriores = _meses_fechados_do_ano(hoje)
    rows = execute_query(
        "SELECT segmento, mes, dt_calculado FROM fcp_faturamento_mensal WHERE mes >= %s",
        (date(hoje.year - 1, 1, 1).isoformat(),),
    ) or []
    calculado = {(r["segmento"], _dia_str(r["mes"])): r["dt_calculado"] for r in rows}
    limite = datetime.now() - timedelta(hours=24)
    pendentes = []
    for seg in _SEGMENTOS_FATURAMENTO:
        for mes in anteriores:
            if (seg, mes.isoformat()) not in calculado:
                pendentes.append((seg, mes))
        for mes in atuais:
            quando = calculado.get((seg, mes.isoformat()))
            if quando is None or quando < limite:
                pendentes.append((seg, mes))
    return pendentes


def _calcular_meses_faturamento(pendentes: list):
    global _calculo_ano_rodando
    try:
        for seg, mes in pendentes:
            sql, params = _SEGMENTOS_FATURAMENTO[seg]
            proximo = (mes + timedelta(days=32)).replace(day=1)
            rows = execute_query(sql, (*params(), mes.isoformat(), proximo.isoformat())) or []
            valor = round(sum(float(r["liquido"]) for r in rows), 2)
            execute_insert(
                """INSERT INTO fcp_faturamento_mensal (segmento, mes, valor, dt_calculado) VALUES (%s, %s, %s, NOW())
                   ON CONFLICT (segmento, mes) DO UPDATE SET valor = EXCLUDED.valor, dt_calculado = NOW()""",
                (seg, mes.isoformat(), valor),
            )
            print(f"[FATURAMENTO-ANO] {seg} {mes.isoformat()[:7]} = {valor}")
    except Exception as e:
        print(f"[ERROR] Erro ao calcular faturamento mensal: {e}")
    finally:
        with _calculo_ano_lock:
            _calculo_ano_rodando = False


@router.get("/api/fluxo-caixa/faturamento-ano")
def faturamento_ano():
    """Faturamento dos meses fechados do ano (fabrica e lojas) e dos mesmos
    meses do ano anterior. Se faltar algum mes no cache, dispara o calculo
    em segundo plano e responde calculando=True (a tela tenta de novo)."""
    global _calculo_ano_rodando
    try:
        _criar_tabela_faturamento_mensal()
        hoje = datetime.now(ZoneInfo("America/Sao_Paulo")).date()
        pendentes = _meses_pendentes(hoje)
        atuais, anteriores = _meses_fechados_do_ano(hoje)
        # Mes do ano corrente com calculo velho (>24h) ainda serve enquanto
        # recalcula; so bloqueia se algum mes nunca foi calculado.
        rows = execute_query(
            "SELECT segmento, mes, valor FROM fcp_faturamento_mensal WHERE mes >= %s",
            (date(hoje.year - 1, 1, 1).isoformat(),),
        ) or []
        valores = {(r["segmento"], _dia_str(r["mes"])): float(r["valor"]) for r in rows}
        faltando = any((seg, mes.isoformat()) not in valores for seg, mes in pendentes)
        if pendentes:
            with _calculo_ano_lock:
                if not _calculo_ano_rodando:
                    _calculo_ano_rodando = True
                    threading.Thread(target=_calcular_meses_faturamento, args=(pendentes,), daemon=True).start()
        resposta = {
            "ano": hoje.year,
            "ateMes": atuais[-1].isoformat()[:7] if atuais else None,
            "calculando": faltando,
            "mesesPendentes": len(pendentes),
        }
        for seg in _SEGMENTOS_FATURAMENTO:
            resposta[seg] = {
                "atual": sum(valores.get((seg, m.isoformat()), 0.0) for m in atuais),
                "anterior": sum(valores.get((seg, m.isoformat()), 0.0) for m in anteriores),
            }
        return resposta
    except Exception as e:
        print(f"[ERROR] Erro ao buscar faturamento do ano: {e}")
        raise HTTPException(status_code=500, detail="Erro ao buscar faturamento do ano")


def _entradas_hoje_informativo(hoje: date, cd_empresas: list) -> dict:
    """Entradas cuja data efetiva e HOJE, so pra conferencia na tela - as
    consultas normais so olham datas FUTURAS (> CURRENT_DATE), entao o dia de
    hoje aparecia sempre zerado. Estes valores NAO entram em nenhum saldo
    (nem do dia, nem acumulado, nem nos totais): o frontend so os exibe
    esmaecidos. Mesmos filtros/regras de cada coluna, so trocando
    '> CURRENT_DATE' por '= CURRENT_DATE'."""
    d = hoje.isoformat()

    def _hoje(sql: str) -> str:
        return sql.replace("> CURRENT_DATE", "= CURRENT_DATE")

    def _total(sql: str, params) -> float:
        rows = execute_query(sql, tuple(params)) or []
        return float(sum(float(r["valor"] or 0) for r in rows))

    w_cartao, p_cartao = _filtros_cartao(d, d, cd_empresas)
    w_boleto, p_boleto = _filtros_boleto(d, d, cd_empresas)
    w_cheque, p_cheque = _filtros_cheque(d, d, cd_empresas)
    sql_lojas, p_lojas = _sql_lojas_diario(d, d)
    sql_outras, p_outras = _sql_outras_entradas_diario(d, d)
    sql_multi, p_multi = _sql_multimarcas_diario(d, d)
    cartao = _total(_hoje(_sql_cartao_diario(w_cartao)), p_cartao)
    lojas_raw = _total(_hoje(sql_lojas), p_lojas)
    # Boleto de HOJE: pago + em aberto (tudo cuja data efetiva e hoje, sem o
    # filtro de saldo > 0), sem as ja descontadas - pedido explicito do
    # usuario, so pra conferencia (nao entra em saldo nenhum).
    where_b_hoje = f"""WHERE tp_documento IN (1) AND tp_situacao = '1' AND nr_portador < 999
        AND tp_cobranca <> 2
        AND {_PRE_FILTRO_VENCIMENTO}
        AND {_EXPR_DT_BOLETO_EFETIVA} = %s
        AND {_FILTRO_SEM_DESCONTADAS}"""
    params_b_hoje: list = [d, d, d]
    if cd_empresas:
        where_b_hoje += " AND cd_empresa = ANY(%s)"
        params_b_hoje.append(cd_empresas)
    rb = execute_query(
        f"SELECT COALESCE(SUM(vl_pago), 0) AS pago, COALESCE(SUM(vl_fatura - vl_pago), 0) AS aberto "
        f"FROM vr_fcr_faturai {where_b_hoje}",
        tuple(params_b_hoje),
    ) or [{"pago": 0, "aberto": 0}]
    boleto_pago = float(rb[0]["pago"] or 0)
    boleto_aberto = float(rb[0]["aberto"] or 0)
    return {
        "dia": d,
        "cartao": cartao,
        "boleto": boleto_pago + boleto_aberto,
        "boletoPago": boleto_pago,
        "boletoAberto": boleto_aberto,
        "cheque": _total(_hoje(_sql_cheque_diario(w_cheque)), p_cheque),
        "lojas": lojas_raw - cartao if lojas_raw > cartao else 0.0,
        "outrasEntradas": _total(_hoje(sql_outras), p_outras),
        "multimarcas": _total(_hoje(sql_multi), p_multi),
    }


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
        # Todas as ENTRADAS so valem de amanha em diante (data efetiva > hoje),
        # entao num periodo no passado nao ha o que buscar - e a consulta de
        # cartao/boleto varrendo meses de faturas so pra descartar tudo levava
        # mais de 100s (erro ao pesquisar retroativo). Encurta o inicio pra
        # amanha e pula as consultas se o periodo termina hoje ou antes.
        dt_inicio_ent = max(dt_inicio, (hoje + timedelta(days=1)).isoformat())
        ent_vazio = dt_inicio_ent > dt_fim
        where_cartao, p_cartao = _filtros_cartao(dt_inicio_ent, dt_fim, cd_empresas)
        where_boleto, p_boleto = _filtros_boleto(dt_inicio_ent, dt_fim, cd_empresas)
        where_cheque, p_cheque = _filtros_cheque(dt_inicio_ent, dt_fim, cd_empresas)
        where_pedidos, p_pedidos = _filtros_pedidos(dt_inicio, dt_fim, cd_empresas)
        sql_lojas_m, p_lojas_m = _sql_lojas_mensal(dt_inicio_ent, dt_fim)
        sql_lojas_d, p_lojas_d = _sql_lojas_diario(dt_inicio_ent, dt_fim)
        sql_outras_m, p_outras_m = _sql_outras_entradas_mensal(dt_inicio_ent, dt_fim)
        sql_outras_d, p_outras_d = _sql_outras_entradas_diario(dt_inicio_ent, dt_fim)
        sql_multi_m, p_multi_m = _sql_multimarcas_mensal(dt_inicio_ent, dt_fim)
        sql_multi_d, p_multi_d = _sql_multimarcas_diario(dt_inicio_ent, dt_fim)

        kpis = _obter_kpis()
        r_saidas_m = execute_query(_sql_saidas_mensal(where_saidas), tuple(p_saidas)) or []
        r_saidas_d = execute_query(_sql_saidas_diario(where_saidas), tuple(p_saidas)) or []
        r_cartao_m = [] if ent_vazio else execute_query(_sql_cartao_mensal(where_cartao), tuple(p_cartao)) or []
        r_cartao_d = [] if ent_vazio else execute_query(_sql_cartao_diario(where_cartao), tuple(p_cartao)) or []
        r_boleto_m = [] if ent_vazio else execute_query(_sql_boleto_mensal(where_boleto), tuple(p_boleto)) or []
        r_boleto_d = [] if ent_vazio else execute_query(_sql_boleto_diario(where_boleto), tuple(p_boleto)) or []
        r_cheque_m = [] if ent_vazio else execute_query(_sql_cheque_mensal(where_cheque), tuple(p_cheque)) or []
        r_cheque_d = [] if ent_vazio else execute_query(_sql_cheque_diario(where_cheque), tuple(p_cheque)) or []
        r_pedidos_m = execute_query(_sql_pedidos_mensal(where_pedidos), tuple(p_pedidos)) or []
        r_pedidos_d = execute_query(_sql_pedidos_diario(where_pedidos), tuple(p_pedidos)) or []
        r_lojas_m = [] if ent_vazio else execute_query(sql_lojas_m, p_lojas_m) or []
        r_lojas_d = [] if ent_vazio else execute_query(sql_lojas_d, p_lojas_d) or []
        r_outras_m = [] if ent_vazio else execute_query(sql_outras_m, p_outras_m) or []
        r_outras_d = [] if ent_vazio else execute_query(sql_outras_d, p_outras_d) or []
        r_multi_m = [] if ent_vazio else execute_query(sql_multi_m, p_multi_m) or []
        r_multi_d = [] if ent_vazio else execute_query(sql_multi_d, p_multi_d) or []

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

        hoje_informativo = None
        if date.fromisoformat(dt_inicio) <= hoje <= date.fromisoformat(dt_fim):
            hoje_informativo = _entradas_hoje_informativo(hoje, cd_empresas)
            if any(hoje_informativo[k] > 0 for k in ("cartao", "boleto", "cheque", "lojas", "outrasEntradas", "multimarcas")) \
                    and hoje.isoformat() not in {x["dia"] for x in dias}:
                # Garante a linha de hoje na tabela (zerada nas colunas reais).
                dias.append({
                    "dia": hoje.isoformat(), "previsao": 0.0, "real": 0.0, "pedidos": 0.0, "totalSaidas": 0.0,
                    "cartao": 0.0, "boleto": 0.0, "cheque": 0.0, "lojas": 0.0, "outrasEntradas": 0.0,
                    "multimarcas": 0.0, "qtd": 0, "saldoAcum": 0.0,
                })
                dias.sort(key=lambda x: x["dia"])

        return {"data": {
            **kpis, "meses": meses, "dias": dias, "saldoBancario": saldos_bancarios["total"],
            "hojeInformativo": hoje_informativo,
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
    despesas: Optional[str] = Query(None, description="cd_despesaitem separados por virgula - so fornecedores dessas despesas"),
):
    try:
        hoje = date.today()
        dt_inicio = dt_inicio or hoje.isoformat()
        dt_fim = dt_fim or (hoje + timedelta(days=30)).isoformat()
        where, params = _filtros_saidas(dt_inicio, dt_fim, _parse_empresas(empresas))
        ids_despesa = [int(x) for x in (despesas or "").split(",") if x.strip().isdigit()]
        if ids_despesa:
            sql = _sql_saidas_por_fornecedor_despesa(where)
            params.append(ids_despesa)
        else:
            sql = _sql_saidas_por_fornecedor(where)
        rows = execute_query(sql, tuple(params)) or []
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
             "nome": r["nome"], "contaDfc": r["conta_dfc"], "valor": float(r["valor"]), "qtd": r["qtd"]}
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


@router.get("/api/fluxo-caixa/simulacao")
def obter_simulacao_fluxo_caixa():
    """Simulacao compartilhada da tela (Uso da Garantia: valor que entraria
    em caixa hoje + data em que esse emprestimo e pago de volta) - fica
    salva no banco, nao no navegador, pra qualquer pessoa que abrir a tela
    (em qualquer computador) ver o mesmo valor/data que outra pessoa
    configurou (pedido explicito do usuario)."""
    _criar_tabelas_fluxo_caixa()
    rows = execute_query(
        "SELECT vl_uso_garantia, dt_pagamento_garantia, usuario, dt_atualizacao FROM fcp_simulacao_fluxo_caixa WHERE id = 1"
    ) or []
    if not rows:
        return {"usoGarantia": 0.0, "dtPagamentoGarantia": None, "usuario": None, "dtAtualizacao": None}
    r = rows[0]
    return {
        "usoGarantia": float(r["vl_uso_garantia"] or 0),
        "dtPagamentoGarantia": _dia_str(r["dt_pagamento_garantia"]) if r["dt_pagamento_garantia"] else None,
        "usuario": r["usuario"],
        "dtAtualizacao": r["dt_atualizacao"].isoformat() if r["dt_atualizacao"] else None,
    }


@router.post("/api/fluxo-caixa/simulacao")
def salvar_simulacao_fluxo_caixa(dados: dict):
    """Grava o 'Uso da Garantia' compartilhado. dados = {usoGarantia, dtPagamentoGarantia, usuario}."""
    try:
        valor = float(dados.get("usoGarantia") or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="usoGarantia precisa ser numerico")
    dt_pagamento = dados.get("dtPagamentoGarantia") or None
    if dt_pagamento:
        try:
            datetime.strptime(dt_pagamento, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"dtPagamentoGarantia invalida: {dt_pagamento}. Use AAAA-MM-DD.")
    usuario = (dados.get("usuario") or "").strip()[:100] or None
    _criar_tabelas_fluxo_caixa()
    execute_insert(
        """INSERT INTO fcp_simulacao_fluxo_caixa (id, vl_uso_garantia, dt_pagamento_garantia, usuario, dt_atualizacao)
           VALUES (1, %s, %s, %s, NOW())
           ON CONFLICT (id) DO UPDATE SET
               vl_uso_garantia = EXCLUDED.vl_uso_garantia,
               dt_pagamento_garantia = EXCLUDED.dt_pagamento_garantia,
               usuario = EXCLUDED.usuario, dt_atualizacao = NOW()""",
        (valor, dt_pagamento, usuario),
    )
    return {"ok": True}


@router.delete("/api/fluxo-caixa/outras-entradas-projecao/{dia}")
def remover_outra_entrada_projecao(dia: str):
    """Remove um dia cadastrado em Outras Entradas - usado pela lista do modal
    (pedido do usuario: ver o que esta cadastrado e tirar alguma linha pra
    simular o fluxo sem ela)."""
    try:
        datetime.strptime(dia, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Data invalida: {dia}. Use AAAA-MM-DD.")
    _criar_tabelas_fluxo_caixa()
    execute_insert("DELETE FROM fcp_outras_entradas_projecao WHERE dt_dia = %s", (dia,))
    return {"ok": True}


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
