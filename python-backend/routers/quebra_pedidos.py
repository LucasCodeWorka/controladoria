"""
Quebra de Pedidos - cancelamentos de itens de pedido da fabrica, abertos por
motivo, por data e consolidados, com o percentual sobre o faturamento da
fabrica no periodo.

Mesma base do indicador "Quebra de Pedidos" (routers/indicadores.py):
 - vr_ped_pedidoicanc2: so o ULTIMO cancelamento de cada pedido+produto no
   periodo (ROW_NUMBER por dt_cadastro desc), pela data do cancelamento;
 - ligado a vr_ped_pedidoi (item do pedido), so operacoes 52 e 1;
 - valor = vl_unitario x qt_cancelada do item.
O indicador considera so o motivo 6 (QUEBRA DE PEDIDOS); aqui entram todos os
motivos, e o motivo 6 vem marcado (ehQuebra) - o total dele bate com o card do
indicador. Faturamento da fabrica = mesmo calculo do indicador (empresa 1,
situacao 4, sem representantes e operacoes excluidos).
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import date, timedelta
from database import execute_query
from routers.indicadores import OPERACOES_EXCLUIDAS, REPRESENTANTES_EXCLUIDOS

router = APIRouter()

MOTIVO_QUEBRA = 6


def _parse_data(valor: Optional[str], padrao: date) -> date:
    if not valor:
        return padrao
    try:
        return date.fromisoformat(valor)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Data invalida: {valor} (use AAAA-MM-DD)")


def _pct(parte: float, total: float) -> Optional[float]:
    return round(parte / total * 100, 2) if total else None


@router.get("/api/quebra-pedidos")
def quebra_pedidos(
    dataInicio: Optional[str] = Query(None, description="Data inicial AAAA-MM-DD (default: 1o dia do mes atual)"),
    dataFim: Optional[str] = Query(None, description="Data final AAAA-MM-DD, inclusive (default: hoje)"),
    somenteQuebra: bool = Query(False, description="true = so o motivo 6 (QUEBRA DE PEDIDOS), igual ao indicador"),
):
    try:
        hoje = date.today()
        ini = _parse_data(dataInicio, hoje.replace(day=1))
        fim = _parse_data(dataFim, hoje)
        if fim < ini:
            raise HTTPException(status_code=400, detail="dataFim anterior a dataInicio")
        fim_exclusivo = fim + timedelta(days=1)
        ops_fab = ", ".join(str(o) for o in OPERACOES_EXCLUIDAS)
        reps_excl = ", ".join(str(r) for r in REPRESENTANTES_EXCLUIDOS)
        filtro_motivo = f"AND u.cd_motivocanc = {MOTIVO_QUEBRA}" if somenteQuebra else ""

        itens = execute_query(
            f"""
            WITH ult AS (
                SELECT a.*, ROW_NUMBER() OVER (
                    PARTITION BY a.cd_empresa, a.cd_pedido, a.cd_produto
                    ORDER BY a.dt_cadastro DESC
                ) AS rn
                FROM vr_ped_pedidoicanc2 a
                WHERE a.dt_cadastro >= %s::date AND a.dt_cadastro < %s::date
            )
            SELECT u.cd_motivocanc AS cd_motivo,
                   COALESCE(NULLIF(TRIM(u.ds_motivocanc), ''), 'Motivo ' || u.cd_motivocanc::text) AS motivo,
                   u.dt_cadastro::date AS data,
                   u.cd_pedido,
                   COALESCE(b.qt_cancelada, 0) AS qtd,
                   COALESCE(b.vl_unitario * b.qt_cancelada, 0) AS valor
            FROM ult u
            JOIN vr_ped_pedidoi b
              ON u.cd_pedido = b.cd_pedido
             AND u.cd_empresa = b.cd_empresa
             AND u.cd_produto = b.cd_produto
            WHERE u.rn = 1
              AND b.cd_operacao IN (52, 1)
              {filtro_motivo}
            """,
            (ini.isoformat(), fim_exclusivo.isoformat()),
        ) or []

        fat_rows = execute_query(
            f"""
            SELECT t.dt_transacao::date AS data,
                   COALESCE(SUM(CASE WHEN t.tp_operacao = 'S' THEN i.vl_totalliquido ELSE -i.vl_totalliquido END), 0) AS fat
            FROM vr_tra_transacao t
            LEFT JOIN vr_tra_transitem i
              ON i.cd_empresa = t.cd_empresa AND i.dt_transacao = t.dt_transacao AND i.nr_transacao = t.nr_transacao
            WHERE t.cd_empresa = 1
              AND t.tp_situacao = 4
              AND t.cd_representant IS NOT NULL
              AND t.cd_representant <> ALL (ARRAY[{reps_excl}])
              AND t.cd_operacao NOT IN ({ops_fab})
              AND t.dt_transacao >= %s::date AND t.dt_transacao < %s::date
              AND ((t.tp_modalidade IN ('4', '8') AND t.tp_operacao = 'S')
                   OR (t.tp_modalidade IN ('3') AND t.tp_operacao = 'E'))
            GROUP BY 1
            """,
            (ini.isoformat(), fim_exclusivo.isoformat()),
        ) or []
        fat_por_dia = {r["data"].isoformat(): float(r["fat"] or 0) for r in fat_rows}
        faturamento = sum(fat_por_dia.values())

        total_valor = sum(float(i["valor"] or 0) for i in itens)
        total_qtd = sum(float(i["qtd"] or 0) for i in itens)

        por_motivo: dict = {}
        por_data: dict = {}
        for i in itens:
            v, q = float(i["valor"] or 0), float(i["qtd"] or 0)
            m = por_motivo.setdefault(i["cd_motivo"], {
                "cdMotivo": i["cd_motivo"], "motivo": i["motivo"], "ehQuebra": i["cd_motivo"] == MOTIVO_QUEBRA,
                "itens": 0, "pedidos": set(), "qtd": 0.0, "valor": 0.0,
            })
            m["itens"] += 1
            m["pedidos"].add(i["cd_pedido"])
            m["qtd"] += q
            m["valor"] += v
            d = por_data.setdefault(i["data"].isoformat(), {"data": i["data"].isoformat(), "itens": 0, "qtd": 0.0, "valor": 0.0, "valorQuebra": 0.0})
            d["itens"] += 1
            d["qtd"] += q
            d["valor"] += v
            if i["cd_motivo"] == MOTIVO_QUEBRA:
                d["valorQuebra"] += v

        lista_motivos = []
        for m in sorted(por_motivo.values(), key=lambda x: x["valor"], reverse=True):
            lista_motivos.append({
                "cdMotivo": m["cdMotivo"], "motivo": m["motivo"], "ehQuebra": m["ehQuebra"],
                "itens": m["itens"], "pedidos": len(m["pedidos"]),
                "qtd": round(m["qtd"], 2), "valor": round(m["valor"], 2),
                "pctDoTotal": _pct(m["valor"], total_valor),
                "pctFaturamento": _pct(m["valor"], faturamento),
            })

        lista_datas = []
        for k in sorted(por_data):
            d = por_data[k]
            fat_dia = fat_por_dia.get(k, 0.0)
            lista_datas.append({
                "data": d["data"], "itens": d["itens"], "qtd": round(d["qtd"], 2), "valor": round(d["valor"], 2),
                "valorQuebra": round(d["valorQuebra"], 2), "faturamento": round(fat_dia, 2),
                "pctFaturamento": _pct(d["valor"], fat_dia),
            })

        quebra = por_motivo.get(MOTIVO_QUEBRA)
        return {
            "dataInicio": ini.isoformat(), "dataFim": fim.isoformat(), "somenteQuebra": somenteQuebra,
            "consolidado": {
                "itens": len(itens),
                "pedidos": len({i["cd_pedido"] for i in itens}),
                "qtd": round(total_qtd, 2),
                "valor": round(total_valor, 2),
                "faturamentoFabrica": round(faturamento, 2),
                "pctFaturamento": _pct(total_valor, faturamento),
                "valorQuebra": round(quebra["valor"], 2) if quebra else 0.0,
                "qtdQuebra": round(quebra["qtd"], 2) if quebra else 0.0,
                "pctQuebraFaturamento": _pct(quebra["valor"], faturamento) if quebra else (0.0 if faturamento else None),
            },
            "porMotivo": lista_motivos,
            "porData": lista_datas,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Erro em quebra-pedidos: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular a quebra de pedidos: {str(e)}")
