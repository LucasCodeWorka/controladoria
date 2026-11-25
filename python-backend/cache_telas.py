"""Cache generico (no banco) das consultas pesadas das telas novas: Balanco
Patrimonial, Endividamento, Indicadores e Comparativo de Mercado.

Problema: o balanco leva de 15s a minutos (varias consultas no banco remoto) e
qualquer tela que dependa dele esperava tudo de novo a cada abertura, em cada
computador. Estourar o tempo de uma consulta ainda zerava parte do balanco.

Solucao (mesmo espirito do dre_cache.py, so que por chave livre):
- resultado guardado em fcp_cache_tela, valido pra qualquer computador;
- dentro do TTL: entrega na hora;
- vencido mas do MESMO DIA e com menos de MAX_VELHO_SEG: entrega o que tem na
  hora e recalcula por tras (quem abre a tela quase nunca espera);
- sem cache, de outro dia ou forcar=True: calcula, guarda e entrega;
- resultado com erro ou incompleto (valido(payload) = False) nunca e guardado;
- aquecer_loop() mantem pronta a visao Liebe (ver main.py).
"""
import asyncio
import json
import threading
import time
from datetime import datetime, timedelta
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from fastapi.encoders import jsonable_encoder

from database import execute_insert, execute_query

TZ = ZoneInfo("America/Sao_Paulo")
MAX_VELHO_SEG = 12 * 3600
INTERVALO_AQUECER_SEG = 25 * 60

_tabela_criada = False
_locks: dict = {}
_guarda = threading.Lock()
_atualizando: set = set()


