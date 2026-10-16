'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Banknote, ChevronDown, Loader2, Settings, X, RotateCcw,
  ArrowUp, ArrowDown, ArrowUpDown, Landmark,
  Wallet, TrendingUp, TrendingDown, AlertCircle, CalendarRange,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LabelProps } from 'recharts';
import { carregarFiltro, salvarFiltro } from '../utils/persistirFiltro';

interface EmpresaFC {
  id: number;
  nome: string;
}

interface VencidoFC {
  prefixo: string;
  qtd: number;
  valor: number;
}

interface MesFC {
  mes: string;
  previsao: number;
  real: number;
  pedidos: number;
  totalSaidas: number;
  cartao: number;
  boleto: number;
  cheque: number;
  lojas: number;
  outrasEntradas: number;
  multimarcas: number;
  qtd: number;
}

interface DiaFC {
  dia: string;
  previsao: number;
  real: number;
  pedidos: number;
  totalSaidas: number;
  cartao: number;
  boleto: number;
  cheque: number;
  lojas: number;
  outrasEntradas: number;
  multimarcas: number;
  qtd: number;
  saldoAcum: number;
}

interface DadosFC {
  vencidos: VencidoFC[];
  totalVencido: number;
  kpi30: number;
  kpi90: number;
  kpi180: number;
  meses: MesFC[];
  dias: DiaFC[];
  saldoBancario: number;
  geradoEm: string;
}

interface ContaBancaria {
  nmBanco: string;
  nrAgencia: string;
  nrConta: string;
  vlSaldo: number;
  dtPosicao: string;
  semDados?: boolean;
}

interface SaldosBancarios {
  contas: ContaBancaria[];
  total: number;
}

interface FaturaDescontada {
  nrFat: number;
  nrParcela: number;
}

interface SaidaFornecedor {
  cdFornecedor: number | null;
  nome: string;
  valor: number;
  qtd: number;
}

interface SaidaDespesa {
  cdDespesaItem: number | null;
  nome: string;
  valor: number;
  qtd: number;
}

interface BoletoDetalheItem {
  cliente: string;
  nrFat: number;
  nrParcela: number;
  dtVencimentoOriginal: string;
  valor: number;
}

type ColKey = 'previsao' | 'real' | 'pedidos' | 'cartao' | 'boleto' | 'cheque' | 'lojas' | 'outrasEntradas' | 'multimarcas';

const FILTRO_KEY = 'fluxo_caixa_filtros_v1';

const COL_DEFS: { group: string; cols: { key: ColKey; label: string; color: string }[] }[] = [
  { group: 'Saídas', cols: [
    { key: 'previsao', label: 'Prev.', color: '#ef4444' },
    { key: 'real', label: 'Real', color: '#991b1b' },
    { key: 'pedidos', label: 'Pedidos', color: '#dc2626' },
  ]},
  // Cartao e Multimarcas tirados temporariamente (pedido explicito do
  // usuario) - nem aparecem na tabela nem compoem o saldo, so volta se
  // pedir de novo. Os dados continuam vindo da API, so nao sao usados aqui.
  { group: 'Entradas', cols: [
    { key: 'outrasEntradas', label: 'Outras Entradas', color: '#7c3aed' },
    { key: 'boleto', label: 'Boleto', color: '#0284c7' },
    { key: 'cheque', label: 'Cheque', color: '#059669' },
    { key: 'lojas', label: 'Lojas', color: '#0891b2' },
  ]},
];

function isoHoje(offsetDias = 0): string {
  return new Date(Date.now() + offsetDias * 86400000).toISOString().slice(0, 10);
}

// Atalhos de periodo - mesmo estilo/posicao dos atalhos ja usados em DRE/
// DFC/CMV Detalhado (componente AtalhosPeriodo), mas voltados pra FRENTE
// (fluxo de caixa e projecao, nao historico fechado) - por isso nao reusa
// aqueles atalhos (Mes Anterior, Ultimos N Meses etc sao todos passados).
// Cada atalho e recalculado em cima do "hoje" de verdade sempre que
// aplicado - inclusive ao restaurar o ultimo filtro salvo (ver useEffect
// de carregamento), pra nunca reabrir com uma janela defasada.
const ATALHOS_PERIODO_FC: { id: string; label: string; calcular: () => { dtInicio: string; dtFim: string } }[] = [
  { id: 'hoje', label: 'Hoje', calcular: () => ({ dtInicio: isoHoje(), dtFim: isoHoje() }) },
  { id: '7d', label: 'Próximos 7 Dias', calcular: () => ({ dtInicio: isoHoje(), dtFim: isoHoje(7) }) },
  { id: '15d', label: 'Próximos 15 Dias', calcular: () => ({ dtInicio: isoHoje(), dtFim: isoHoje(15) }) },
  { id: '30d', label: 'Próximos 30 Dias', calcular: () => ({ dtInicio: isoHoje(), dtFim: isoHoje(30) }) },
  { id: '60d', label: 'Próximos 60 Dias', calcular: () => ({ dtInicio: isoHoje(), dtFim: isoHoje(60) }) },
  { id: '90d', label: 'Próximos 90 Dias', calcular: () => ({ dtInicio: isoHoje(), dtFim: isoHoje(90) }) },
  { id: 'mes', label: 'Este Mês', calcular: () => {
      const hoje = new Date();
      const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
      return { dtInicio: isoHoje(), dtFim: fimMes.toISOString().slice(0, 10) };
    } },
];

function fmtBRL(valor: number | null | undefined, decimais = 2): string {
  if (valor == null || isNaN(valor)) return '—';
  const sinal = valor < 0 ? '-' : '';
  const abs = Math.abs(valor);
  return `${sinal}R$ ${abs.toLocaleString('pt-BR', { minimumFractionDigits: decimais, maximumFractionDigits: decimais })}`;
}

function fmtNum(valor: number | null | undefined): string {
  if (valor == null || isNaN(valor)) return '—';
  return valor.toLocaleString('pt-BR');
}

// Rotulo compacto pro grafico (R$ 4,9 mi em vez de R$ 4.943.000) - full
// precision ja fica no tooltip, o rotulo so precisa dar a ordem de grandeza
// sem lotar a barra de texto.
function fmtBRLCompacto(valor: number | null | undefined): string {
  if (valor == null || isNaN(valor)) return '—';
  const sinal = valor < 0 ? '-' : '';
  const abs = Math.abs(valor);
  return `${sinal}R$ ${abs.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })}`;
}

function fmtMes(ym: string): string {
  const [y, m] = ym.split('-');
  const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${MESES[parseInt(m, 10) - 1]}/${y.slice(2)}`;
}

interface MesFCComSaldo extends MesFC {
  totalEntradas: number;
  saldoAcumulado: number;
  // Saidas plotadas abaixo do zero (coluna unica: entradas sobem, saidas
  // descem) - so pro desenho; valores exibidos continuam vindo de totalSaidas.
  saidasAbaixoZero: number;
}

interface TooltipMesPayload {
  payload: MesFCComSaldo;
}

const COR_SAIDAS = '#dc2626';
const COR_ENTRADAS = '#059669';
const COR_SALDO = '#2563eb';

function LinhaTooltip({ cor, rotulo, valor, detalhe, forte }: { cor?: string; rotulo: string; valor: number; detalhe?: boolean; forte?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-6 ${detalhe ? 'pl-4 text-gray-500' : 'text-gray-900'}`}>
      <span className="flex items-center gap-1.5">
        {cor && <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: cor }} />}
        {rotulo}
      </span>
      <span className={`tabular-nums ${forte ? 'font-semibold' : ''}`}>{fmtBRL(valor)}</span>
    </div>
  );
}

