"""
DRE projetada dos proximos 12 meses.

Base: o MESMO mes do ano anterior (DRE consolidada/analitica ja existente, via
dre_cache - mesma consulta e mesmo cache da tela de DRE). Cada conta folha vira:
  - receita (01.*): realizado do mes-base x (1 + crescimento da receita);
  - variavel (% da receita): percentual sobre a receita bruta do mes-base,
    aplicado na receita projetada do mes;
  - fixa: realizado do mes-base x (1 + inflacao).
A classificacao fixa/variavel fica na tabela dre_projetada_classificacao
(o que nao foi classificado cai no padrao de _tipo_padrao).

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
from database import execute_query, execute_insert
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
    diretos (04) e comissoes/comercial de representantes (08.10) variam com a
    receita; o resto e fixo."""
    if codigo.startswith("01"):
        return "receita"
    if codigo.startswith(("02", "04", "08.10")):
        return "variavel"
    return "fixa"


def _criar_tabela():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS dre_projetada_classificacao (
            conta TEXT PRIMARY KEY,
            tipo TEXT NOT NULL,
            dt_atualizacao TIMESTAMP DEFAULT NOW()
        )
    """)


def _classificacoes() -> dict:
    _criar_tabela()
    rows = execute_query("SELECT conta, tipo FROM dre_projetada_classificacao") or []
    return {r["conta"]: r["tipo"] for r in rows}


def _soma_meses(ano: int, mes: int, n: int):
    idx = ano * 12 + (mes - 1) + n
    return idx // 12, idx % 12 + 1


@router.get("/api/dre-projetada")
def dre_projetada(
    inicio: Optional[str] = Query(None, description="Primeiro mes projetado YYYY-MM (default: mes atual)"),
    cenario: str = Query("realista", description="pessimista | realista | otimista | personalizado"),
    inflacao: Optional[float] = Query(None, description="% de inflacao aplicada as contas fixas (default: IPCA 12m)"),
    crescimentoReceita: Optional[float] = Query(None, description="% de crescimento da receita (so no cenario personalizado)"),
    filtro: str = Query("consolidado"),
    forcar: bool = Query(False),
):
    try:
        hoje = date.today()
        ano, mes = (int(x) for x in inicio.split("-")) if inicio else (hoje.year, hoje.month)
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
        for c in folhas:
            tipo = classif.get(c) or _tipo_padrao(c)
            tipos[c] = tipo
            linha = {"total": 0.0}
            for pj, pb in zip(proj, base):
                b = val(c, pb)
                if tipo == "receita":
                    v = b * (1 + g_rec / 100)
                elif tipo == "variavel":
                    pct = (b / receita_base[pb]) if receita_base[pb] else 0
                    v = pct * receita_proj[pj]
                else:
                    v = b * (1 + infl_fixas / 100)
                linha[pj] = v
                linha["total"] += v
            projetado[c] = linha

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


@router.post("/api/dre-projetada/classificacao")
def salvar_classificacao(data: dict):
    conta = str(data.get("conta") or "").strip()
    tipo = str(data.get("tipo") or "").strip()
    if not conta or tipo not in ("fixa", "variavel"):
        raise HTTPException(status_code=400, detail="conta e tipo (fixa | variavel) obrigatorios")
    try:
        _criar_tabela()
        execute_insert(
            """INSERT INTO dre_projetada_classificacao (conta, tipo, dt_atualizacao) VALUES (%s, %s, NOW())
               ON CONFLICT (conta) DO UPDATE SET tipo = EXCLUDED.tipo, dt_atualizacao = NOW()""",
            (conta, tipo),
        )
        return {"ok": True}
    except Exception as e:
        print(f"[ERROR] Erro ao salvar classificacao da DRE projetada: {e}")
        raise HTTPException(status_code=500, detail="Erro ao salvar a classificação")
