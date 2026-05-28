'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';

interface GiroLojas {
  giro: number;
  estoque_total: number;
  media_mensal: number;
  dt_referencia: string | null;
}

interface GiroMP {
  giro: number | null;
  consumo_valor: number;
  estoque_valor: number;
  dt_referencia: string | null;
}

interface GiroFabrica {
  giro: number | null;
  estoque_total: number;
  media_mensal: number;
  dt_referencia: string | null;
}

interface FaturamentoFabrica {
  dt_referencia: string | null;
  acum_2026: number;
  acum_2025: number;
  crescimento_pct: number | null;
}

interface QuebradePedidos {
  dt_referencia: string | null;
  quebra_valor: number;
  faturamento_mes: number;
  quebra_pct: number | null;
}

interface EcommerceAds {
  dt_referencia: string | null;
  custo: number;
  receita: number;
  cliques: number;
  sessoes_engajadas: number;
  transacoes: number;
  roas: number | null;
  taxa_conv_pct: number | null;
}

interface VendasVolumeVarejo {
  dt_referencia: string | null;
  volume_valor: number;
  varejo_valor: number;
  total_valor: number;
  volume_pct: number | null;
  varejo_pct: number | null;
}

interface MesHistorico {
  mes: string;
  atualizado_em: string;
  giro_lojas?: GiroLojas;
  giro_mp?: GiroMP;
  giro_fabrica?: GiroFabrica;
  faturamento_fabrica?: FaturamentoFabrica;
  faturamento_ecommerce?: FaturamentoFabrica;
  quebra_pedidos?: QuebradePedidos;
  vendas_volume_varejo?: VendasVolumeVarejo;
  ecommerce_ads?: EcommerceAds;
}

const NOMES_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function fmtMesLabel(isoDate: string) {
  const m = parseInt(isoDate.split('-')[1]) - 1;
  return `${NOMES_MES[m]}/26`;
}

function fmt(n: number, decimais = 2) {
  return n.toLocaleString('pt-BR', {
    minimumFractionDigits: decimais,
    maximumFractionDigits: decimais,
  });
}

function fmtMoeda(n: number) {
  return n.toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}

