"""
DRE projetada dos proximos 12 meses.

Base: o MESMO mes do ano anterior (DRE consolidada/analitica ja existente, via
dre_cache - mesma consulta e mesmo cache da tela de DRE). Cada conta folha vira:
  - receita (01.*): realizado do mes-base x (1 + crescimento da receita);
  - variavel (% da receita): percentual sobre a receita LIQUIDA do mes-base,
    aplicado na receita liquida projetada do mes (deducoes, grupo 02, usam a
    receita bruta, pois sao elas que formam a liquida);
  - fixa: realizado do mes-base x (1 + inflacao).
A classificacao fixa/variavel e a da tela de DRE (plano_contas_dre_tipo_custo);
o que nao foi classificado cai no padrao de _tipo_padrao.

Cenarios prontos (inflacao = IPCA 12 meses do BCB, editavel na tela):
  pessimista: igual ao ano anterior (receita +0%, fixas +0%)
  realista:   ano anterior + inflacao (receita +inflacao, fixas +inflacao)
  otimista:   ano anterior + inflacao + 5% (receita +inflacao+5%, fixas +inflacao)
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


@router.get("/api/dre-projetada")
def dre_projetada(
    inicio: Optional[str] = Query(None, description="Primeiro mes projetado YYYY-MM (default: proximo mes)"),
    cenario: str = Query("realista", description="pessimista | realista | otimista | personalizado"),
    inflacao: Optional[float] = Query(None, description="% de inflacao aplicada as contas fixas (default: IPCA 12m)"),
    crescimentoReceita: Optional[float] = Query(None, description="% de crescimento da receita (so no cenario personalizado)"),
    filtro: str = Query("consolidado"),
    forcar: bool = Query(False),
):
    try:
        hoje = date.today()
        ano, mes = (int(x) for x in inicio.split("-")) if inicio else _soma_meses(hoje.year, hoje.month, 1)
        if not 1 <= mes <= 12:
            raise HTTPException(status_code=400, detail="inicio deve ser YYYY-MM")
        ipca = _ipca_12m()
        infl = ipca["valor"] if inflacao is None else inflacao

        if cenario == "pessimista":
            g_rec, infl_fixas = 0.0, 0.0
        elif cenario == "realista":
            g_rec, infl_fixas = infl, infl
        elif cenario == "otimista":
            g_rec, infl_fixas = infl + ADICIONAL_OTIMISTA, infl
        elif cenario == "personalizado":
            g_rec, infl_fixas = (infl if crescimentoReceita is None else crescimentoReceita), infl
        else:
            raise HTTPException(status_code=400, detail="cenario invalido")

        # 12 meses projetados e os 12 meses-base (mesmo mes, um ano antes)
        proj, base = [], []
        for n in range(12):
            a, m = _soma_meses(ano, mes, n)
            proj.append(f"{a}-{m:02d}")
            base.append(f"{a - 1}-{m:02d}")
        ini_base = f"{base[0]}-01"
        a_fim, m_fim = _soma_meses(ano - 1, mes, 12)  # primeiro dia do mes seguinte ao ultimo mes-base
        ult = date(a_fim, m_fim, 1).toordinal() - 1
        fim_base = date.fromordinal(ult).isoformat()

        dados = dre_cache.obter(
            "analitica", ini_base, fim_base, filtro, forcar,
            lambda: dre_mod._calcular_valores_unificada(ini_base, fim_base, filtro, campo_data_despesa="dt_emissao"),
        )
        valores = dados.get("valores") or {}

        codigos = set(valores.keys())
        folhas = [
            c for c in codigos
            if c not in TOTALIZADORES and c not in ("NAO_CLASSIFICADO", "EXCLUIDO")
            and not any(o != c and o.startswith(c + ".") for o in codigos)
        ]
        classif = _classificacoes()

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
