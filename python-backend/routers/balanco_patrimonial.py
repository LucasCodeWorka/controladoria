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

# PC.1 / PNC.7 Fornecedores e alugueis a pagar: despesaitens validados pelo
# usuario (72 codigos).
DESPESAITENS_FORNECEDORES = (
    4, 11, 16, 17, 18, 20, 22, 24, 26, 28, 29, 31, 37, 38, 39, 40, 41, 45, 49, 50,
    51, 52, 53, 55, 56, 58, 60, 61, 63, 64, 70, 73, 74, 76, 79, 82, 83, 84, 85, 87,
    110, 146, 149, 152, 159, 160, 161, 167, 218, 219, 220, 221, 222, 224, 225, 226,
    227, 228, 229, 231, 259, 262, 263, 264, 271, 280, 287, 488, 539, 543, 544, 546,
)

# PC.5 / PNC.9 Tributos a recolher: despesaitens indicados pelo usuario (12 codigos).
DESPESAITENS_TRIBUTOS = (111, 112, 113, 116, 117, 118, 119, 120, 126, 127, 250, 285)

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

SQL_ESTOQUE_LOJAS_DT_BASE = "SELECT MAX(dt_atualizacao) AS dt FROM mv_pcp_estoque_atual_lojas"

SQL_ESTOQUE_LOJAS_VALORIZADO = """
    WITH base AS (
        SELECT e.cd_empresa, e.cd_produto, e.estoque_bruto,
               btrim(pc.cd_classificacao::text) AS idmarca
        FROM mv_pcp_estoque_atual_lojas e
        LEFT JOIN prd_produtoclas pc ON pc.cd_produto = e.cd_produto AND pc.cd_tipoclas = 20
        WHERE e.estoque_bruto > 0 AND e.cd_empresa = ANY(%s)
    ),
    com_valor AS (
        SELECT b.*,
            CASE WHEN b.idmarca = ANY (ARRAY['0001','0002','0009'])
                 THEN COALESCE(NULLIF(f_prd_valor_produto2(1,1,'P',1,b.cd_produto,NULL),0), 21.9)
                 ELSE COALESCE(NULLIF(f_prd_valor_produto2(1,1,'C',2,b.cd_produto,NULL),0), 21.9)
            END AS vl_unit
        FROM base b
    )
    SELECT cd_empresa, SUM(estoque_bruto) AS pecas,
           SUM(estoque_bruto * vl_unit * CASE WHEN cd_empresa = 2 THEN 0.7 ELSE 0.8 END) AS valor
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


# Estoque PA da FABRICA (cd_empresa 1 no mesmo cache): mv_pcp_estoque_atual
# (estoque da fabrica, sem coluna de empresa) x custo tabela 'C' cod 999 da
# empresa 1 (f_prd_valor_produto2) + 10%. Produto sem valor nessa tabela vale 0.
CD_EMPRESA_CACHE_FABRICA = 1
ACRESCIMO_ESTOQUE_FABRICA = 1.10

SQL_ESTOQUE_FABRICA_DT_BASE = "SELECT MAX(dt_atualizacao) AS dt FROM mv_pcp_estoque_atual"

SQL_ESTOQUE_FABRICA_VALORIZADO = """
    SELECT SUM(estoque_bruto) AS pecas,
           SUM(estoque_bruto * COALESCE(vl_unit, 0) * %s) AS valor
    FROM (
        SELECT e.estoque_bruto,
               NULLIF(f_prd_valor_produto2(1, 1, 'C', 999, e.cd_produto, NULL), 0) AS vl_unit
        FROM mv_pcp_estoque_atual e
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
            valores_sql = ",".join(["(%s,%s,%s,%s)"] * len(rows))
            params = [p for r in rows for p in (r["cd_empresa"], float(r["pecas"]), round(float(r["valor"]), 2), base)]
            execute_insert(
                f"INSERT INTO fcp_balanco_estoque_lojas (cd_empresa, pecas, valor, dt_base) VALUES {valores_sql}",
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
        r = (execute_query(SQL_ESTOQUE_FABRICA_VALORIZADO, (ACRESCIMO_ESTOQUE_FABRICA,)) or [{}])[0]
        execute_insert(f"DELETE FROM fcp_balanco_estoque_lojas WHERE {filtro}", ())
        execute_insert(
            "INSERT INTO fcp_balanco_estoque_lojas (cd_empresa, pecas, valor, dt_base) VALUES (%s,%s,%s,%s)",
            (CD_EMPRESA_CACHE_FABRICA, float(r.get("pecas") or 0), round(float(r.get("valor") or 0), 2), base),
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


def _estoque_pa_lojas(empresas: Optional[str]) -> float:
    """Valor do estoque PA das lojas (foto atual), das empresas filtradas
    (todas as lojas se nao houver filtro)."""
    _garantir_cache_estoque_lojas()
    lista = [e for e in _parse_empresas(empresas) if e in CCUSTOS_LOJAS]
    if empresas and not lista:
        return 0.0
    sql = f"SELECT COALESCE(SUM(valor), 0) AS total FROM fcp_balanco_estoque_lojas WHERE cd_empresa > 1"
    params: tuple = ()
    if empresas:
        sql += " AND cd_empresa = ANY(%s)"
        params = (lista,)
    return float((execute_query(sql, params) or [{"total": 0}])[0]["total"] or 0)


def _estoque_pa_fabrica(empresas: Optional[str]) -> float:
    """Estoque PA da fabrica: entra se nao ha filtro de empresas ou se a
    fabrica (empresa 1) esta entre as selecionadas."""
    if empresas and CD_EMPRESA_CACHE_FABRICA not in _parse_empresas(empresas):
        return 0.0
    _garantir_cache_estoque_lojas()
    rows = execute_query(
        f"SELECT COALESCE(SUM(valor), 0) AS total FROM fcp_balanco_estoque_lojas WHERE cd_empresa = {CD_EMPRESA_CACHE_FABRICA}", ()
    ) or [{"total": 0}]
    return float(rows[0]["total"] or 0)


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
# Imobilizado). NAO depende do filtro de empresas da tela (sao bens de CB
# Empreendimentos, Cairo Benevides e Pacifico Holding) nem do mes de
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
    if not (execute_query("SELECT 1 FROM fcp_balanco_bens LIMIT 1", ()) or []):
        valores_sql = ",".join(["(%s,%s,%s,%s,%s,%s,%s,%s)"] * len(BENS_INICIAIS))
        params = [p for b in BENS_INICIAIS for p in b]
        execute_insert(
            "INSERT INTO fcp_balanco_bens (bloco, descricao, tipo, linha_balanco, empresa, valor, saldo_devedor, referencia) "
            f"VALUES {valores_sql}",
            tuple(params),
        )


def _total_bens_por_linha() -> dict:
    """{'ANC.5': total, 'ANC.6': total} dos bens ativos."""
    _criar_tabela_bens()
    rows = execute_query(
        "SELECT linha_balanco, COALESCE(SUM(valor), 0) AS total FROM fcp_balanco_bens WHERE ativo GROUP BY linha_balanco", ()
    ) or []
    return {r["linha_balanco"]: float(r["total"]) for r in rows}


@router.get("/api/balanco-patrimonial/indicadores-dre")
def get_indicadores_dre(mesReferencia: str = Query(..., description="Mes de referencia YYYY-MM")):
    """Lucro liquido (conta 14) e EBITDA (conta 09) da DRE consolidada nos 12
    meses que terminam no mes de referencia, lidos do mesmo cache da tela de
    DRE. Alimenta ROE e Divida liquida / EBITDA."""
    try:
        from routers import dre as dre_mod
        ano, mes = (int(x) for x in mesReferencia.split("-"))
        if not 1 <= mes <= 12:
            raise ValueError
    except ValueError:
        raise HTTPException(status_code=400, detail="mesReferencia deve ser YYYY-MM")
    try:
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

        return {"inicio": ini, "fim": fim, "lucroLiquido12m": soma_12m("14"), "ebitda12m": soma_12m("09")}
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
    cartoes), Estoques e Bens, e no Passivo Fornecedores (PC.1 ate 12 meses e PNC.7 depois), Salarios (PC.4), Tributos (PC.5 ate 12 meses e PNC.9 depois), IR e CSLL (PC.6 ate 12 meses e PNC.10 depois), Materia-prima (PC.2) e Emprestimos (PC.3 ate 12 meses e PNC.8 depois). As
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
            return {"AC.1": _obter_saldos_bancarios(somente_hoje=False)["total"]}

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
            lojas, fabrica, mp = _estoque_pa_lojas(empresas), _estoque_pa_fabrica(empresas), _estoque_mp_fabrica(empresas)
            return {"AC.3": lojas + fabrica + mp, "AC.3.1": lojas, "AC.3.2": fabrica, "AC.3.3": mp}

        # ANC.5 Investimentos e ANC.6 Imobilizado = bens cadastrados (fixos).
        def _bens():
            return _total_bens_por_linha()

        # Emprestimos = principal (despesaitem 114) + juros (137) em aberto (nada
        # pago), sem filtro de empresa, igual a consulta passada pelo usuario.
        # PC.3 = vence em ate 12 meses (de hoje); PNC.8 = vence depois disso.
        # .1 = principal e .2 = juros (aberturas so de exibicao). Passivo = negativo.
        def _emprestimos():
            rows = execute_query(
                """SELECT cd_despesaitem::text AS item,
                          COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                          COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN ('114', '137')
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = '0'
                   GROUP BY 1""", ()
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
        # nada pago), sem filtro de empresa e sem separacao por prazo.
        def _materia_prima():
            rows = execute_query(
                """SELECT COALESCE(SUM(vl_rateio), 0) AS total
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = 0""", (DESPESAITENS_MATERIA_PRIMA,)
            ) or []
            return {"PC.2": -float(rows[0]["total"]) if rows else 0.0}

        # PC.1 = fornecedores e alugueis a pagar que vencem em ate 12 meses (de
        # hoje); PNC.7 = os que vencem depois disso. Em aberto, nada pago, sem
        # filtro de empresa.
        def _fornecedores():
            rows = execute_query(
                """SELECT
                       COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                       COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = 0""", (DESPESAITENS_FORNECEDORES,)
            ) or []
            r = rows[0] if rows else {"ate_12m": 0, "apos_12m": 0}
            return {"PC.1": -float(r["ate_12m"]), "PNC.7": -float(r["apos_12m"])}

        # PC.5 = tributos a recolher que vencem em ate 12 meses (de hoje); PNC.9 =
        # os que vencem depois disso. Em aberto, nada pago, sem filtro de empresa.
        def _tributos():
            rows = execute_query(
                """SELECT
                       COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                       COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = 0""", (DESPESAITENS_TRIBUTOS,)
            ) or []
            r = rows[0] if rows else {"ate_12m": 0, "apos_12m": 0}
            return {"PC.5": -float(r["ate_12m"]), "PNC.9": -float(r["apos_12m"])}

        # PC.6 = IR e CSLL que vencem em ate 12 meses (de hoje); PNC.10 = os que
        # vencem depois disso. Em aberto, nada pago, sem filtro de empresa.
        def _ir_csll():
            rows = execute_query(
                """SELECT
                       COALESCE(SUM(CASE WHEN dt_vencimento < CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS ate_12m,
                       COALESCE(SUM(CASE WHEN dt_vencimento >= CURRENT_DATE + INTERVAL '12 months' THEN vl_rateio END), 0) AS apos_12m
                   FROM public.vr_fcp_despduplicatai
                   WHERE cd_despesaitem IN %s
                     AND dt_vencimento >= CURRENT_DATE
                     AND tp_situacao = 'N'
                     AND vl_pago = 0""", (DESPESAITENS_IR_CSLL,)
            ) or []
            r = rows[0] if rows else {"ate_12m": 0, "apos_12m": 0}
            return {"PC.6": -float(r["ate_12m"]), "PNC.10": -float(r["apos_12m"])}

        # PC.4 Salarios e encargos a pagar = custo_total da competencia mais
        # recente de fato_custo_mensal. Passivo = negativo.
        def _salarios():
            rows = execute_query(
                "SELECT competencia, custo_total FROM fato_custo_mensal ORDER BY competencia DESC LIMIT 1", ()
            ) or []
            return {"PC.4": -float(rows[0]["custo_total"] or 0) if rows else 0.0}

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
