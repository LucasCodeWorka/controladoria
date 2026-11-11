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
import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import re
import dre_cache
from database import execute_query, execute_insert
from routers.dre import CCUSTOS_LOJAS, FILTRO_DUPLICATAS_EXCLUIDAS_SQL, PARAMS_DUPLICATAS_EXCLUIDAS, CCUSTOS_FABRICA, CCUSTOS_ECOMMERCE, CCUSTO_ECOMMERCE_AGRUPADO
from routers.cmv_detalhado import CD_EMPRESA_FABRICA
from routers.fluxo_caixa import _obter_saldos_bancarios, _filtros_boleto, _filtros_cartao, _filtros_cheque, _parse_empresas, _criar_tabelas_fluxo_caixa

router = APIRouter()

MESES_JANELA_PADRAO = 12

# PC.1 Fornecedores e alugueis a pagar: despesaitens validados pelo
# usuario (72 codigos).
DESPESAITENS_FORNECEDORES = (
    4, 11, 16, 17, 18, 20, 22, 24, 26, 28, 29, 31, 37, 38, 39, 40, 41, 45, 49, 50,
    51, 52, 53, 55, 56, 58, 60, 61, 63, 64, 70, 73, 74, 76, 79, 82, 83, 84, 85, 87,
    110, 146, 149, 152, 159, 160, 161, 167, 218, 219, 220, 221, 222, 224, 225, 226,
    227, 228, 229, 231, 259, 262, 263, 264, 271, 280, 287, 488, 539, 543, 544, 546,
)

# PC.5 Tributos a recolher: despesaitens indicados pelo usuario (15 codigos;
# inclui 158 Multas SEFAZ, 123 ISS ret. fonte e 230 IRRF outros servicos).
DESPESAITENS_TRIBUTOS = (111, 112, 113, 116, 117, 118, 119, 120, 123, 126, 127, 230, 250, 285)

# PC.ETR / PNC.ETR Endividamento tributario: multas SEFAZ (despesa 158), tiradas de
# Tributos a recolher. Ate 12 meses (inclui vencidas e nao pagas) = circulante;
# depois disso = nao circulante.
DESPESAITENS_ENDIVIDAMENTO_TRIBUTARIO = (158,)

# PC.IMV / PNC.IMV Obrigacoes por compra de imoveis: contratos de compra de
# imoveis (EDGE 700 e CASA MAUA 2101/2702/2703/2602).
DESPESAITENS_IMOVEIS = (992, 994, 996, 998, 999)

# PC.6 / PNC.10 IR e CSLL: IRPJ apuracao (125) e CSLL apuracao (124).
DESPESAITENS_IR_CSLL = (124, 125)

# PC.2 Obrigacoes de compra de MP. e serv.: despesaitens de materia-prima
# validados pelo usuario (1196 codigos), a pagar de hoje em diante.
DESPESAITENS_MATERIA_PRIMA = tuple(str(c) for c in (
    [1, 2, 3, 19, 21, 69, 75, 88, 89, 92, 101, 106, 107, 108, 109, 133, 223, 849, 983]
    + list(range(176, 186)) + list(range(281, 285)) + list(range(288, 473)) + list(range(474, 488))
    + list(range(494, 523)) + list(range(528, 539)) + list(range(1453, 1478))
    + list(range(10000, 10187)) + list(range(11000, 11712))
))


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


# ── Ajustes manuais do passivo ───────────────────────────────────────────
# Valores lancados a mao por conta (ex: rescisao de funcionarios em PC.4),
# somados a conta. Para mudar o valor, atualize a linha (ou desative e insira outra).
AJUSTES_INICIAIS = [
    # (conta, descricao, valor)
    ("PC.4", "RESCISAO DE FUNCIONARIOS", 1961644.14),
]


