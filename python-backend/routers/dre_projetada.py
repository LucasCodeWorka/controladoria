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
    "08.02.20": ("fixo", -6812.30),    # MANUT DE SOFTWARE
    "08.05.02": ("fixo", -12000.0),    # PROPAGANDAS EM MIDIAS DIGITAIS
    "08.02.18": ("fixo", 0.0),         # CORREIOS E MALOTES
    "08.10.01": ("pct_liquida", -0.1248),  # FRETES VENDAS = 12,48% da receita liquida
    "10.03.02": ("fixo", 0.0),         # IOF
    "08.03.02": ("fixo", -200.0),      # MANUTENCAO EDIFICACOES
}
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

        receita_base = {p: val("01", p) for p in base}
        receita_proj = {pj: receita_base[pb] * (1 + g_rec / 100) for pj, pb in zip(proj, base)}

        projetado = {}
        tipos = {}

        def projetar(c, base_pct, proj_pct):
            tipo = _tipo_da_conta(c, classif) if not c.startswith("01") else "receita"
            tipos[c] = tipo
            linha = {"total": 0.0}
            for pj, pb in zip(proj, base):
                b = val(c, pb)
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


# ── Realizado (para comparar com a projecao / orcamento) ─────────────────
@router.get("/api/dre-projetada/realizado")
def realizado(
    inicio: str = Query(..., description="Primeiro mes da projecao, YYYY-MM"),
    filtro: str = Query("consolidado"),
    forcar: bool = Query(False),
):
    """DRE realizada dos mesmos 12 meses da projecao (mesma consulta/cache da tela de DRE).
    So os meses FECHADOS (anteriores ao mes corrente) trazem valor; o resto vem em 'abertos'."""
    try:
        ano, mes = (int(x) for x in inicio.split("-"))
        if not 1 <= mes <= 12:
            raise ValueError
    except ValueError:
        raise HTTPException(status_code=400, detail="inicio deve ser YYYY-MM")
    try:
        hoje = date.today()
        meses = []
        for n in range(12):
            a, m = _soma_meses(ano, mes, n)
            meses.append(f"{a}-{m:02d}")
        fechados = [m for m in meses if tuple(int(x) for x in m.split("-")) < (hoje.year, hoje.month)]
        if not fechados:
            return {"periodos": meses, "fechados": [], "abertos": meses, "realizado": {}}
        a_ult, m_ult = (int(x) for x in fechados[-1].split("-"))
        a_prox, m_prox = _soma_meses(a_ult, m_ult, 1)
        ini = f"{meses[0]}-01"
        fim = date.fromordinal(date(a_prox, m_prox, 1).toordinal() - 1).isoformat()
        dados = dre_cache.obter(
            "analitica", ini, fim, filtro, forcar,
            lambda: dre_mod._calcular_valores_unificada(ini, fim, filtro, campo_data_despesa="dt_emissao"),
        )
        valores = dados.get("valores") or {}
        saida = {}
        for cod, linha in valores.items():
            if cod in ("NAO_CLASSIFICADO", "EXCLUIDO"):
                continue
            saida[cod] = {m: float((linha or {}).get(m, 0) or 0) for m in fechados}
        return {"periodos": meses, "fechados": fechados, "abertos": [m for m in meses if m not in fechados], "realizado": saida}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro no realizado da DRE projetada: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao buscar o realizado: {str(e)}")


# ── Orcamentos (cenarios da DRE projetada salvos) ────────────────────────
# O orcamento guarda os VALORES finais (ja com as edicoes de A/V %) congelados: assim ele nao muda
# quando a base do ano anterior se move, e da pra comparar com o realizado depois.
from pydantic import BaseModel
from typing import Any, Dict, List
from database import execute_insert


class OrcamentoIn(BaseModel):
    nome: str
    filtro: str = "consolidado"
    inicio: str
    cenario: str = "realista"
    parametros: Dict[str, Any] = {}
    periodos: List[Dict[str, Any]]
    valores: Dict[str, Dict[str, float]]
    anoAnterior: Dict[str, Dict[str, float]] = {}
    tipos: Dict[str, str] = {}
    manuais: List[Dict[str, Any]] = []
    qtdEdicoes: int = 0