function TooltipMes({ active, payload }: { active?: boolean; payload?: TooltipMesPayload[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const m = payload[0].payload;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2.5 text-xs space-y-1 min-w-[260px]">
      <p className="font-semibold text-gray-900 mb-1.5">{fmtMes(m.mes)}</p>
      <LinhaTooltip cor={COR_ENTRADAS} rotulo="Entradas" valor={m.totalEntradas} forte />
      <LinhaTooltip rotulo="Outras entradas" valor={m.outrasEntradas} detalhe />
      <LinhaTooltip rotulo="Boleto" valor={m.boleto} detalhe />
      <LinhaTooltip rotulo="Cheque" valor={m.cheque} detalhe />
      <LinhaTooltip rotulo="Lojas" valor={m.lojas} detalhe />
      <div className="pt-1" />
      <LinhaTooltip cor={COR_SAIDAS} rotulo="Saídas" valor={m.totalSaidas} forte />
      <LinhaTooltip rotulo="Real" valor={m.real} detalhe />
      <LinhaTooltip rotulo="Previsão" valor={m.previsao} detalhe />
      <LinhaTooltip rotulo="Pedidos" valor={m.pedidos} detalhe />
      <div className="border-t border-gray-100 mt-1.5 pt-1.5">
        <LinhaTooltip cor={COR_SALDO} rotulo="Saldo acumulado" valor={m.saldoAcumulado} forte />
      </div>
    </div>
  );
}

// Rotulos nas pontas da coluna: entrada acima do topo do verde, saida abaixo
// da base do vermelho, saldo numa pilula sobre o ponto azul. Desenhados a mao
// (<text> puro) porque o rotulo padrao do recharts quebra o texto na largura
// da barra.
function caixaRotulo(props: LabelProps) {
  const vb = (props.viewBox ?? {}) as { x?: number; y?: number; width?: number; height?: number };
  return {
    x: Number(vb.x ?? props.x ?? 0),
    y: Number(vb.y ?? props.y ?? 0),
    width: Number(vb.width ?? props.width ?? 0),
    height: Number(vb.height ?? props.height ?? 0),
    valor: Number(props.value ?? 0),
  };
}

function RotuloEntrada(props: LabelProps) {
  const { x, y, width, height, valor } = caixaRotulo(props);
  if (!valor) return null;
  const topo = Math.min(y, y + height);
  return (
    <text x={x + width / 2} y={topo - 9} textAnchor="middle" fontSize={14} fontWeight={600} fill="#065f46">
      {fmtBRLCompacto(valor)}
    </text>
  );
}

function RotuloSaida(props: LabelProps) {
  const { x, y, width, height, valor } = caixaRotulo(props);
  if (!valor) return null;
  const base = Math.max(y, y + height);
  return (
    <text x={x + width / 2} y={base + 21} textAnchor="middle" fontSize={14} fontWeight={600} fill="#991b1b">
      {fmtBRLCompacto(Math.abs(valor))}
    </text>
  );
}

// Com muitos meses (colunas estreitas) a pilula grande encosta na do mes
// vizinho - acima de 8 meses usa a versao compacta.
function desenharPilulaSaldo(props: LabelProps, compacto: boolean) {
  const { x, y, valor } = caixaRotulo(props);
  const texto = fmtBRLCompacto(valor);
  const fonte = compacto ? 11 : 13;
  const altura = compacto ? 18 : 22;
  const largura = texto.length * (compacto ? 6.1 : 7.3) + (compacto ? 10 : 14);
  return (
    <g>
      <rect x={x - largura / 2} y={y - altura - 11} width={largura} height={altura} rx={altura / 2} fill="#ffffff" stroke={COR_SALDO} strokeWidth={1} />
      <text x={x} y={y - 11 - altura / 2 + fonte * 0.36} textAnchor="middle" fontSize={fonte} fontWeight={600} fill={valor >= 0 ? '#1e3a8a' : '#b91c1c'}>
        {texto}
      </text>
    </g>
  );
}

const RotuloSaldo = (props: LabelProps) => desenharPilulaSaldo(props, false);
const RotuloSaldoCompacto = (props: LabelProps) => desenharPilulaSaldo(props, true);

function GraficoMensalFC({ meses, saldoBancario }: { meses: MesFC[]; saldoBancario: number }) {
  if (!meses.length) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem dados no período.</p>;
  }
  // Saldo acumulado parte do saldo bancario real (mesma base da coluna
  // "Saldo Acum." da tabela diaria) e vai somando o resultado (entradas -
  // saidas) de cada mes, em ordem - nao e o resultado isolado do mes.
  // Cartao e Multimarcas tirados temporariamente (pedido explicito do
  // usuario) - nao contam nem aqui nem na tabela diaria, so volta se
  // pedir de novo.
  let acumulado = saldoBancario;
  const dados: MesFCComSaldo[] = meses.map((m) => {
    const totalEntradas = m.outrasEntradas + m.boleto + m.cheque + m.lojas;
    acumulado += totalEntradas - m.totalSaidas;
    return { ...m, totalEntradas, saldoAcumulado: acumulado, saidasAbaixoZero: -m.totalSaidas };
  });
  return (
    <div role="img" aria-label="Saídas, entradas e saldo acumulado projetados por mês">
      <div className="flex items-center gap-5 mb-3 text-xs text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: COR_ENTRADAS }} /> Entradas (acima do zero)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: COR_SAIDAS }} /> Saídas (abaixo do zero)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="relative w-4 h-0.5 rounded-full inline-block" style={{ backgroundColor: COR_SALDO }}>
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full ring-2 ring-white" style={{ backgroundColor: COR_SALDO }} />
          </span>
          Saldo acumulado
        </span>
      </div>
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={dados} margin={{ top: 28, right: 24, left: 4, bottom: 4 }} barCategoryGap="35%" stackOffset="sign">
          <CartesianGrid stroke="#f1f2f4" vertical={false} />
          <XAxis dataKey="mes" tickFormatter={fmtMes} axisLine={false} tickLine={false} interval={0} tick={{ fontSize: 13, fill: '#374151', fontWeight: 600 }} dy={6} />
          <YAxis
            tickFormatter={(v: number) => fmtBRLCompacto(v)} tick={{ fontSize: 12, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={88}
            padding={{ top: 28, bottom: 32 }}
          />
          <ReferenceLine y={0} stroke="#9ca3af" />
          <Tooltip content={<TooltipMes />} cursor={{ fill: '#f3f4f6', radius: 6 }} />
          <Bar dataKey="totalEntradas" name="Entradas" stackId="fluxo" fill={COR_ENTRADAS} radius={[6, 6, 0, 0]} maxBarSize={108}>
            <LabelList dataKey="totalEntradas" content={RotuloEntrada} />
          </Bar>
          <Bar dataKey="saidasAbaixoZero" name="Saídas" stackId="fluxo" fill={COR_SAIDAS} radius={[6, 6, 0, 0]} maxBarSize={108}>
            <LabelList dataKey="saidasAbaixoZero" content={RotuloSaida} />
          </Bar>
          <Line
            type="monotone" dataKey="saldoAcumulado" name="Saldo acumulado" stroke={COR_SALDO} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round"
            dot={{ r: 4, fill: COR_SALDO, stroke: '#ffffff', strokeWidth: 2 }}
            activeDot={{ r: 6, fill: COR_SALDO, stroke: '#ffffff', strokeWidth: 2 }}
          >
            <LabelList dataKey="saldoAcumulado" content={dados.length > 8 ? RotuloSaldoCompacto : RotuloSaldo} />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Lista ranqueada estilo "barra horizontal com rotulo" (valor a esquerda,
// barra proporcional ao maior valor da lista, nome a direita) - mesmo
// layout do relatorio de referencia que o usuario pediu pra replicar aqui.
// Resumo do periodo em forma de "conta": componentes de entrada somam no
// total de recebimentos, componentes de saida no total de pagamentos, e os
// dois fecham no saldo final (saldo inicial + recebimentos - pagamentos).
// Usa os mesmos totais do rodape da Visao Diaria, entao respeita os toggles
// de coluna e a simulacao - coluna desligada aparece riscada, valendo 0.
interface ParcelaResumo {
  rotulo: string;
  valor: number;
  ativa: boolean;
}

function Operador({ simbolo }: { simbolo: string }) {
  return (
    <span className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 text-gray-500 text-lg font-semibold flex items-center justify-center" aria-hidden="true">
      {simbolo}
    </span>
  );
}

function LinhaEquacao({ parcelas, rotuloTotal, total, tom }: { parcelas: ParcelaResumo[]; rotuloTotal: string; total: number; tom: 'entrada' | 'saida' }) {
  const estiloTotal = tom === 'entrada'
    ? 'bg-green-50 border-green-200 text-green-800'
    : 'bg-red-50 border-red-200 text-red-800';
  const corBarra = tom === 'entrada' ? 'bg-green-500' : 'bg-red-500';
  return (
    <div className="flex items-stretch gap-2 flex-wrap">
      {parcelas.map((p, i) => (
        <React.Fragment key={p.rotulo}>
          {i > 0 && <div className="flex items-center"><Operador simbolo="+" /></div>}
          <div className={`relative min-w-[175px] flex-1 rounded-lg border border-gray-200 bg-white px-4 py-3 overflow-hidden ${p.ativa ? '' : 'opacity-60'}`}
            title={p.ativa ? undefined : 'Coluna desligada nos filtros - não entra no cálculo'}>
            <span className={`absolute left-0 top-0 bottom-0 w-1 ${corBarra}`} />
            <p className="text-base text-gray-500">{p.rotulo}</p>
            <p className={`text-xl font-semibold text-gray-900 tabular-nums whitespace-nowrap ${p.ativa ? '' : 'line-through'}`}>{fmtBRL(p.valor)}</p>
          </div>
        </React.Fragment>
      ))}
      <div className="flex items-center"><Operador simbolo="=" /></div>
      <div className={`min-w-[210px] flex-1 rounded-lg border px-4 py-3 ${estiloTotal}`}>
        <p className="text-base font-medium opacity-80">{rotuloTotal}</p>
        <p className="text-2xl font-bold tabular-nums whitespace-nowrap">{fmtBRL(total)}</p>
      </div>
    </div>
  );
}

function ResumoPeriodoFC({ entradas, saidas, totalEntradas, totalSaidas, saldoInicial, dtIni, dtFim }: {
  entradas: ParcelaResumo[]; saidas: ParcelaResumo[]; totalEntradas: number; totalSaidas: number;
  saldoInicial: number; dtIni: string; dtFim: string;
}) {
  const saldoFinal = saldoInicial + totalEntradas - totalSaidas;
  const positivo = saldoFinal >= 0;
  const fmtDia = (iso: string) => iso.split('-').reverse().join('/');
  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Resumo do Período</h2>
        {dtIni && <span className="text-sm text-gray-500 tabular-nums">{fmtDia(dtIni)} a {fmtDia(dtFim)}</span>}
      </div>
      <div className="p-4 grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-3 min-w-0">
          <LinhaEquacao parcelas={entradas} rotuloTotal="Total de recebimentos" total={totalEntradas} tom="entrada" />
          <LinhaEquacao parcelas={saidas} rotuloTotal="Total de pagamentos" total={totalSaidas} tom="saida" />
        </div>
        <div className={`rounded-xl border-2 p-4 flex flex-col md:flex-row md:items-center md:justify-between xl:flex-col xl:items-stretch xl:justify-center gap-3 ${positivo ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'}`}>
          <div>
            <p className="text-sm font-medium text-gray-600">Saldo final do período</p>
            <p className={`text-4xl font-bold whitespace-nowrap mt-0.5 ${positivo ? 'text-green-700' : 'text-red-700'}`}>{fmtBRL(saldoFinal)}</p>
          </div>
          <div className="pt-3 border-t md:pt-0 md:border-t-0 md:pl-4 md:border-l xl:pl-0 xl:border-l-0 xl:pt-3 xl:border-t border-gray-200 space-y-1 text-sm tabular-nums md:min-w-[300px] xl:min-w-0">
            <div className="flex justify-between gap-3 text-gray-600"><span>Saldo inicial</span><span>{fmtBRL(saldoInicial)}</span></div>
            <div className="flex justify-between gap-3 text-green-700"><span>+ Recebimentos</span><span>{fmtBRL(totalEntradas)}</span></div>
            <div className="flex justify-between gap-3 text-red-700"><span>− Pagamentos</span><span>{fmtBRL(totalSaidas)}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Ranking "nome+valor em cima, barra fina embaixo" - padrao mais usado em
// dashboards financeiros (Stripe/Linear-style) pra resolver o problema do
// layout antigo: nome e valor ficavam na MESMA linha que a barra, entao
// nomes compridos (ex: "SECRETARIA DA RECEITA FEDERAL...") eram cortados
// de forma feia quando a barra crescia. Com nome/valor na propria linha,
// so competem entre si - a barra nunca rouba espaco do texto.
function ListaBarrasRanking({ itens, cor }: { itens: { nome: string; valor: number }[]; cor: string }) {
  if (!itens.length) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem dados no período.</p>;
  }
  const maxValor = Math.max(...itens.map((i) => i.valor), 1);
  return (
    <div className="max-h-[700px] overflow-y-auto pr-1 -mx-2 space-y-0.5">
      {itens.map((item, i) => (
        <div key={`${item.nome}-${i}`} className="flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-gray-50 transition-colors">
          <span className="w-5 flex-shrink-0 text-right text-xs text-gray-400 tabular-nums pt-0.5">{i + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-black truncate" title={item.nome}>{item.nome}</span>
              <span className="text-sm font-semibold text-black tabular-nums flex-shrink-0">{fmtBRL(-item.valor)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mt-1.5">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(3, (item.valor / maxValor) * 100)}%`, backgroundColor: cor }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function FluxoCaixaPage() {
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaFC[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<Set<number>>(new Set());
  const [filtroEmpresasAberto, setFiltroEmpresasAberto] = useState(false);

  const [dtInicio, setDtInicio] = useState(isoHoje());
  const [dtFim, setDtFim] = useState(isoHoje(30));
  const [ultimoAtalho, setUltimoAtalho] = useState<string | null>(null);

  const [dados, setDados] = useState<DadosFC | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [saidasFornecedor, setSaidasFornecedor] = useState<SaidaFornecedor[]>([]);
  const [saidasDespesa, setSaidasDespesa] = useState<SaidaDespesa[]>([]);
  const [saldosBancarios, setSaldosBancarios] = useState<SaldosBancarios | null>(null);
  const [sortKey, setSortKey] = useState<'nome' | 'valor'>('valor');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [colsAtivas, setColsAtivas] = useState<Record<ColKey, boolean>>({
    previsao: true, real: true, pedidos: true,
    cartao: true, boleto: true, cheque: true, lojas: true, outrasEntradas: true, multimarcas: true,
  });

  const [crescMulti, setCrescMulti] = useState(0);
  const [inflacaoMulti, setInflacaoMulti] = useState(0);
  const [crescLojas, setCrescLojas] = useState(0);

  const [lojasModalAberto, setLojasModalAberto] = useState(false);
  const [lojasPaste, setLojasPaste] = useState('');
  const [lojasStatus, setLojasStatus] = useState('');
  const [lojasSalvando, setLojasSalvando] = useState(false);

  const [outrasEntradasModalAberto, setOutrasEntradasModalAberto] = useState(false);
  const [outrasEntradasPaste, setOutrasEntradasPaste] = useState('');
  const [outrasEntradasStatus, setOutrasEntradasStatus] = useState('');
  const [outrasEntradasSalvando, setOutrasEntradasSalvando] = useState(false);

  const [faturasModalAberto, setFaturasModalAberto] = useState(false);
  const [faturasLista, setFaturasLista] = useState<FaturaDescontada[] | null>(null);
  const [faturasPaste, setFaturasPaste] = useState('');
  const [faturasStatus, setFaturasStatus] = useState('');
  const [faturasSalvando, setFaturasSalvando] = useState(false);

  const [boletoDetalheDia, setBoletoDetalheDia] = useState<string | null>(null);
  const [boletoDetalheLista, setBoletoDetalheLista] = useState<BoletoDetalheItem[] | null>(null);
  const [boletoDetalheErro, setBoletoDetalheErro] = useState('');

  // So volta a salvar o filtro depois que o salvo foi restaurado - senao a
  // restauracao dos toggles (sincrona) dispara o salvamento com as datas
  // padrao e empresas vazias ANTES da lista de empresas chegar, e o filtro
  // salvo era sobrescrito toda vez que a tela abria.
  const filtroRestauradoRef = useRef(false);

  useEffect(() => {
    // Lido uma unica vez, na abertura - nunca depois de um possivel salvamento.
    const salvo = carregarFiltro<{
      empresas: number[]; dtInicio: string; dtFim: string; ultimoAtalho?: string | null;
      colsAtivas?: Record<ColKey, boolean>; crescMulti?: number; inflacaoMulti?: number; crescLojas?: number;
    }>(FILTRO_KEY);

    fetch('/api/fluxo-caixa/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((lista: EmpresaFC[]) => {
        // Antes dos setState abaixo: eles sao aplicados juntos, entao o
        // primeiro salvamento ja enxerga os valores restaurados.
        filtroRestauradoRef.current = true;
        setEmpresasDisponiveis(lista || []);
        const validas = new Set((lista || []).map((e) => e.id));
        const empresasValidas = (salvo?.empresas || []).filter((id) => validas.has(id));
        setEmpresasSelecionadas(new Set(empresasValidas.length > 0 ? empresasValidas : (lista || []).map((e) => e.id)));
        // Se o ultimo filtro usado foi um atalho (ex: "Próximos 30 Dias"),
        // recalcula em cima do "hoje" de agora, em vez de so repetir as
        // mesmas datas congeladas de quando foi salvo (senao reabrir no dia
        // seguinte mostraria uma janela ja defasada 1 dia pra tras).
        const atalho = salvo?.ultimoAtalho ? ATALHOS_PERIODO_FC.find((a) => a.id === salvo.ultimoAtalho) : null;
        if (atalho) {
          const { dtInicio: di, dtFim: df } = atalho.calcular();
          setDtInicio(di);
          setDtFim(df);
          setUltimoAtalho(atalho.id);
        } else {
          if (salvo?.dtInicio) setDtInicio(salvo.dtInicio);
          if (salvo?.dtFim) setDtFim(salvo.dtFim);
        }
      })
      .catch((e) => {
        filtroRestauradoRef.current = true;
        console.error('Erro ao buscar empresas do fluxo de caixa:', e);
      });

    // Toggles de coluna e simulacao de cenario tambem ficam salvos entre
    // visitas - nao dependem da lista de empresas, carrega direto.
    if (salvo?.colsAtivas) setColsAtivas(salvo.colsAtivas);
    if (salvo?.crescMulti !== undefined) setCrescMulti(salvo.crescMulti);
    if (salvo?.inflacaoMulti !== undefined) setInflacaoMulti(salvo.inflacaoMulti);
    if (salvo?.crescLojas !== undefined) setCrescLojas(salvo.crescLojas);
  }, []);

  function aplicarAtalhoPeriodo(atalho: typeof ATALHOS_PERIODO_FC[number]) {
    const { dtInicio: di, dtFim: df } = atalho.calcular();
    setDtInicio(di);
    setDtFim(df);
    setUltimoAtalho(atalho.id);
  }

  useEffect(() => {
    if (!filtroRestauradoRef.current) return;
    salvarFiltro(FILTRO_KEY, {
      empresas: Array.from(empresasSelecionadas), dtInicio, dtFim, ultimoAtalho,
      colsAtivas, crescMulti, inflacaoMulti, crescLojas,
    });
  }, [empresasSelecionadas, dtInicio, dtFim, ultimoAtalho, colsAtivas, crescMulti, inflacaoMulti, crescLojas]);

  async function buscar() {
    setLoading(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ dt_inicio: dtInicio, dt_fim: dtFim });
      if (empresasSelecionadas.size > 0 && empresasSelecionadas.size < empresasDisponiveis.length) {
        params.set('empresas', Array.from(empresasSelecionadas).join(','));
      }
      const qs = params.toString();
      const [respDados, respFornecedor, respDespesa, respSaldos] = await Promise.all([
        fetch(`/api/fluxo-caixa/dados?${qs}`, { cache: 'no-store' }),
        fetch(`/api/fluxo-caixa/saidas-por-fornecedor?${qs}`, { cache: 'no-store' }),
        fetch(`/api/fluxo-caixa/saidas-por-despesa?${qs}`, { cache: 'no-store' }),
        fetch('/api/fluxo-caixa/saldos-bancarios', { cache: 'no-store' }),
      ]);
      const json = await respDados.json();
      if (!respDados.ok || json.error) {
        setErro(json.error || json.detail || 'Erro ao carregar fluxo de caixa');
        return;
      }
      setDados(json.data);
      setSaidasFornecedor(respFornecedor.ok ? await respFornecedor.json() : []);
      setSaidasDespesa(respDespesa.ok ? await respDespesa.json() : []);
      setSaldosBancarios(respSaldos.ok ? await respSaldos.json() : null);
    } catch (error) {
      console.error('Erro ao buscar fluxo de caixa:', error);
      setErro('Erro ao buscar os dados. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  function alternarOrdenacao(key: 'nome' | 'valor') {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'valor' ? 'desc' : 'asc');
    }
  }

  const fornecedoresOrdenados = [...saidasFornecedor].sort((a, b) => {
    const mult = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'nome') return a.nome.localeCompare(b.nome) * mult;
    return (a.valor - b.valor) * mult;
  });

  // Nao busca sozinho ao carregar a tela - so quando o usuario clicar em
  // "Aplicar" (pedido explicito do usuario, pra nao disparar a consulta
  // pesada toda vez que a tela abre).

  function toggleEmpresaFiltro(id: number) {
    setEmpresasSelecionadas((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }

  function toggleCol(key: ColKey) {
    setColsAtivas((atual) => ({ ...atual, [key]: !atual[key] }));
  }

  function resetarAjustes() {
    setCrescMulti(0);
    setInflacaoMulti(0);
    setCrescLojas(0);
  }

  async function lojasGravar() {
    const raw = lojasPaste.trim();
    if (!raw) { setLojasStatus('Cole os dados primeiro.'); return; }

    const linhas: { dia: string; valor: number }[] = [];
    for (const linha of raw.split('\n')) {
      const partes = linha.trim().split(/[\t;]/);
      if (partes.length < 2) continue;
      const [datePart, valPart] = partes;
      let iso: string | null = null;
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(datePart.trim())) {
        const [d, m, y] = datePart.trim().split('/');
        iso = `${y}-${m}-${d}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(datePart.trim())) {
        iso = datePart.trim();
      } else continue;
      const valor = parseFloat(valPart.trim().replace(/\./g, '').replace(',', '.'));
      if (isNaN(valor)) continue;
      linhas.push({ dia: iso, valor });
    }

    if (!linhas.length) { setLojasStatus('Nenhuma linha válida encontrada.'); return; }
    setLojasStatus(`Salvando ${linhas.length} linha(s)…`);
    setLojasSalvando(true);
    try {
      const res = await fetch('/api/fluxo-caixa/lojas-projecao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(linhas),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao salvar');
      setLojasStatus(`✓ ${json.count} dia(s) salvos.`);
      setLojasPaste('');
      setTimeout(() => {
        setLojasModalAberto(false);
        setLojasStatus('');
        buscar();
      }, 900);
    } catch (e) {
      setLojasStatus(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
    } finally {
      setLojasSalvando(false);
    }
  }

  async function outrasEntradasGravar() {
    const raw = outrasEntradasPaste.trim();
    if (!raw) { setOutrasEntradasStatus('Cole os dados primeiro.'); return; }

    const linhas: { dia: string; valor: number }[] = [];
    for (const linha of raw.split('\n')) {
      const partes = linha.trim().split(/[\t;]/);
      if (partes.length < 2) continue;
      const [datePart, valPart] = partes;
      let iso: string | null = null;
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(datePart.trim())) {
        const [d, m, y] = datePart.trim().split('/');
        iso = `${y}-${m}-${d}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(datePart.trim())) {
        iso = datePart.trim();
      } else continue;
      const valor = parseFloat(valPart.trim().replace(/\./g, '').replace(',', '.'));
      if (isNaN(valor)) continue;
      linhas.push({ dia: iso, valor });
    }

    if (!linhas.length) { setOutrasEntradasStatus('Nenhuma linha válida encontrada.'); return; }
    setOutrasEntradasStatus(`Salvando ${linhas.length} linha(s)…`);
    setOutrasEntradasSalvando(true);
    try {
      const res = await fetch('/api/fluxo-caixa/outras-entradas-projecao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(linhas),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao salvar');
      setOutrasEntradasStatus(`✓ ${json.count} dia(s) salvos.`);
      setOutrasEntradasPaste('');
      setTimeout(() => {
        setOutrasEntradasModalAberto(false);
        setOutrasEntradasStatus('');
        buscar();
      }, 900);
    } catch (e) {
      setOutrasEntradasStatus(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
    } finally {
      setOutrasEntradasSalvando(false);
    }
  }

  async function faturasCarregarLista() {
    setFaturasLista(null);
    try {
      const res = await fetch('/api/fluxo-caixa/faturas-descontadas', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao carregar');
      setFaturasLista(json);
    } catch (e) {
      setFaturasStatus(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
      setFaturasLista([]);
    }
  }

  function faturasAbrir() {
    setFaturasModalAberto(true);
    setFaturasStatus('');
    faturasCarregarLista();
  }

  async function faturasGravar() {
    const raw = faturasPaste.trim();
    if (!raw) { setFaturasStatus('Cole os dados primeiro.'); return; }

    const linhas: { nrFat: number; nrParcela: number }[] = [];
    for (const linha of raw.split('\n')) {
      const m = linha.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!m) continue;
      linhas.push({ nrFat: parseInt(m[1], 10), nrParcela: parseInt(m[2], 10) });
    }

    if (!linhas.length) { setFaturasStatus('Nenhuma linha válida encontrada (formato: fatura/parcela).'); return; }
    setFaturasStatus(`Salvando ${linhas.length} fatura(s)…`);
    setFaturasSalvando(true);
    try {
      const res = await fetch('/api/fluxo-caixa/faturas-descontadas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(linhas),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao salvar');
      setFaturasStatus(`✓ ${json.count} fatura(s) salvas.`);
      setFaturasPaste('');
      await faturasCarregarLista();
      buscar();
    } catch (e) {
      setFaturasStatus(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
    } finally {
      setFaturasSalvando(false);
    }
  }

  async function faturasRemover(nrFat: number, nrParcela: number) {
    try {
      await fetch(`/api/fluxo-caixa/faturas-descontadas/${nrFat}/${nrParcela}`, { method: 'DELETE' });
      await faturasCarregarLista();
      buscar();
    } catch (e) {
      console.error('Erro ao remover fatura descontada:', e);
    }
  }

  async function faturasRemoverTudo() {
    if (!confirm('Remover TODAS as faturas descontadas cadastradas? Essa ação não pode ser desfeita.')) return;
    try {
      const res = await fetch('/api/fluxo-caixa/faturas-descontadas', { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao remover');
      setFaturasStatus(`✓ ${json.count} fatura(s) removidas.`);
      await faturasCarregarLista();
      buscar();
    } catch (e) {
      setFaturasStatus(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
    }
  }

  // Detalhe das faturas de Boleto de um dia especifico - clique na celula
  // Boleto da Visao Diaria. Usa o mesmo filtro de empresas selecionado no
  // topo da tela, pra bater exatamente com o valor mostrado na celula.
  async function boletoDetalheAbrir(dia: string) {
    setBoletoDetalheDia(dia);
    setBoletoDetalheLista(null);
    setBoletoDetalheErro('');
    try {
      const params = new URLSearchParams({ dia });
      if (empresasSelecionadas.size > 0 && empresasSelecionadas.size < empresasDisponiveis.length) {
        params.set('empresas', Array.from(empresasSelecionadas).join(','));
      }
      const res = await fetch(`/api/fluxo-caixa/boleto-detalhe?${params.toString()}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao buscar faturas');
      setBoletoDetalheLista(json);
    } catch (e) {
      setBoletoDetalheErro(e instanceof Error ? e.message : 'Erro desconhecido');
      setBoletoDetalheLista([]);
    }
  }

  // Linhas da tabela diaria com toggles de coluna + simulacao aplicados -
  // saldo diario/acumulado precisa ser recalculado no cliente (o valor que
  // vem do backend e o "cru", sem nenhum ajuste de simulacao/toggle). O
  // acumulado parte do saldo bancario real (posicao de caixa atual das
  // contas), nao de zero - pedido explicito do usuario.
  const ev = (key: ColKey, val: number) => (colsAtivas[key] ? val || 0 : 0);
  let acumLocal = dados?.saldoBancario ?? 0;
  const linhasDiarias = (dados?.dias || []).map((dia) => {
    const adjLojas = (dia.lojas || 0) * (1 + crescLojas / 100);
    const adjMulti = (dia.multimarcas || 0) * (1 + crescMulti / 100) * (1 + inflacaoMulti / 100);

    const effPrev = ev('previsao', dia.previsao);
    const effReal = ev('real', dia.real);
    const effPed = ev('pedidos', dia.pedidos);
    const effOutras = ev('outrasEntradas', dia.outrasEntradas);
    const effBol = ev('boleto', dia.boleto);
    const effCheq = ev('cheque', dia.cheque);
    const effLoj = ev('lojas', adjLojas);

    const effSaidas = effPrev + effReal + effPed;
    // Cartao e Multimarcas tirados temporariamente (pedido explicito do
    // usuario) - nao compoem mais o saldo, so volta se pedir de novo.
    const effEntradas = effOutras + effBol + effCheq + effLoj;
    const effSaldoDia = effEntradas - effSaidas;
    acumLocal += effSaldoDia;

    return {
      dia, adjLojas, adjMulti, effPrev, effReal, effPed, effOutras, effBol, effCheq, effLoj,
      effSaidas, effEntradas, effSaldoDia, saldoAcum: acumLocal,
    };
  });

  const totais = linhasDiarias.reduce((acc, l) => ({
    previsao: acc.previsao + l.effPrev,
    real: acc.real + l.effReal,
    pedidos: acc.pedidos + l.effPed,
    saidas: acc.saidas + l.effSaidas,
    outrasEntradas: acc.outrasEntradas + l.effOutras,
    boleto: acc.boleto + l.effBol,
    cheque: acc.cheque + l.effCheq,
    lojas: acc.lojas + l.effLoj,
    entradas: acc.entradas + l.effEntradas,
    qtd: acc.qtd + l.dia.qtd,
  }), { previsao: 0, real: 0, pedidos: 0, saidas: 0, outrasEntradas: 0, boleto: 0, cheque: 0, lojas: 0, entradas: 0, qtd: 0 });

  const saldoFinal = totais.entradas - totais.saidas;

  // Mesmos totais, mas sem o toggle de coluna - so pra exibir (riscado) quanto
  // uma coluna desligada valeria no Resumo do Periodo.
  const totaisBrutos = linhasDiarias.reduce((acc, l) => ({
    previsao: acc.previsao + (l.dia.previsao || 0),
    real: acc.real + (l.dia.real || 0),
    pedidos: acc.pedidos + (l.dia.pedidos || 0),
    outrasEntradas: acc.outrasEntradas + (l.dia.outrasEntradas || 0),
    boleto: acc.boleto + (l.dia.boleto || 0),
    cheque: acc.cheque + (l.dia.cheque || 0),
    lojas: acc.lojas + l.adjLojas,
  }), { previsao: 0, real: 0, pedidos: 0, outrasEntradas: 0, boleto: 0, cheque: 0, lojas: 0 });
  const DIAS_SEMANA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  const hoje = isoHoje();

  // Sabado/domingo nunca tem dado proprio (tudo e deslocado pro dia util
  // seguinte pelas regras de compensacao/projecao do backend) - pedido
  // explicito do usuario pra nem aparecer essas linhas na Visao Diaria.
  // O acumulado (acumLocal) e os totais do rodape continuam somando TODOS
  // os dias (inclusive fim de semana, caso Cheque - unica coluna sem
  // deslocamento - tenha valor num sabado/domingo), so a linha em si some.
  const linhasDiariasVisiveis = linhasDiarias.filter((l) => {
    const dow = new Date(`${l.dia.dia}T12:00:00`).getDay();
    return dow !== 0 && dow !== 6;
  });

  function celula(key: ColKey, rawVal: number, cor: string, bgLinha: string, extraClasse = '', onClick?: () => void) {
    const ativa = colsAtivas[key];
    const v = rawVal || 0;
    const clicavel = ativa && v > 0 && !!onClick;
    return (
      <td
        className={`text-right px-3 py-2 tabular-nums border-r border-b border-gray-300 ${bgLinha} ${extraClasse} ${clicavel ? 'cursor-pointer hover:underline' : ''}`}
        style={{ color: ativa ? cor : '#94a3b8', fontWeight: ativa && v > 0 ? 600 : 400 }}
        onClick={clicavel ? onClick : undefined}
        title={clicavel ? 'Ver faturas' : undefined}
      >
        {v > 0 ? <span style={!ativa ? { textDecoration: 'line-through' } : undefined}>{fmtBRL(v)}</span> : <span className="text-gray-300">—</span>}
      </td>
    );
  }

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-rose-100 rounded-lg">
            <Banknote className="w-6 h-6 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">Fluxo de Caixa</h1>
            <p className="text-sm text-gray-500">Saídas (duplicatas a pagar) e entradas projetadas/realizadas, com saldo diário acumulado.</p>
          </div>
        </div>
        {dados?.geradoEm && <span className="text-sm text-gray-500">Atualizado em {dados.geradoEm}</span>}
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">De</label>
              <input
                type="date" value={dtInicio}
                onChange={(e) => { setDtInicio(e.target.value); setUltimoAtalho(null); }}
                className="h-9 px-2 border border-gray-300 rounded-md text-sm text-black"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Até</label>
              <input
                type="date" value={dtFim}
                onChange={(e) => { setDtFim(e.target.value); setUltimoAtalho(null); }}
                className="h-9 px-2 border border-gray-300 rounded-md text-sm text-black"
              />
            </div>
          </div>

          <div className="hidden sm:block self-stretch w-px bg-gray-200" />

          <div className="relative">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-1">Empresa</label>
            <button
              onClick={() => setFiltroEmpresasAberto((v) => !v)}
              className="min-w-[160px] h-9 flex items-center justify-between gap-2 px-3 border border-gray-300 rounded-md text-sm text-black bg-white hover:bg-gray-50"
            >
              Empresas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
              <ChevronDown className="w-4 h-4 text-gray-500" />
            </button>
            {filtroEmpresasAberto && (
              <div className="absolute z-30 mt-1 w-64 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-xl p-2">
                <div className="flex justify-between px-1 pb-1 mb-1 border-b border-gray-100">
                  <button
                    className="text-xs font-medium text-rose-700 hover:text-rose-900"
                    onClick={() => setEmpresasSelecionadas(new Set(empresasDisponiveis.map((e) => e.id)))}
                  >
                    Todas
                  </button>
                  <button className="text-xs font-medium text-black hover:text-black" onClick={() => setEmpresasSelecionadas(new Set())}>
                    Nenhuma
                  </button>
                </div>
                {empresasDisponiveis.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 px-1 py-1 text-sm text-black hover:bg-gray-50 rounded cursor-pointer">
                    <input type="checkbox" checked={empresasSelecionadas.has(e.id)} onChange={() => toggleEmpresaFiltro(e.id)} />
                    {e.nome}
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={buscar}
            disabled={loading}
            className="h-9 flex items-center gap-2 px-4 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Aplicar
          </button>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-3 border-t border-gray-100">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">Período rápido</span>
          {ATALHOS_PERIODO_FC.map((atalho) => (
            <button
              key={atalho.id}
              onClick={() => aplicarAtalhoPeriodo(atalho)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                ultimoAtalho === atalho.id ? 'bg-rose-100 text-rose-700 font-medium' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              }`}
            >
              {atalho.label}
            </button>
          ))}
        </div>

        {erro && (
          <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 mt-3">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{erro}</span>
          </div>
        )}
      </div>

      {loading && !dados && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {!loading && !dados && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
          <CalendarRange className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-gray-500">Escolha o período e clique em Aplicar.</p>
        </div>
      )}

      {dados && (
        <>
          {/* Cards de KPI (Vencidos/30d/90d/12m) e alerta de vencidos
              tirados temporariamente (pedido explicito do usuario) - os
              dados continuam vindo da API, so nao sao mostrados aqui. */}

          {/* Indicadores principais - leitura imediata do saldo inicial,
              entradas/saidas do periodo e saldo final projetado. Reaproveita
              valores ja calculados (totais, linhasDiarias) - nenhum calculo
              novo. Mesmo padrao de card (borda esquerda colorida) ja usado
              no DFC, pra manter consistencia visual entre as telas. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white rounded-lg shadow-md p-4 border-l-4 border-gray-400">
              <div className="flex items-center gap-2 text-gray-500 text-xs font-medium">
                <Wallet className="w-4 h-4" /> Saldo inicial
              </div>
              <p className="text-2xl font-bold tabular-nums mt-1.5 text-black">{fmtBRL(dados.saldoBancario)}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4 border-l-4 border-green-500">
              <div className="flex items-center gap-2 text-gray-500 text-xs font-medium">
                <TrendingUp className="w-4 h-4 text-green-600" /> Entradas no período
              </div>
              <p className="text-2xl font-bold tabular-nums mt-1.5 text-green-700">{fmtBRL(totais.entradas)}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4 border-l-4 border-red-500">
              <div className="flex items-center gap-2 text-gray-500 text-xs font-medium">
                <TrendingDown className="w-4 h-4 text-red-600" /> Saídas no período
              </div>
              <p className="text-2xl font-bold tabular-nums mt-1.5 text-red-700">{fmtBRL(totais.saidas)}</p>
            </div>
            {(() => {
              const saldoFinalProjetado = linhasDiarias.length > 0 ? linhasDiarias[linhasDiarias.length - 1].saldoAcum : dados.saldoBancario;
              const positivo = saldoFinalProjetado >= 0;
              return (
                <div className={`bg-white rounded-lg shadow-md p-4 border-l-4 ${positivo ? 'border-green-500' : 'border-red-500'}`}>
                  <div className="flex items-center gap-2 text-gray-500 text-xs font-medium">
                    <Banknote className={`w-4 h-4 ${positivo ? 'text-green-600' : 'text-red-600'}`} /> Saldo final projetado
                  </div>
                  <p className={`text-2xl font-bold tabular-nums mt-1.5 ${positivo ? 'text-green-700' : 'text-red-700'}`}>{fmtBRL(saldoFinalProjetado)}</p>
                </div>
              );
            })()}
          </div>

          {/* Saldos bancarios - posicao de caixa atual, entra compondo o
              Saldo Acum. da tabela diaria abaixo (ver acumLocal). Mesmo
              estilo visual da Visao Diaria (cabecalho solido, zebra,
              linhas de grade) - pedido explicito do usuario. */}
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="flex items-center px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold text-black uppercase tracking-wide flex items-center gap-2">
                <Landmark className="w-4 h-4 text-rose-600" /> Saldos Bancários
              </h2>
            </div>
            {saldosBancarios && saldosBancarios.contas.length > 0 ? (
              <div className="overflow-x-auto [transform:translateZ(0)]">
                <table className="w-full text-sm border-separate [border-spacing:0]">
                  <thead>
                    <tr>
                      <th className="text-left px-4 py-2 font-semibold text-white bg-gray-500 border-b border-r border-gray-600">Banco</th>
                      <th className="text-left px-4 py-2 font-semibold text-white bg-gray-500 border-b border-r border-gray-600">Agência</th>
                      <th className="text-left px-4 py-2 font-semibold text-white bg-gray-500 border-b border-r border-gray-600">Conta</th>
                      <th className="text-right px-4 py-2 font-semibold text-white bg-gray-500 border-b border-r border-gray-600">Posição em</th>
                      <th className="text-right px-4 py-2 font-semibold text-white bg-gray-500 border-b border-gray-600">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saldosBancarios.contas.map((c, i) => {
                      const bgHover = `${i % 2 === 0 ? 'bg-white' : 'bg-gray-300'} group-hover:bg-rose-50`;
                      return (
                      <tr key={`${c.nmBanco}-${c.nrConta}-${i}`} className="group transition-colors">
                        <td className={`px-4 py-2 text-black border-r border-b border-gray-300 ${bgHover}`}>{c.nmBanco}</td>
                        <td className={`px-4 py-2 text-black tabular-nums border-r border-b border-gray-300 ${bgHover}`}>{c.nrAgencia}</td>
                        <td className={`px-4 py-2 text-black tabular-nums border-r border-b border-gray-300 ${bgHover}`}>{c.nrConta}</td>
                        <td className={`px-4 py-2 text-right text-gray-600 tabular-nums border-r border-b border-gray-300 ${bgHover}`} title={c.semDados ? `Última posição: ${c.dtPosicao.split('-').reverse().join('/')}` : undefined}>
                          {c.semDados ? <span className="italic text-gray-400">Sem dados</span> : c.dtPosicao.split('-').reverse().join('/')}
                        </td>
                        <td className={`px-4 py-2 text-right font-semibold tabular-nums border-b border-gray-300 ${bgHover} ${c.vlSaldo >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(c.vlSaldo)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold bg-gray-400">
                      <td colSpan={4} className="px-4 py-2.5 text-right uppercase text-xs tracking-wide text-black border-t-2 border-r border-gray-400">Total</td>
                      <td className={`px-4 py-2.5 text-right tabular-nums border-t-2 border-gray-400 ${(saldosBancarios?.total ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(saldosBancarios?.total ?? 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-500 py-8 text-center">Nenhuma conta bancária cadastrada.</p>
            )}
          </div>

          {/* Grafico mensal */}
          <div className="bg-white rounded-lg shadow-md p-4">
            <h2 className="text-sm font-semibold text-black uppercase tracking-wide mb-3">Projeção Mensal</h2>
            <GraficoMensalFC meses={dados.meses} saldoBancario={dados.saldoBancario} />
          </div>

          {/* Visao diaria */}
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Visão Diária</h2>
              <div className="flex gap-2">
                <button onClick={faturasAbrir} className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 text-black rounded px-2 py-1 transition-colors">
                  <Settings className="w-3.5 h-3.5" /> Faturas Descontadas
                </button>
                <button onClick={() => setLojasModalAberto(true)} className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 text-black rounded px-2 py-1 transition-colors">
                  <Settings className="w-3.5 h-3.5" /> Projeção Lojas
                </button>
                <button onClick={() => setOutrasEntradasModalAberto(true)} className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 text-black rounded px-2 py-1 transition-colors">
                  <Settings className="w-3.5 h-3.5" /> Outras Entradas
                </button>
              </div>
            </div>

            {/* Simulacao */}
            <div className="flex items-center gap-4 flex-wrap px-4 py-2.5 border-b border-gray-200 bg-amber-50">
              <span className="text-xs font-bold text-black uppercase tracking-wide">Simulação</span>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="font-semibold text-purple-700">Multimarcas</span>
                <span className="text-gray-600">Crescimento</span>
                <input type="number" step={0.5} value={crescMulti} onChange={(e) => setCrescMulti(parseFloat(e.target.value) || 0)} className="w-16 px-1.5 py-1 border border-gray-300 rounded text-right text-sm text-black" />
                <span className="text-gray-600">%</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="font-semibold text-purple-700">Multimarcas</span>
                <span className="text-gray-600">Inflação</span>
                <input type="number" step={0.5} value={inflacaoMulti} onChange={(e) => setInflacaoMulti(parseFloat(e.target.value) || 0)} className="w-16 px-1.5 py-1 border border-gray-300 rounded text-right text-sm text-black" />
                <span className="text-gray-600">%</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="font-semibold text-cyan-700">Lojas</span>
                <span className="text-gray-600">Crescimento</span>
                <input type="number" step={0.5} value={crescLojas} onChange={(e) => setCrescLojas(parseFloat(e.target.value) || 0)} className="w-16 px-1.5 py-1 border border-gray-300 rounded text-right text-sm text-black" />
                <span className="text-gray-600">%</span>
              </label>
              <button onClick={resetarAjustes} className="flex items-center gap-1 text-xs font-medium text-black border border-gray-300 rounded px-2 py-1 hover:bg-white transition-colors">
                <RotateCcw className="w-3.5 h-3.5" /> Resetar
              </button>
            </div>

            {/* Toggles de coluna */}
            <div className="flex items-center gap-1.5 flex-wrap px-4 py-2.5 border-b border-gray-200">
              {COL_DEFS.map((g) => (
                <React.Fragment key={g.group}>
                  <span className="text-xs font-bold text-black uppercase tracking-wide mr-1">{g.group}:</span>
                  {g.cols.map((c) => {
                    const on = colsAtivas[c.key];
                    return (
                      <button
                        key={c.key}
                        onClick={() => toggleCol(c.key)}
                        title={on ? 'Excluir do cálculo' : 'Incluir no cálculo'}
                        className="text-xs font-semibold rounded-full px-2.5 py-1 mr-1 border transition-colors"
                        style={{ borderColor: on ? c.color : '#cbd5e1', backgroundColor: on ? `${c.color}18` : '#f1f5f9', color: on ? c.color : '#64748b' }}
                      >
                        {on ? '✓' : '○'} {c.label}
                      </button>
                    );
                  })}
                  <span className="w-2" />
                </React.Fragment>
              ))}
            </div>

            <div className="overflow-x-auto max-h-[78vh] overflow-y-auto [transform:translateZ(0)]">
              <table className="w-full text-sm min-w-[1100px] border-separate [border-spacing:0]">
                <thead className="sticky top-0 z-10">
                  <tr className="text-left">
                    <th rowSpan={2} className="px-3 py-2 min-w-[90px] align-middle font-medium text-white bg-gray-500 border-b-2 border-r-2 border-gray-600">Data</th>
                    <th colSpan={4} className="px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-white bg-red-600 border-b border-red-700">Saídas</th>
                    <th colSpan={5} className="px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-white bg-green-600 border-b border-green-700 border-l-2 border-l-gray-300">Entradas</th>
                    <th rowSpan={2} className="px-3 py-2 text-right whitespace-nowrap align-middle font-medium text-white bg-blue-600 border-b-2 border-blue-700 border-r border-blue-700 border-l-2 border-l-gray-300">Saldo Dia</th>
                    <th rowSpan={2} className="px-3 py-2 text-right whitespace-nowrap align-middle font-medium text-white bg-blue-600 border-b-2 border-blue-700 border-r-2 border-blue-700">Saldo Acum.</th>
                    <th rowSpan={2} className="px-3 py-2 text-right align-middle font-medium text-white bg-gray-500 border-b-2 border-gray-600">Qtd</th>
                  </tr>
                  <tr className="text-left">
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-red-500 border-b-2 border-red-300 border-r border-red-400">Prev.</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-red-500 border-b-2 border-red-300 border-r border-red-400">Real</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-red-500 border-b-2 border-red-300 border-r border-red-400">Pedidos</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-white bg-red-700 border-b-2 border-red-300 border-r-2 border-gray-300">Total</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Outras Entradas</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Boleto</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Cheque</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Lojas</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-white bg-green-700 border-b-2 border-green-300 border-r-2 border-gray-300">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {linhasDiariasVisiveis.length === 0 && (
                    <tr><td colSpan={13} className="text-center text-gray-500 py-8">Sem dados no período selecionado</td></tr>
                  )}
                  {linhasDiariasVisiveis.map((l, i) => {
                    const dt = new Date(`${l.dia.dia}T12:00:00`);
                    const dow = DIAS_SEMANA[dt.getDay()];
                    const isHoje = l.dia.dia === hoje;
                    const [, mm, dd] = l.dia.dia.split('-');
                    // Ultimo dia do mes - fechamento - fica com destaque
                    // verde (pedido explicito do usuario), com prioridade
                    // abaixo de "hoje" mas acima da zebra normal.
                    const isUltimoDiaMes = dt.getDate() === new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
                    // Zebra bem visivel (branco/cinza-100, nao cinza-50 que
                    // quase nao se distingue do branco) - pedido explicito
                    // do usuario. O fim de semana ja fica marcado pelo
                    // proprio rotulo SAB/DOM ao lado da data, sem precisar
                    // de uma 3a cor de fundo que brigava com a zebra.
                    const bg = isHoje ? 'bg-sky-50' : isUltimoDiaMes ? 'bg-green-200' : i % 2 === 0 ? 'bg-white' : 'bg-gray-300';
                    const bgHover = `${bg} group-hover:bg-rose-50`;
                    return (
                      <tr key={l.dia.dia} className={`group ${isHoje ? 'font-bold' : ''} transition-colors`}>
                        <td className={`px-3 py-2 whitespace-nowrap text-black border-r-2 border-b border-gray-300 ${bgHover}`}>
                          <span className="tabular-nums">{dd}/{mm}</span>
                          <span className="text-xs text-gray-500 ml-1.5">{dow}</span>
                          {isHoje && <span className="text-xs font-medium bg-sky-600 text-white rounded px-1.5 py-0.5 ml-1.5 align-middle">hoje</span>}
                        </td>
                        {celula('previsao', l.dia.previsao, '#ef4444', bgHover)}
                        {celula('real', l.dia.real, '#991b1b', bgHover)}
                        {celula('pedidos', l.dia.pedidos, '#dc2626', bgHover)}
                        <td className={`text-right px-3 py-2 tabular-nums font-bold text-red-800 border-r-2 border-b border-gray-300 ${bgHover}`}>
                          {l.effSaidas > 0 ? fmtBRL(l.effSaidas) : <span className="text-gray-400">—</span>}
                        </td>
                        {celula('outrasEntradas', l.dia.outrasEntradas, '#7c3aed', bgHover)}
                        {celula('boleto', l.dia.boleto, '#0284c7', bgHover, '', () => boletoDetalheAbrir(l.dia.dia))}
                        {celula('cheque', l.dia.cheque, '#059669', bgHover)}
                        {celula('lojas', l.adjLojas, '#0891b2', bgHover)}
                        <td className={`text-right px-3 py-2 tabular-nums font-bold text-green-800 border-r-2 border-b border-gray-300 ${bgHover}`}>
                          {l.effEntradas > 0 ? fmtBRL(l.effEntradas) : <span className="text-gray-400">—</span>}
                        </td>
                        <td className={`text-right px-3 py-2 tabular-nums font-bold border-r border-b border-gray-300 ${bgHover} ${l.effSaldoDia >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(l.effSaldoDia)}</td>
                        <td className={`text-right px-3 py-2 tabular-nums font-bold border-r-2 border-b border-gray-300 ${bgHover} ${l.saldoAcum >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(l.saldoAcum)}</td>
                        <td className={`text-right px-3 py-2 tabular-nums text-black border-b border-gray-300 ${bgHover}`}>{fmtNum(l.dia.qtd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {linhasDiarias.length > 0 && (
                  <tfoot>
                    <tr className="font-bold text-sm bg-gray-400">
                      <td className="px-3 py-2.5 uppercase text-xs tracking-wide text-black border-t-2 border-r-2 border-gray-400">Total</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-red-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.previsao)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-red-800 border-t-2 border-r border-gray-400">{fmtBRL(totais.real)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-red-600 border-t-2 border-r border-gray-400">{fmtBRL(totais.pedidos)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-red-800 border-t-2 border-r-2 border-gray-400">{fmtBRL(totais.saidas)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-violet-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.outrasEntradas)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-sky-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.boleto)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-green-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.cheque)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-cyan-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.lojas)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-green-800 border-t-2 border-r-2 border-gray-400">{fmtBRL(totais.entradas)}</td>
                      <td className={`text-right px-3 py-2.5 tabular-nums border-t-2 border-r border-gray-400 ${saldoFinal >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(saldoFinal)}</td>
                      <td className={`text-right px-3 py-2.5 tabular-nums border-t-2 border-r-2 border-gray-400 ${saldoFinal >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(saldoFinal)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-black border-t-2 border-gray-400">{fmtNum(totais.qtd)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <ResumoPeriodoFC
            entradas={[
              { rotulo: 'Outras entradas', valor: totaisBrutos.outrasEntradas, ativa: colsAtivas.outrasEntradas },
              { rotulo: 'Boletos', valor: totaisBrutos.boleto, ativa: colsAtivas.boleto },
              { rotulo: 'Cheques', valor: totaisBrutos.cheque, ativa: colsAtivas.cheque },
              { rotulo: 'Lojas', valor: totaisBrutos.lojas, ativa: colsAtivas.lojas },
            ]}
            saidas={[
              { rotulo: 'Previsão', valor: totaisBrutos.previsao, ativa: colsAtivas.previsao },
              { rotulo: 'Real', valor: totaisBrutos.real, ativa: colsAtivas.real },
              { rotulo: 'Pedidos de compra', valor: totaisBrutos.pedidos, ativa: colsAtivas.pedidos },
            ]}
            totalEntradas={totais.entradas}
            totalSaidas={totais.saidas}
            saldoInicial={dados.saldoBancario}
            dtIni={dados.dias[0]?.dia ?? ''}
            dtFim={dados.dias[dados.dias.length - 1]?.dia ?? ''}
          />

          {/* Saidas por fornecedor (ranking + detalhado ordenavel) e por
              despesa (mesmo periodo/empresas filtrados acima) - as 3 lado a
              lado, mesma altura (pedido explicito do usuario). */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-white rounded-lg shadow-md overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Fornecedores</h2>
              </div>
              <div className="p-4">
                <ListaBarrasRanking itens={saidasFornecedor} cor="#dc2626" />
              </div>
            </div>
            <div className="bg-white rounded-lg shadow-md overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Despesas</h2>
              </div>
              <div className="p-4">
                <ListaBarrasRanking itens={saidasDespesa} cor="#f59e0b" />
              </div>
            </div>
            <div className="bg-white rounded-lg shadow-md overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Todos os Fornecedores</h2>
              </div>
              <div className="overflow-x-auto max-h-[732px] overflow-y-auto [transform:translateZ(0)]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-black cursor-pointer select-none" onClick={() => alternarOrdenacao('nome')}>
                        <span className="inline-flex items-center gap-1">
                          Nome
                          {sortKey === 'nome' ? (sortDir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />) : <ArrowUpDown className="w-3.5 h-3.5 text-gray-400" />}
                        </span>
                      </th>
                      <th className="text-right px-4 py-2 font-medium text-black cursor-pointer select-none" onClick={() => alternarOrdenacao('valor')}>
                        <span className="inline-flex items-center gap-1">
                          Valor Atual
                          {sortKey === 'valor' ? (sortDir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />) : <ArrowUpDown className="w-3.5 h-3.5 text-gray-400" />}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fornecedoresOrdenados.length === 0 && (
                      <tr><td colSpan={2} className="text-center text-gray-500 py-8">Sem dados no período selecionado</td></tr>
                    )}
                    {fornecedoresOrdenados.map((f, i) => {
                      const bgHover = `${i % 2 === 0 ? 'bg-white' : 'bg-gray-300'} group-hover:bg-rose-50`;
                      return (
                      <tr key={`${f.cdFornecedor}-${i}`} className="group transition-colors">
                        <td className={`px-4 py-2 text-black border-b border-gray-200 ${bgHover}`}>{f.nome}</td>
                        <td className={`px-4 py-2 text-right font-semibold text-red-600 tabular-nums border-b border-gray-200 ${bgHover}`}>{fmtBRL(-f.valor)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Modal: Projecao Lojas */}
      {lojasModalAberto && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setLojasModalAberto(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 sticky top-0 bg-white">
              <h2 className="text-base font-semibold text-black">Projeção de Lojas</h2>
              <button onClick={() => setLojasModalAberto(false)} className="text-black/50 hover:text-black"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600 mb-3">
                Cole os dados da planilha abaixo — uma linha por dia.<br />
                Formatos aceitos: <code>DD/MM/AAAA;valor</code> ou <code>DD/MM/AAAA[tab]valor</code> (tab do Excel)
              </p>
              <textarea
                value={lojasPaste}
                onChange={(e) => setLojasPaste(e.target.value)}
                rows={14}
                placeholder={'01/07/2026;91188.26\n02/07/2026;91188.26\n...'}
                className="w-full box-border font-mono text-sm text-black p-2.5 border border-gray-300 rounded resize-vertical"
              />
              <div className="flex gap-2 mt-3 justify-end items-center">
                <span className="flex-1 text-sm text-gray-600">{lojasStatus}</span>
                <button onClick={() => setLojasModalAberto(false)} className="px-4 py-2 border border-gray-300 rounded text-sm text-black hover:bg-gray-50">Cancelar</button>
                <button onClick={lojasGravar} disabled={lojasSalvando} className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-semibold disabled:opacity-50 transition-colors">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Projecao Outras Entradas */}
      {outrasEntradasModalAberto && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setOutrasEntradasModalAberto(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 sticky top-0 bg-white">
              <h2 className="text-base font-semibold text-black">Outras Entradas</h2>
              <button onClick={() => setOutrasEntradasModalAberto(false)} className="text-black/50 hover:text-black"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600 mb-3">
                Cole os dados da planilha abaixo — uma linha por dia.<br />
                Formatos aceitos: <code>DD/MM/AAAA;valor</code> ou <code>DD/MM/AAAA[tab]valor</code> (tab do Excel)
              </p>
              <textarea
                value={outrasEntradasPaste}
                onChange={(e) => setOutrasEntradasPaste(e.target.value)}
                rows={14}
                placeholder={'20/10/2026;390000\n06/11/2026;3539445.01\n...'}
                className="w-full box-border font-mono text-sm text-black p-2.5 border border-gray-300 rounded resize-vertical"
              />
              <div className="flex gap-2 mt-3 justify-end items-center">
                <span className="flex-1 text-sm text-gray-600">{outrasEntradasStatus}</span>
                <button onClick={() => setOutrasEntradasModalAberto(false)} className="px-4 py-2 border border-gray-300 rounded text-sm text-black hover:bg-gray-50">Cancelar</button>
                <button onClick={outrasEntradasGravar} disabled={outrasEntradasSalvando} className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-semibold disabled:opacity-50 transition-colors">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Faturas Descontadas */}
      {faturasModalAberto && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setFaturasModalAberto(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 sticky top-0 bg-white">
              <h2 className="text-base font-semibold text-black">Faturas Descontadas (Empresa 001)</h2>
              <button onClick={() => setFaturasModalAberto(false)} className="text-black/50 hover:text-black"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600 mb-3">
                Faturas já descontadas junto ao banco não entram mais no Boleto futuro. Cole abaixo — uma linha por fatura/parcela.<br />
                Formato: <code>102045/002</code>
              </p>
              <textarea
                value={faturasPaste}
                onChange={(e) => setFaturasPaste(e.target.value)}
                rows={8}
                placeholder={'102045/002\n102045/003\n...'}
                className="w-full box-border font-mono text-sm text-black p-2.5 border border-gray-300 rounded resize-vertical"
              />
              <div className="flex gap-2 mt-3 justify-end items-center">
                <span className="flex-1 text-sm text-gray-600">{faturasStatus}</span>
                <button onClick={faturasGravar} disabled={faturasSalvando} className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-semibold disabled:opacity-50 transition-colors">Salvar</button>
              </div>
              <div className="mt-4 border-t border-gray-200 pt-3">
                <div className="flex justify-between items-center">
                  <strong className="text-sm text-black">Já cadastradas</strong>
                  <button onClick={faturasRemoverTudo} className="text-xs font-medium border border-red-600 text-red-600 rounded px-2 py-0.5 hover:bg-red-50">Remover tudo</button>
                </div>
                <div className="mt-2 max-h-44 overflow-y-auto text-sm">
                  {faturasLista === null && <span className="text-gray-500">Carregando…</span>}
                  {faturasLista !== null && faturasLista.length === 0 && <span className="text-gray-500">Nenhuma fatura cadastrada.</span>}
                  {faturasLista?.map((f) => (
                    <div key={`${f.nrFat}-${f.nrParcela}`} className="flex justify-between items-center py-1 border-b border-gray-100 text-black">
                      <span>{String(f.nrFat).padStart(6, '0')}/{String(f.nrParcela).padStart(3, '0')}</span>
                      <button onClick={() => faturasRemover(f.nrFat, f.nrParcela)} className="text-red-600 hover:text-red-800 text-sm">remover</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Detalhe das faturas de Boleto de um dia (clique na celula) */}
      {boletoDetalheDia && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setBoletoDetalheDia(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-black">
                Boletos — {boletoDetalheDia.split('-').reverse().join('/')}
              </h2>
              <button onClick={() => setBoletoDetalheDia(null)} className="text-black/50 hover:text-black"><X className="w-5 h-5" /></button>
            </div>
            <div className="overflow-y-auto flex-1">
              {boletoDetalheLista === null && (
                <div className="flex items-center justify-center py-12 text-gray-500">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…
                </div>
              )}
              {boletoDetalheErro && (
                <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md mx-5 mt-4 px-3 py-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{boletoDetalheErro}</span>
                </div>
              )}
              {boletoDetalheLista !== null && !boletoDetalheErro && boletoDetalheLista.length === 0 && (
                <p className="text-sm text-gray-500 py-12 text-center">Nenhuma fatura encontrada para esse dia.</p>
              )}
              {boletoDetalheLista !== null && boletoDetalheLista.length > 0 && (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium text-black">Cliente</th>
                      <th className="text-left px-3 py-2 font-medium text-black">Fatura/Parcela</th>
                      <th className="text-right px-3 py-2 font-medium text-black">Vencimento original</th>
                      <th className="text-right px-5 py-2 font-medium text-black">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {boletoDetalheLista.map((item, i) => (
                      <tr key={`${item.nrFat}-${item.nrParcela}-${i}`} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-5 py-1.5 text-black">{item.cliente}</td>
                        <td className="px-3 py-1.5 text-black tabular-nums">
                          {String(item.nrFat).padStart(6, '0')}/{String(item.nrParcela).padStart(3, '0')}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600 tabular-nums">{item.dtVencimentoOriginal.split('-').reverse().join('/')}</td>
                        <td className="px-5 py-1.5 text-right font-semibold text-sky-700 tabular-nums">{fmtBRL(item.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold bg-gray-200 border-t-2 border-gray-400">
                      <td colSpan={3} className="px-5 py-2 text-right uppercase text-xs tracking-wide text-black">Total</td>
                      <td className="px-5 py-2 text-right tabular-nums text-sky-700">
                        {fmtBRL(boletoDetalheLista.reduce((acc, item) => acc + item.valor, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
