"""Cache da DRE (Analitica, Sintetica e Por Empresa) e do DFC (Mensal, Mensal
sem antecipacao e Por Centro de Custo) - guardado no banco.

Problema (pedido explicito do usuario): a DRE leva de 10 a 60s pra
calcular, e o cache da propria tela so vale no navegador que consultou.
Abrindo em outro computador (ex.: na sala do chefe, com o mesmo usuario) a
consulta comecava do zero, na frente de todo mundo.

Solucao: o resultado de cada (visao, periodo, filtro) fica salvo em
fcp_dre_cache e qualquer computador recebe na hora. Um agendador mantem
prontos os periodos que a tela usa (cada mes desde jan/2025 + atalhos de
periodo + o mesmo periodo do ano anterior, usado nos comparativos).

Validade (regras combinadas com o usuario):
- periodo que termina ate DATA_CONGELAMENTO (jan/2025 a jun/2026): calculado
  UMA vez e guardado - so refaz se a classificacao mudar ou no botao 🔄;
- periodo ja fechado depois disso (jul/2026 ate o mes passado): refeito
  toda noite (HORA_RECALCULO_NOTURNO);
- periodo que inclui o mes atual: refeito a cada INTERVALO_AGENDADOR_SEG.
Qualquer mudanca de classificacao/plano de contas/CMV apaga tudo
(invalidar) e o agendador recalcula em seguida.
"""
import asyncio
import json
import threading
import time
import traceback
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from fastapi.encoders import jsonable_encoder

from database import execute_insert, execute_query

TZ = ZoneInfo("America/Sao_Paulo")
INICIO_HISTORICO = date(2025, 1, 1)
DATA_CONGELAMENTO = date(2026, 6, 30)
INTERVALO_AGENDADOR_SEG = 30 * 60
# Mes atual: o agendador refaz com mais de AQUECER_MES_ATUAL_APOS_SEG; a tela
# so recalcula sozinha se passar de VALIDADE_MES_ATUAL_SEG (folga caso o
# agendador atrase) - assim quem abre a tela quase nunca espera.
AQUECER_MES_ATUAL_APOS_SEG = 25 * 60
VALIDADE_MES_ATUAL_SEG = 60 * 60
VALIDADE_FECHADO_SEG = 26 * 3600
HORA_RECALCULO_NOTURNO = 2
FILTRO_PADRAO = "consolidado"

# visao -> (filtro mantido pronto pelo agendador, faz comparativo com o ano
# anterior na tela?). Visao sem filtro na API usa "".
VISOES = {
    "analitica": (FILTRO_PADRAO, True),
    "sintetica": (FILTRO_PADRAO, True),
    "por-empresa": ("", False),
    "dfc-mensal": (FILTRO_PADRAO, False),
    "dfc-sem-antecipacao": (FILTRO_PADRAO, False),
    "dfc-por-ccusto": ("", False),
}
VISOES_DRE = ["analitica", "sintetica", "por-empresa"]
VISOES_DFC = ["dfc-mensal", "dfc-sem-antecipacao", "dfc-por-ccusto"]

_calculadoras: dict = {}
_locks: dict = {}
_locks_guarda = threading.Lock()
_tabela_criada = False
_acordar_agendador = threading.Event()


def registrar(visao: str, calcular: Callable[[str, str, str], dict]) -> None:
    """dre.py registra aqui a funcao que calcula cada visao (evita import
    circular - o agendador precisa chamar o calculo sem passar por HTTP)."""
    _calculadoras[visao] = calcular


def _criar_tabela() -> None:
    global _tabela_criada
    if _tabela_criada:
        return
    execute_insert("""
        CREATE TABLE IF NOT EXISTS fcp_dre_cache (
            visao TEXT NOT NULL,
            dt_inicio DATE NOT NULL,
            dt_fim DATE NOT NULL,
            filtro TEXT NOT NULL,
            payload TEXT NOT NULL,
            dt_calculado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            seg_calculo NUMERIC(8, 1),
            PRIMARY KEY (visao, dt_inicio, dt_fim, filtro)
        )
    """, ())
    _tabela_criada = True


def _agora() -> datetime:
    return datetime.now(TZ)


def _lock_da(chave: tuple) -> threading.Lock:
    with _locks_guarda:
        return _locks.setdefault(chave, threading.Lock())


def _ler(chave: tuple) -> Optional[dict]:
    rows = execute_query(
        "SELECT payload, dt_calculado FROM fcp_dre_cache WHERE visao = %s AND dt_inicio = %s AND dt_fim = %s AND filtro = %s",
        chave,
    ) or []
    return rows[0] if rows else None


def _salvar(chave: tuple, payload: dict, segundos: float) -> None:
    execute_insert("""
        INSERT INTO fcp_dre_cache (visao, dt_inicio, dt_fim, filtro, payload, dt_calculado, seg_calculo)
        VALUES (%s, %s, %s, %s, %s, NOW(), %s)
        ON CONFLICT (visao, dt_inicio, dt_fim, filtro)
        DO UPDATE SET payload = EXCLUDED.payload, dt_calculado = NOW(), seg_calculo = EXCLUDED.seg_calculo
    """, (*chave, json.dumps(payload), round(segundos, 1)))


