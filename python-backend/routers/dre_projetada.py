"""
DRE projetada dos proximos 12 meses.

Base: o MESMO mes do calendario na ocorrencia FECHADA mais recente (DRE consolidada/analitica ja existente, via
dre_cache - mesma consulta e mesmo cache da tela de DRE). Cada conta folha vira:
  - receita (01.*): realizado do mes-base x (1 + crescimento da receita);
  - variavel (% da receita): percentual sobre a receita LIQUIDA do mes-base,
    aplicado na receita liquida projetada do mes (deducoes, grupo 02, usam a
    receita bruta, pois sao elas que formam a liquida);
  - fixa: realizado do mes-base, sem reajuste (inflacao e crescimento so valem para a receita).
A classificacao fixa/variavel e a da tela de DRE (plano_contas_dre_tipo_custo);
o que nao foi classificado cai no padrao de _tipo_padrao.

Cenarios prontos (inflacao = IPCA 12 meses do BCB, editavel na tela):
  pessimista: igual ao ano anterior (receita +0%)
  realista:   receita do ano anterior + inflacao
  otimista:   receita do ano anterior + inflacao + 5%
  meta:       receita com o crescimento sugerido para chegar a META_LUCRO% de lucro
As despesas fixas sempre repetem o valor do ano anterior.
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date
import json
import time
import urllib.request

import dre_cache
from database import execute_query
from routers import dre as dre_mod

router = APIRouter()

TOTALIZADORES = ("03", "05", "07", "09", "11", "14")
INFLACAO_PADRAO = 4.5
ADICIONAL_OTIMISTA = 5.0
# Projecoes manuais (sem base no ano anterior), por empresa: (conta, nome, valor
# mensal - despesa negativa, ccusto do e-commerce que ativa a linha).
CCUSTO_ECOMMERCE = "120"
LINHAS_MANUAIS = [
    {"codigo": "08.04.99", "nome": "SALARIO COMPLETO GERENTE (PROJECAO)", "valor": -13000.0},
]
# Contas do e-commerce com projecao propria no lugar da regra padrao:
# ("fixo", valor mensal - despesa negativa), ("pct_liquida", % negativo da receita liquida do mes)
# ou ("abate", valor mensal a abater da projecao padrao, sem passar de zero).
AJUSTES_ECOMMERCE = {
    "08.01.07": ("fixo", -120.0),      # TAXAS E EMOLUMENTO - CO
    "08.02.20": ("abate", 3000.0),     # MANUT DE SOFTWARE: projecao padrao (sem o Google) abatida em R$ 3.000/mes
    "08.02.18": ("fixo", 0.0),         # CORREIOS E MALOTES
    "08.10.01": ("pct_liquida", -0.1248),  # FRETES VENDAS = 12,48% da receita liquida
    "10.03.02": ("fixo", 0.0),         # IOF
    "08.03.02": ("fixo", -200.0),      # MANUTENCAO EDIFICACOES
}
# Despesas de um fornecedor do e-commerce que, na base, saem de uma conta e vao
# para outra (so na projecao; o "ano anterior" continua como realizado).
# (conta de origem, conta de destino, trecho do nome do fornecedor)
MOVER_FORNECEDOR_ECOMMERCE = ("08.02.20", "08.05.02", "GOOGLE BRASIL INTERNET")
_cache_mover = {}  # periodo -> (timestamp, valor)
TTL_MOVER = 1800


def _valor_fornecedor_mes(periodo):
    """Soma (positiva) das duplicatas do e-commerce (120) na conta de origem,
    do fornecedor indicado, no mes (mesmo criterio da DRE: dt_emissao)."""
    agora = time.time()
    c = _cache_mover.get(periodo)
    if c and agora - c[0] < TTL_MOVER:
        return c[1]
    origem, _, nome = MOVER_FORNECEDOR_ECOMMERCE
    r = dre_mod._buscar_duplicatas_unificada(origem, periodo, CCUSTO_ECOMMERCE, campo_data_despesa="dt_emissao")
    v = sum(float(d.get("valor") or 0) for d in (r.get("duplicatas") or []) if nome in (d.get("nmFornecedor") or "").upper())
    _cache_mover[periodo] = (agora, v)
    return v


META_LUCRO = 10.0  # % de lucro liquido sobre a receita liquida do cenario "meta"

_cache_ipca = {"valor": None, "em": 0.0}


def _ipca_12m() -> dict:
    """IPCA acumulado em 12 meses (serie 13522 do BCB). Falhou: padrao."""
    if _cache_ipca["valor"] is not None and time.time() - _cache_ipca["em"] < 6 * 3600:
        return _cache_ipca["valor"]
    try:
        url = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.13522/dados/ultimos/1?formato=json"
        with urllib.request.urlopen(url, timeout=8) as r:
            dado = json.loads(r.read().decode())[0]
        res = {"valor": float(dado["valor"]), "data": dado["data"], "fonte": "IPCA 12 meses (BCB)"}
        _cache_ipca.update(valor=res, em=time.time())
        return res
    except Exception as e:
        print(f"[DRE-PROJETADA] IPCA indisponivel, usando padrao: {e}")
        return {"valor": INFLACAO_PADRAO, "data": None, "fonte": "padrão (IPCA indisponível)"}


def _tipo_padrao(codigo: str) -> str:
    """Classificacao inicial: receita (01), deducoes/impostos (02), custos
    diretos (04) variam com a receita; o resto e fixo."""
    if codigo.startswith("01"):
        return "receita"
    if codigo.startswith(("02", "04")):
        return "variavel"
    return "fixa"


def _classificacoes() -> dict:
    """Fixo/variavel ja definido na tela de DRE (plano_contas_dre_tipo_custo,
    por grupo - ex: 08.01 fixo, 08.05 variavel)."""
    try:
        rows = execute_query("SELECT codigo, tipo FROM plano_contas_dre_tipo_custo") or []
    except Exception as e:
        print(f"[DRE-PROJETADA] Classificacao fixo/variavel indisponivel: {e}")
        rows = []
    return {r["codigo"]: ("variavel" if r["tipo"] == "variavel" else "fixa") for r in rows}


def _tipo_da_conta(codigo: str, classif: dict) -> str:
    """A propria conta ou o grupo mais proximo classificado; senao o padrao."""
    partes = codigo.split(".")
    for n in range(len(partes), 0, -1):
        tipo = classif.get(".".join(partes[:n]))
        if tipo:
            return tipo
    return _tipo_padrao(codigo)


def _soma_meses(ano: int, mes: int, n: int):
    idx = ano * 12 + (mes - 1) + n
    return idx // 12, idx % 12 + 1


def _crescimento_meta(inicio, inflacao, filtro, meta, ctx=None, sem_gerente=False):
    """Crescimento da receita para atingir `meta`% de lucro liquido. Com fixas
    constantes e variaveis proporcionais a receita, receita liquida e lucro sao
    lineares no crescimento g; basta avaliar em g=0 e g=100 e resolver
    lucro(g) = meta% x receita(g). gEfetivo = crescimento total sobre o ano
    anterior (nunca abaixo da inflacao); necessario = o que falta DEPOIS da
    inflacao. Sem solucao so com venda: tudo None."""
    def pontos(g):
        r = _projetar(inicio, "personalizado", inflacao, g, filtro, False, ctx, sem_gerente=sem_gerente)
        return (float((r["projetado"].get("03") or {}).get("total", 0) or 0),
                float((r["projetado"].get("14") or {}).get("total", 0) or 0),
                r["parametros"]["inflacao"])
    r0, l0, infl_uso = pontos(0.0)
    r1, l1, _ = pontos(100.0)
    m = meta / 100
    den = (l1 - l0) - m * (r1 - r0)  # variacao do (lucro - meta x receita) a cada +100%
    if r0 > 0 and l0 >= m * r0:
        g_total = 0.0
    elif den > 0:
        g_total = 100.0 * (m * r0 - l0) / den
    else:
        return {"necessario": None, "receitaNecessaria": None, "gEfetivo": None}
    # o crescimento pedido vem DEPOIS da inflacao: (1+inflacao) x (1+x) = 1+g_total
    g_efetivo = max(g_total, infl_uso)  # a inflacao ja esta na receita projetada
    return {
        "necessario": max(0.0, ((1 + g_total / 100) / (1 + infl_uso / 100) - 1) * 100),
        "receitaNecessaria": r0 + (r1 - r0) * g_efetivo / 100,
        "gEfetivo": g_efetivo,
    }


@router.get("/api/dre-projetada")
def dre_projetada(
    inicio: Optional[str] = Query(None, description="Primeiro mes projetado YYYY-MM (default: proximo mes)"),
    cenario: str = Query("realista", description="pessimista | realista | otimista | meta | equilibrio (meta 0% de lucro) | personalizado"),
    inflacao: Optional[float] = Query(None, description="% de inflacao da RECEITA (default: IPCA 12m); fixas nao tem reajuste"),
    crescimentoReceita: Optional[float] = Query(None, description="% de crescimento da receita (so no cenario personalizado)"),
    filtro: str = Query("consolidado"),
    forcar: bool = Query(False),
    semGerente: bool = Query(False, description="Desconsidera a linha manual do salario completo do gerente (e-commerce)"),
):
    return _projetar(inicio, cenario, inflacao, crescimentoReceita, filtro, forcar, None, sem_gerente=semGerente)


def _projetar(inicio, cenario, inflacao, crescimentoReceita, filtro, forcar, ctx, ajustes=True, sem_gerente=False):
    """ctx (opcional): dict que guarda a base (cache da DRE) e a classificacao
    entre varias projecoes da mesma empresa - o resumo roda 6 por empresa e
    cada leitura do cache e uma ida ao banco."""
    try:
        hoje = date.today()
        ano, mes = (int(x) for x in inicio.split("-")) if inicio else _soma_meses(hoje.year, hoje.month, 1)
        if not 1 <= mes <= 12:
            raise HTTPException(status_code=400, detail="inicio deve ser YYYY-MM")
        ipca = _ipca_12m()
        infl = ipca["valor"] if inflacao is None else inflacao

        infl_fixas = 0.0  # fixas repetem o ano anterior; inflacao/crescimento so na receita
        if cenario == "pessimista":
            g_rec = 0.0
        elif cenario == "realista":
            g_rec = infl
        elif cenario == "otimista":
            g_rec = infl + ADICIONAL_OTIMISTA
        elif cenario == "personalizado":
            g_rec = infl if crescimentoReceita is None else crescimentoReceita
        elif cenario in ("meta", "equilibrio"):
            alvo = _crescimento_meta(inicio, inflacao, filtro, META_LUCRO if cenario == "meta" else 0.0, ctx, sem_gerente)
            g_rec = alvo["gEfetivo"] if alvo["gEfetivo"] is not None else infl  # sem solucao: so inflacao
        else:
            raise HTTPException(status_code=400, detail="cenario invalido")

        # 12 meses projetados; a base de cada um e o mesmo mes do calendario na
        # ocorrencia FECHADA mais recente (nunca o mes corrente/futuro, que esta
        # parcial). Hoje (nov/26): dez/26..out/27 usam dez/25..out/26 e nov/27 usa nov/25.
        primeiro_mes_aberto = (hoje.year, hoje.month)
        proj, base = [], []
        for n in range(12):
            a, m = _soma_meses(ano, mes, n)
            proj.append(f"{a}-{m:02d}")
            ab = a - 1
            while (ab, m) >= primeiro_mes_aberto:
                ab -= 1
            base.append(f"{ab}-{m:02d}")
        base_ord = sorted(base)
        ini_base = f"{base_ord[0]}-01"
        a_fim, m_fim = (int(x) for x in base_ord[-1].split("-"))
        a_fim, m_fim = _soma_meses(a_fim, m_fim, 1)  # primeiro dia do mes seguinte ao ultimo mes-base
        ult = date(a_fim, m_fim, 1).toordinal() - 1
        fim_base = date.fromordinal(ult).isoformat()

        chave_base = (ini_base, fim_base, filtro)
        if ctx is not None and chave_base in ctx:
            dados = ctx[chave_base]
        else:
            dados = dre_cache.obter(
                "analitica", ini_base, fim_base, filtro, forcar,
                lambda: dre_mod._calcular_valores_unificada(ini_base, fim_base, filtro, campo_data_despesa="dt_emissao"),
            )
            if ctx is not None:
                ctx[chave_base] = dados
        valores = dados.get("valores") or {}

        codigos = set(valores.keys())
        folhas = [
            c for c in codigos
            if c not in TOTALIZADORES and c not in ("NAO_CLASSIFICADO", "EXCLUIDO")
            and not any(o != c and o.startswith(c + ".") for o in codigos)
        ]
        if ctx is not None and "classif" in ctx:
            classif = ctx["classif"]
        else:
            classif = _classificacoes()
            if ctx is not None:
                ctx["classif"] = classif

        def val(codigo, periodo):
            return float((valores.get(codigo) or {}).get(periodo, 0) or 0)

        # Base da projecao: no e-commerce (filtro 120, consolidado ou lojas com ele),
        # a parcela do fornecedor sai da conta de origem e entra na de destino.
        mover = {}
        partes_f = [x.strip() for x in filtro.split(",")]
        if ajustes and (filtro == "consolidado" or CCUSTO_ECOMMERCE in partes_f):
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=6) as pool:
                mover = dict(zip(base, pool.map(_valor_fornecedor_mes, base)))
        org, dst, _n = MOVER_FORNECEDOR_ECOMMERCE
        if any(mover.values()) and dst not in folhas:
            folhas.append(dst)

        def val_proj(codigo, periodo):
            v = val(codigo, periodo)
            m = mover.get(periodo, 0.0)
            if not m:
                return v
            if codigo == org or codigo.startswith(org + "."):
                return v + m  # despesa e negativa: tirar o valor da origem
            if codigo == dst:
                return v - m
            return v

        receita_base = {p: val("01", p) for p in base}
        receita_proj = {pj: receita_base[pb] * (1 + g_rec / 100) for pj, pb in zip(proj, base)}

        projetado = {}
        tipos = {}

        def projetar(c, base_pct, proj_pct):
            tipo = _tipo_da_conta(c, classif) if not c.startswith("01") else "receita"
            tipos[c] = tipo
            linha = {"total": 0.0}
            for pj, pb in zip(proj, base):
                b = val_proj(c, pb)
                if tipo == "receita":
                    v = b * (1 + g_rec / 100)
                elif tipo == "variavel":
                    # % sobre a receita do mes-base, aplicado na receita projetada do mes
                    pct = (b / base_pct[pb]) if base_pct[pb] else 0
                    v = pct * proj_pct[pj]
                else:
                    v = b * (1 + infl_fixas / 100)
                linha[pj] = v
                linha["total"] += v
            projetado[c] = linha

        # 1) receita bruta e deducoes (02): variaveis sobre a receita BRUTA (sao
        #    elas que formam a liquida, entao nao podem depender dela)
        for c in folhas:
            if c.startswith(("01", "02")):
                projetar(c, receita_base, receita_proj)
        liquida_proj = {
            pj: sum(projetado[c][pj] for c in folhas if c.startswith(("01", "02")))
            for pj in proj
        }
        liquida_base = {pb: val("03", pb) for pb in base}
        # 2) demais contas: variaveis sobre a receita LIQUIDA
        for c in folhas:
            if not c.startswith(("01", "02")):
                projetar(c, liquida_base, liquida_proj)

        # Ajustes do e-commerce. Filtro so 120: substitui a conta. Consolidado ou
        # varias lojas com o 120: soma a diferenca (ajuste - projecao padrao do
        # e-commerce), calculada com o mesmo crescimento de receita.
        def _valor_ajuste(regra, liquida, padrao=0.0):
            if regra[0] == "fixo":
                return regra[1]
            if regra[0] == "abate":
                return min(padrao + regra[1], 0.0)
            return regra[1] * liquida

        partes = [x.strip() for x in filtro.split(",")]
        if ajustes and partes == [CCUSTO_ECOMMERCE]:
            for cod, regra in AJUSTES_ECOMMERCE.items():
                v = {pj: _valor_ajuste(regra, liquida_proj[pj], float((projetado.get(cod) or {}).get(pj, 0) or 0)) for pj in proj}
                projetado[cod] = {**v, "total": sum(v.values())}
                tipos[cod] = "manual"
        elif ajustes and (filtro == "consolidado" or CCUSTO_ECOMMERCE in partes):
            eco = _projetar(inicio, "personalizado", inflacao, g_rec, CCUSTO_ECOMMERCE, False, ctx, ajustes=False, sem_gerente=sem_gerente)["projetado"]
            for cod, regra in AJUSTES_ECOMMERCE.items():
                atual = projetado.get(cod) or {}
                padrao = eco.get(cod) or {}
                v = {pj: float(atual.get(pj, 0) or 0)
                     + _valor_ajuste(regra, float((eco.get("03") or {}).get(pj, 0) or 0), float(padrao.get(pj, 0) or 0))
                     - float(padrao.get(pj, 0) or 0) for pj in proj}
                projetado[cod] = {**v, "total": sum(v.values())}
                tipos[cod] = "manual"

        # Linhas manuais: so no e-commerce (filtro 120) e no consolidado, que o inclui
        manuais = []
        if filtro == "consolidado" or CCUSTO_ECOMMERCE in [x.strip() for x in filtro.split(",")]:
            for lm in ([] if sem_gerente else LINHAS_MANUAIS):
                projetado[lm["codigo"]] = {**{pj: lm["valor"] for pj in proj}, "total": lm["valor"] * len(proj)}
                tipos[lm["codigo"]] = "manual"
                manuais.append({"codigo": lm["codigo"], "nome": lm["nome"]})

        projetado = dre_mod._somar_hierarquia(projetado, proj)
        projetado = dre_mod._calcular_totalizadores(projetado, proj)

        # Base reindexada pelos meses projetados (coluna "ano anterior")
        base_reindex = {}
        for c in set(projetado.keys()) | set(valores.keys()):
            if c in ("NAO_CLASSIFICADO", "EXCLUIDO"):
                continue
            linha = {"total": 0.0}
            for pj, pb in zip(proj, base):
                linha[pj] = val(c, pb)
                linha["total"] += linha[pj]
            base_reindex[c] = linha

        return {
            "periodos": [{"key": pj, "label": f"{pj.split('-')[1]}/{pj.split('-')[0][2:]}", "base": pb} for pj, pb in zip(proj, base)],
            "projetado": projetado,
            "anoAnterior": base_reindex,
            "tipos": tipos,
            "manuais": manuais,
            "parametros": {
                "cenario": cenario, "inflacao": infl, "inflacaoFixas": infl_fixas, "crescimentoReceita": g_rec,
                "adicionalOtimista": ADICIONAL_OTIMISTA, "ipca": ipca, "filtro": filtro,
                "baseInicio": ini_base, "baseFim": fim_base,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro na DRE projetada: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao montar a DRE projetada: {str(e)}")


@router.get("/api/dre-projetada/resumo")
def resumo(
    inicio: Optional[str] = Query(None),
    inflacao: Optional[float] = Query(None),
    crescimentoReceita: Optional[float] = Query(None, description="Se informado, inclui o cenario personalizado"),
    filtro: str = Query("consolidado"),
    meta: float = Query(META_LUCRO, description="% de lucro liquido desejado sobre a receita liquida"),
    forcar: bool = Query(False),
    semGerente: bool = Query(False, description="Desconsidera a linha manual do salario completo do gerente (e-commerce)"),
):
    """Receita liquida e lucro liquido (conta 14) projetados nos 12 meses, em
    cada cenario, para UM filtro (empresa). A base do ano anterior vem do
    cache, entao so o primeiro cenario consulta o banco."""
    cenarios = ["pessimista", "realista", "otimista"] + (["personalizado"] if crescimentoReceita is not None else [])
    ctx = {}
    saida, ano_anterior, periodo = {}, None, None
    for i, cen in enumerate(cenarios):
        r = _projetar(inicio, cen, inflacao, crescimentoReceita, filtro, forcar and i == 0, ctx, sem_gerente=semGerente)
        def tot(d, c):
            return float((d.get(c) or {}).get("total", 0) or 0)
        rec, luc = tot(r["projetado"], "03"), tot(r["projetado"], "14")
        saida[cen] = {"receitaLiquida": rec, "lucro": luc, "percentual": (luc / rec * 100) if rec else None}
        if ano_anterior is None:
            rec_a, luc_a = tot(r["anoAnterior"], "03"), tot(r["anoAnterior"], "14")
            ano_anterior = {"receitaLiquida": rec_a, "lucro": luc_a, "percentual": (luc_a / rec_a * 100) if rec_a else None}

    alvo = _crescimento_meta(inicio, inflacao, filtro, meta, ctx, semGerente)
    if alvo["gEfetivo"] is not None:
        r = _projetar(inicio, "personalizado", inflacao, alvo["gEfetivo"], filtro, False, ctx, sem_gerente=semGerente)
        rec, luc = float((r["projetado"].get("03") or {}).get("total", 0) or 0), float((r["projetado"].get("14") or {}).get("total", 0) or 0)
        saida["meta"] = {"receitaLiquida": rec, "lucro": luc, "percentual": (luc / rec * 100) if rec else None}
    alvo0 = _crescimento_meta(inicio, inflacao, filtro, 0.0, ctx, semGerente)
    if alvo0["gEfetivo"] is not None:
        r = _projetar(inicio, "personalizado", inflacao, alvo0["gEfetivo"], filtro, False, ctx, sem_gerente=semGerente)
        rec, luc = float((r["projetado"].get("03") or {}).get("total", 0) or 0), float((r["projetado"].get("14") or {}).get("total", 0) or 0)
        saida["equilibrio"] = {"receitaLiquida": rec, "lucro": luc, "percentual": (luc / rec * 100) if rec else None}
    necessario, receita_necessaria = alvo["necessario"], alvo["receitaNecessaria"]
    return {"filtro": filtro, "anoAnterior": ano_anterior, "cenarios": saida, "crescimentoNecessario": necessario, "receitaNecessaria": receita_necessaria, "crescimentoNecessario0": alvo0["necessario"], "receitaNecessaria0": alvo0["receitaNecessaria"], "meta": meta}