def _criar_tabela_orcamentos():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS dre_projetada_orcamentos (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL,
            filtro TEXT NOT NULL,
            inicio TEXT NOT NULL,
            cenario TEXT,
            parametros JSONB,
            periodos JSONB NOT NULL,
            valores JSONB NOT NULL,
            ano_anterior JSONB,
            tipos JSONB,
            manuais JSONB,
            qtd_edicoes INTEGER NOT NULL DEFAULT 0,
            receita_liquida NUMERIC,
            lucro NUMERIC,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        )""", ())


def _tot(valores: dict, cod: str) -> float:
    return float(((valores or {}).get(cod) or {}).get("total", 0) or 0)


@router.get("/api/dre-projetada/orcamentos")
def listar_orcamentos():
    try:
        _criar_tabela_orcamentos()
        rows = execute_query(
            """SELECT id, nome, filtro, inicio, cenario, qtd_edicoes, receita_liquida, lucro, criado_em, atualizado_em
               FROM dre_projetada_orcamentos WHERE ativo ORDER BY atualizado_em DESC""", ()) or []
        return {"orcamentos": [{
            "id": r["id"], "nome": r["nome"], "filtro": r["filtro"], "inicio": r["inicio"], "cenario": r["cenario"],
            "qtdEdicoes": r["qtd_edicoes"], "receitaLiquida": float(r["receita_liquida"] or 0), "lucro": float(r["lucro"] or 0),
            "criadoEm": r["criado_em"].isoformat() if r["criado_em"] else None,
            "atualizadoEm": r["atualizado_em"].isoformat() if r["atualizado_em"] else None,
        } for r in rows]}
    except Exception as e:
        print(f"[ERROR] listar orcamentos: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/dre-projetada/orcamentos/{orcamento_id}")
def obter_orcamento(orcamento_id: int):
    try:
        _criar_tabela_orcamentos()
        rows = execute_query("SELECT * FROM dre_projetada_orcamentos WHERE id = %s AND ativo", (orcamento_id,)) or []
        if not rows:
            raise HTTPException(status_code=404, detail="Orcamento nao encontrado")
        r = rows[0]
        return {
            "id": r["id"], "nome": r["nome"], "filtro": r["filtro"], "inicio": r["inicio"], "cenario": r["cenario"],
            "parametros": r["parametros"] or {}, "periodos": r["periodos"], "valores": r["valores"],
            "anoAnterior": r["ano_anterior"] or {}, "tipos": r["tipos"] or {}, "manuais": r["manuais"] or [],
            "qtdEdicoes": r["qtd_edicoes"],
            "atualizadoEm": r["atualizado_em"].isoformat() if r["atualizado_em"] else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] obter orcamento: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _params_orcamento(o: OrcamentoIn) -> tuple:
    return (
        o.nome.strip(), o.filtro, o.inicio, o.cenario, json.dumps(o.parametros), json.dumps(o.periodos),
        json.dumps(o.valores), json.dumps(o.anoAnterior), json.dumps(o.tipos), json.dumps(o.manuais),
        o.qtdEdicoes, _tot(o.valores, "03"), _tot(o.valores, "14"),
    )


@router.post("/api/dre-projetada/orcamentos")
def criar_orcamento(o: OrcamentoIn):
    if not o.nome.strip():
        raise HTTPException(status_code=400, detail="Informe o nome do orcamento")
    try:
        _criar_tabela_orcamentos()
        rows = execute_insert(
            """INSERT INTO dre_projetada_orcamentos
               (nome, filtro, inicio, cenario, parametros, periodos, valores, ano_anterior, tipos, manuais, qtd_edicoes, receita_liquida, lucro)
               VALUES (%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s,%s) RETURNING id""",
            _params_orcamento(o))
        return {"id": rows[0]["id"] if rows else None}
    except Exception as e:
        print(f"[ERROR] criar orcamento: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/dre-projetada/orcamentos/{orcamento_id}")
def atualizar_orcamento(orcamento_id: int, o: OrcamentoIn):
    if not o.nome.strip():
        raise HTTPException(status_code=400, detail="Informe o nome do orcamento")
    try:
        _criar_tabela_orcamentos()
        execute_insert(
            """UPDATE dre_projetada_orcamentos SET nome=%s, filtro=%s, inicio=%s, cenario=%s, parametros=%s::jsonb,
               periodos=%s::jsonb, valores=%s::jsonb, ano_anterior=%s::jsonb, tipos=%s::jsonb, manuais=%s::jsonb,
               qtd_edicoes=%s, receita_liquida=%s, lucro=%s, atualizado_em=NOW() WHERE id=%s AND ativo""",
            _params_orcamento(o) + (orcamento_id,))
        return {"id": orcamento_id}
    except Exception as e:
        print(f"[ERROR] atualizar orcamento: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/dre-projetada/orcamentos/{orcamento_id}")
def excluir_orcamento(orcamento_id: int):
    try:
        _criar_tabela_orcamentos()
        execute_insert("UPDATE dre_projetada_orcamentos SET ativo = FALSE, atualizado_em = NOW() WHERE id = %s", (orcamento_id,))
        return {"id": orcamento_id}
    except Exception as e:
        print(f"[ERROR] excluir orcamento: {e}")
        raise HTTPException(status_code=500, detail=str(e))