def _criar_tabela_ajustes():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_balanco_ajustes (
            id SERIAL PRIMARY KEY,
            conta TEXT NOT NULL,
            descricao TEXT NOT NULL,
            valor NUMERIC(16, 2) NOT NULL,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """, ())
    for conta, desc, valor in AJUSTES_INICIAIS:
        if not (execute_query("SELECT 1 FROM fcp_balanco_ajustes WHERE conta = %s AND descricao = %s", (conta, desc)) or []):
            execute_insert("INSERT INTO fcp_balanco_ajustes (conta, descricao, valor) VALUES (%s,%s,%s)", (conta, desc, valor))


def _total_ajustes(conta: str) -> float:
    _criar_tabela_ajustes()
    r = execute_query("SELECT COALESCE(SUM(valor), 0) AS v FROM fcp_balanco_ajustes WHERE conta = %s AND ativo", (conta,)) or [{"v": 0}]
    return float(r[0]["v"] or 0)


def _janela_proximo_mes(mes_referencia: str) -> tuple:
    """(primeiro, ultimo dia) do mes seguinte ao de referencia (YYYY-MM)."""
    ano, mes = (int(p) for p in mes_referencia.split("-"))
    a1, m1 = _somar_meses(ano, mes, 1)
    a2, m2 = _somar_meses(ano, mes, 2)
    return date(a1, m1, 1).isoformat(), (date(a2, m2, 1) - timedelta(days=1)).isoformat()


# ── Rescisao de aluguel (shoppings) ──────────────────────────────────────
# Multa por devolver o salao antes do fim do contrato (art. 4o Lei 8.245/91):
# pct_multa (20%) x aluguel mensal minimo x meses ate o fim do contrato. Casos
# cadastrados um a um em fcp_balanco_rescisoes (centro de custo, despesa do
# aluguel minimo, fim do contrato). Valor mensal de referencia = parcela do
# mes de referencia da despesa/centro de custo, MAS em dezembro e janeiro
# (13o dobra o aluguel) usa novembro. Meses = os que faltam depois do mes de
# referencia ate o fim do contrato (mes do fim proporcional ao dia). Soma de
# verdade em PC.1 (aberta como "Rescisao de alugueis"). Respeita o filtro:
# so entra se o centro de custo do caso esta nas empresas escolhidas.
# Casos com reducao (ex: Porto Alegre, CC 20): dt_inicio_contrato + a cada
# reducao_a_cada_pct % do prazo transcorrido (meses de inicio ate o mes de
# referencia, inclusive / meses totais do contrato) a multa cai reducao_pct %.
# Casos com piso (ex: Shopping CC 3): multa = MAIOR entre pct_multa % dos
# alugueis restantes e multa_min_meses x aluguel mensal (15 alugueis).
# Casos com devolucao de investimento do shopping (ex: CC 21): investimento x
# meses restantes / meses totais do contrato (inicio..fim), somado a multa.
# Correcao monetaria e juros (0,5% a.m.) NAO entram: correm depois da rescisao.
# multa_proporcional: o valor de multa_min_meses x aluguel e reduzido pela fracao
# do contrato que resta (dias do 1o dia do mes seguinte ao de referencia ate o
# fim / dias totais inicio..fim) - ex: CC 15 (10 alugueis proporcionais).
# aluguel_fixo (opcional): aluguel mensal do contrato, usado no lugar das parcelas
# lancadas (ex: CC 21, que nao tem parcela lancada em varios meses).
RESCISOES_INICIAIS = [
    # (descricao, cd_ccusto, cd_despesaitem, dt_fim_contrato, pct_multa, dt_inicio_contrato, reducao_pct, reducao_a_cada_pct, multa_min_meses, investimento, multa_proporcional)
    ("ALUGUEL MINIMO - SHOPPING CC 8", 8, 85, "2029-07-19", 20, None, 0, 0, 0, 0, False),
    ("ALUGUEL MINIMO - SHOPPING PORTO ALEGRE CC 20", 20, 85, "2031-05-31", 80, "2026-06-01", 5, 20, 0, 0, False),
    ("ALUGUEL MINIMO - SHOPPING RIOMAR RECIFE CC 17 (LOJA 1110)", 17, 85, "2030-08-09", 20, None, 0, 0, 0, 0, False),
    ("ALUGUEL MINIMO - SHOPPING CC 3 (CLAUSULA 18.3)", 3, 85, "2031-01-10", 80, None, 0, 0, 15, 0, False),
    # CC 5 (clausula 10.3): multa fixa de 3 alugueis minimos (pct 0 + piso de 3 meses).
    ("ALUGUEL MINIMO - SHOPPING CC 5 (CLAUSULA 10.3)", 5, 85, "2029-02-28", 0, None, 0, 0, 3, 0, False),
    # CC 2 e CC 4: multa de 1 aluguel minimo (sem data de fim informada: 9999-12-31 = sem encerramento).
    ("ALUGUEL MINIMO - SHOPPING CC 2 (1 ALUGUEL)", 2, 85, "9999-12-31", 0, None, 0, 0, 1, 0, False),
    ("ALUGUEL MINIMO - SHOPPING CC 4 (1 ALUGUEL)", 4, 85, "9999-12-31", 0, None, 0, 0, 1, 0, False),
    ("ALUGUEL MINIMO - SHOPPING CC 21 (CLAUSULA 12)", 21, 85, "2031-06-30", 20, "2026-07-01", 0, 0, 0, 200000, False),
    ("ALUGUEL MINIMO - SHOPPING CC 14 (CLAUSULA 6.2)", 14, 85, "2030-01-01", 20, None, 0, 0, 0, 0),
    # CC 15 (clausula 11a, par. 1o, contrato de 2020): 10 alugueis proporcionais ao periodo restante da renovacao vigente (20/06/2025 a 19/06/2030).
    ("ALUGUEL MINIMO - SHOPPING CC 15 (CLAUSULA 11)", 15, 85, "2030-06-19", 0, "2025-06-20", 0, 0, 10, 0, True),
    # CC 19 (item 10.5 do Quadro de Informacoes Basicas): 5 alugueis proporcionais ao prazo restante.
    ("ALUGUEL MINIMO - SHOPPING CC 19 (ITEM 10.5)", 19, 85, "2027-07-30", 0, "2022-07-31", 0, 0, 5, 0, True),
    # E-commerce (CC 120; o 49 vem junto no filtro): multa de 3 alugueis minimos, sem data de fim informada.
    ("ALUGUEL MINIMO - ECOMMERCE CC 120 (3 ALUGUEIS)", 120, 85, "9999-12-31", 0, None, 0, 0, 3, 0, False),
    # CC 22 (clausula 18.3): maior entre 10 alugueis e 80% dos alugueis vincendos (contrato 01/12/2022 a 30/11/2027).
    ("ALUGUEL MINIMO - SHOPPING CC 22 (CLAUSULA 18.3)", 22, 85, "2027-11-30", 80, "2022-12-01", 0, 0, 10, 0, False),
    # CC 7: multa limitada a 3 alugueis minimos (contrato 26/04/2024 a 25/05/2029).
    ("ALUGUEL MINIMO - SHOPPING CC 7 (3 ALUGUEIS)", 7, 85, "2029-05-25", 0, "2024-04-26", 0, 0, 3, 0, False),
    # CC 6 (nova vigencia 10/04/2027 a 09/04/2032): 3 alugueis, reduzidos proporcionalmente ao tempo cumprido (antes do inicio da vigencia vale cheio).
    ("ALUGUEL MINIMO - SHOPPING CC 6 (NOVA VIGENCIA)", 6, 85, "2032-04-09", 0, "2027-04-10", 0, 0, 3, 0, True),
    # CC 10 (clausula 11a, par. 1o): 10 alugueis proporcionais ao periodo restante da renovacao (12/06/2026 a 11/06/2031).
    ("ALUGUEL MINIMO - SHOPPING CC 10 (CLAUSULA 11)", 10, 85, "2031-06-11", 0, "2026-06-12", 0, 0, 10, 0, True),
]


def _criar_tabela_rescisoes():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_balanco_rescisoes (
            id SERIAL PRIMARY KEY,
            descricao TEXT NOT NULL,
            cd_ccusto INTEGER NOT NULL,
            cd_despesaitem INTEGER NOT NULL,
            dt_fim_contrato DATE NOT NULL,
            pct_multa NUMERIC(6, 2) NOT NULL DEFAULT 20,
            ativo BOOLEAN NOT NULL DEFAULT TRUE
        )
    """, ())
    execute_insert("ALTER TABLE fcp_balanco_rescisoes ADD COLUMN IF NOT EXISTS dt_inicio_contrato DATE", ())
    execute_insert("ALTER TABLE fcp_balanco_rescisoes ADD COLUMN IF NOT EXISTS reducao_pct NUMERIC(6, 2) NOT NULL DEFAULT 0", ())
    execute_insert("ALTER TABLE fcp_balanco_rescisoes ADD COLUMN IF NOT EXISTS reducao_a_cada_pct NUMERIC(6, 2) NOT NULL DEFAULT 0", ())
    execute_insert("ALTER TABLE fcp_balanco_rescisoes ADD COLUMN IF NOT EXISTS multa_min_meses NUMERIC(6, 2) NOT NULL DEFAULT 0", ())
    execute_insert("ALTER TABLE fcp_balanco_rescisoes ADD COLUMN IF NOT EXISTS investimento NUMERIC(16, 2) NOT NULL DEFAULT 0", ())
    execute_insert("ALTER TABLE fcp_balanco_rescisoes ADD COLUMN IF NOT EXISTS aluguel_fixo NUMERIC(16, 2) NOT NULL DEFAULT 0", ())
    execute_insert("ALTER TABLE fcp_balanco_rescisoes ADD COLUMN IF NOT EXISTS multa_proporcional BOOLEAN NOT NULL DEFAULT FALSE", ())
    # CC 21: aluguel do contrato (clausula 12a, par.1o).
    execute_insert("UPDATE fcp_balanco_rescisoes SET aluguel_fixo = 10685 WHERE cd_ccusto = 21 AND cd_despesaitem = 85 AND aluguel_fixo = 0", ())
    # CC 6: novembro/2026 tem duas parcelas lancadas (03/11 e 30/11), o que dobrava a base.
    execute_insert("UPDATE fcp_balanco_rescisoes SET aluguel_fixo = 18724 WHERE cd_ccusto = 6 AND cd_despesaitem = 85 AND aluguel_fixo = 0", ())
    # Casos de RESCISOES_INICIAIS entram se ainda nao existem (centro de custo + despesa).
    for r in RESCISOES_INICIAIS:
        if not (execute_query("SELECT 1 FROM fcp_balanco_rescisoes WHERE cd_ccusto = %s AND cd_despesaitem = %s", (r[1], r[2])) or []):
            execute_insert(
                "INSERT INTO fcp_balanco_rescisoes (descricao, cd_ccusto, cd_despesaitem, dt_fim_contrato, pct_multa, "
                "dt_inicio_contrato, reducao_pct, reducao_a_cada_pct, multa_min_meses, investimento, multa_proporcional) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", r
            )


def _mes_base_rescisao(mes_referencia: str) -> tuple:
    """(ano, mes) do aluguel usado no calculo: o do mes de referencia, exceto
    dezembro/janeiro (13o em dobro) que usam novembro."""
    ano, mes = (int(p) for p in mes_referencia.split("-"))
    if mes == 12:
        return ano, 11
    if mes == 1:
        return ano - 1, 11
    return ano, mes


def _meses_ate_fim(mes_referencia: str, fim: date) -> float:
    """Meses depois do mes de referencia ate o fim do contrato (o mes do fim
    entra proporcional: dia do fim / dias do mes)."""
    ano, mes = (int(p) for p in mes_referencia.split("-"))
    total = 0.0
    a, m = _somar_meses(ano, mes, 1)
    while (a, m) <= (fim.year, fim.month):
        dias_mes = (date(*_somar_meses(a, m, 1), 1) - date(a, m, 1)).days
        total += 1.0 if (a, m) < (fim.year, fim.month) else fim.day / dias_mes
        a, m = _somar_meses(a, m, 1)
    return total