def _inclui_mes_atual(dt_fim: date, agora: datetime) -> bool:
    return dt_fim >= agora.date().replace(day=1)


def _valido(dt_fim_str: str, dt_calculado: datetime, agora: datetime) -> bool:
    """Pode ser entregue pra tela sem recalcular?"""
    dt_fim = date.fromisoformat(dt_fim_str)
    idade = (agora - dt_calculado).total_seconds()
    if _inclui_mes_atual(dt_fim, agora):
        return idade < VALIDADE_MES_ATUAL_SEG
    # Periodo fechado: so vale se foi calculado DEPOIS de fechar (senao
    # faltariam os ultimos dias - ex.: calculado em 30/09 pra setembro).
    if dt_calculado.astimezone(TZ).date() <= dt_fim:
        return False
    if dt_fim <= DATA_CONGELAMENTO:
        return True
    return idade < VALIDADE_FECHADO_SEG


def _precisa_aquecer(dt_fim_str: str, dt_calculado: Optional[datetime], agora: datetime) -> bool:
    """Criterio do agendador - mais agressivo que _valido, pra recalcular
    ANTES de alguem abrir a tela e encontrar o cache vencido."""
    if dt_calculado is None or not _valido(dt_fim_str, dt_calculado, agora):
        return True
    dt_fim = date.fromisoformat(dt_fim_str)
    if _inclui_mes_atual(dt_fim, agora):
        return (agora - dt_calculado).total_seconds() > AQUECER_MES_ATUAL_APOS_SEG
    if dt_fim <= DATA_CONGELAMENTO:
        return False
    # Fechado depois do congelamento: refaz uma vez por noite.
    calculado = dt_calculado.astimezone(TZ)
    return agora.hour >= HORA_RECALCULO_NOTURNO and (
        calculado.date() < agora.date() or calculado.hour < HORA_RECALCULO_NOTURNO
    )


def _anotar(payload: dict, dt_calculado: datetime, do_cache: bool) -> dict:
    if isinstance(payload, dict):
        payload = {**payload, "_cache": {
            "calculadoEm": dt_calculado.astimezone(TZ).isoformat(),
            "doCache": do_cache,
        }}
    return payload


def _calcular_e_salvar(chave: tuple, calcular: Callable[[], dict]) -> tuple:
    inicio = time.time()
    payload = jsonable_encoder(calcular())
    segundos = time.time() - inicio
    # Resposta de erro nao vai pro cache (senao o erro ficaria "congelado").
    if isinstance(payload, dict) and not payload.get("error"):
        try:
            _salvar(chave, payload, segundos)
        except Exception as e:
            print(f"[DRE-CACHE] Falha ao salvar {chave}: {e}")
    return payload, _agora()


def obter(visao: str, dataInicio: str, dataFim: str, filtro: Optional[str], forcar: bool,
          calcular: Callable[[], dict]) -> dict:
    """Usado pelos endpoints da DRE: devolve do cache se valido, senao
    calcula, guarda e devolve. forcar=True (botao 🔄) sempre recalcula."""
    try:
        _criar_tabela()
    except Exception as e:
        print(f"[DRE-CACHE] Tabela indisponivel, calculando direto: {e}")
        return calcular()

    chave = (visao, dataInicio, dataFim, filtro or "")
    pedido_em = _agora()
    if not forcar:
        linha = _ler(chave)
        if linha and _valido(dataFim, linha["dt_calculado"], pedido_em):
            return _anotar(json.loads(linha["payload"]), linha["dt_calculado"], True)

    # Um calculo por chave de cada vez: se o agendador (ou outra pessoa) ja
    # esta calculando o mesmo periodo, espera e aproveita o resultado.
    with _lock_da(chave):
        linha = _ler(chave)
        if linha and linha["dt_calculado"] >= pedido_em:
            return _anotar(json.loads(linha["payload"]), linha["dt_calculado"], True)
        if linha and not forcar and _valido(dataFim, linha["dt_calculado"], _agora()):
            return _anotar(json.loads(linha["payload"]), linha["dt_calculado"], True)
        payload, calculado_em = _calcular_e_salvar(chave, calcular)
    return _anotar(payload, calculado_em, False)


def invalidar(motivo: str, visoes: Optional[list] = None) -> None:
    """Apaga o cache das visoes informadas (todas se None) - classificacao
    mudou e afeta qualquer periodo, inclusive os congelados - e acorda o
    agendador pra recalcular."""
    try:
        _criar_tabela()
        if visoes:
            execute_insert("DELETE FROM fcp_dre_cache WHERE visao = ANY(%s)", (list(visoes),))
        else:
            execute_insert("DELETE FROM fcp_dre_cache", ())
        print(f"[DRE-CACHE] Cache apagado ({', '.join(visoes) if visoes else 'tudo'}): {motivo}")
    except Exception as e:
        print(f"[DRE-CACHE] Falha ao apagar cache ({motivo}): {e}")
    _acordar_agendador.set()


