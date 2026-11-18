"""
Giro - referencias "enviadas para 70%": o usuario marca, loja a loja, no modal da tabela
"Qtd novo por loja", as referencias/cores que vai mandar para campanha de 70%. O desconto vale
pra rede toda do canal, entao a chave e referencia + cor + canal (a mesma cor marcada em duas lojas
conta uma vez so). Guarda um retrato do estoque da rede e dos precos na hora da marcacao.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional

from database import execute_query, execute_insert

router = APIRouter()


class ItemEnviado(BaseModel):
    referencia: str
    cor: Optional[str] = ""
    canal: str = "varejo"              # varejo | atacado
    nome: str = ""
    loja_origem: str = ""
    mes_referencia: str = ""
    estoque_rede: float = 0
    preco_cheio: Optional[float] = None
    preco_campanha: Optional[float] = None
    preco_70: Optional[float] = None
    pct_campanha: Optional[float] = None


class LoteEnviado(BaseModel):
    itens: List[ItemEnviado]


def _criar_tabela():
    execute_insert("""
        CREATE TABLE IF NOT EXISTS giro_enviadas_70 (
            id SERIAL PRIMARY KEY,
            referencia TEXT NOT NULL,
            cor TEXT NOT NULL DEFAULT '',
            canal TEXT NOT NULL DEFAULT 'varejo',
            nome TEXT,
            loja_origem TEXT,
            mes_referencia TEXT,
            estoque_rede NUMERIC NOT NULL DEFAULT 0,
            preco_cheio NUMERIC,
            preco_campanha NUMERIC,
            preco_70 NUMERIC,
            pct_campanha NUMERIC,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE (referencia, cor, canal)
        )""", ())


@router.get("/api/giro/enviadas-70")
def listar():
    try:
        _criar_tabela()
        rows = execute_query(
            """SELECT id, referencia, cor, canal, nome, loja_origem, mes_referencia, estoque_rede, preco_cheio, preco_campanha,
                      preco_70, pct_campanha, criado_em, atualizado_em
               FROM giro_enviadas_70 ORDER BY criado_em DESC, id DESC""", ()) or []
        itens = []
        for r in rows:
            pc, p70, est = r["preco_campanha"], r["preco_70"], float(r["estoque_rede"] or 0)
            dif = (float(pc) - float(p70)) if pc is not None and p70 is not None else None
            itens.append({
                "id": r["id"], "referencia": r["referencia"], "cor": r["cor"], "canal": r["canal"], "nome": r["nome"],
                "lojaOrigem": r["loja_origem"], "mesReferencia": r["mes_referencia"], "estoqueRede": est,
                "precoCheio": float(r["preco_cheio"]) if r["preco_cheio"] is not None else None,
                "precoCampanha": float(pc) if pc is not None else None, "preco70": float(p70) if p70 is not None else None,
                "pctCampanha": float(r["pct_campanha"]) if r["pct_campanha"] is not None else None,
                "difPeca": dif, "impacto": dif * est if dif is not None else None,
                "criadoEm": r["criado_em"].isoformat() if r["criado_em"] else None,
            })
        return {"itens": itens}
    except Exception as e:
        print(f"[ERROR] enviadas-70 listar: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/giro/enviadas-70")
def marcar(lote: LoteEnviado):
    """Marca (ou atualiza o retrato de) varias referencias/cores de uma vez."""
    try:
        _criar_tabela()
        for i in lote.itens:
            execute_insert(
                """INSERT INTO giro_enviadas_70
                   (referencia, cor, canal, nome, loja_origem, mes_referencia, estoque_rede, preco_cheio, preco_campanha, preco_70, pct_campanha)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (referencia, cor, canal) DO UPDATE SET nome = EXCLUDED.nome, mes_referencia = EXCLUDED.mes_referencia,
                     estoque_rede = EXCLUDED.estoque_rede, preco_cheio = EXCLUDED.preco_cheio, preco_campanha = EXCLUDED.preco_campanha,
                     preco_70 = EXCLUDED.preco_70, pct_campanha = EXCLUDED.pct_campanha, atualizado_em = NOW()""",
                (i.referencia, i.cor or "", i.canal, i.nome, i.loja_origem, i.mes_referencia, i.estoque_rede, i.preco_cheio,
                 i.preco_campanha, i.preco_70, i.pct_campanha))
        return {"marcados": len(lote.itens)}
    except Exception as e:
        print(f"[ERROR] enviadas-70 marcar: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/giro/enviadas-70")
def desmarcar(
    referencia: Optional[str] = Query(None), cor: Optional[str] = Query(""), canal: str = Query("varejo"),
    todas: bool = Query(False, description="true = limpa a lista inteira"),
):
    try:
        _criar_tabela()
        if todas:
            execute_insert("DELETE FROM giro_enviadas_70", ())
        elif referencia:
            execute_insert("DELETE FROM giro_enviadas_70 WHERE referencia = %s AND cor = %s AND canal = %s", (referencia, cor or "", canal))
        else:
            raise HTTPException(status_code=400, detail="Informe referencia/cor/canal ou todas=true")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] enviadas-70 desmarcar: {e}")
        raise HTTPException(status_code=500, detail=str(e))