def _reducao_rescisao(mes_referencia: str, caso: dict) -> float:
    """Fracao (0 a 1) de reducao da multa: reducao_pct % a cada reducao_a_cada_pct %
    do prazo contratual transcorrido (meses de dt_inicio_contrato ate o mes de
    referencia, inclusive, sobre o total de meses do contrato)."""
    inicio, fim = caso.get("dt_inicio_contrato"), caso["dt_fim_contrato"]
    passo, red = float(caso.get("reducao_a_cada_pct") or 0), float(caso.get("reducao_pct") or 0)
    if not inicio or passo <= 0 or red <= 0:
        return 0.0
    ano, mes = (int(p) for p in mes_referencia.split("-"))
    total_meses = (fim.year - inicio.year) * 12 + fim.month - inicio.month + 1
    transcorridos = max(0, min(total_meses, (ano - inicio.year) * 12 + mes - inicio.month + 1))
    degraus = int((transcorridos / total_meses * 100) // passo)
    return min(1.0, degraus * red / 100)


def _fmt_brl(v: float) -> str:
    return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _rescisoes_detalhadas(mes_referencia: str, empresas: Optional[str]) -> list:
    """Um item por caso cadastrado com multa > 0: descricao, texto de memoria do
    calculo e valor (multa + devolucao de investimento, ja com reducao)."""
    _criar_tabela_rescisoes()
    casos = execute_query("SELECT * FROM fcp_balanco_rescisoes WHERE ativo ORDER BY cd_ccusto", ()) or []
    selecionados = set(_expandir_empresas_para_ccustos(_parse_empresas(empresas))) if empresas else None
    ref = tuple(int(p) for p in mes_referencia.split("-"))
    itens = []
    for c in casos:
        if selecionados is not None and c["cd_ccusto"] not in selecionados:
            continue
        if ref >= (c["dt_fim_contrato"].year, c["dt_fim_contrato"].month):
            continue  # contrato encerrado (ou no mes do fim): sem multa
        ab, mb = _mes_base_rescisao(mes_referencia)
        ini = date(ab, mb, 1)
        fim_mes = date(*_somar_meses(ab, mb, 1), 1) - timedelta(days=1)
        r = execute_query(
            """SELECT COALESCE(SUM(vl_rateio), 0) AS v FROM public.vr_fcp_despduplicatai
               WHERE cd_despesaitem = %s AND cd_ccusto = %s AND tp_situacao <> 'C'
                 AND dt_vencimento BETWEEN %s AND %s""",
            (c["cd_despesaitem"], c["cd_ccusto"], ini, fim_mes),
        ) or [{"v": 0}]
        fixo = float(c.get("aluguel_fixo") or 0)
        aluguel = fixo or float(r[0]["v"] or 0)
        meses = _meses_ate_fim(mes_referencia, c["dt_fim_contrato"]) if float(c["pct_multa"]) > 0 else 0.0
        pct = float(c["pct_multa"])
        multa = pct / 100 * aluguel * meses if pct > 0 else 0.0
        piso = float(c.get("multa_min_meses") or 0) * aluguel
        fracao = 1.0
        if c.get("multa_proporcional") and c.get("dt_inicio_contrato"):
            ini_c, fim_c = c["dt_inicio_contrato"], c["dt_fim_contrato"]
            a1, m1 = _somar_meses(*ref, 1)
            restante = max(0, (fim_c - date(a1, m1, 1)).days + 1)
            fracao = min(1.0, restante / ((fim_c - ini_c).days + 1))
            piso *= fracao
        multa = max(multa, piso)
        reducao = _reducao_rescisao(mes_referencia, c)
        valor = multa * (1 - reducao)
        partes = [f"Aluguel base {mb:02d}/{ab}: {_fmt_brl(aluguel)}" + (" (fixo do contrato)" if fixo else "")]
        if pct > 0:
            partes.append(f"{pct:g}% x {meses:.2f} meses restantes".replace(".", ","))
        if float(c.get("multa_min_meses") or 0) > 0:
            partes.append(f"{float(c['multa_min_meses']):g} alugueis" + (f" x {fracao:.1%} do prazo restante".replace(".", ",") if c.get("multa_proporcional") else ""))
        if reducao > 0:
            partes.append(f"reducao de {reducao:.0%}")
        if pct > 0 and float(c.get("multa_min_meses") or 0) > 0:
            partes.append("vale o maior")
        invest = float(c.get("investimento") or 0)
        if invest > 0 and c.get("dt_inicio_contrato"):
            ini_c, fim_c = c["dt_inicio_contrato"], c["dt_fim_contrato"]
            total_meses = (fim_c.year - ini_c.year) * 12 + fim_c.month - ini_c.month + 1
            dev = invest * min(1.0, _meses_ate_fim(mes_referencia, fim_c) / total_meses)
            valor += dev
            partes.append(f"devolucao do investimento {_fmt_brl(dev)}")
        itens.append({
            "descricao": f"CC {c['cd_ccusto']} - {c['descricao']}",
            "informacao": " | ".join(partes) + f" | contrato ate {c['dt_fim_contrato'].strftime('%d/%m/%Y') if c['dt_fim_contrato'].year < 9999 else 'sem data de fim'}",
            "valor": round(valor, 2),
        })
    return itens


def _calcular_rescisoes(mes_referencia: str, empresas: Optional[str]) -> float:
    """Total (positivo) das multas de rescisao dos casos cadastrados."""
    return round(sum(i["valor"] for i in _rescisoes_detalhadas(mes_referencia, empresas)), 2)


def _expandir_empresas_para_ccustos(lista_empresas: list) -> list:
    """Expande os codigos escolhidos no filtro de empresas da tela (1 por
    loja + 1 pra fabrica) pros centros de custo REAIS de
    vr_fcp_despduplicatai - MESMA configuracao ja usada no DRE/DFC
    (CCUSTOS_FABRICA, CCUSTOS_ECOMMERCE): "Fabrica" (empresa 1) vira todos
    os ccustos internos dela (500 a 514 inclusos, onde a maioria das
    duplicatas de materia-prima e emprestimo fica lancada de verdade);
    "Ecommerce" (empresa/ccusto 120) sempre vem junto do 49 (que nao tem
    empresa propria). Sem isso, filtrar so por Fabrica ficava cego pros
    ccustos internos dela."""
    ccustos: set = set()
    for cd in lista_empresas:
        if cd == CD_EMPRESA_FABRICA:
            ccustos.update(CCUSTOS_FABRICA)
        elif cd == CCUSTO_ECOMMERCE_AGRUPADO:
            ccustos.update(CCUSTOS_ECOMMERCE)
        else:
            ccustos.add(cd)
    return list(ccustos)


def _filtro_ccusto_duplicatas(empresas: Optional[str], por_empresa_tambem: bool = False, alias: str = "") -> tuple:
    """Clausula/params do filtro de empresas do Passivo nas duplicatas: respeita
    o centro de custo (cd_ccusto = codigo da empresa; Fabrica expande pros
    ccustos internos). Sem filtro = tudo. por_empresa_tambem tambem aceita a
    empresa da duplicata (cd_empresa): usado nos imoveis, em que parte do
    EDGE esta no ccusto 515 mas com empresa 110 (CB EMP.)."""
    if not empresas:
        return "", ()
    lista = _parse_empresas(empresas)
    if not lista:
        return "", ()
    a = f"{alias}." if alias else ""
    if por_empresa_tambem:
        return f" AND ({a}cd_ccusto = ANY(%s) OR {a}cd_empresa = ANY(%s))", (_expandir_empresas_para_ccustos(lista), lista)
    return f" AND {a}cd_ccusto = ANY(%s)", (_expandir_empresas_para_ccustos(lista),)


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
            ccustos_expandidos = _expandir_empresas_para_ccustos(lista_empresas)
            clausula_empresa = " AND d.cd_ccusto = ANY(%s)"
            params_empresa = (ccustos_expandidos,)

    row = execute_query(f"""
        SELECT SUM(ABS(d.vl_rateio)) AS total
        FROM vr_fcp_despduplicatai d
        WHERE d.dt_vencimento >= %s AND d.dt_vencimento <= %s
          AND d.tp_situacao = 'N'
          AND d.cd_despesaitem = ANY(%s)
          AND {FILTRO_DUPLICATAS_EXCLUIDAS_SQL}{clausula_empresa}
    """, (data_inicio, data_fim, despesaitens, *PARAMS_DUPLICATAS_EXCLUIDAS, *params_empresa))

    return float((row[0]["total"] if row else 0) or 0)


def _somar_boletos_a_receber(data_inicio: str, data_fim: str, empresas: Optional[str]) -> float:
    """Total da coluna Boleto do Fluxo de Caixa na janela: mesma regra
    (_filtros_boleto) - boleto em aberto, sem descontado em banco, so de hoje em
    diante (data efetiva de compensacao)."""
    _criar_tabelas_fluxo_caixa()
    where, params = _filtros_boleto(data_inicio, data_fim, _parse_empresas(empresas))
    rows = execute_query(
        f"SELECT COALESCE(SUM(vl_fatura - vl_pago), 0) AS total FROM vr_fcr_faturai {where}",
        tuple(params),
    ) or []
    return float(rows[0]["total"] or 0) if rows else 0.0


def _somar_cartoes_a_receber(data_inicio: str, data_fim: str, empresas: Optional[str]) -> float:
    """Total da coluna Cartao do Fluxo de Caixa na janela: vendas REAIS em
    cartao (credito/debito) ainda nao recebidas, pela data de recebimento
    calculada a partir da venda (_filtros_cartao)."""
    _criar_tabelas_fluxo_caixa()
    where, params = _filtros_cartao(data_inicio, data_fim, _parse_empresas(empresas))
    rows = execute_query(
        f"SELECT COALESCE(SUM(vl_fatura - COALESCE(vl_desconto, 0)), 0) AS total FROM vr_fcr_faturai {where}",
        tuple(params),
    ) or []
    return float(rows[0]["total"] or 0) if rows else 0.0


def _somar_cheques_a_receber(data_inicio: str, data_fim: str, empresas: Optional[str]) -> float:
    """Total da coluna Cheque do Fluxo de Caixa na janela: mesma regra
    (_filtros_cheque) - cheque em aberto, so de hoje em diante (data efetiva
    de compensacao, fim de semana avanca pro proximo dia util)."""
    _criar_tabelas_fluxo_caixa()
    where, params = _filtros_cheque(data_inicio, data_fim, _parse_empresas(empresas))
    rows = execute_query(
        f"SELECT COALESCE(SUM(vl_fatura - vl_pago), 0) AS total FROM vr_fcr_faturai {where}",
        tuple(params),
    ) or []
    return float(rows[0]["total"] or 0) if rows else 0.0


# ── Estoque PA das lojas (foto atual) ─────────────────────────────────────
# Estoque de mv_pcp_estoque_atual_lojas (posicao mais recente de cada
# empresa x produto) valorizado com o MESMO custo unitario do CMV das lojas
# (vr_cmv_lojas_v2): tabela 'P' cod 1 pras marcas 0001/0002/0009, 'C' cod 2
# pras demais, R$ 21,90 se o produto nao tem valor, x0,7 na Maraponga (2) e
# x0,8 nas outras. Diferenca pro CMV: aqui o valor e o ATUAL do produto (nao
# o da data da venda). Estoque negativo vale 0. Empresas = lojas da DRE
# (CCUSTOS_LOJAS, inclui o e-commerce 120) - 100/110/999 sao deposito/CD, nao
# loja, e ficam de fora.
# Valorizar os ~50 mil itens leva dezenas de segundos (funcao de valor por
# linha), entao o resultado por empresa fica em cache no banco e so e refeito
# quando a materialized view foi atualizada depois do ultimo calculo.
_lock_estoque_lojas = threading.Lock()

# Produtos em LEVE DEFEITO ou OPORTUNIDADE (ate 1 ano, entre 1 e 2 anos, acima de
# 2 anos) - status de mv_prd_referencia_produto (mesma fonte do Giro) - tem o
# custo unitario reduzido em 50% no estoque PA (lojas e fabrica) do balanco.
FATOR_STATUS_DESCONTO = 0.5
VERSAO_CACHE_ESTOQUE = 3  # sobe quando a regra de valorizacao muda: invalida o cache

SQL_ESTOQUE_LOJAS_DT_BASE = "SELECT MAX(dt_atualizacao) AS dt FROM mv_pcp_estoque_atual_lojas"

SQL_ESTOQUE_LOJAS_VALORIZADO = """
    WITH base AS (
        SELECT e.cd_empresa, e.cd_produto, e.estoque_bruto,
               btrim(pc.cd_classificacao::text) AS idmarca
        FROM mv_pcp_estoque_atual_lojas e
        LEFT JOIN prd_produtoclas pc ON pc.cd_produto = e.cd_produto AND pc.cd_tipoclas = 20
        WHERE e.estoque_bruto > 0 AND e.cd_empresa = ANY(%s)
    ),
    prod_desconto AS (
        SELECT DISTINCT cd_produto FROM mv_prd_referencia_produto
        WHERE btrim(upper(status)) = 'LEVE DEFEITO' OR btrim(upper(status)) LIKE 'OPORTUNIDADE%%'
    ),
    com_valor AS (
        SELECT b.*,
            (CASE WHEN b.idmarca = ANY (ARRAY['0001','0002','0009'])
                 THEN COALESCE(NULLIF(f_prd_valor_produto2(1,1,'P',1,b.cd_produto,NULL),0), 21.9)
                 ELSE COALESCE(NULLIF(f_prd_valor_produto2(1,1,'C',2,b.cd_produto,NULL),0), 21.9)
            END) * CASE WHEN d.cd_produto IS NOT NULL THEN 0.5 ELSE 1 END AS vl_unit,
            (d.cd_produto IS NOT NULL) AS fora_linha
        FROM base b
        LEFT JOIN prod_desconto d ON d.cd_produto = b.cd_produto
    )
    SELECT cd_empresa, SUM(estoque_bruto) AS pecas,
           SUM(estoque_bruto * vl_unit * CASE WHEN cd_empresa = 2 THEN 0.7 ELSE 0.8 END) AS valor,
           COALESCE(SUM(estoque_bruto * vl_unit * CASE WHEN cd_empresa = 2 THEN 0.7 ELSE 0.8 END) FILTER (WHERE fora_linha), 0) AS valor_fora
    FROM com_valor GROUP BY cd_empresa
"""


def _criar_tabela_estoque_lojas():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_balanco_estoque_lojas (
            cd_empresa INTEGER PRIMARY KEY,
            pecas NUMERIC(14, 2) NOT NULL,
            valor NUMERIC(16, 2) NOT NULL,
            dt_base TIMESTAMPTZ NOT NULL,
            dt_calculado TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """, ())
    # Regra de valorizacao nova (status c/ 50%): descarta o cache antigo das
    # lojas/fabrica uma unica vez; MP (-1) nao muda.
    execute_insert("ALTER TABLE fcp_balanco_estoque_lojas ADD COLUMN IF NOT EXISTS versao INTEGER NOT NULL DEFAULT 1", ())
    execute_insert("ALTER TABLE fcp_balanco_estoque_lojas ADD COLUMN IF NOT EXISTS valor_fora NUMERIC(16, 2) NOT NULL DEFAULT 0", ())
    execute_insert("DELETE FROM fcp_balanco_estoque_lojas WHERE cd_empresa > 0 AND versao < %s", (VERSAO_CACHE_ESTOQUE,))


# Estoque PA da FABRICA (cd_empresa 1 no mesmo cache): mv_pcp_estoque_atual
# (estoque da fabrica, sem coluna de empresa) x custo tabela 'C' cod 999 da
# empresa 1 (f_prd_valor_produto2) + 10%. Produto sem valor nessa tabela vale 0.
CD_EMPRESA_CACHE_FABRICA = 1
ACRESCIMO_ESTOQUE_FABRICA = 1.10

SQL_ESTOQUE_FABRICA_DT_BASE = "SELECT MAX(dt_atualizacao) AS dt FROM mv_pcp_estoque_atual"

SQL_ESTOQUE_FABRICA_VALORIZADO = """
    WITH
    prod_desconto AS (
        SELECT DISTINCT cd_produto FROM mv_prd_referencia_produto
        WHERE btrim(upper(status)) = 'LEVE DEFEITO' OR btrim(upper(status)) LIKE 'OPORTUNIDADE%%'
    )
    SELECT SUM(estoque_bruto) AS pecas,
           SUM(estoque_bruto * COALESCE(vl_unit, 0) * %s) AS valor,
           COALESCE(SUM(estoque_bruto * COALESCE(vl_unit, 0) * %s) FILTER (WHERE fora_linha), 0) AS valor_fora
    FROM (
        SELECT e.estoque_bruto,
               NULLIF(f_prd_valor_produto2(1, 1, 'C', 999, e.cd_produto, NULL), 0)
                   * CASE WHEN d.cd_produto IS NOT NULL THEN 0.5 ELSE 1 END AS vl_unit,
               (d.cd_produto IS NOT NULL) AS fora_linha
        FROM mv_pcp_estoque_atual e
        LEFT JOIN prod_desconto d ON d.cd_produto = e.cd_produto
        WHERE e.estoque_bruto > 0
    ) x
"""


# Estoque MP da FABRICA (cd_empresa -1 no mesmo cache): saldo mais recente de
# cada materia-prima (produtos 1.000.000 a 4.999.999) da empresa 1, saldo 1, em
# prd_prdsaldo x custo tabela 'C' cod 2 (f_prd_valor_produto2). Sem valor = 0.
# prd_prdsaldo e pesada (~20s) e nao tem view de "atualizacao", entao o cache
# vale por TTL_ESTOQUE_MP_SEG.
CD_EMPRESA_CACHE_MP = -1
TTL_ESTOQUE_MP_SEG = 2 * 3600

SQL_ESTOQUE_MP_VALORIZADO = """
    SELECT SUM(estoque_bruto) AS pecas,
           SUM(estoque_bruto * COALESCE(vl_unit, 0)) AS valor
    FROM (
        SELECT s.estoque_bruto,
               NULLIF(f_prd_valor_produto2(1, 1, 'C', 2, s.cd_produto, NULL), 0) AS vl_unit
        FROM (
            SELECT DISTINCT ON (s.cd_produto) s.cd_produto, s.qt_saldo AS estoque_bruto
            FROM prd_prdsaldo s
            WHERE s.cd_empresa = 1 AND s.cd_saldo = 1 AND s.cd_produto > 1000000 AND s.cd_produto < 5000000
            ORDER BY s.cd_produto, s.dt_saldo DESC
        ) s
        WHERE s.estoque_bruto > 0
    ) x
"""


def _cache_em_dia(filtro_empresas: str, base) -> bool:
    cache = execute_query(
        f"SELECT MAX(dt_base) AS dt, COUNT(*) AS n FROM fcp_balanco_estoque_lojas WHERE {filtro_empresas}", ()
    ) or [{}]
    return bool(base is not None and cache[0].get("n") and cache[0].get("dt") == base)


def _garantir_cache_estoque_lojas() -> None:
    """Recalcula o cache se a view de estoque foi atualizada depois dele."""
    _criar_tabela_estoque_lojas()
    _garantir_cache_estoque_fabrica()
    _garantir_cache_estoque_mp()
    filtro = "cd_empresa > 1"  # lojas (fabrica = 1 e MP = -1 tem linha propria)
    base = (execute_query(SQL_ESTOQUE_LOJAS_DT_BASE, ()) or [{}])[0].get("dt")
    if _cache_em_dia(filtro, base):
        return
    with _lock_estoque_lojas:
        if _cache_em_dia(filtro, base):
            return  # outra requisicao acabou de calcular
        inicio = time.time()
        rows = execute_query(SQL_ESTOQUE_LOJAS_VALORIZADO, (list(CCUSTOS_LOJAS.keys()),)) or []
        if base is None:
            return
        execute_insert(f"DELETE FROM fcp_balanco_estoque_lojas WHERE {filtro}", ())
        if rows:
            valores_sql = ",".join(["(%s,%s,%s,%s,%s,%s)"] * len(rows))
            params = [p for r in rows for p in (r["cd_empresa"], float(r["pecas"]), round(float(r["valor"]), 2), base, VERSAO_CACHE_ESTOQUE, round(float(r["valor_fora"]), 2))]
            execute_insert(
                f"INSERT INTO fcp_balanco_estoque_lojas (cd_empresa, pecas, valor, dt_base, versao, valor_fora) VALUES {valores_sql}",
                tuple(params),
            )
        print(f"[BALANCO] Estoque PA das lojas recalculado: {len(rows)} empresa(s) em {time.time() - inicio:.1f}s")


def _garantir_cache_estoque_fabrica() -> None:
    filtro = f"cd_empresa = {CD_EMPRESA_CACHE_FABRICA}"
    base = (execute_query(SQL_ESTOQUE_FABRICA_DT_BASE, ()) or [{}])[0].get("dt")
    if _cache_em_dia(filtro, base):
        return
    with _lock_estoque_lojas:
        if _cache_em_dia(filtro, base) or base is None:
            return
        inicio = time.time()
        r = (execute_query(SQL_ESTOQUE_FABRICA_VALORIZADO, (ACRESCIMO_ESTOQUE_FABRICA, ACRESCIMO_ESTOQUE_FABRICA)) or [{}])[0]
        execute_insert(f"DELETE FROM fcp_balanco_estoque_lojas WHERE {filtro}", ())
        execute_insert(
            "INSERT INTO fcp_balanco_estoque_lojas (cd_empresa, pecas, valor, dt_base, versao, valor_fora) VALUES (%s,%s,%s,%s,%s,%s)",
            (CD_EMPRESA_CACHE_FABRICA, float(r.get("pecas") or 0), round(float(r.get("valor") or 0), 2), base, VERSAO_CACHE_ESTOQUE,
             round(float(r.get("valor_fora") or 0), 2)),
        )
        print(f"[BALANCO] Estoque PA da fabrica recalculado em {time.time() - inicio:.1f}s")


def _garantir_cache_estoque_mp() -> None:
    linha = (execute_query(
        f"SELECT dt_calculado FROM fcp_balanco_estoque_lojas WHERE cd_empresa = {CD_EMPRESA_CACHE_MP}", ()
    ) or [None])[0]
    def _fresco(l) -> bool:
        if not l:
            return False
        idade = (execute_query("SELECT EXTRACT(EPOCH FROM (NOW() - %s::timestamptz)) AS s", (l["dt_calculado"],)) or [{"s": 1e9}])[0]["s"]
        return float(idade) < TTL_ESTOQUE_MP_SEG
    if _fresco(linha):
        return
    with _lock_estoque_lojas:
        linha = (execute_query(
            f"SELECT dt_calculado FROM fcp_balanco_estoque_lojas WHERE cd_empresa = {CD_EMPRESA_CACHE_MP}", ()
        ) or [None])[0]
        if _fresco(linha):
            return
        inicio = time.time()
        r = (execute_query(SQL_ESTOQUE_MP_VALORIZADO, ()) or [{}])[0]
        execute_insert(f"DELETE FROM fcp_balanco_estoque_lojas WHERE cd_empresa = {CD_EMPRESA_CACHE_MP}", ())
        execute_insert(
            "INSERT INTO fcp_balanco_estoque_lojas (cd_empresa, pecas, valor, dt_base) VALUES (%s,%s,%s,NOW())",
            (CD_EMPRESA_CACHE_MP, float(r.get("pecas") or 0), round(float(r.get("valor") or 0), 2)),
        )
        print(f"[BALANCO] Estoque MP da fabrica recalculado em {time.time() - inicio:.1f}s")


def _estoque_mp_fabrica(empresas: Optional[str]) -> float:
    """Estoque de materia-prima da fabrica: entra se nao ha filtro de empresas
    ou se a fabrica (empresa 1) esta entre as selecionadas."""
    if empresas and CD_EMPRESA_CACHE_FABRICA not in _parse_empresas(empresas):
        return 0.0
    _criar_tabela_estoque_lojas()
    _garantir_cache_estoque_mp()
    rows = execute_query(
        f"SELECT COALESCE(SUM(valor), 0) AS total FROM fcp_balanco_estoque_lojas WHERE cd_empresa = {CD_EMPRESA_CACHE_MP}", ()
    ) or [{"total": 0}]
    return float(rows[0]["total"] or 0)


def _estoque_pa_lojas(empresas: Optional[str]) -> tuple:
    """Valor do estoque PA das lojas (foto atual), das empresas filtradas
    (todas as lojas se nao houver filtro)."""
    _garantir_cache_estoque_lojas()
    lista = [e for e in _parse_empresas(empresas) if e in CCUSTOS_LOJAS]
    if empresas and not lista:
        return 0.0, 0.0
    sql = "SELECT COALESCE(SUM(valor), 0) AS total, COALESCE(SUM(valor_fora), 0) AS fora FROM fcp_balanco_estoque_lojas WHERE cd_empresa > 1"
    params: tuple = ()
    if empresas:
        sql += " AND cd_empresa = ANY(%s)"
        params = (lista,)
    r = (execute_query(sql, params) or [{"total": 0, "fora": 0}])[0]
    return float(r["total"] or 0), float(r["fora"] or 0)


def _estoque_pa_fabrica(empresas: Optional[str]) -> tuple:
    """Estoque PA da fabrica: entra se nao ha filtro de empresas ou se a
    fabrica (empresa 1) esta entre as selecionadas."""
    if empresas and CD_EMPRESA_CACHE_FABRICA not in _parse_empresas(empresas):
        return 0.0, 0.0
    _garantir_cache_estoque_lojas()
    rows = execute_query(
        f"SELECT COALESCE(SUM(valor), 0) AS total, COALESCE(SUM(valor_fora), 0) AS fora FROM fcp_balanco_estoque_lojas WHERE cd_empresa = {CD_EMPRESA_CACHE_FABRICA}", ()
    ) or [{"total": 0, "fora": 0}]
    return float(rows[0]["total"] or 0), float(rows[0]["fora"] or 0)


async def loop_cache_estoque_lojas() -> None:
    """Mantem o cache pronto em background (startup em main.py), pra tela
    nao esperar o calculo."""
    await asyncio.sleep(45)
    while True:
        try:
            await asyncio.to_thread(_garantir_cache_estoque_lojas)
        except Exception as e:
            print(f"[BALANCO] Erro ao atualizar cache do estoque das lojas: {e}")
        await asyncio.sleep(30 * 60)


# ── Bens (investimentos e imobilizado) ───────────────────────────────────
# Lancamento manual por enquanto: fcp_balanco_bens, criada ja com os bens da
# planilha de patrimonio (valor da planilha, sem depreciacao - balanco
# gerencial). linha_balanco = conta do plano (ANC.5 Investimentos, ANC.6
# Imobilizado). Filtra pelo cd_empresa (LIEBE=1, CB EMP.=110, CAIRO EIRELLI=100), mas nao depende do mes de
# referencia (foto atual). saldo_devedor fica guardado, mas ainda nao entra no
# Passivo.
BENS_INICIAIS = [
    # (bloco, descricao, tipo, linha_balanco, empresa, valor, saldo_devedor, referencia)
    ("CB EMPREENDIMENTOS", "JEEP COMPASS LIMITED", "VEICULO", "ANC.6", "CB EMP.", 190000.00, 0, "POL1E53"),
    ("CB EMPREENDIMENTOS", "HONDA HR-V EX 1.5 16V CVT", "VEICULO", "ANC.6", "CB EMP.", 160000.00, 0, "SBI1C66"),
    ("CB EMPREENDIMENTOS", "PEUGEOT EXPERT BUSINPK", "VEICULO", "ANC.6", "CB EMP.", 120000.00, 0, "PMW0H05"),
    ("CB EMPREENDIMENTOS", "CASA MAUA - 208m2 - APTO 2101", "IMOVEL", "ANC.5", "CB EMP.", 4200000.00, 1725156.73, "ENTREGA DEZ 2028"),
    ("CB EMPREENDIMENTOS", "CASA MAUA 130m2 - APTO 2602", "IMOVEL", "ANC.5", "CB EMP.", 2790000.00, 1093983.77, "ENTREGA DEZ 2028"),
    ("CB EMPREENDIMENTOS", "CASA MAUA 130m2 - APTO 2702", "IMOVEL", "ANC.5", "CB EMP.", 2790000.00, 1115315.66, "ENTREGA DEZ 2028"),
    ("CB EMPREENDIMENTOS", "CASA MAUA 130m2 - APTO 2703", "IMOVEL", "ANC.5", "CB EMP.", 2790000.00, 1135347.54, "ENTREGA DEZ 2028"),
    ("CB EMPREENDIMENTOS", "EDGE", "IMOVEL", "ANC.5", "CB EMP.", 7500000.00, 4548696.74, "ENTREGA DEZ 2026"),
    ("CB EMPREENDIMENTOS", "BS DESIGN", "IMOVEL", "ANC.6", "CB EMP.", 10000000.00, 0, "46924"),  # usado pela empresa
    ("CB EMPREENDIMENTOS", "TERRENO BR 116", "IMOVEL", "ANC.5", "CB EMP.", 5000000.00, 1377735.12, "65884"),
    ("CB EMPREENDIMENTOS", "TERRENO CASTELAO", "IMOVEL", "ANC.6", "CB EMP.", 7500000.00, 0, "27968"),  # futura fabrica
    ("CAIRO BENEVIDES INDUSTRIA E COMERCIO", "I/BMW X2 XDRIVE20I MSP", "VEICULO", "ANC.6", "LIEBE", 420000.00, 357255.55, "UVA3I35"),
    ("CAIRO BENEVIDES INDUSTRIA E COMERCIO", "I/BMW X3 30 XDRIVE", "VEICULO", "ANC.6", "LIEBE", 520000.00, 431819.33, "UUU6G64"),
    ("PACIFICO HOLDING", "SOLAR PRACA", "IMOVEL", "ANC.5", "CAIRO EIRELLI", 10500000.00, 0, ""),
]


# Codigos do filtro de empresas do balanco: LIEBE = empresa 001 (fabrica); as
# demais usam a empresa/centro de custo real do ERP (CB EMP. 110, CAIRO EIRELLI
# 100, CORPO SEXY 50 - esta ainda sem bens), o que faz contas a pagar/receber
# tambem respeitarem o filtro.
CD_EMPRESA_BENS = {"LIEBE": 1, "CB EMP.": 110, "CAIRO EIRELLI": 100}


def _filtro_bens(empresas: Optional[str]):
    """Clausula/params do filtro de empresas aplicado aos bens (sem filtro = todos)."""
    if not empresas:
        return "", ()
    return " AND cd_empresa = ANY(%s)", (_parse_empresas(empresas),)


def _criar_tabela_bens():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_balanco_bens (
            id SERIAL PRIMARY KEY,
            bloco TEXT NOT NULL,
            descricao TEXT NOT NULL,
            tipo TEXT NOT NULL,
            linha_balanco TEXT NOT NULL,
            empresa TEXT,
            valor NUMERIC(16, 2) NOT NULL,
            saldo_devedor NUMERIC(16, 2) NOT NULL DEFAULT 0,
            referencia TEXT,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """, ())
    execute_insert("ALTER TABLE fcp_balanco_bens ADD COLUMN IF NOT EXISTS cd_empresa INTEGER", ())
    if not (execute_query("SELECT 1 FROM fcp_balanco_bens LIMIT 1", ()) or []):
        valores_sql = ",".join(["(%s,%s,%s,%s,%s,%s,%s,%s)"] * len(BENS_INICIAIS))
        params = [p for b in BENS_INICIAIS for p in b]
        execute_insert(
            "INSERT INTO fcp_balanco_bens (bloco, descricao, tipo, linha_balanco, empresa, valor, saldo_devedor, referencia) "
            f"VALUES {valores_sql}",
            tuple(params),
        )
    # Bens sem codigo de empresa (lancados antes do filtro ou a mao) herdam do nome.
    for nome, cd in CD_EMPRESA_BENS.items():
        execute_insert("UPDATE fcp_balanco_bens SET cd_empresa = %s WHERE cd_empresa IS NULL AND empresa = %s", (cd, nome))


def _total_bens_por_linha(empresas: Optional[str] = None) -> dict:
    """{'ANC.5': total, 'ANC.6': total} dos bens ativos das empresas filtradas."""
    _criar_tabela_bens()
    clausula, params = _filtro_bens(empresas)
    rows = execute_query(
        f"SELECT linha_balanco, COALESCE(SUM(valor), 0) AS total FROM fcp_balanco_bens WHERE ativo{clausula} GROUP BY linha_balanco", params
    ) or []
    return {r["linha_balanco"]: float(r["total"]) for r in rows}


def _listar_bens(empresas: Optional[str] = None) -> list:
    """Bens ativos (um por linha) para abrir ANC.5/ANC.6 no balanco."""
    _criar_tabela_bens()
    clausula, params = _filtro_bens(empresas)
    rows = execute_query(
        f"SELECT id, linha_balanco, descricao, empresa, valor FROM fcp_balanco_bens WHERE ativo{clausula} ORDER BY linha_balanco, valor DESC, id", params
    ) or []
    return [
        {
            "codigo": f"{r['linha_balanco']}.B{r['id']}",
            "linha": r["linha_balanco"],
            "nome": f"{r['descricao']} ({r['empresa']})" if r.get("empresa") else r["descricao"],
            "valor": float(r["valor"]),
        }
        for r in rows
    ]


@router.get("/api/balanco-patrimonial/indicadores-dre")
def get_indicadores_dre(mesReferencia: str = Query(..., description="Mes de referencia YYYY-MM")):
    """Lucro liquido (conta 14) e EBITDA (conta 09) da DRE consolidada nos 12
    meses fechados que terminam no mes de referencia, lidos do mesmo cache da
    tela de DRE. Se o mes de referencia e o mes corrente (ou futuro), ainda
    esta aberto e distorce o resultado - a janela termina no ultimo mes
    fechado. Alimenta ROE e Divida liquida / EBITDA."""
    try:
        from routers import dre as dre_mod
        ano, mes = (int(x) for x in mesReferencia.split("-"))
        if not 1 <= mes <= 12:
            raise ValueError
    except ValueError:
        raise HTTPException(status_code=400, detail="mesReferencia deve ser YYYY-MM")
    try:
        hoje = date.today()
        if (ano, mes) >= (hoje.year, hoje.month):
            ano, mes = (hoje.year, hoje.month - 1) if hoje.month > 1 else (hoje.year - 1, 12)
        ini_ano, ini_mes = (ano - 1, mes + 1) if mes < 12 else (ano, 1)
        ini = f"{ini_ano}-{ini_mes:02d}-01"
        prox = date(ano + (mes == 12), mes % 12 + 1, 1)
        fim = (prox - timedelta(days=1)).isoformat()
        dados = dre_cache.obter(
            "analitica", ini, fim, "consolidado", False,
            lambda: dre_mod._calcular_valores_unificada(ini, fim, "consolidado", campo_data_despesa="dt_emissao"),
        )
        valores = dados.get("valores") or {}

        def soma_12m(codigo):
            return sum(float(v or 0) for k, v in (valores.get(codigo) or {}).items() if re.fullmatch(r"\d{4}-\d{2}", k))

        return {"inicio": ini, "fim": fim, "mesFim": f"{ano}-{mes:02d}", "lucroLiquido12m": soma_12m("14"), "ebitda12m": soma_12m("09")}
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/balanco-patrimonial/dados")
def get_balanco_patrimonial(
    mesReferencia: str = Query(..., description="Mes de referencia YYYY-MM"),
    empresas: Optional[str] = Query(None, description="Lista de cd_empresa/cd_ccusto separados por virgula (default: todas)")
):
    """
    Valores do Balanco Patrimonial: Caixa, Contas a Receber (boletos e
    cartoes), Estoques e Bens, e no Passivo Fornecedores (PC.1 = vencimentos do proximo mes ao de referencia), Salarios (PC.4), Tributos (PC.5 = vencimentos do proximo mes ao de referencia), IR e CSLL (PC.6 ate 12 meses e PNC.10 depois), Obrigacoes por compra de imoveis (PC.IMV ate 12 meses e PNC.IMV depois), Materia-prima (PC.2) e Emprestimos (PC.3 ate 12 meses e PNC.8 depois). As
    demais contas do Passivo nao tem fonte ligada (a tela de classificacao de
    despesas foi descontinuada) e ficam zeradas.
    """
    try:
        _criar_tabelas_balanco()

        # A tela de configuracao do balanco (classificacao de despesas -> contas do
        # Passivo e janela por conta) foi descontinuada: as contas do Passivo que
        # dependiam dela (PC.1 a PC.4) ficam zeradas e a janela de Contas a
        # Receber usa o padrao. As tabelas continuam no banco, so nao alimentam mais.
        meses_janela_receber = MESES_JANELA_PADRAO

        # Cada bloco e uma consulta de 15-25s no banco remoto; em fila davam ~2
        # minutos. Rodam em paralelo (pool de conexoes e thread-safe) e o
        # tempo total cai pro da consulta mais lenta.
        valores: dict = {}

        # AC.1 Caixa e equivalentes de caixa = total dos saldos bancarios, o MESMO
        # valor do fluxo de caixa (posicao de caixa mais recente de cada conta,
        # sem filtro de empresa - a tabela de saldos nao tem cd_empresa). Nao
        # depende do mes de referencia: e a posicao de HOJE.
        def _caixa():
            # Sem posicao de hoje, vale o ultimo saldo de cada conta.
            saldos = _obter_saldos_bancarios(somente_hoje=False)
            # _CAIXA_POS / _CHEQUE_ESP: usados so no indicador de divida (caixa
            # disponivel = saldos positivos; saldo negativo = cheque especial
            # utilizado, que e divida). Saem de "valores" antes da resposta.
            return {
                "AC.1": saldos["total"],
                "_CAIXA_POS": sum(c["vlSaldo"] for c in saldos["contas"] if c["vlSaldo"] > 0),
                "_CHEQUE_ESP": -sum(c["vlSaldo"] for c in saldos["contas"] if c["vlSaldo"] < 0),
            }

        # AC.2 Contas a receber = boletos + cartoes + cheques do Fluxo de Caixa (colunas
        # Boleto e Cartao), na janela configurada da conta (default 12 meses) e
        # no filtro de empresas. AC.2.1/AC.2.2 = abertura so de exibicao.
        def _boletos():
            ini, fim = _janela_vencimento(mesReferencia, meses_janela_receber)
            return _somar_boletos_a_receber(ini, fim, empresas)

        def _cartoes():
            ini, fim = _janela_vencimento(mesReferencia, meses_janela_receber)
            return _somar_cartoes_a_receber(ini, fim, empresas)

        def _cheques():
            ini, fim = _janela_vencimento(mesReferencia, meses_janela_receber)
            return _somar_cheques_a_receber(ini, fim, empresas)

        # AC.3 Estoques = Estoque PA lojas + PA fabrica + MP fabrica (foto atual -
        # nao depende do mes de referencia; filtro de empresas vale).
        def _estoques():
            (lojas, lojas_fora), (fabrica, fabrica_fora), mp = _estoque_pa_lojas(empresas), _estoque_pa_fabrica(empresas), _estoque_mp_fabrica(empresas)
            # .1/.2 = em linha / fora de linha (LEVE DEFEITO e OPORTUNIDADE) - so exibicao.
            return {"AC.3": lojas + fabrica + mp,
                    "AC.3.1": lojas, "AC.3.1.1": lojas - lojas_fora, "AC.3.1.2": lojas_fora,
                    "AC.3.2": fabrica, "AC.3.2.1": fabrica - fabrica_fora, "AC.3.2.2": fabrica_fora,
                    "AC.3.3": mp}

        # ANC.5 Investimentos e ANC.6 Imobilizado = bens cadastrados (fixos).
        def _bens():
            return _total_bens_por_linha(empresas)

        # Emprestimos = principal (despesaitem 114) + juros (137) em aberto (nada
        # pago), sem filtro de empresa, igual a consulta passada pelo usuario.
        # PC.3 = vence em ate 12 meses (de hoje); PNC.8 = vence depois disso.
        # .1 = principal e .2 = juros (aberturas so de exibicao). Passivo = negativo.
        def _emprestimos():
            cc, prm = _filtro_ccusto_duplicatas(empresas)
            rows = execute_query(
                f"""SELECT cd_despesaitem::text AS item,
                          COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                          COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN ('114', '137')
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = '0'{cc}
                   GROUP BY 1""", tuple(prm)
            ) or []
            por_item = {r["item"]: r for r in rows}
            def v(item, col):
                return -float(por_item[item][col]) if item in por_item else 0.0
            pc_p, pc_j = v("114", "ate_12m"), v("137", "ate_12m")
            pnc_p, pnc_j = v("114", "apos_12m"), v("137", "apos_12m")
            return {
                "PC.3": pc_p + pc_j, "PC.3.1": pc_p, "PC.3.2": pc_j,
                "PNC.8": pnc_p + pnc_j, "PNC.8.1": pnc_p, "PNC.8.2": pnc_j,
            }

        # PC.2 = materia-prima a pagar (vencimento de hoje em diante, em aberto,
        # nada pago), filtrada pelo centro de custo das empresas escolhidas e sem separacao por prazo.
        def _materia_prima():
            cc, prm = _filtro_ccusto_duplicatas(empresas)
            rows = execute_query(
                f"""SELECT COALESCE(SUM(vl_rateio), 0) AS total
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = 0{cc}""", (DESPESAITENS_MATERIA_PRIMA, *prm)
            ) or []
            return {"PC.2": -float(rows[0]["total"]) if rows else 0.0}

        # PC.1 = fornecedores e alugueis a pagar do PROXIMO MES FECHADO ao mes de
        # referencia (filtro novembro -> vencimentos de dezembro): as previsoes de
        # fornecedor ja estao lancadas, entao o mes seguinte vem inteiro e nada
        # do mes atual/vencido entra. Em aberto, nada pago, filtrado pelo centro
        # de custo das empresas escolhidas. Nao ha mais PNC.7.
        def _fornecedores():
            cc, prm = _filtro_ccusto_duplicatas(empresas)
            ini, fim = _janela_proximo_mes(mesReferencia)
            rows = execute_query(
                f"""SELECT COALESCE(SUM(vl_rateio), 0) AS total
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento BETWEEN %s AND %s
                     AND tp_situacao = 'N'
                     AND vl_pago = 0{cc}""", (DESPESAITENS_FORNECEDORES, ini, fim, *prm)
            ) or []
            proximo = float(rows[0]["total"]) if rows else 0.0
            rescisao = _calcular_rescisoes(mesReferencia, empresas)
            return {"PC.1": -(proximo + rescisao), "PC.1.1": -proximo, "PC.1.2": -rescisao}

        # PC.5 = tributos a recolher do PROXIMO MES FECHADO ao mes de referencia (mesmo
        # conceito de PC.1): em aberto, nada pago, filtrado pelo centro de custo das
        # empresas escolhidas. Nao ha mais PNC.9.
        def _tributos():
            cc, prm = _filtro_ccusto_duplicatas(empresas)
            ini, fim = _janela_proximo_mes(mesReferencia)
            rows = execute_query(
                f"""SELECT COALESCE(SUM(vl_rateio), 0) AS total
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento BETWEEN %s AND %s
                     AND tp_situacao = 'N'
                     AND vl_pago = 0{cc}""", (DESPESAITENS_TRIBUTOS, ini, fim, *prm)
            ) or []
            return {"PC.5": -float(rows[0]["total"]) if rows else 0.0}

        # Endividamento tributario (multas SEFAZ): PC.ETR = vencidas + a vencer em
        # ate 12 meses (de hoje); PNC.ETR = depois disso. Em aberto, nada pago,
        # filtrado pelo centro de custo das empresas escolhidas.
        def _endividamento_tributario():
            cc, prm = _filtro_ccusto_duplicatas(empresas)
            rows = execute_query(
                f"""SELECT
                       COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                       COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND tp_situacao = 'N'
                     AND vl_pago = 0{cc}""", (DESPESAITENS_ENDIVIDAMENTO_TRIBUTARIO, *prm)
            ) or []
            r = rows[0] if rows else {"ate_12m": 0, "apos_12m": 0}
            return {"PC.ETR": -float(r["ate_12m"]), "PNC.ETR": -float(r["apos_12m"])}

        # PC.6 = IR e CSLL que vencem em ate 12 meses (de hoje); PNC.10 = os que
        # vencem depois disso. Em aberto, nada pago, sem filtro de empresa.
        def _ir_csll():
            cc, prm = _filtro_ccusto_duplicatas(empresas)
            rows = execute_query(
                f"""SELECT
                       COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                       COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = 0{cc}""", (DESPESAITENS_IR_CSLL, *prm)
            ) or []
            r = rows[0] if rows else {"ate_12m": 0, "apos_12m": 0}
            return {"PC.6": -float(r["ate_12m"]), "PNC.10": -float(r["apos_12m"])}

        # Obrigacoes por compra de imoveis: ate 12 meses (de hoje) = PC.IMV, depois
        # disso = PNC.IMV. A vencer, em aberto, nada pago (vencidos nao entram),
        # sem filtro de empresa.
        def _imoveis():
            cc, prm = _filtro_ccusto_duplicatas(empresas, por_empresa_tambem=True)
            rows = execute_query(
                f"""SELECT
                       COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                       COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = 0{cc}""", (DESPESAITENS_IMOVEIS, *prm)
            ) or []
            r = rows[0] if rows else {"ate_12m": 0, "apos_12m": 0}
            return {"PC.IMV": -float(r["ate_12m"]), "PNC.IMV": -float(r["apos_12m"])}

        # PC.4 Salarios e encargos a pagar = custo_total da competencia mais
        # recente de fato_custo_mensal (PC.4.1) + lancamentos manuais da conta em
        # fcp_balanco_ajustes (PC.4.2, ex: rescisao de funcionarios), sem filtro
        # de empresa. Passivo = negativo.
        def _salarios():
            rows = execute_query(
                "SELECT competencia, custo_total FROM fato_custo_mensal ORDER BY competencia DESC LIMIT 1", ()
            ) or []
            salarios = float(rows[0]["custo_total"] or 0) if rows else 0.0
            extras = _total_ajustes("PC.4")
            return {"PC.4": -(salarios + extras), "PC.4.1": -salarios, "PC.4.2": -extras}

        with ThreadPoolExecutor(max_workers=6) as pool:
            f_opcionais = {
                "Saldo bancario": pool.submit(_caixa),
                "Boletos a receber": pool.submit(_boletos),
                "Cartoes a receber": pool.submit(_cartoes),
                "Cheques a receber": pool.submit(_cheques),
                "Estoques": pool.submit(_estoques),
                "Bens": pool.submit(_bens),
                "Emprestimos": pool.submit(_emprestimos),
                "Materia-prima": pool.submit(_materia_prima),
                "Fornecedores": pool.submit(_fornecedores),
                "Salarios": pool.submit(_salarios),
                "Tributos": pool.submit(_tributos),
                "IR e CSLL": pool.submit(_ir_csll),
                "Imoveis": pool.submit(_imoveis),
                "Endividamento tributario": pool.submit(_endividamento_tributario),
            }
            resultados = {}
            for nome, f in f_opcionais.items():
                try:
                    resultados[nome] = f.result()
                except Exception as e:
                    print(f"[BALANCO] {nome} indisponivel: {e}")
        valores.update(resultados.get("Saldo bancario", {}))
        if "Boletos a receber" in resultados and "Cartoes a receber" in resultados and "Cheques a receber" in resultados:
            boletos, cartoes, cheques = resultados["Boletos a receber"], resultados["Cartoes a receber"], resultados["Cheques a receber"]
            valores["AC.2"] = boletos + cartoes + cheques
            valores["AC.2.1"] = boletos
            valores["AC.2.2"] = cartoes
            valores["AC.2.3"] = cheques
        valores.update(resultados.get("Estoques", {}))
        valores.update(resultados.get("Bens", {}))
        valores.update(resultados.get("Emprestimos", {}))
        valores.update(resultados.get("Materia-prima", {}))
        valores.update(resultados.get("Fornecedores", {}))
        valores.update(resultados.get("Salarios", {}))
        valores.update(resultados.get("Tributos", {}))
        valores.update(resultados.get("IR e CSLL", {}))
        valores.update(resultados.get("Imoveis", {}))
        valores.update(resultados.get("Endividamento tributario", {}))

        bens = []
        if "Bens" in resultados:
            try:
                bens = _listar_bens(empresas)
            except Exception as e:
                print(f"[BALANCO] detalhe de bens indisponivel: {e}")
        caixa_disponivel = valores.pop("_CAIXA_POS", None)
        cheque_especial = valores.pop("_CHEQUE_ESP", None)
        return {"valores": valores, "bens": bens, "mesReferencia": mesReferencia,
                "caixaDisponivel": caixa_disponivel, "chequeEspecial": cheque_especial}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro ao buscar balanco patrimonial: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar balanco patrimonial: {str(e)}")


# Detalhe de uma conta do Passivo (fornecedor x despesa x mes de vencimento).
# Mesmos filtros das contas em /dados: em aberto, nada pago, vencimento de hoje
# em diante, sem filtro de empresa; "ate_12m" / "apos_12m" = corte do CP/LP.
_DETALHE_PASSIVO = {
    "PC.1": (lambda: DESPESAITENS_FORNECEDORES, "proximo_mes"),
    "PC.2": (lambda: DESPESAITENS_MATERIA_PRIMA, None),
    "PC.3": (lambda: ("114", "137"), "ate"), "PNC.8": (lambda: ("114", "137"), "apos"),
    "PC.IMV": (lambda: DESPESAITENS_IMOVEIS, "ate"), "PNC.IMV": (lambda: DESPESAITENS_IMOVEIS, "apos"),
    "PC.ETR": (lambda: DESPESAITENS_ENDIVIDAMENTO_TRIBUTARIO, "ate_com_vencidos"), "PNC.ETR": (lambda: DESPESAITENS_ENDIVIDAMENTO_TRIBUTARIO, "apos"),
    "PC.5": (lambda: DESPESAITENS_TRIBUTOS, "proximo_mes"),
    "PC.6": (lambda: DESPESAITENS_IR_CSLL, "ate"), "PNC.10": (lambda: DESPESAITENS_IR_CSLL, "apos"),
}


@router.get("/api/balanco-patrimonial/detalhe-lancamentos")
def get_detalhe_lancamentos(conta: str = Query(..., description="PC.1.2 (rescisoes de aluguel) ou PC.4.2 (rescisao de funcionarios)"),
                            empresas: Optional[str] = Query(None),
                            mesReferencia: Optional[str] = Query(None)):
    """Itens calculados/lancados a mao que compoem uma abertura do Passivo."""
    try:
        if conta == "PC.1.2":
            itens = _rescisoes_detalhadas(mesReferencia or date.today().strftime("%Y-%m"), empresas)
        elif conta == "PC.4.2":
            _criar_tabela_ajustes()
            rows = execute_query("SELECT descricao, valor FROM fcp_balanco_ajustes WHERE conta = 'PC.4' AND ativo ORDER BY id", ()) or []
            itens = [{"descricao": r["descricao"], "informacao": "Lancamento manual", "valor": float(r["valor"])} for r in rows]
        else:
            raise HTTPException(status_code=400, detail="Abertura sem detalhamento")
        return {"conta": conta, "itens": itens}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] detalhe-lancamentos {conta}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/balanco-patrimonial/detalhe-passivo")