# ── Periodos mantidos prontos pelo agendador ─────────────────────────────
# Mesmas datas que app/components/filtros/AtalhosPeriodo.tsx gera (o cache e
# por periodo EXATO) + cada mes inteiro + o mesmo periodo menos 1 ano
# (comparativo com ano anterior da Analitica/Sintetica).
def _fim_mes(ano: int, mes: int) -> date:
    return date(ano, mes, monthrange(ano, mes)[1])


def _menos_meses(d: date, n: int) -> date:
    total = d.year * 12 + d.month - 1 - n
    return date(total // 12, total % 12 + 1, 1)


def _ano_anterior(d: date) -> date:
    return d.replace(year=d.year - 1, day=min(d.day, monthrange(d.year - 1, d.month)[1]))


def periodos_alvo(hoje: date) -> list:
    inicio_mes = hoje.replace(day=1)
    fim_mes_anterior = inicio_mes - timedelta(days=1)
    atalhos = [
        (inicio_mes, _fim_mes(hoje.year, hoje.month)),                      # Mes Atual
        (fim_mes_anterior.replace(day=1), fim_mes_anterior),                # Mes Anterior
        (_menos_meses(inicio_mes, 3), fim_mes_anterior),                    # Ultimos 3
        (_menos_meses(inicio_mes, 6), fim_mes_anterior),                    # Ultimos 6
        (_menos_meses(inicio_mes, 12), fim_mes_anterior),                   # Ultimos 12
        (date(hoje.year, 1, 1),
         fim_mes_anterior if fim_mes_anterior.year == hoje.year else _fim_mes(hoje.year, hoje.month)),  # Ano Atual
        (date(2025, 1, 1), date(2025, 12, 31)),                             # 2025
    ]
    meses = []
    d = inicio_mes
    while d >= INICIO_HISTORICO:
        meses.append((d, _fim_mes(d.year, d.month)))
        d = _menos_meses(d, 1)
    comparativos = [(_ano_anterior(i), _ano_anterior(f)) for i, f in atalhos]

    alvos = []
    for visao, (filtro, tem_comparativo) in VISOES.items():
        for i, f in atalhos + meses:
            alvos.append((visao, i.isoformat(), f.isoformat(), filtro))
        if tem_comparativo:
            for i, f in comparativos:
                alvos.append((visao, i.isoformat(), f.isoformat(), filtro))
    vistos = set()
    unicos = []
    for alvo in alvos:
        if alvo not in vistos:
            vistos.add(alvo)
            unicos.append(alvo)
    # Mais urgente primeiro: o que inclui o mes atual, depois o resto.
    unicos.sort(key=lambda a: not _inclui_mes_atual(date.fromisoformat(a[2]), datetime.now(TZ)))
    return unicos


def aquecer() -> None:
    """Uma rodada do agendador: recalcula, um de cada vez (pra nao pesar no
    banco), so o que precisa."""
    _criar_tabela()
    agora = _agora()
    calculados = {
        (r["visao"], r["dt_inicio"].isoformat(), r["dt_fim"].isoformat(), r["filtro"]): r["dt_calculado"]
        for r in execute_query("SELECT visao, dt_inicio, dt_fim, filtro, dt_calculado FROM fcp_dre_cache") or []
    }
    pendentes = [a for a in periodos_alvo(agora.date()) if _precisa_aquecer(a[2], calculados.get(a), agora)]
    if not pendentes:
        return
    print(f"[DRE-CACHE] Agendador: {len(pendentes)} periodo(s) para recalcular")
    for visao, ini, fim, filtro in pendentes:
        calcular = _calculadoras.get(visao)
        if not calcular:
            continue
        chave = (visao, ini, fim, filtro)
        try:
            with _lock_da(chave):
                inicio = time.time()
                _calcular_e_salvar(chave, lambda: calcular(ini, fim, filtro or FILTRO_PADRAO))
                print(f"[DRE-CACHE] {visao} {ini}..{fim} {filtro or '-'}: {time.time() - inicio:.1f}s")
        except Exception as e:
            print(f"[DRE-CACHE] Erro ao calcular {chave}: {e}")
        if _acordar_agendador.is_set():
            # Cache foi apagado no meio (classificacao mudou): recomeca a
            # rodada do zero, senao continuaria com a lista antiga.
            return


async def loop_agendador() -> None:
    """Roda pra sempre em background (startup em main.py), no mesmo estilo
    do agendador do giro: o calculo pesado roda em thread separada."""
    await asyncio.sleep(30)
    while True:
        _acordar_agendador.clear()
        try:
            await asyncio.to_thread(aquecer)
        except Exception as e:
            print(f"[DRE-CACHE] Erro no agendador: {e}")
            traceback.print_exc()
        await asyncio.to_thread(_acordar_agendador.wait, INTERVALO_AGENDADOR_SEG)