def _criar_tabela() -> None:
    global _tabela_criada
    if _tabela_criada:
        return
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_cache_tela (
            chave TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            dt_calculado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            seg_calculo NUMERIC(8, 1)
        )
    """, ())
    _tabela_criada = True


def _agora() -> datetime:
    return datetime.now(TZ)


def _lock_da(chave: str) -> threading.Lock:
    with _guarda:
        return _locks.setdefault(chave, threading.Lock())


def _ler(chave: str) -> Optional[dict]:
    rows = execute_query("SELECT payload, dt_calculado FROM fcp_cache_tela WHERE chave = %s", (chave,)) or []
    return rows[0] if rows else None


def _anotar(payload, dt_calculado: datetime, do_cache: bool, atualizando: bool = False):
    if isinstance(payload, dict):
        return {**payload, "_cache": {
            "calculadoEm": dt_calculado.astimezone(TZ).isoformat(), "doCache": do_cache, "atualizando": atualizando,
        }}
    return payload


def _valido_padrao(payload) -> bool:
    return isinstance(payload, dict) and not payload.get("error")


def _calcular_e_salvar(chave: str, calcular: Callable[[], dict], valido: Callable[[dict], bool]):
    inicio = time.time()
    payload = jsonable_encoder(calcular())
    segundos = time.time() - inicio
    if valido(payload):
        try:
            execute_insert("""
                INSERT INTO fcp_cache_tela (chave, payload, dt_calculado, seg_calculo) VALUES (%s, %s, NOW(), %s)
                ON CONFLICT (chave) DO UPDATE SET payload = EXCLUDED.payload, dt_calculado = NOW(), seg_calculo = EXCLUDED.seg_calculo
            """, (chave, json.dumps(payload), round(segundos, 1)))
        except Exception as e:
            print(f"[CACHE-TELA] Falha ao salvar {chave}: {e}")
    else:
        print(f"[CACHE-TELA] Resultado incompleto/erro de {chave} nao foi guardado")
    return payload, _agora()


def _atualizar_em_segundo_plano(chave: str, calcular: Callable[[], dict], valido: Callable[[dict], bool]) -> None:
    with _guarda:
        if chave in _atualizando:
            return
        _atualizando.add(chave)

    def _rodar():
        try:
            with _lock_da(chave):
                _calcular_e_salvar(chave, calcular, valido)
        except Exception as e:
            print(f"[CACHE-TELA] Falha ao atualizar {chave} em segundo plano: {e}")
        finally:
            with _guarda:
                _atualizando.discard(chave)

    threading.Thread(target=_rodar, daemon=True).start()


def obter(chave: str, ttl_seg: int, calcular: Callable[[], dict], forcar: bool = False,
          valido: Optional[Callable[[dict], bool]] = None):
    valido = valido or _valido_padrao
    try:
        _criar_tabela()
    except Exception as e:
        print(f"[CACHE-TELA] Tabela indisponivel, calculando direto: {e}")
        return calcular()

    agora = _agora()
    if not forcar:
        linha = _ler(chave)
        if linha:
            idade = (agora - linha["dt_calculado"]).total_seconds()
            mesmo_dia = linha["dt_calculado"].astimezone(TZ).date() == agora.date()
            if idade < ttl_seg and mesmo_dia:
                return _anotar(json.loads(linha["payload"]), linha["dt_calculado"], True)
            if mesmo_dia and idade < MAX_VELHO_SEG:
                _atualizar_em_segundo_plano(chave, calcular, valido)
                return _anotar(json.loads(linha["payload"]), linha["dt_calculado"], True, atualizando=True)

    with _lock_da(chave):
        linha = _ler(chave)
        if linha and linha["dt_calculado"] >= agora:  # outra requisicao acabou de calcular
            return _anotar(json.loads(linha["payload"]), linha["dt_calculado"], True)
        payload, calculado_em = _calcular_e_salvar(chave, calcular, valido)
    return _anotar(payload, calculado_em, False)


def invalidar(prefixo: str, motivo: str = "") -> None:
    """Apaga as chaves que comecam com o prefixo (dado de origem mudou)."""
    try:
        _criar_tabela()
        execute_insert("DELETE FROM fcp_cache_tela WHERE chave LIKE %s", (prefixo + "%",))
        print(f"[CACHE-TELA] Cache '{prefixo}' apagado{': ' + motivo if motivo else ''}")
    except Exception as e:
        print(f"[CACHE-TELA] Falha ao apagar '{prefixo}': {e}")


# ── Visao Liebe (balanco + DFC por agrupamento) mantida pronta ───────────
def _ultimo_mes_fechado(hoje) -> tuple:
    return (hoje.year, hoje.month - 1) if hoje.month > 1 else (hoje.year - 1, 12)


def aquecer_visao_liebe() -> None:
    """Deixa pronto o que o Comparativo de Mercado e a tela de Indicadores
    consultam: balanco na visao Liebe (mes atual), CMV 12m e a DFC do ultimo
    mes fechado para lojas+ecommerce e fabrica."""
    import calendar
    from routers import balanco_patrimonial as bp, dre as dre_mod, indicadores as ind
    import dre_cache

    hoje = _agora().date()
    a, m = _ultimo_mes_fechado(hoje)
    # Mes atual e mes anterior (a tela de Indicadores tem os dois como botao e
    # o Balanco/Comparativo abrem no atual).
    for mes in (f"{hoje.year}-{hoje.month:02d}", f"{a}-{m:02d}"):
        try:
            bp.get_balanco_patrimonial(mes, bp.EMPRESAS_VISAO_LIEBE, True, True, False)
        except Exception as e:
            print(f"[CACHE-TELA] Aquecer balanco {mes}: {e}")
        try:
            bp.get_indicadores_dre(mes)  # Lucro/EBITDA/receita/CMV 12m (usa o cache da DRE)
        except Exception as e:
            print(f"[CACHE-TELA] Aquecer DRE 12m {mes}: {e}")
    try:
        ind.get_cmv_12m(f"{a}-{m:02d}", False)
    except Exception as e:
        print(f"[CACHE-TELA] Aquecer CMV 12m: {e}")
    ini = f"{a}-{m:02d}-01"
    fim = f"{a}-{m:02d}-{calendar.monthrange(a, m)[1]:02d}"
    filtro_lojas = ",".join(str(cd) for cd in sorted(dre_mod.CCUSTOS_LOJAS.keys()))
    for filtro in (filtro_lojas, "fabrica"):
        try:
            with dre_cache.CALCULO_PESADO:
                pass  # so serializa com o agendador da DRE; o obter() abaixo ja toma o lock
            dre_cache.obter("dfc-mensal", ini, fim, filtro, False,
                            lambda f=filtro: dre_mod._calcular_valores_dfc(ini, fim, f, sem_antecipacao=False))
        except Exception as e:
            print(f"[CACHE-TELA] Aquecer DFC {filtro[:20]}: {e}")


async def aquecer_loop() -> None:
    await asyncio.sleep(90)
    while True:
        try:
            await asyncio.to_thread(aquecer_visao_liebe)
        except Exception as e:
            print(f"[CACHE-TELA] Erro no aquecimento: {e}")
        await asyncio.sleep(INTERVALO_AQUECER_SEG)