def get_detalhe_passivo(conta: str = Query(..., description="Codigo da conta do Passivo, ex: PC.1"),
                        empresas: Optional[str] = Query(None, description="Empresas do filtro (cd_empresa/ccusto, virgula)"),
                        mesReferencia: Optional[str] = Query(None, description="Mes de referencia YYYY-MM (PC.1 = mes seguinte)")):
    """Linhas agregadas (fornecedor, despesa, mes de vencimento) que compoem uma
    conta do Passivo. O front agrupa por fornecedor, por despesa ou por mes."""
    if conta not in _DETALHE_PASSIVO:
        raise HTTPException(status_code=400, detail="Conta sem detalhamento")
    itens_fn, janela = _DETALHE_PASSIVO[conta]
    corte = ""
    if janela in ("ate", "ate_com_vencidos"):
        corte = "AND d.dt_vencimento < CURRENT_DATE + INTERVAL '12 months'"
    elif janela == "apos":
        corte = "AND d.dt_vencimento >= CURRENT_DATE + INTERVAL '12 months'"
    prm_corte: tuple = ()
    piso = "" if janela == "ate_com_vencidos" else "AND d.dt_vencimento >= CURRENT_DATE"
    if janela == "proximo_mes":
        ini, fim = _janela_proximo_mes(mesReferencia or date.today().strftime("%Y-%m"))
        corte = "AND d.dt_vencimento BETWEEN %s AND %s"
        prm_corte = (ini, fim)
        piso = ""
    cc, prm = _filtro_ccusto_duplicatas(empresas, por_empresa_tambem=conta in ("PC.IMV", "PNC.IMV"), alias="d")
    try:
        rows = execute_query(
            f"""SELECT d.cd_fornecedor,
                       CASE WHEN p.nm_fantasia IS NULL OR TRIM(p.nm_fantasia) = '' OR p.nm_fantasia ~ '^\\*+$'
                            THEN COALESCE(p.nm_pessoa, pf.nm_pessoa, 'Fornecedor ' || d.cd_fornecedor::text)
                            ELSE p.nm_fantasia END AS fornecedor,
                       d.cd_despesaitem::text AS cd_despesa,
                       COALESCE(i.ds_despesaitem, 'Despesa ' || d.cd_despesaitem::text) AS despesa,
                       to_char(d.dt_vencimento, 'YYYY-MM') AS mes,
                       SUM(d.vl_rateio) AS valor,
                       COUNT(*) AS qtd
                FROM public.vr_fcp_despduplicatai d
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
                LEFT JOIN public.vr_fcp_despesaitem i ON i.cd_despesaitem = d.cd_despesaitem
                WHERE d.cd_despesaitem IN %s
                  {piso}
                  AND d.tp_situacao = 'N'
                  AND d.vl_pago = 0
                  {corte}{cc}
                GROUP BY 1, 2, 3, 4, 5
                ORDER BY 5, 2""",
            (tuple(itens_fn()), *prm_corte, *prm),
        ) or []
        return {
            "conta": conta,
            "linhas": [
                {"cdFornecedor": r["cd_fornecedor"], "fornecedor": r["fornecedor"], "cdDespesa": r["cd_despesa"],
                 "despesa": r["despesa"], "mes": r["mes"], "valor": float(r["valor"] or 0), "qtd": int(r["qtd"])}
                for r in rows
            ],
        }
    except Exception as e:
        print(f"[ERROR] detalhe-passivo {conta}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
