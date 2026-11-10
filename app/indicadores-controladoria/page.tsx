'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Loader2, ChevronRight, ArrowUp, ArrowDown, Minus, CheckCircle2, AlertCircle, MinusCircle } from 'lucide-react';
import { calcularIndicadoresBalanco, montarValoresBalanco, type EntradaIndicadoresBalanco, type StatusIndicador } from '../balanco-patrimonial/indicadoresBalanco';

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

interface CmvPct {
  dt_referencia: string | null;
  cmv_valor: number;
  receita_liquida: number;
  cmv_pct: number | null;
}

interface LucroLiqPct {
  dt_referencia: string | null;
  periodo_meses: number;
  data_inicio: string;
  data_fim: string;
  total_empresas: number;
  empresas_positivas: number;
  empresas_negativas: number;
  pct_positivas: number | null;
}

interface SobraMp {
  dt_referencia: string | null;
  sobra_mp_pct: number | null;
  total_sobra: number;
  total_solicitada: number;
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
  cmv_pct?: CmvPct;
  lucro_liq_pct?: LucroLiqPct;
  sobra_mp?: SobraMp;
}

const NOMES_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function fmtMesLabel(isoDate: string) {
  const [ano, mes] = isoDate.split('-');
  return `${NOMES_MES[parseInt(mes) - 1]}/${ano.slice(2)}`;
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

const LIMITE_VOLUME = 13.5;

const ESTILOS_STATUS: Record<StatusIndicador, { valor: string; badge: string; rotulo: string; icone: typeof CheckCircle2 }> = {
  ok: { valor: 'text-teal-700', badge: 'bg-teal-50 border-teal-200 text-teal-700', rotulo: 'Dentro da referência', icone: CheckCircle2 },
  atencao: { valor: 'text-amber-800', badge: 'bg-amber-50 border-amber-200 text-amber-800', rotulo: 'Atenção', icone: AlertCircle },
  ruim: { valor: 'text-rose-700', badge: 'bg-rose-50 border-rose-200 text-rose-700', rotulo: 'Atenção', icone: AlertCircle },
  neutro: { valor: 'text-black', badge: 'bg-slate-100 border-slate-200 text-black', rotulo: 'Informativo', icone: MinusCircle },
};

// Cada linha da tabela. valor(h) = numero do indicador naquele mes (null = sem
// dado); formatar() mostra o numero; detalhes() sao os apoios que antes ficavam
// dentro do card.
interface Indicador {
  id: string;
  titulo: string;
  descricao: string;
  unidade: string;
  cor: string;
  valor: (h: MesHistorico) => number | null | undefined;
  formatar: (n: number) => string;
  detalhes: (h: MesHistorico) => { label: string; valor: string }[];
  limite?: { valor: number; rotulo: string };
}

const sinal = (n: number, casas = 1) => `${n >= 0 ? '+' : ''}${fmt(n, casas)}`;

const INDICADORES: Indicador[] = [
  {
    id: 'giro_lojas', titulo: 'Giro de Estoque — Lojas', unidade: 'x / mês', cor: '#B3838C',
    descricao: 'Estoque total das lojas dividido pela média mensal de venda (unidades).',
    valor: (h) => h.giro_lojas?.giro, formatar: (n) => fmt(n),
    detalhes: (h) => h.giro_lojas ? [
      { label: 'Estoque (unid.)', valor: fmt(h.giro_lojas.estoque_total, 0) },
      { label: 'Média mensal (unid.)', valor: fmt(h.giro_lojas.media_mensal, 0) },
    ] : [],
  },
  {
    id: 'giro_mp', titulo: 'Giro de Matéria Prima', unidade: 'meses de cobertura', cor: '#8B7AAA',
    descricao: 'Estoque de matéria-prima em R$ dividido pelo consumo do mês.',
    valor: (h) => h.giro_mp?.giro, formatar: (n) => fmt(n),
    detalhes: (h) => h.giro_mp ? [
      { label: 'Estoque MP (R$)', valor: fmtMoeda(h.giro_mp.estoque_valor) },
      { label: 'Consumo mês (R$)', valor: fmtMoeda(h.giro_mp.consumo_valor) },
    ] : [],
  },
  {
    id: 'giro_fabrica', titulo: 'Giro de Estoque — Fábrica', unidade: 'meses de cobertura', cor: '#5E8FA0',
    descricao: 'Estoque total da fábrica dividido pela média mensal (unidades).',
    valor: (h) => h.giro_fabrica?.giro, formatar: (n) => fmt(n, 1),
    detalhes: (h) => h.giro_fabrica ? [
      { label: 'Estoque (unid.)', valor: fmt(h.giro_fabrica.estoque_total, 0) },
      { label: 'Média mensal (unid.)', valor: fmt(h.giro_fabrica.media_mensal, 0) },
    ] : [],
  },
  {
    id: 'fat_fabrica', titulo: 'Faturamento Lojas + Fábrica', unidade: '% vs ano anterior', cor: '#7BAA8B',
    descricao: 'Crescimento do faturamento acumulado no ano contra o mesmo período do ano anterior.',
    valor: (h) => h.faturamento_fabrica?.crescimento_pct, formatar: (n) => sinal(n),
    detalhes: (h) => h.faturamento_fabrica ? [
      { label: 'Acum. ano atual', valor: fmtMoeda(h.faturamento_fabrica.acum_2026) },
      { label: 'Acum. ano ant.', valor: fmtMoeda(h.faturamento_fabrica.acum_2025) },
    ] : [],
  },
  {
    id: 'quebra', titulo: 'Quebra de Pedidos', unidade: '% do fat. fábrica', cor: '#8B6E5A',
    descricao: 'Valor de pedidos quebrados sobre o faturamento da fábrica no mês.',
    valor: (h) => h.quebra_pedidos?.quebra_pct, formatar: (n) => fmt(n, 2),
    detalhes: (h) => h.quebra_pedidos ? [
      { label: 'Quebra (R$)', valor: fmtMoeda(h.quebra_pedidos.quebra_valor) },
      { label: 'Fat. fábrica mês', valor: fmtMoeda(h.quebra_pedidos.faturamento_mes) },
    ] : [],
  },
  {
    id: 'volume', titulo: 'Volume x Varejo', unidade: '% de volume', cor: '#A07840',
    descricao: `Participação das vendas em volume no total. Limite ideal: ${fmt(LIMITE_VOLUME, 1)}%.`,
    valor: (h) => h.vendas_volume_varejo?.volume_pct, formatar: (n) => fmt(n, 2),
    limite: { valor: LIMITE_VOLUME, rotulo: 'Limite ideal' },
    detalhes: (h) => h.vendas_volume_varejo ? [
      { label: 'Volume (R$)', valor: fmtMoeda(h.vendas_volume_varejo.volume_valor) },
      { label: 'Varejo (R$)', valor: fmtMoeda(h.vendas_volume_varejo.varejo_valor) },
    ] : [],
  },
  {
    id: 'fat_ecom', titulo: 'Faturamento E-commerce', unidade: '% vs ano anterior', cor: '#C4895A',
    descricao: 'Crescimento do faturamento acumulado do e-commerce contra o ano anterior.',
    valor: (h) => h.faturamento_ecommerce?.crescimento_pct, formatar: (n) => sinal(n),
    detalhes: (h) => h.faturamento_ecommerce ? [
      { label: 'Acum. ano atual', valor: fmtMoeda(h.faturamento_ecommerce.acum_2026) },
      { label: 'Acum. ano ant.', valor: fmtMoeda(h.faturamento_ecommerce.acum_2025) },
    ] : [],
  },
  {
    id: 'roas', titulo: 'ROAS — Google Ads (CPC)', unidade: 'x de retorno', cor: '#4A7FA5',
    descricao: 'Receita gerada para cada R$ 1 investido em Google Ads (CPC).',
    valor: (h) => h.ecommerce_ads?.roas, formatar: (n) => fmt(n, 2),
    detalhes: (h) => h.ecommerce_ads ? [
      { label: 'Investido (R$)', valor: fmtMoeda(h.ecommerce_ads.custo) },
      { label: 'Receita (R$)', valor: fmtMoeda(h.ecommerce_ads.receita) },
    ] : [],
  },
  {
    id: 'conv', titulo: 'Taxa de Conversão — CPC', unidade: '% sessões → compra', cor: '#5A8A6A',
    descricao: 'Transações sobre sessões engajadas vindas de anúncios CPC.',
    valor: (h) => h.ecommerce_ads?.taxa_conv_pct, formatar: (n) => fmt(n, 2),
    detalhes: (h) => h.ecommerce_ads ? [
      { label: 'Sessões engajadas', valor: h.ecommerce_ads.sessoes_engajadas.toLocaleString('pt-BR') },
      { label: 'Transações', valor: h.ecommerce_ads.transacoes.toLocaleString('pt-BR') },
    ] : [],
  },
  {
    id: 'cmv', titulo: 'CMV % (Custo da Mercadoria)', unidade: '% da receita líquida', cor: '#9B5A5A',
    descricao: 'Custo das mercadorias vendidas sobre a receita líquida.',
    valor: (h) => h.cmv_pct?.cmv_pct, formatar: (n) => fmt(n, 1),
    detalhes: (h) => h.cmv_pct ? [
      { label: 'CMV (R$)', valor: fmtMoeda(h.cmv_pct.cmv_valor) },
      { label: 'Receita líq. (R$)', valor: fmtMoeda(h.cmv_pct.receita_liquida) },
    ] : [],
  },
  {
    id: 'lucro', titulo: 'Lucro Líquido — Empresas', unidade: '% com lucro > 0', cor: '#4A8B7A',
    descricao: 'Percentual de empresas do grupo com lucro líquido positivo no período.',
    valor: (h) => h.lucro_liq_pct?.pct_positivas, formatar: (n) => fmt(n, 1),
    detalhes: (h) => h.lucro_liq_pct ? [
      { label: 'Empresas c/ lucro', valor: `${h.lucro_liq_pct.empresas_positivas}/${h.lucro_liq_pct.total_empresas}` },
      { label: 'Período', valor: `Últ. ${h.lucro_liq_pct.periodo_meses} meses` },
    ] : [],
  },
  {
    id: 'sobra_mp', titulo: 'Sobra de MP', unidade: '% sobra / solicitada', cor: '#6A8B9B',
    descricao: 'Matéria-prima que sobrou em relação à quantidade solicitada.',
    valor: (h) => h.sobra_mp?.sobra_mp_pct, formatar: (n) => fmt(n, 2),
    detalhes: (h) => h.sobra_mp ? [
      { label: 'Sobra (unid.)', valor: fmt(h.sobra_mp.total_sobra, 0) },
      { label: 'Solicitada (unid.)', valor: fmt(h.sobra_mp.total_solicitada, 0) },
    ] : [],
  },
];

// Mini grafico da coluna "Tendência": ultimos 5 meses ate o mes selecionado.
function Tendencia({ pontos, cor }: { pontos: { rotulo: string; valor: number | null; selecionado: boolean }[]; cor: string }) {
  const validos = pontos.filter((p) => p.valor != null) as { valor: number }[];
  if (validos.length < 2) return <span className="text-xs text-black">—</span>;
  const W = 150, H = 34, PX = 10, PY = 5;
  const min = Math.min(...validos.map((p) => p.valor));
  const max = Math.max(...validos.map((p) => p.valor));
  const range = max - min || 1;
  const xs = (i: number) => PX + (i / (pontos.length - 1)) * (W - 2 * PX);
  const ys = (v: number) => PY + (1 - (v - min) / range) * (H - 2 * PY);
  const seg = pontos.map((p, i) => (p.valor != null ? `${xs(i)},${ys(p.valor)}` : null)).filter(Boolean).join(' ');
  return (
    <svg width={W} height={H + 14} className="block mx-auto">
      <polyline points={seg} fill="none" stroke={cor} strokeWidth={1.5} strokeOpacity={0.6} />
      {pontos.map((p, i) => p.valor != null && (
        <circle key={i} cx={xs(i)} cy={ys(p.valor)} r={p.selecionado ? 4 : 3} fill={cor} fillOpacity={p.selecionado ? 1 : 0.55} />
      ))}
      {pontos.map((p, i) => (
        <text key={i} x={xs(i)} y={H + 11} textAnchor="middle" fontSize={9} fill="#000000" fontWeight={p.selecionado ? 700 : 400}>
          {p.rotulo.split('/')[0]}
        </text>
      ))}
    </svg>
  );
}

// Grafico de linha grande (linha expandida): todos os meses do historico.
function GraficoLinha({ ind, historico, indiceSelecionado }: { ind: Indicador; historico: MesHistorico[]; indiceSelecionado: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(700);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pontos = historico.map((h, i) => ({ rotulo: fmtMesLabel(h.mes), valor: ind.valor(h) ?? null, i }));
  const validos = pontos.filter((p) => p.valor != null) as { rotulo: string; valor: number; i: number }[];
  if (validos.length < 2) {
    return <p className="text-sm text-black py-6 text-center">Histórico insuficiente para o gráfico (precisa de pelo menos 2 meses).</p>;
  }

  const H = 240, PL = 52, PR = 24, PT = 24, PB = 30;
  const todos = validos.map((p) => p.valor).concat(ind.limite ? [ind.limite.valor] : []);
  let min = Math.min(...todos), max = Math.max(...todos);
  const folga = (max - min || Math.abs(max) || 1) * 0.15;
  min -= folga; max += folga;
  const x = (i: number) => PL + (historico.length === 1 ? 0 : (i / (historico.length - 1)) * (W - PL - PR));
  const y = (v: number) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB);
  const ticks = Array.from({ length: 5 }, (_, k) => min + ((max - min) * k) / 4);
  const caminho = validos.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p.i)},${y(p.valor)}`).join(' ');

  return (
    <div ref={ref} className="w-full">
      <svg width={W} height={H} className="block">
        {ticks.map((t, k) => (
          <g key={k}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={PL - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#000000">{ind.formatar(t)}</text>
          </g>
        ))}
        {ind.limite && (
          <g>
            <line x1={PL} x2={W - PR} y1={y(ind.limite.valor)} y2={y(ind.limite.valor)} stroke="#B05030" strokeDasharray="5 4" strokeWidth={1.5} />
            <text x={W - PR} y={y(ind.limite.valor) - 5} textAnchor="end" fontSize={10} fill="#B05030">
              {ind.limite.rotulo}: {ind.formatar(ind.limite.valor)}
            </text>
          </g>
        )}
        <path d={caminho} fill="none" stroke={ind.cor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {validos.map((p) => {
          const sel = p.i === indiceSelecionado;
          return (
            <g key={p.i}>
              <circle cx={x(p.i)} cy={y(p.valor)} r={sel ? 6 : 4} fill={ind.cor} stroke="white" strokeWidth={2} />
              <text x={x(p.i)} y={y(p.valor) - 11} textAnchor="middle" fontSize={11} fill="#000000" fontWeight={sel ? 700 : 500}>
                {ind.formatar(p.valor)}
              </text>
            </g>
          );
        })}
        {pontos.map((p) => (
          <text key={p.i} x={x(p.i)} y={H - 8} textAnchor="middle" fontSize={11} fill="#000000" fontWeight={p.i === indiceSelecionado ? 700 : 400}>
            {p.rotulo}
          </text>
        ))}
      </svg>
    </div>
  );
}

function Variacao({ atual, anterior, ind }: { atual: number | null | undefined; anterior: number | null | undefined; ind: Indicador }) {
  if (atual == null || anterior == null) return <span className="text-black">—</span>;
  const d = atual - anterior;
  const Icone = Math.abs(d) < 0.005 ? Minus : d > 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-1 text-black">
      <Icone className="w-3.5 h-3.5" />
      {ind.formatar(Math.abs(d))}
    </span>
  );
}

export default function IndicadoresControladoriaPage() {
  const [historico, setHistorico] = useState<MesHistorico[]>([]);
  const [mesSelecionado, setMesSelecionado] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [sincAuto, setSincAuto] = useState(false);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [expandidoBalanco, setExpandidoBalanco] = useState<string | null>(null);
  const [entradaBalanco, setEntradaBalanco] = useState<EntradaIndicadoresBalanco | null>(null);
  const [erroBalanco, setErroBalanco] = useState<string | null>(null);
  const [prazosDfc, setPrazosDfc] = useState<{ pmr: number | null; pmp: number | null; pme: number | null; inicio: string; fim: string } | null>(null);
  const [erroDfc, setErroDfc] = useState<string | null>(null);

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
  const dadosAnterior = indiceSelecionado > 0 ? historico[indiceSelecionado - 1] : undefined;

  // Pills de meses: ano corrente ate hoje
  const mesesComCache = new Set(historico.map((h) => h.mes));
  const anoAtual = new Date().getFullYear();
  const mesesAno: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const iso = `${anoAtual}-${String(m).padStart(2, '0')}-01`;
    if (iso <= mesAtualISO) mesesAno.push(iso);
  }

  // Ultimos 5 meses terminando no selecionado (coluna Tendência)
  const janela = indiceSelecionado >= 0
    ? historico.slice(Math.max(0, indiceSelecionado - 4), indiceSelecionado + 1)
    : [];

  const COLUNAS = 7;

  // Indicadores financeiros do balanco: mesmas consultas da tela do Balanco
  // Patrimonial (todas as empresas), pro mes selecionado. E uma foto da
  // posicao atual - nao ha historico mensal desses indicadores, por isso nao
  // tem grafico de linha (ao clicar abre a memoria de calculo).
  const mesBalanco = dadosMes?.mes?.slice(0, 7) ?? null;
  useEffect(() => {
    if (!mesBalanco) return;
    let vivo = true;
    setEntradaBalanco(null);
    setErroBalanco(null);
    const dre = fetch(`/api/balanco-patrimonial/indicadores-dre?mesReferencia=${mesBalanco}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => (typeof d.lucroLiquido12m === 'number'
        ? { lucroLiquido12m: d.lucroLiquido12m, ebitda12m: d.ebitda12m, inicio: d.inicio, fim: d.fim }
        : null))
      .catch(() => null);
    fetch(`/api/balanco-patrimonial/dados?mesReferencia=${mesBalanco}`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d.error || !d.valores) throw new Error(d.error || d.detail || 'Erro ao buscar o balanço patrimonial');
        return d;
      })
      .then(async (d) => {
        const dreVal = await dre;
        if (!vivo) return;
        setEntradaBalanco({
          valores: montarValoresBalanco(d.valores),
          caixaDisponivel: typeof d.caixaDisponivel === 'number' ? d.caixaDisponivel : null,
          chequeEspecial: Number(d.chequeEspecial ?? 0),
          dre: dreVal,
        });
      })
      .catch((e) => { if (vivo) setErroBalanco(e instanceof Error ? e.message : 'Erro ao buscar o balanço patrimonial'); });
    return () => { vivo = false; };
  }, [mesBalanco]);

  // Prazos medios da DFC (mesma consulta da tela da DFC, visao mensal
  // consolidada): periodo = mes selecionado inteiro; se for o mes corrente
  // (ainda aberto), usa o ultimo mes fechado - igual ao padrao da tela da DFC.
  const periodoDfc = (() => {
    if (!mesBalanco) return null;
    let [a, m] = mesBalanco.split('-').map(Number);
    const hoje = new Date();
    if (a === hoje.getFullYear() && m === hoje.getMonth() + 1) {
      m -= 1;
      if (m === 0) { m = 12; a -= 1; }
    }
    const ultimo = new Date(a, m, 0).getDate();
    const mm = String(m).padStart(2, '0');
    return { inicio: `${a}-${mm}-01`, fim: `${a}-${mm}-${String(ultimo).padStart(2, '0')}` };
  })();
  const inicioDfc = periodoDfc?.inicio ?? null;
  const fimDfc = periodoDfc?.fim ?? null;
  useEffect(() => {
    if (!inicioDfc || !fimDfc) return;
    let vivo = true;
    setPrazosDfc(null);
    setErroDfc(null);
    const controller = new AbortController();
    const params = new URLSearchParams({ dataInicio: inicioDfc, dataFim: fimDfc, filtro: 'consolidado', semAntecipacao: 'false' });
    fetch(`/api/dfc/unificada?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!vivo) return;
        if (d.error || !d.metadata) throw new Error(d.error || 'Erro ao buscar os prazos médios da DFC');
        setPrazosDfc({
          pmr: d.metadata.prazoMedioRecebimento ?? null,
          pmp: d.metadata.prazoMedioPagamento ?? null,
          pme: d.metadata.prazoMedioEstocagem ?? null,
          inicio: inicioDfc,
          fim: fimDfc,
        });
      })
      .catch((e) => { if (vivo && e?.name !== 'AbortError') setErroDfc(e instanceof Error ? e.message : 'Erro ao buscar os prazos médios da DFC'); });
    return () => { vivo = false; controller.abort(); };
  }, [inicioDfc, fimDfc]);

  const cicloFinanceiro =
    prazosDfc && prazosDfc.pmr !== null && prazosDfc.pme !== null && prazosDfc.pmp !== null
      ? prazosDfc.pmr + prazosDfc.pme - prazosDfc.pmp
      : null;
  const fmtDias = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${n.toFixed(1)} dias`);
  const linhasDfc: { id: string; titulo: string; valor: string; calculo: string; verde?: boolean }[] = prazosDfc ? [
    { id: 'pmr', titulo: 'Prazo Médio de Recebimento', valor: fmtDias(prazosDfc.pmr), calculo: 'Prazo médio, em dias, entre a venda e o recebimento dos clientes no período.' },
    { id: 'pmp', titulo: 'Prazo Médio de Pagamento', valor: fmtDias(prazosDfc.pmp), calculo: 'Prazo médio, em dias, entre a compra e o pagamento aos fornecedores no período.' },
    { id: 'pme', titulo: 'Prazo Médio de Estocagem', valor: fmtDias(prazosDfc.pme), calculo: 'Quantidade média em estoque (1º dia + último dia do último mês, dividido por 2) sobre a quantidade faturada no mesmo mês (todas as lojas), multiplicado pelos dias do mês.' },
    {
      id: 'ciclo', titulo: 'Ciclo Financeiro', valor: fmtDias(cicloFinanceiro), verde: cicloFinanceiro !== null && cicloFinanceiro < 0,
      calculo: `PMR + PME − PMP${cicloFinanceiro !== null ? ` = ${prazosDfc.pmr!.toFixed(1)} + ${prazosDfc.pme!.toFixed(1)} − ${prazosDfc.pmp!.toFixed(1)}` : ''}. Quantos dias, em média, a empresa financia a operação com capital próprio antes de recuperar o dinheiro em caixa.`,
    },
  ] : [];

  const indicadoresBalanco = entradaBalanco ? calcularIndicadoresBalanco(entradaBalanco) : [];

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-brand-dark">INDICADORES DE CONTROLADORIA</h1>
          {dadosMes?.atualizado_em && (
            <p className="text-xs text-black mt-1">
              Dados atualizados em: {new Date(dadosMes.atualizado_em).toLocaleString('pt-BR')}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          {mesesAno.map((iso) => {
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
                    ? 'bg-white text-black border-gray-200 hover:border-brand-primary hover:text-brand-primary'
                    : 'bg-gray-50 text-black border-gray-100 cursor-not-allowed'
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

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-600 text-white text-left">
              <th className="w-10 px-3 py-3" />
              <th className="px-4 py-3 font-semibold">Indicador</th>
              <th className="px-4 py-3 font-semibold text-right whitespace-nowrap">
                Realizado{dadosMes ? ` (${fmtMesLabel(dadosMes.mes)})` : ''}
              </th>
              <th className="px-4 py-3 font-semibold text-right whitespace-nowrap">Mês anterior</th>
              <th className="px-4 py-3 font-semibold text-right whitespace-nowrap">Variação</th>
              <th className="px-4 py-3 font-semibold">Detalhes</th>
              <th className="px-4 py-3 font-semibold text-center whitespace-nowrap">Tendência (5m)</th>
            </tr>
          </thead>
          <tbody>
            {carregando && !dadosMes ? (
              <tr>
                <td colSpan={COLUNAS} className="py-12 text-center text-black">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                  Carregando...
                </td>
              </tr>
            ) : !dadosMes ? (
              <tr>
                <td colSpan={COLUNAS} className="py-12 text-center text-black">Sem dados — clique em Atualizar Dados para gerar.</td>
              </tr>
            ) : (
              INDICADORES.map((ind) => {
                const atual = ind.valor(dadosMes);
                const anterior = dadosAnterior ? ind.valor(dadosAnterior) : null;
                const aberto = expandido === ind.id;
                const acimaLimite = ind.limite && atual != null && atual > ind.limite.valor;
                const pontos = janela.map((h) => ({
                  rotulo: fmtMesLabel(h.mes),
                  valor: ind.valor(h) ?? null,
                  selecionado: h.mes === dadosMes.mes,
                }));
                return (
                  <React.Fragment key={ind.id}>
                    <tr
                      onClick={() => setExpandido(aberto ? null : ind.id)}
                      className={`border-t border-gray-100 cursor-pointer transition ${aberto ? 'bg-gray-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-3 py-4 text-black">
                        <ChevronRight className={`w-4 h-4 transition-transform ${aberto ? 'rotate-90' : ''}`} />
                      </td>
                      <td className="px-4 py-4 max-w-[420px]">
                        <p className="font-semibold text-black">{ind.titulo}</p>
                        <p className="text-xs text-black mt-0.5">{ind.descricao}</p>
                      </td>
                      <td className="px-4 py-4 text-right whitespace-nowrap">
                        <p className={`font-semibold text-base ${acimaLimite ? 'text-orange-700' : 'text-black'}`}>
                          {atual != null ? ind.formatar(atual) : '—'}{acimaLimite ? ' ⚠' : ''}
                        </p>
                        <p className="text-xs text-black">{ind.unidade}</p>
                      </td>
                      <td className="px-4 py-4 text-right whitespace-nowrap text-black">
                        {anterior != null ? ind.formatar(anterior) : '—'}
                      </td>
                      <td className="px-4 py-4 text-right whitespace-nowrap">
                        <Variacao atual={atual} anterior={anterior} ind={ind} />
                      </td>
                      <td className="px-4 py-4">
                        <div className="space-y-0.5">
                          {ind.detalhes(dadosMes).map((d) => (
                            <div key={d.label} className="flex justify-between gap-6 text-xs">
                              <span className="text-black">{d.label}</span>
                              <span className="font-medium text-black whitespace-nowrap">{d.valor}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Tendencia pontos={pontos} cor={ind.cor} />
                      </td>
                    </tr>
                    {aberto && (
                      <tr className="bg-gray-50 border-t border-gray-100">
                        <td colSpan={COLUNAS} className="px-6 py-4">
                          <p className="text-sm font-semibold text-black mb-2">
                            {ind.titulo} — evolução mensal <span className="font-normal text-black">({ind.unidade})</span>
                          </p>
                          <GraficoLinha ind={ind} historico={historico} indiceSelecionado={indiceSelecionado} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-bold text-black">Indicadores financeiros — Balanço Patrimonial</h2>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-600 text-white text-left">
                <th className="w-10 px-3 py-3" />
                <th className="px-4 py-3 font-semibold">Indicador</th>
                <th className="px-4 py-3 font-semibold text-right whitespace-nowrap">Realizado</th>
                <th className="px-4 py-3 font-semibold">Meta</th>
                <th className="px-4 py-3 font-semibold">Cálculo</th>
                <th className="px-4 py-3 font-semibold text-center">Situação</th>
              </tr>
            </thead>
            <tbody>
              {erroBalanco ? (
                <tr><td colSpan={6} className="py-10 text-center text-black">{erroBalanco}</td></tr>
              ) : !entradaBalanco ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-black">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Carregando...
                  </td>
                </tr>
              ) : (
                indicadoresBalanco.map((ind) => {
                  const aberto = expandidoBalanco === ind.id;
                  const st = ESTILOS_STATUS[ind.status];
                  const IconeSt = st.icone;
                  return (
                    <React.Fragment key={ind.id}>
                      <tr
                        onClick={() => setExpandidoBalanco(aberto ? null : ind.id)}
                        className={`border-t border-gray-100 cursor-pointer transition ${aberto ? 'bg-gray-50' : 'hover:bg-gray-50'}`}
                      >
                        <td className="px-3 py-4 text-black">
                          <ChevronRight className={`w-4 h-4 transition-transform ${aberto ? 'rotate-90' : ''}`} />
                        </td>
                        <td className="px-4 py-4 font-semibold text-black whitespace-nowrap">{ind.titulo}</td>
                        <td className={`px-4 py-4 text-right font-semibold text-base whitespace-nowrap ${st.valor}`}>{ind.valor}</td>
                        <td className="px-4 py-4 text-black">{ind.meta}</td>
                        <td className="px-4 py-4 text-xs text-black max-w-[520px]">{ind.detalhe}</td>
                        <td className="px-4 py-4 text-center">
                          <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold ${st.badge}`}>
                            <IconeSt className="w-3.5 h-3.5" />{st.rotulo}
                          </span>
                        </td>
                      </tr>
                      {aberto && (
                        <tr className="bg-gray-50 border-t border-gray-100">
                          <td colSpan={6} className="px-6 py-4">
                            <p className="text-sm font-semibold text-black mb-2">Memória de cálculo — {ind.titulo}</p>
                            <table className="text-sm max-w-xl">
                              <tbody>
                                {ind.memoria.map((l) => (
                                  <tr key={l.t} className={l.forte ? 'font-bold border-t border-gray-300' : ''}>
                                    <td className="py-1 pr-8 text-black">{l.t}</td>
                                    <td className="py-1 text-right text-black whitespace-nowrap">{l.v}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-bold text-black">
          Indicadores financeiros — DFC
          {periodoDfc && (
            <span className="ml-2 text-sm font-normal text-black">
              (período {periodoDfc.inicio.split('-').reverse().join('/')} a {periodoDfc.fim.split('-').reverse().join('/')} · consolidado)
            </span>
          )}
        </h2>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-600 text-white text-left">
                <th className="px-4 py-3 font-semibold">Indicador</th>
                <th className="px-4 py-3 font-semibold text-right whitespace-nowrap">Realizado</th>
                <th className="px-4 py-3 font-semibold">Cálculo</th>
              </tr>
            </thead>
            <tbody>
              {erroDfc ? (
                <tr><td colSpan={3} className="py-10 text-center text-black">{erroDfc}</td></tr>
              ) : !prazosDfc ? (
                <tr>
                  <td colSpan={3} className="py-10 text-center text-black">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Carregando...
                  </td>
                </tr>
              ) : (
                linhasDfc.map((l) => (
                  <tr key={l.id} className="border-t border-gray-100">
                    <td className="px-4 py-4 font-semibold text-black whitespace-nowrap">{l.titulo}</td>
                    <td className={`px-4 py-4 text-right font-semibold text-base whitespace-nowrap ${l.verde ? 'text-green-600' : 'text-black'}`}>{l.valor}</td>
                    <td className="px-4 py-4 text-xs text-black max-w-[640px]">{l.calculo}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