function Sparkline({
  valores,
  meses,
  indiceSelecionado,
}: {
  valores: number[];
  meses: string[];
  indiceSelecionado: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(300);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (valores.length < 2) return <div ref={containerRef} className="w-full" />;

  const CHART_H = 60;
  const LABEL_H = 18;
  const H = CHART_H + LABEL_H;
  const PAD_X = 16;
  const PAD_Y = 6;

  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const range = max - min || 1;

  const pts = valores.map((v, i) => ({
    x: PAD_X + (i / (valores.length - 1)) * (W - 2 * PAD_X),
    y: PAD_Y + (1 - (v - min) / range) * (CHART_H - 2 * PAD_Y),
  }));

  const linePath = `M ${pts.map((p) => `${p.x},${p.y}`).join(' L ')}`;
  const areaPath = `M ${pts[0].x},${CHART_H} L ${pts.map((p) => `${p.x},${p.y}`).join(' L ')} L ${pts[pts.length - 1].x},${CHART_H} Z`;

  return (
    <div ref={containerRef} className="w-full">
      <svg width={W} height={H} style={{ display: 'block' }}>
        <path d={areaPath} fill="white" fillOpacity={0.12} />
        <path d={linePath} fill="none" stroke="white" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {pts.map((p, i) => {
          const isSel = i === indiceSelecionado;
          return (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={isSel ? 4.5 : 2.5}
              fill="white"
              fillOpacity={isSel ? 1 : 0.5}
              stroke={isSel ? 'rgba(255,255,255,0.4)' : 'none'}
              strokeWidth={isSel ? 3 : 0}
            />
          );
        })}

        {meses.map((m, i) => {
          const isSel = i === indiceSelecionado;
          return (
            <text
              key={i}
              x={pts[i].x}
              y={H - 2}
              textAnchor="middle"
              fontSize={9}
              fill="white"
              fillOpacity={isSel ? 1 : 0.45}
              fontWeight={isSel ? 700 : 400}
            >
              {m}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function CardIndicador({
  titulo,
  valor,
  unidade,
  linhas,
  carregando,
  cor,
  sparkline,
  indiceSelecionado,
}: {
  titulo: string;
  valor: string;
  unidade: string;
  linhas: { label: string; valor: string }[];
  carregando: boolean;
  cor: string;
  sparkline?: { valores: number[]; meses: string[] };
  indiceSelecionado: number;
}) {
  return (
    <div className="rounded-xl p-6 flex flex-col gap-3" style={{ backgroundColor: cor }}>
      <p className="text-sm font-medium text-white/70">{titulo}</p>

      {carregando ? (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="w-5 h-5 animate-spin text-white/60" />
          <span className="text-sm text-white/60">Carregando...</span>
        </div>
      ) : (
        <>
          <p className="text-4xl font-bold text-white leading-none">
            {valor}
            <span className="text-base font-normal text-white/60 ml-2">{unidade}</span>
          </p>

          <div className="space-y-1.5">
            {linhas.map((l) => (
              <div key={l.label} className="flex justify-between text-sm">
                <span className="text-white/60">{l.label}</span>
                <span className="font-medium text-white/90">{l.valor}</span>
              </div>
            ))}
          </div>

          {sparkline && sparkline.valores.length >= 2 && (
            <div className="mt-1 border-t border-white/10 pt-3">
              <Sparkline
                valores={sparkline.valores}
                meses={sparkline.meses}
                indiceSelecionado={indiceSelecionado}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const CORES = {
  lojas:     '#B3838C',
  mp:        '#8B7AAA',
  fabrica:   '#5E8FA0',
  fat:       '#7BAA8B',
  ecommerce: '#C4895A',
  quebra:    '#8B6E5A',
  volume:    '#A07840',
};

export default function IndicadoresControladoriaPage() {
  const [historico, setHistorico] = useState<MesHistorico[]>([]);
  const [mesSelecionado, setMesSelecionado] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [sincAuto, setSincAuto] = useState(false);
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState<string | null>(null);

  const mesAtualISO = (() => {
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-01`;
  })();

  const carregarHistorico = useCallback(async (): Promise<MesHistorico[]> => {
    setCarregando(true);
    try {
      const r = await fetch('/api/indicadores/historico');
      const d = await r.json();
      if (Array.isArray(d.meses) && d.meses.length > 0) {
        setHistorico(d.meses);
        setMesSelecionado((prev) => prev ?? d.meses[d.meses.length - 1].mes);
        setUltimaAtualizacao(new Date().toLocaleString('pt-BR'));
        return d.meses;
      }
    } catch (e) {
      console.error(e);
    } finally {
      setCarregando(false);
    }
    return [];
  }, []);

  useEffect(() => {
    carregarHistorico().then((meses) => {
      const temMesAtual = meses.some((m) => m.mes === mesAtualISO);
      if (!temMesAtual) {
        // Novo mês detectado sem cache — sincroniza automaticamente
        setSincAuto(true);
        fetch('/api/indicadores/cache/sincronizar', { method: 'POST' })
          .then(() => carregarHistorico())
          .catch(console.error)
          .finally(() => setSincAuto(false));
      }
    });

    const handler = () => {
      setMesSelecionado(null);
      carregarHistorico();
    };
    window.addEventListener('cache-synced', handler);
    return () => window.removeEventListener('cache-synced', handler);
  }, [carregarHistorico, mesAtualISO]);

  const indiceSelecionado = mesSelecionado
    ? historico.findIndex((h) => h.mes === mesSelecionado)
    : historico.length - 1;

  const dadosMes = historico[indiceSelecionado];
  const gl  = dadosMes?.giro_lojas ?? null;
  const gm  = dadosMes?.giro_mp ?? null;
  const gf  = dadosMes?.giro_fabrica ?? null;
  const ff  = dadosMes?.faturamento_fabrica ?? null;
  const fe  = dadosMes?.faturamento_ecommerce ?? null;
  const qp  = dadosMes?.quebra_pedidos ?? null;
  const vv  = dadosMes?.vendas_volume_varejo ?? null;
  const ea  = dadosMes?.ecommerce_ads ?? null;

  const LIMITE_VOLUME = 13.5;

  const mesesLabel   = historico.map((h) => fmtMesLabel(h.mes));
  const serieLojas   = historico.map((h) => h.giro_lojas?.giro ?? 0);
  const serieMP      = historico.map((h) => h.giro_mp?.giro ?? 0);
  const serieFabrica = historico.map((h) => h.giro_fabrica?.giro ?? 0);
  const serieFat     = historico.map((h) => h.faturamento_fabrica?.crescimento_pct ?? 0);
  const serieEcom    = historico.map((h) => h.faturamento_ecommerce?.crescimento_pct ?? 0);
  const serieQuebra  = historico.map((h) => h.quebra_pedidos?.quebra_pct ?? 0);
  const serieVolume  = historico.map((h) => h.vendas_volume_varejo?.volume_pct ?? 0);
  const serieRoas    = historico.map((h) => h.ecommerce_ads?.roas ?? 0);
  const serieConv    = historico.map((h) => h.ecommerce_ads?.taxa_conv_pct ?? 0);

  // Meses de 2026 até hoje
  const mesesComCache = new Set(historico.map((h) => h.mes));
  const meses2026: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const iso = `2026-${String(m).padStart(2, '0')}-01`;
    if (iso <= mesAtualISO) meses2026.push(iso);
  }

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-brand-dark">INDICADORES DE CONTROLADORIA</h1>
          {ultimaAtualizacao && (
            <p className="text-xs text-gray-400 mt-1">Atualizado em: {ultimaAtualizacao}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          {meses2026.map((iso) => {
            const temCache = mesesComCache.has(iso);
            const selecionado = mesSelecionado === iso;
            return (
              <button
                key={iso}
                onClick={() => temCache && setMesSelecionado(iso)}
                disabled={!temCache}
                title={!temCache ? 'Sem dados — clique em Atualizar Dados para gerar' : undefined}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition border ${
                  selecionado
                    ? 'bg-brand-primary text-white border-brand-primary'
                    : temCache
                    ? 'bg-white text-gray-600 border-gray-200 hover:border-brand-primary hover:text-brand-primary'
                    : 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed'
                }`}
              >
                {fmtMesLabel(iso)}
              </button>
            );
          })}
        </div>
      </div>

      {sincAuto && (
        <div className="flex items-center gap-2 text-sm text-brand-primary">
          <Loader2 className="w-4 h-4 animate-spin" />
          Novo mês detectado — sincronizando dados automaticamente...
        </div>
      )}

      {/* Fileira 1 — Giro de Estoque */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CardIndicador
          titulo="Giro de Estoque — Lojas"
          valor={gl ? fmt(gl.giro) : '—'}
          unidade="x / mes"
          carregando={carregando}
          cor={CORES.lojas}
          indiceSelecionado={indiceSelecionado}
          sparkline={serieLojas.length >= 2 ? { valores: serieLojas, meses: mesesLabel } : undefined}
          linhas={gl ? [
            { label: 'Estoque (unid.)', valor: fmt(gl.estoque_total, 0) },
            { label: 'Media mensal (unid.)', valor: fmt(gl.media_mensal, 0) },
          ] : []}
        />

        <CardIndicador
          titulo="Giro de Materia Prima"
          valor={gm?.giro != null ? fmt(gm.giro) : '—'}
          unidade="meses cobertura"
          carregando={carregando}
          cor={CORES.mp}
          indiceSelecionado={indiceSelecionado}
          sparkline={serieMP.length >= 2 ? { valores: serieMP, meses: mesesLabel } : undefined}
          linhas={gm ? [
            { label: 'Estoque MP (R$)', valor: fmtMoeda(gm.estoque_valor) },
            { label: 'Consumo mes (R$)', valor: fmtMoeda(gm.consumo_valor) },
          ] : []}
        />

        <CardIndicador
          titulo="Giro de Estoque — Fabrica"
          valor={gf?.giro != null ? fmt(gf.giro, 1) : '—'}
          unidade="meses cobertura"
          carregando={carregando}
          cor={CORES.fabrica}
          indiceSelecionado={indiceSelecionado}
          sparkline={serieFabrica.length >= 2 ? { valores: serieFabrica, meses: mesesLabel } : undefined}
          linhas={gf ? [
            { label: 'Estoque (unid.)', valor: fmt(gf.estoque_total, 0) },
            { label: 'Media mensal (unid.)', valor: fmt(gf.media_mensal, 0) },
          ] : []}
        />
      </div>

      {/* Fileira 2 — Operacional */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CardIndicador
          titulo="Faturamento Lojas + Fabrica"
          valor={ff?.crescimento_pct != null
            ? `${ff.crescimento_pct >= 0 ? '+' : ''}${fmt(ff.crescimento_pct, 1)}`
            : '—'}
          unidade="% vs ano ant."
          carregando={carregando}
          cor={CORES.fat}
          indiceSelecionado={indiceSelecionado}
          sparkline={serieFat.length >= 2 ? { valores: serieFat, meses: mesesLabel } : undefined}
          linhas={ff ? [
            { label: 'Acum. ano atual', valor: fmtMoeda(ff.acum_2026) },
            { label: 'Acum. ano ant.', valor: fmtMoeda(ff.acum_2025) },
          ] : []}
        />

        <CardIndicador
          titulo="Quebra de Pedidos"
          valor={qp?.quebra_pct != null ? fmt(qp.quebra_pct, 2) : '—'}
          unidade="% fat. fábrica"
          carregando={carregando}
          cor={CORES.quebra}
          indiceSelecionado={indiceSelecionado}
          sparkline={serieQuebra.length >= 2 ? { valores: serieQuebra, meses: mesesLabel } : undefined}
          linhas={qp ? [
            { label: 'Quebra (R$)', valor: fmtMoeda(qp.quebra_valor) },
            { label: 'Fat. fábrica mês', valor: fmtMoeda(qp.faturamento_mes) },
          ] : []}
        />

        <CardIndicador
          titulo="Volume x Varejo"
          valor={vv?.volume_pct != null ? fmt(vv.volume_pct, 2) : '—'}
          unidade={`% volume${vv?.volume_pct != null && vv.volume_pct > LIMITE_VOLUME ? ' ⚠' : ''}`}
          carregando={carregando}
          cor={vv?.volume_pct != null && vv.volume_pct > LIMITE_VOLUME ? '#B05030' : CORES.volume}
          indiceSelecionado={indiceSelecionado}
          sparkline={serieVolume.length >= 2 ? { valores: serieVolume, meses: mesesLabel } : undefined}
          linhas={vv ? [
            { label: 'Volume (R$)', valor: fmtMoeda(vv.volume_valor) },
            { label: 'Varejo (R$)', valor: fmtMoeda(vv.varejo_valor) },
            { label: 'Limite ideal', valor: `${fmt(LIMITE_VOLUME, 1)}%` },
          ] : []}
        />
      </div>

      {/* Fileira 3 — E-commerce */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CardIndicador
          titulo="Faturamento E-commerce"
          valor={fe?.crescimento_pct != null
            ? `${fe.crescimento_pct >= 0 ? '+' : ''}${fmt(fe.crescimento_pct, 1)}`
            : '—'}
          unidade="% vs ano ant."
          carregando={carregando}
          cor={CORES.ecommerce}
          indiceSelecionado={indiceSelecionado}
          sparkline={serieEcom.length >= 2 ? { valores: serieEcom, meses: mesesLabel } : undefined}
          linhas={fe ? [
            { label: 'Acum. ano atual', valor: fmtMoeda(fe.acum_2026) },
            { label: 'Acum. ano ant.', valor: fmtMoeda(fe.acum_2025) },
          ] : []}
        />

        <CardIndicador
          titulo="ROAS — Google Ads (CPC)"
          valor={ea?.roas != null ? fmt(ea.roas, 2) : '—'}
          unidade="x retorno"
          carregando={carregando}
          cor="#4A7FA5"
          indiceSelecionado={indiceSelecionado}
          sparkline={serieRoas.length >= 2 ? { valores: serieRoas, meses: mesesLabel } : undefined}
          linhas={ea ? [
            { label: 'Investido (R$)', valor: fmtMoeda(ea.custo) },
            { label: 'Receita (R$)',   valor: fmtMoeda(ea.receita) },
          ] : []}
        />

        <CardIndicador
          titulo="Taxa de Conversão — CPC"
          valor={ea?.taxa_conv_pct != null ? fmt(ea.taxa_conv_pct, 2) : '—'}
          unidade="% sessões → compra"
          carregando={carregando}
          cor="#5A8A6A"
          indiceSelecionado={indiceSelecionado}
          sparkline={serieConv.length >= 2 ? { valores: serieConv, meses: mesesLabel } : undefined}
          linhas={ea ? [
            { label: 'Sessões engajadas', valor: ea.sessoes_engajadas.toLocaleString('pt-BR') },
            { label: 'Transações',        valor: ea.transacoes.toLocaleString('pt-BR') },
          ] : []}
        />
      </div>
    </div>
  );
}
