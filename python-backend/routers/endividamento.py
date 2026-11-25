"""
Gestao do endividamento (PWR - Endividamento): modelagem de cada contrato de emprestimo pelo
sistema SAC ou PRICE (mesmas formulas das abas "M07 - Modelo - SAC" e "M07 - Modelo - PRICE") e
o consolidado "Painel Divida Geral" (saldo, custo ponderado e despesa financeira mes a mes).

Os contratos nascem dos titulos de emprestimo do banco (despesa 114 = principal; 137 = juros),
agrupados por fornecedor + numero da duplicata; a taxa e a modalidade sao calibradas pelos proprios
titulos e podem ser corrigidas/confirmadas na tela (cadastro em fcp_endividamento_contratos).
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from datetime import date, timedelta
import calendar
import json
import time
import urllib.request

from database import execute_query, execute_insert

router = APIRouter()

ITENS_PRINCIPAL = 114
ITENS_JUROS = (137, 115, 121, 258)


# ── Motor de calculo (formulas da planilha) ──────────────────────────────

def edate(d: date, n: int) -> date:
    """EDATE do Excel: soma n meses mantendo o dia (limitado ao fim do mes)."""
    m0 = d.month - 1 + n
    ano, mes = d.year + m0 // 12, m0 % 12 + 1
    return date(ano, mes, min(d.day, calendar.monthrange(ano, mes)[1]))


def taxa_dia(aa: float) -> float:   # =(1+E7)^(1/360)-1
    return (1 + aa) ** (1 / 360) - 1


def taxa_mes(aa: float) -> float:   # =(1+E7)^(1/12)-1
    return (1 + aa) ** (1 / 12) - 1


def cronograma_sac(valor: float, taxa_aa: float, prazo: int, dt_liberacao: date, carencia: int = 0,
                   per_juros_carencia: int = 3, base_juros: str = "mensal") -> List[dict]:
    """Aba 'Modelo - SAC'. Na carencia: juros = saldo x taxa dia x dias (simples), pagos a cada
    `per_juros_carencia` meses e sem amortizar. Depois: amortizacao constante (valor/prazo) e
    juros = saldo x taxa mensal equivalente (base 'mensal', como a planilha) ou por dias corridos
    (base 'dias', para contratos em que o banco cobra por dia)."""
    td, tm = taxa_dia(taxa_aa), taxa_mes(taxa_aa)
    amort_const = valor / prazo if prazo else 0.0
    saldo, anterior, acumulado = valor, dt_liberacao, 0.0
    linhas = []
    total = carencia + prazo
    for k in range(1, total + 1):
        venc = edate(dt_liberacao, k)
        dias = (venc - anterior).days
        if k <= carencia:
            juros, amort = saldo * td * dias, 0.0
            acumulado += juros
            if per_juros_carencia and (k % per_juros_carencia == 0 or k == carencia):
                parcela, acumulado = acumulado, 0.0
            else:
                parcela = 0.0
        else:
            juros = saldo * tm if base_juros == "mensal" else saldo * ((1 + td) ** dias - 1)
            amort = saldo if k == total else amort_const
            parcela = amort + juros
        saldo_ini = saldo
        saldo -= amort
        linhas.append({"n": k, "vencimento": venc.isoformat(), "dias": dias, "saldoInicial": saldo_ini, "juros": juros,
                       "amortizacao": amort, "parcela": parcela, "saldoDevedor": max(saldo, 0.0), "carencia": k <= carencia})
        anterior = venc
    return linhas


def _price_final(valor, aa, prazo, dt_lib, primeiro_venc, parcela):
    td = taxa_dia(aa)
    saldo, anterior = valor, dt_lib
    for k in range(prazo):
        venc = primeiro_venc if k == 0 else edate(primeiro_venc, k)
        juros = saldo * ((1 + td) ** (venc - anterior).days - 1)
        saldo -= parcela - juros
        anterior = venc
    return saldo


def parcela_price(valor, aa, prazo, dt_lib, primeiro_venc) -> float:
    """Parcela fixa que zera o saldo na ultima parcela (a planilha recebe essa parcela digitada, do banco)."""
    lo, hi = 0.0, valor * 2
    for _ in range(80):
        meio = (lo + hi) / 2
        if _price_final(valor, aa, prazo, dt_lib, primeiro_venc, meio) > 0:
            lo = meio
        else:
            hi = meio
    return (lo + hi) / 2


def cronograma_price(valor: float, taxa_aa: float, prazo: int, dt_liberacao: date,
                     primeiro_venc: Optional[date] = None, parcela: Optional[float] = None) -> List[dict]:
    """Aba 'Modelo - PRICE': juros = saldo x ((1+taxa dia)^dias - 1) (composto equivalente),
    amortizacao = parcela - juros, parcela fixa."""
    td = taxa_dia(taxa_aa)
    primeiro = primeiro_venc or edate(dt_liberacao, 1)
    pmt = parcela if parcela else parcela_price(valor, taxa_aa, prazo, dt_liberacao, primeiro)
    saldo, anterior = valor, dt_liberacao
    linhas = []
    for k in range(1, prazo + 1):
        venc = primeiro if k == 1 else edate(primeiro, k - 1)
        dias = (venc - anterior).days
        juros = saldo * ((1 + td) ** dias - 1)
        amort = saldo if k == prazo else pmt - juros
        saldo_ini = saldo
        saldo -= amort
        linhas.append({"n": k, "vencimento": venc.isoformat(), "dias": dias, "saldoInicial": saldo_ini, "juros": juros,
                       "amortizacao": amort, "parcela": amort + juros, "saldoDevedor": max(saldo, 0.0), "carencia": False})
        anterior = venc
    return linhas


def cronograma_contrato(c: dict) -> List[dict]:
    dt_lib = c["dt_liberacao"] if isinstance(c["dt_liberacao"], date) else date.fromisoformat(str(c["dt_liberacao"])[:10])
    valor, aa = float(c["valor_liberado"]), float(c["taxa_aa"])
    prazo = int(c["prazo_meses"])
    if prazo <= 0 or valor <= 0:
        return []
    if c["modalidade"] == "PRICE":
        pv = c.get("primeiro_vencimento")
        pv = pv if (pv is None or isinstance(pv, date)) else date.fromisoformat(str(pv)[:10])
        pf = float(c["parcela_fixa"]) if c.get("parcela_fixa") else None
        return cronograma_price(valor, aa, prazo, dt_lib, pv, pf)
    return cronograma_sac(valor, aa, prazo, dt_lib, int(c.get("carencia_meses") or 0), int(c.get("per_juros_carencia") or 3),
                          c.get("base_juros") or "mensal")


# ── Calibracao a partir dos titulos do banco ─────────────────────────────

def _carregar_titulos(cd_fornecedor: int, nr_duplicata: int) -> List[dict]:
    """Parcelas do contrato (fornecedor + duplicata): principal (114) e juros (137...) por parcela."""
    rows = execute_query(
        """SELECT nr_parcela, dt_vencimento::date AS venc, cd_despesaitem AS item, SUM(vl_rateio) AS valor,
                  MAX(CASE WHEN tp_situacao = 'N' AND vl_pago = 0 THEN 1 ELSE 0 END) AS aberto,
                  SUM(CASE WHEN tp_situacao = 'N' AND vl_pago = 0 THEN vl_rateio ELSE 0 END) AS valor_aberto
           FROM public.vr_fcp_despduplicatai
           WHERE cd_fornecedor = %s AND nr_duplicata = %s AND tp_situacao <> 'C'
             AND cd_despesaitem IN (114, 137, 115, 121, 258)
           GROUP BY 1, 2, 3 ORDER BY 1, 3""", (cd_fornecedor, nr_duplicata)) or []
    por: Dict[int, dict] = {}
    for r in rows:
        p = por.setdefault(r["nr_parcela"], {"n": r["nr_parcela"], "venc": r["venc"], "principal": 0.0, "juros": 0.0, "aberto": False,
                                                 "principal_aberto": 0.0, "juros_aberto": 0.0})
        if r["item"] == ITENS_PRINCIPAL:
            p["principal"] += float(r["valor"]); p["principal_aberto"] += float(r["valor_aberto"] or 0)
        else:
            p["juros"] += float(r["valor"]); p["juros_aberto"] += float(r["valor_aberto"] or 0)
        p["aberto"] = p["aberto"] or bool(r["aberto"])
        if r["venc"] and (p["venc"] is None or r["venc"] > p["venc"]):
            p["venc"] = r["venc"]
    return [por[k] for k in sorted(por)]


def _rel_std(xs: List[float]) -> float:
    xs = [x for x in xs if x]
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5 / m if m else 0.0


def _melhor_taxa(erro_por_taxa) -> float:
    """Busca em grade + refinamento da taxa anual que minimiza o erro."""
    melhor, e_melhor = 0.01, float("inf")
    for i in range(1, 301):
        aa = i / 200  # 0,5% .. 150%
        e = erro_por_taxa(aa)
        if e < e_melhor:
            melhor, e_melhor = aa, e
    passo = 0.005
    for _ in range(30):
        for cand in (melhor - passo, melhor + passo):
            if cand > 0:
                e = erro_por_taxa(cand)
                if e < e_melhor:
                    melhor, e_melhor = cand, e
        passo /= 1.6
    return melhor


def calibrar_contrato(titulos: List[dict]) -> dict:
    """Infere modalidade, valor liberado, prazo, data de liberacao e taxa a.a. dos titulos.
    - Com juros (137) separados: principal por parcela + juros por parcela -> taxa pelo ajuste dos juros.
    - So com o 114 (parcela cheia = amortizacao + juros): ajusta SAC (P e taxa) pela serie das parcelas."""
    com_principal = [t for t in titulos if t["principal"] > 0]
    if not com_principal:
        return {}
    primeira = titulos[0]
    todas_venc = [t["venc"] for t in titulos if t["venc"]]
    dt_lib = edate(min(todas_venc), -1)
    tem_juros_separado = any(t["juros"] > 0 for t in com_principal)
    n = len(com_principal)
    if tem_juros_separado:
        valor = sum(t["principal"] for t in com_principal)
        cv_princ = _rel_std([t["principal"] for t in com_principal])
        cv_total = _rel_std([t["principal"] + t["juros"] for t in com_principal])
        modalidade = "SAC" if cv_princ <= cv_total or cv_princ < 0.03 else "PRICE"
        # juros pagos em cada parcela (com juros): saldo anterior = valor - principal ja amortizado
        # (parcelas anteriores a amortizar; as so-juros, sem principal, nao amortizam)
        seq = sorted(titulos, key=lambda t: t["venc"])
        def residuos(aa):
            """Erro relativo do juros de cada parcela (juros pago vs modelo sobre o saldo anterior)."""
            td = taxa_dia(aa); saldo = valor; ant = dt_liberacao_calc; out = []
            for t in seq:
                dias = (t["venc"] - ant).days
                modelo = saldo * ((1 + td) ** dias - 1)
                if t["juros"] > 0 and modelo > 0:
                    out.append(((t["juros"] - modelo) / t["juros"], t))
                saldo -= t["principal"]; ant = t["venc"]
            return out
        dt_liberacao_calc = dt_lib
        excluidos: set = set()
        def erro(aa):
            return sum(r ** 2 for r, t in residuos(aa) if t["n"] not in excluidos)
        aa = _melhor_taxa(erro)
        # poda de outliers (ex.: primeira parcela com juros de carencia/encargos): tira o pior ponto
        # enquanto ele concentrar a maior parte do erro, refazendo o ajuste
        for _ in range(2):
            res = [(abs(r), t) for r, t in residuos(aa) if t["n"] not in excluidos]
            if len(res) < 4:
                break
            res.sort(key=lambda x: -x[0])
            if res[0][0] ** 2 > 0.5 * sum(x[0] ** 2 for x in res):
                excluidos.add(res[0][1]["n"])
                aa = _melhor_taxa(erro)
            else:
                break
        usados = [r for r, t in residuos(aa) if t["n"] not in excluidos]
        rmse = (sum(r ** 2 for r in usados) / len(usados)) ** 0.5 if usados else None
        # parcelas so de juros antes da primeira com principal = carencia (pagamento mensal de juros)
        carencia = len([t for t in seq if t["venc"] < min(x["venc"] for x in com_principal)])
        return {"modalidade": modalidade, "base_juros": "dias", "valor_liberado": round(valor, 2), "prazo_meses": n,
                "carencia_meses": carencia, "per_juros_carencia": 1,
                "dt_liberacao": dt_lib, "taxa_aa": round(aa, 4), "parcela_fixa": None,
                "ajuste_erro": round(rmse, 4) if rmse is not None else None,
                "metodo": "principal+juros" + (f" (parcela(s) {sorted(excluidos)} fora do ajuste)" if excluidos else "")}
    # so parcela cheia: SAC com P e taxa desconhecidos
    parcelas = [(t["venc"], t["principal"]) for t in sorted(com_principal, key=lambda t: t["venc"])]
    cv = _rel_std([p for _, p in parcelas])
    def monta(aa):
        td = taxa_dia(aa); ant = dt_lib; xs = []
        for k, (v, _) in enumerate(parcelas):
            dias = (v - ant).days
            xs.append(1 / n + (1 - k / n) * ((1 + td) ** dias - 1)); ant = v
        return xs
    def erro_sac(aa):
        xs = monta(aa)
        num = sum(x * p for x, (_, p) in zip(xs, parcelas)); den = sum(x * x for x in xs)
        P = num / den if den else 0
        return sum((P * x - p) ** 2 for x, (_, p) in zip(xs, parcelas))
    if cv < 0.01:  # parcela cheia constante: PRICE (valor e taxa nao se separam so pelas parcelas)
        pmt = sum(p for _, p in parcelas) / n
        aa = 0.18
        return {"modalidade": "PRICE", "base_juros": "dias", "valor_liberado": round(pmt * n / (1 + aa * n / 12) , 2), "prazo_meses": n,
                "dt_liberacao": dt_lib, "taxa_aa": aa, "parcela_fixa": round(pmt, 2), "ajuste_erro": None, "metodo": "parcela constante (confirmar valor e taxa)"}
    aa = _melhor_taxa(erro_sac)
    xs = monta(aa)
    P = sum(x * p for x, (_, p) in zip(xs, parcelas)) / sum(x * x for x in xs)
    rmse = (erro_sac(aa) / n) ** 0.5 / (sum(p for _, p in parcelas) / n)
    return {"modalidade": "SAC", "base_juros": "dias", "valor_liberado": round(P, 2), "prazo_meses": n, "dt_liberacao": dt_lib,
            "taxa_aa": round(aa, 4), "parcela_fixa": None, "ajuste_erro": round(rmse, 4), "metodo": "parcela cheia (SAC)"}


# ── Cadastro de contratos ────────────────────────────────────────────────

class ContratoIn(BaseModel):
    nome: str
    instituicao: str = ""
    cd_fornecedor: Optional[int] = None
    nr_duplicata: Optional[int] = None
    empresa: str = ""
    natureza: str = "Empréstimo Bancário"
    operacao: str = ""
    modalidade: str = "SAC"           # SAC | PRICE
    base_juros: str = "mensal"        # mensal (como a planilha) | dias (dias corridos)
    dt_liberacao: str
    valor_liberado: float
    prazo_meses: int
    carencia_meses: int = 0
    per_juros_carencia: int = 3
    taxa_aa: float                    # fracao (0,18 = 18% a.a.)
    parcela_fixa: Optional[float] = None
    primeiro_vencimento: Optional[str] = None
    taxa_confirmada: bool = False
    observacao: str = ""


def _criar_tabelas():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_endividamento_contratos (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL,
            instituicao TEXT,
            cd_fornecedor INTEGER,
            nr_duplicata BIGINT,
            empresa TEXT,
            natureza TEXT,
            operacao TEXT,
            modalidade TEXT NOT NULL DEFAULT 'SAC',
            base_juros TEXT NOT NULL DEFAULT 'mensal',
            dt_liberacao DATE NOT NULL,
            valor_liberado NUMERIC(16, 2) NOT NULL,
            prazo_meses INTEGER NOT NULL,
            carencia_meses INTEGER NOT NULL DEFAULT 0,
            per_juros_carencia INTEGER NOT NULL DEFAULT 3,
            taxa_aa NUMERIC(10, 6) NOT NULL,
            parcela_fixa NUMERIC(16, 2),
            primeiro_vencimento DATE,
            taxa_confirmada BOOLEAN NOT NULL DEFAULT FALSE,
            origem TEXT NOT NULL DEFAULT 'manual',
            metodo_calibracao TEXT,
            ajuste_erro NUMERIC(10, 4),
            observacao TEXT,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        )""", ())
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_endividamento_config (
            chave TEXT PRIMARY KEY, valor TEXT, atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        )""", ())


def _linha_contrato(r: dict) -> dict:
    return {k: (v.isoformat() if isinstance(v, (date,)) or hasattr(v, "isoformat") else (float(v) if hasattr(v, "as_tuple") else v)) for k, v in r.items()}


def _resumo_contrato(c: dict, hoje: date) -> dict:
    cron = cronograma_contrato(c)
    pagas = [x for x in cron if date.fromisoformat(x["vencimento"]) <= hoje]
    futuras = [x for x in cron if date.fromisoformat(x["vencimento"]) > hoje]
    saldo = pagas[-1]["saldoDevedor"] if pagas else float(c["valor_liberado"])
    if not pagas and c.get("origem") == "manual" and date.fromisoformat(str(c["dt_liberacao"])[:10]) > hoje:
        saldo = 0.0
    prox = futuras[0] if futuras else None
    return {
        "saldoAtual": round(saldo, 2),
        "proximaParcela": {"vencimento": prox["vencimento"], "valor": round(prox["parcela"], 2)} if prox else None,
        "vencimentoFinal": cron[-1]["vencimento"] if cron else None,
        "jurosRestantes": round(sum(x["juros"] for x in futuras), 2),
        "parcelasRestantes": len(futuras),
        "taxaMensal": round(taxa_mes(float(c["taxa_aa"])), 6),
    }


def _titulos_abertos_contrato(c: dict) -> dict:
    if not c.get("cd_fornecedor") or not c.get("nr_duplicata"):
        return {"principal": 0.0, "juros": 0.0}
    t = _carregar_titulos(int(c["cd_fornecedor"]), int(c["nr_duplicata"]))
    return {"principal": round(sum(x["principal_aberto"] for x in t), 2), "juros": round(sum(x["juros_aberto"] for x in t), 2)}


def _invalida_painel(f):
    """Depois de alterar contratos/metas, apaga o cache do painel (cache_telas)."""
    import functools
    import cache_telas

    @functools.wraps(f)
    def _wrap(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        finally:
            cache_telas.invalidar("endividamento-painel", f.__name__)
    return _wrap


@router.get("/api/endividamento/contratos")
def listar_contratos():
    try:
        _criar_tabelas()
        hoje = date.today()
        rows = execute_query("SELECT * FROM fcp_endividamento_contratos WHERE ativo ORDER BY valor_liberado DESC", ()) or []
        saida = []
        for r in rows:
            c = _linha_contrato(r)
            saida.append({**c, **_resumo_contrato(r, hoje), "titulosAbertos": _titulos_abertos_contrato(r)})
        return {"contratos": saida}
    except Exception as e:
        print(f"[ERROR] listar contratos: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _valores_insert(c: ContratoIn) -> tuple:
    return (c.nome.strip(), c.instituicao, c.cd_fornecedor, c.nr_duplicata, c.empresa, c.natureza, c.operacao, c.modalidade,
            c.base_juros, c.dt_liberacao, c.valor_liberado, c.prazo_meses, c.carencia_meses, c.per_juros_carencia, c.taxa_aa,
            c.parcela_fixa, c.primeiro_vencimento or None, c.taxa_confirmada, c.observacao)


def _validar(c: ContratoIn):
    if not c.nome.strip():
        raise HTTPException(status_code=400, detail="Informe o nome do contrato")
    if c.modalidade not in ("SAC", "PRICE"):
        raise HTTPException(status_code=400, detail="Modalidade deve ser SAC ou PRICE")
    if c.prazo_meses <= 0 or c.valor_liberado <= 0 or c.taxa_aa < 0:
        raise HTTPException(status_code=400, detail="Valor, prazo e taxa precisam ser positivos")
    try:
        date.fromisoformat(c.dt_liberacao[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail="Data de liberacao invalida (AAAA-MM-DD)")


@router.post("/api/endividamento/contratos")
@_invalida_painel
def criar_contrato(c: ContratoIn):
    _validar(c)
    try:
        _criar_tabelas()
        rows = execute_insert(
            """INSERT INTO fcp_endividamento_contratos
               (nome, instituicao, cd_fornecedor, nr_duplicata, empresa, natureza, operacao, modalidade, base_juros, dt_liberacao,
                valor_liberado, prazo_meses, carencia_meses, per_juros_carencia, taxa_aa, parcela_fixa, primeiro_vencimento,
                taxa_confirmada, observacao, origem)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'manual') RETURNING id""", _valores_insert(c))
        return {"id": rows[0]["id"] if rows else None}
    except Exception as e:
        print(f"[ERROR] criar contrato: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/endividamento/contratos/{contrato_id}")
@_invalida_painel
def atualizar_contrato(contrato_id: int, c: ContratoIn):
    _validar(c)
    try:
        _criar_tabelas()
        execute_insert(
            """UPDATE fcp_endividamento_contratos SET nome=%s, instituicao=%s, cd_fornecedor=%s, nr_duplicata=%s, empresa=%s,
               natureza=%s, operacao=%s, modalidade=%s, base_juros=%s, dt_liberacao=%s, valor_liberado=%s, prazo_meses=%s,
               carencia_meses=%s, per_juros_carencia=%s, taxa_aa=%s, parcela_fixa=%s, primeiro_vencimento=%s,
               taxa_confirmada=%s, observacao=%s, atualizado_em=NOW() WHERE id=%s AND ativo""",
            _valores_insert(c) + (contrato_id,))
        return {"id": contrato_id}
    except Exception as e:
        print(f"[ERROR] atualizar contrato: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/endividamento/contratos/{contrato_id}")
@_invalida_painel
def excluir_contrato(contrato_id: int):
    try:
        _criar_tabelas()
        execute_insert("UPDATE fcp_endividamento_contratos SET ativo = FALSE, atualizado_em = NOW() WHERE id = %s", (contrato_id,))
        return {"id": contrato_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _totais(cron: List[dict]) -> dict:
    return {"juros": round(sum(x["juros"] for x in cron), 2), "amortizacao": round(sum(x["amortizacao"] for x in cron), 2),
            "parcelas": round(sum(x["parcela"] for x in cron), 2)}


@router.post("/api/endividamento/simular")
def simular(c: ContratoIn):
    """Recalculo ao vivo (como o 'RECALCULO SISTEMA SAC/PRICE' da planilha), sem gravar."""
    _validar(c)
    try:
        d = {**c.dict(), "dt_liberacao": c.dt_liberacao[:10]}
        cron = cronograma_contrato(d)
        return {"cronograma": cron, "totais": _totais(cron),
                "parcelaPrice": round(parcela_price(c.valor_liberado, c.taxa_aa, c.prazo_meses, date.fromisoformat(c.dt_liberacao[:10]),
                                                    date.fromisoformat(c.primeiro_vencimento[:10]) if c.primeiro_vencimento else edate(date.fromisoformat(c.dt_liberacao[:10]), 1)), 2)
                if c.modalidade == "PRICE" else None}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] simular: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/endividamento/contratos/{contrato_id}/cronograma")
def cronograma_do_contrato(contrato_id: int):
    """Cronograma modelado + o que esta lancado no contas a pagar (114/137) por parcela, para conferir."""
    try:
        _criar_tabelas()
        rows = execute_query("SELECT * FROM fcp_endividamento_contratos WHERE id = %s AND ativo", (contrato_id,)) or []
        if not rows:
            raise HTTPException(status_code=404, detail="Contrato nao encontrado")
        r = rows[0]
        cron = cronograma_contrato(r)
        lancado = []
        if r.get("cd_fornecedor") and r.get("nr_duplicata"):
            lancado = _carregar_titulos(int(r["cd_fornecedor"]), int(r["nr_duplicata"]))
        return {"contrato": _linha_contrato(r), "resumo": _resumo_contrato(r, date.today()), "cronograma": cron, "totais": _totais(cron),
                "lancado": [{"n": t["n"], "vencimento": t["venc"].isoformat() if t["venc"] else None, "principal": round(t["principal"], 2),
                             "juros": round(t["juros"], 2), "aberto": t["aberto"]} for t in lancado]}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] cronograma: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/endividamento/sincronizar")
@_invalida_painel
def sincronizar(recalibrar: bool = Query(False, description="Recalibra tambem os contratos ja importados e ainda nao confirmados")):
    """Cria (ou recalibra) contratos a partir dos titulos de emprestimo em aberto (despesa 114)."""
    try:
        _criar_tabelas()
        grupos = execute_query(
            """SELECT d.cd_fornecedor, d.nr_duplicata, MIN(d.cd_empresa) AS cd_empresa,
                      COALESCE(NULLIF(TRIM(p.nm_fantasia), ''), p.nm_pessoa, pf.nm_pessoa, 'Fornecedor ' || d.cd_fornecedor::text) AS instituicao
               FROM public.vr_fcp_despduplicatai d
               LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
               LEFT JOIN vr_pes_pesfisica pf ON pf.cd_pessoa = d.cd_fornecedor
               WHERE d.cd_despesaitem = 114 AND d.tp_situacao = 'N' AND d.vl_pago = 0 AND d.dt_vencimento >= CURRENT_DATE
               GROUP BY 1, 2, 4""", ()) or []
        criados, recalibrados, sem_ajuste = 0, 0, []
        for g in grupos:
            inst = str(g["instituicao"]).strip()
            if inst.startswith("*"):
                inst = f"Fornecedor {g['cd_fornecedor']}"
            titulos = _carregar_titulos(int(g["cd_fornecedor"]), int(g["nr_duplicata"]))
            cal = calibrar_contrato(titulos)
            if not cal:
                continue
            existente = execute_query("SELECT id, taxa_confirmada FROM fcp_endividamento_contratos WHERE cd_fornecedor=%s AND nr_duplicata=%s",
                                      (g["cd_fornecedor"], g["nr_duplicata"])) or []
            natureza = "Empréstimo Bancário" if any(k in inst.upper() for k in ("BANCO", "BNB", "FINANCEIRA", "SECURITIZADORA", "CREDIT")) else "Dívida com terceiros"
            vals = (cal["modalidade"], cal["base_juros"], cal["dt_liberacao"].isoformat(), cal["valor_liberado"], cal["prazo_meses"],
                    cal.get("carencia_meses", 0), cal.get("per_juros_carencia", 3),
                    cal["taxa_aa"], cal["parcela_fixa"], cal.get("metodo"), cal.get("ajuste_erro"))
            if existente:
                if recalibrar and not existente[0]["taxa_confirmada"]:
                    execute_insert(
                        """UPDATE fcp_endividamento_contratos SET modalidade=%s, base_juros=%s, dt_liberacao=%s, valor_liberado=%s, prazo_meses=%s,
                           carencia_meses=%s, per_juros_carencia=%s, taxa_aa=%s, parcela_fixa=%s, metodo_calibracao=%s, ajuste_erro=%s, atualizado_em=NOW() WHERE id=%s""",
                        vals + (existente[0]["id"],))
                    recalibrados += 1
                continue
            execute_insert(
                """INSERT INTO fcp_endividamento_contratos
                   (modalidade, base_juros, dt_liberacao, valor_liberado, prazo_meses, carencia_meses, per_juros_carencia, taxa_aa, parcela_fixa, metodo_calibracao, ajuste_erro,
                    nome, instituicao, cd_fornecedor, nr_duplicata, empresa, natureza, operacao, origem)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'banco')""",
                vals + (f"{inst} - {g['nr_duplicata']}", inst, g["cd_fornecedor"], g["nr_duplicata"], str(g["cd_empresa"] or ""), natureza, "Empréstimo"))
            criados += 1
            if cal.get("ajuste_erro") is None or cal["ajuste_erro"] > 0.05:
                sem_ajuste.append(f"{inst} - {g['nr_duplicata']}")
        return {"criados": criados, "recalibrados": recalibrados, "ajusteRuim": sem_ajuste}
    except Exception as e:
        print(f"[ERROR] sincronizar: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ── Selic (referencia de mercado para comparar o custo da divida) ────────
_cache_selic: Dict[str, Any] = {"valor": None, "em": 0.0}


@router.get("/api/endividamento/selic")
def selic():
    """Meta Selic a.a. (serie 432 do BCB). Cache de 6h; se o BCB falhar, devolve o ultimo valor ou indisponivel."""
    if _cache_selic["valor"] is not None and time.time() - _cache_selic["em"] < 6 * 3600:
        return _cache_selic["valor"]
    try:
        url = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json"
        with urllib.request.urlopen(url, timeout=8) as r:
            dado = json.loads(r.read().decode())[0]
        aa = float(dado["valor"]) / 100
        res = {"disponivel": True, "aa": aa, "mensal": taxa_mes(aa), "data": dado["data"], "fonte": "Meta Selic (BCB, série 432)"}
        _cache_selic.update(valor=res, em=time.time())
        return res
    except Exception as e:
        print(f"[ENDIVIDAMENTO] Selic indisponivel: {e}")
        return _cache_selic["valor"] or {"disponivel": False, "aa": None, "mensal": None, "data": None, "fonte": "Selic indisponível no momento"}


# ── Painel Divida Geral (consolidado) ────────────────────────────────────

def _config(chave: str, padrao=None):
    r = execute_query("SELECT valor FROM fcp_endividamento_config WHERE chave = %s", (chave,)) or []
    return r[0]["valor"] if r else padrao


class MetasIn(BaseModel):
    metaDivida: Optional[float] = None
    metaCustoMensal: Optional[float] = None   # fracao (0,015 = 1,5% a.m.)


@router.get("/api/endividamento/metas")
def obter_metas():
    _criar_tabelas()
    md, mc = _config("meta_divida"), _config("meta_custo_mensal")
    return {"metaDivida": float(md) if md not in (None, "") else None, "metaCustoMensal": float(mc) if mc not in (None, "") else None}


@router.put("/api/endividamento/metas")
@_invalida_painel
def salvar_metas(m: MetasIn):
    _criar_tabelas()
    for chave, v in (("meta_divida", m.metaDivida), ("meta_custo_mensal", m.metaCustoMensal)):
        execute_insert("""INSERT INTO fcp_endividamento_config (chave, valor, atualizado_em) VALUES (%s, %s, NOW())
                          ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()""", (chave, "" if v is None else str(v)))
    return obter_metas()


def _fim_do_mes(ano: int, mes: int) -> date:
    return date(ano, mes, calendar.monthrange(ano, mes)[1])


def _saldo_em(c: dict, cron: List[dict], fim: date) -> float:
    ate = [x for x in cron if date.fromisoformat(x["vencimento"]) <= fim]
    if ate:
        return ate[-1]["saldoDevedor"]
    if c.get("origem") == "manual" and date.fromisoformat(str(c["dt_liberacao"])[:10]) > fim:
        return 0.0
    return float(c["valor_liberado"])


@router.get("/api/endividamento/painel")
def painel(meses: int = Query(36, ge=1, le=120), mesDetalhe: Optional[str] = Query(None, description="YYYY-MM para o detalhe por contrato (padrao: mes atual)"),
           forcar: bool = Query(False, description="Ignora o cache e recalcula")):
    """Consolidado mes a mes (aba 'Painel Divida Geral' + 'E.1 Mes N'): saldo, custo ponderado, despesa financeira.
    Com cache em banco (cache_telas); contratos/metas alterados apagam o cache."""
    import cache_telas
    return cache_telas.obter(f"endividamento-painel|{meses}|{mesDetalhe or ''}", 10 * 60, lambda: _calcular_painel(meses, mesDetalhe), forcar=forcar)


def _calcular_painel(meses: int, mesDetalhe: Optional[str]):
    try:
        _criar_tabelas()
        hoje = date.today()
        rows = execute_query("SELECT * FROM fcp_endividamento_contratos WHERE ativo", ()) or []
        crons = {r["id"]: cronograma_contrato(r) for r in rows}
        base = hoje.replace(day=1)
        meses_lista = []
        for k in range(meses):
            d0 = edate(base, k)
            meses_lista.append((d0.year, d0.month))
        linhas, ant_desp = [], None
        detalhe_por_mes: Dict[str, List[dict]] = {}
        for k, (a, m) in enumerate(meses_lista):
            fim = _fim_do_mes(a, m)
            ini = date(a, m, 1)
            itens, tot_saldo, tot_ponder, parcelas_mes, juros_mes = [], 0.0, 0.0, 0.0, 0.0
            for r in rows:
                s = _saldo_em(r, crons[r["id"]], fim)
                tm = taxa_mes(float(r["taxa_aa"]))
                par = sum(x["parcela"] for x in crons[r["id"]] if ini <= date.fromisoformat(x["vencimento"]) <= fim)
                jur = sum(x["juros"] for x in crons[r["id"]] if ini <= date.fromisoformat(x["vencimento"]) <= fim)
                parcelas_mes += par; juros_mes += jur
                tot_saldo += s; tot_ponder += s * tm
                itens.append({"id": r["id"], "nome": r["nome"], "empresa": r["empresa"], "natureza": r["natureza"], "operacao": r["operacao"],
                              "instituicao": r["instituicao"], "modalidade": r["modalidade"], "vencimentoFinal": crons[r["id"]][-1]["vencimento"] if crons[r["id"]] else None,
                              "taxaAa": float(r["taxa_aa"]), "taxaMensal": tm, "saldo": round(s, 2), "parcela": round(par, 2), "taxaConfirmada": r["taxa_confirmada"]})
            custo_m = tot_ponder / tot_saldo if tot_saldo else 0.0
            for it in itens:
                it["ponderacao"] = it["saldo"] / tot_saldo if tot_saldo else 0.0
                it["proporcaoTaxa"] = it["ponderacao"] * it["taxaMensal"]
            desp = custo_m * tot_saldo
            chave = f"{a}-{m:02d}"
            detalhe_por_mes[chave] = itens
            linhas.append({
                "mes": chave, "n": k + 1, "saldo": round(tot_saldo, 2), "custoMensal": custo_m, "custoAnual": (1 + custo_m) ** 12 - 1,
                "despesaFinanceira": round(desp, 2), "difMesAnterior": round(desp - ant_desp, 2) if ant_desp is not None and desp else 0.0,
                "parcelas": round(parcelas_mes, 2), "jurosCronograma": round(juros_mes, 2),
            })
            ant_desp = desp
        for l in linhas:
            l["ganho12m"] = round(l["difMesAnterior"] * 12, 2)
        metas = obter_metas()
        for l in linhas:
            l["distanciaMetaDivida"] = round(l["saldo"] - metas["metaDivida"], 2) if metas["metaDivida"] is not None else None
            l["distanciaMetaCusto"] = (l["custoMensal"] - metas["metaCustoMensal"]) if metas["metaCustoMensal"] is not None else None
        anos = []
        for i in range(0, len(linhas), 12):
            bloco = linhas[i:i + 12]
            anos.append({"ano": i // 12 + 1, "mesInicial": bloco[0]["mes"], "mesFinal": bloco[-1]["mes"],
                         "saldoFinal": bloco[-1]["saldo"], "saldoMedio": round(sum(x["saldo"] for x in bloco) / len(bloco), 2),
                         "despesaFinanceira": round(sum(x["despesaFinanceira"] for x in bloco), 2),
                         "jurosCronograma": round(sum(x["jurosCronograma"] for x in bloco), 2),
                         "parcelas": round(sum(x["parcelas"] for x in bloco), 2),
                         "custoMensalMedio": (sum(x["custoMensal"] * x["saldo"] for x in bloco) / sum(x["saldo"] for x in bloco)) if sum(x["saldo"] for x in bloco) else 0.0})
        # conferencia com o balanco (titulos de principal em aberto, de hoje em diante)
        bal = execute_query(
            """SELECT COALESCE(SUM(CASE WHEN cd_despesaitem = 114 THEN vl_rateio END), 0) AS principal,
                      COALESCE(SUM(CASE WHEN cd_despesaitem IN (137, 115, 121, 258) THEN vl_rateio END), 0) AS juros
               FROM public.vr_fcp_despduplicatai
               WHERE cd_despesaitem IN (114, 137, 115, 121, 258) AND dt_vencimento >= CURRENT_DATE AND tp_situacao = 'N' AND vl_pago = 0""", ()) or [{"principal": 0, "juros": 0}]
        saldo_hoje = sum(_saldo_em(r, crons[r["id"]], hoje) for r in rows)
        mes_det = mesDetalhe if mesDetalhe in detalhe_por_mes else (linhas[0]["mes"] if linhas else None)
        return {
            "meses": linhas, "anos": anos, "metas": metas,
            "detalheMes": {"mes": mes_det, "contratos": detalhe_por_mes.get(mes_det, []) if mes_det else []},
            "conferenciaBalanco": {"principalTitulos": float(bal[0]["principal"]), "jurosTitulos": float(bal[0]["juros"]),
                                   "saldoModelo": round(saldo_hoje, 2), "diferenca": round(float(bal[0]["principal"]) - saldo_hoje, 2)},
            "qtdContratos": len(rows),
        }
    except Exception as e:
        print(f"[ERROR] painel endividamento: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
