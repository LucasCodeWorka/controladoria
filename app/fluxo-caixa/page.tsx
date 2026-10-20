'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Banknote, ChevronDown, Loader2, Settings, X, RotateCcw,
  ArrowUp, ArrowDown, ArrowUpDown, Landmark,
  Wallet, TrendingUp, TrendingDown, AlertCircle, CalendarRange,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import { useAuth } from '../contexts/AuthContext';

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
  // Pagamento do Uso da Garantia (simulacao) caido nesse mes - nao e uma
  // despesa real (nao soma em nenhuma coluna do backend), so desconta do
  // saldo acumulado do grafico mensal. Opcional pra nao quebrar o uso de
  // MesFC pros dados crus do backend (dados.meses), que nunca tem esse campo.
  ajusteGarantia?: number;
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
  vlLimite: number;
  vlDisponivel: number;
  vlLimiteContratado: number;
  qtDiasCarencia: number;
  qtDiasUsados: number;
  qtDiasRestantes: number;
  dtPosicao: string;
  semDados?: boolean;
}

interface SaldosBancarios {
  contas: ContaBancaria[];
  total: number;
  totalLimite: number;
  totalDisponivel: number;
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
  contaDfc: string | null;
  valor: number;
  qtd: number;
}

interface ItemRanking {
  nome: string;
  valor: number;
  // cd_despesaitem por tras da linha - clique filtra os fornecedores por elas
  ids?: number[];
  composicao?: ItemRanking[];
}

interface DespesaSelecionada {
  nome: string;
  ids: number[];
}

function idsDespesa(d: SaidaDespesa) {
  return d.cdDespesaItem !== null ? [d.cdDespesaItem] : [];
}

// Materia prima vira uma linha so no ranking de despesas (pedido explicito do
// usuario). Criterio principal: a classificacao DFC OP.01 (Custos com Materia
// Prima). Item ainda sem classificacao cai na heuristica pelo nome.
// Classificado em outra conta (ex.: EDGE 700 = INV.01) NAO entra.
const CONTA_DFC_MATERIA_PRIMA = 'OP.01';
const NOME_MATERIA_PRIMA =
  /\b(MATERIA ?PRIMA|M\.? ?PRIMA|TECIDOS?|MALHAS?|RENDAS?|LYCRA|ELASTICOS?|BOJOS?|LINHAS?|FIOS?|TULES?|CETIM|COTTON|MANTAS?|ARCOS?|ABOTOADOR(ES)?|CADARCOS?|ENFEITES?|ETIQUETAS?|TAGS?|AVIAMENTOS?|EMBALAGE(M|NS)|BOTO(ES)|BOTAO|ZIPER|FECHOS?|ALCAS?|REGULADOR(ES)?|COLCHETES?|ENTRETELAS?)\b/;

function ehMateriaPrima(d: SaidaDespesa) {
  if (d.contaDfc) return d.contaDfc.startsWith(CONTA_DFC_MATERIA_PRIMA);
  return NOME_MATERIA_PRIMA.test(d.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase());
}

function agruparMateriaPrima(despesas: SaidaDespesa[]): ItemRanking[] {
  const paraItem = (d: SaidaDespesa): ItemRanking => ({ nome: d.nome, valor: d.valor, ids: idsDespesa(d) });
  const mp = despesas.filter(ehMateriaPrima);
  const outras = despesas.filter((d) => !ehMateriaPrima(d)).map(paraItem);
  if (!mp.length) return outras;
  const linhaMp: ItemRanking = {
    nome: 'MATÉRIA PRIMA',
    valor: mp.reduce((a, d) => a + d.valor, 0),
    ids: mp.flatMap(idsDespesa),
    composicao: [...mp].sort((a, b) => b.valor - a.valor).map(paraItem),
  };
  return [linhaMp, ...outras].sort((a, b) => b.valor - a.valor);
}

interface BoletoDetalheItem {
  cliente: string;
  nrFat: number;
  nrParcela: number;
  dtVencimentoOriginal: string;
  valor: number;
  banco: string;
}

type ColKey = 'previsao' | 'real' | 'pedidos' | 'cartao' | 'boleto' | 'cheque' | 'lojas' | 'outrasEntradas' | 'multimarcas';

const FILTRO_KEY = 'fluxo_caixa_filtros_v1';

const COL_DEFS: { group: string; cols: { key: ColKey; label: string; color: string }[] }[] = [
  { group: 'Saídas', cols: [
    { key: 'previsao', label: 'Prev.', color: '#ef4444' },
    { key: 'real', label: 'Real', color: '#991b1b' },
    { key: 'pedidos', label: 'Pedidos', color: '#dc2626' },
  ]},
  // Cartao e Multimarcas VOLTARAM (pedido explicito do usuario). Cartao: o
  // backend ja desconta o cartao da coluna Lojas (meta), entao sem somar o
  // Cartao essa parte sumia das entradas.
  { group: 'Entradas', cols: [
    { key: 'outrasEntradas', label: 'Outras Entradas', color: '#7c3aed' },
    { key: 'boleto', label: 'Boleto', color: '#0284c7' },
    { key: 'cheque', label: 'Cheque', color: '#059669' },
    { key: 'lojas', label: 'Lojas', color: '#0891b2' },
    { key: 'cartao', label: 'Cartão', color: '#4d7c0f' },
    { key: 'multimarcas', label: 'Multimarcas', color: '#9333ea' },
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
    <div className={`flex items-center justify-between gap-6 ${detalhe ? 'pl-4 text-black' : 'text-black'}`}>
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
      <p className="font-semibold text-black mb-1.5">{fmtMes(m.mes)}</p>
      <LinhaTooltip cor={COR_ENTRADAS} rotulo="Entradas" valor={m.totalEntradas} forte />
      <LinhaTooltip rotulo="Outras entradas" valor={m.outrasEntradas} detalhe />
      <LinhaTooltip rotulo="Boleto" valor={m.boleto} detalhe />
      <LinhaTooltip rotulo="Cheque" valor={m.cheque} detalhe />
      <LinhaTooltip rotulo="Lojas" valor={m.lojas} detalhe />
      <LinhaTooltip rotulo="Cartão" valor={m.cartao} detalhe />
      <LinhaTooltip rotulo="Multimarcas" valor={m.multimarcas} detalhe />
      <div className="pt-1" />
      <LinhaTooltip cor={COR_SAIDAS} rotulo="Saídas" valor={m.totalSaidas} forte />
      <LinhaTooltip rotulo="Real" valor={m.real} detalhe />
      <LinhaTooltip rotulo="Previsão" valor={m.previsao} detalhe />
      <LinhaTooltip rotulo="Pedidos" valor={m.pedidos} detalhe />
      {!!m.ajusteGarantia && (
        <LinhaTooltip rotulo="Pagamento uso da garantia (simulação)" valor={m.ajusteGarantia} detalhe />
      )}
      <div className="border-t border-gray-100 mt-1.5 pt-1.5">
        <LinhaTooltip cor={COR_SALDO} rotulo="Saldo acumulado" valor={m.saldoAcumulado} forte />
      </div>
    </div>
  );
}

// Selo do banco (sigla nas cores da marca) ao lado do nome em Saldos
// Bancarios - sem imagem externa. Banco fora da lista ganha selo cinza com
// as iniciais; pra dar cor a um banco novo, basta incluir aqui.
const SELOS_BANCO: { chaves: string[]; sigla: string; fundo: string; texto: string }[] = [
  { chaves: ['itau'], sigla: 'it', fundo: '#EC7000', texto: '#002D72' },
  { chaves: ['santander'], sigla: 'S', fundo: '#EC0000', texto: '#FFFFFF' },
  { chaves: ['banco do brasil', 'bb'], sigla: 'BB', fundo: '#FAE128', texto: '#0038A8' },
  { chaves: ['abc'], sigla: 'ABC', fundo: '#00335E', texto: '#FFFFFF' },
  { chaves: ['bnb', 'nordeste'], sigla: 'BNB', fundo: '#B5121B', texto: '#FFFFFF' },
  { chaves: ['safra'], sigla: 'S', fundo: '#0B2240', texto: '#C9A54C' },
  { chaves: ['bradesco'], sigla: 'B', fundo: '#CC092F', texto: '#FFFFFF' },
  { chaves: ['caixa', 'cef'], sigla: 'CX', fundo: '#005CA9', texto: '#F39200' },
  { chaves: ['sicoob'], sigla: 'SC', fundo: '#003641', texto: '#00AE9D' },
  { chaves: ['sicredi'], sigla: 'SI', fundo: '#3FA110', texto: '#FFFFFF' },
  { chaves: ['nubank', 'nu pagamentos'], sigla: 'nu', fundo: '#820AD1', texto: '#FFFFFF' },
  { chaves: ['inter'], sigla: 'in', fundo: '#FF7A00', texto: '#FFFFFF' },
  { chaves: ['btg'], sigla: 'BTG', fundo: '#0D1F3C', texto: '#FFFFFF' },
];

function normalizarNome(nome: string): string {
  return nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function SeloBanco({ nome }: { nome: string }) {
  const n = normalizarNome(nome);
  const selo = SELOS_BANCO.find((s) => s.chaves.some((k) => n === k || n.startsWith(`${k} `) || n.includes(k)));
  const palavras = nome.split(/\s+/).filter((p) => p && !['banco', 'do', 'da', 'de', 's.a.', 'sa'].includes(normalizarNome(p)));
  const sigla = selo?.sigla ?? (palavras.length ? palavras : [nome]).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded-full font-bold flex-shrink-0 ring-1 ring-black/5"
      style={{ backgroundColor: selo?.fundo ?? '#e5e7eb', color: selo?.texto ?? '#000000', fontSize: sigla.length >= 3 ? 8 : 10, letterSpacing: sigla.length >= 3 ? '-0.02em' : undefined }}
      aria-hidden="true"
    >
      {sigla}
    </span>
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
    return <p className="text-sm text-black py-8 text-center">Sem dados no período.</p>;
  }
  // Saldo acumulado parte do saldo bancario real (mesma base da coluna
  // "Saldo Acum." da tabela diaria) e vai somando o resultado (entradas -
  // saidas) de cada mes, em ordem - nao e o resultado isolado do mes.
  // Cartao e Multimarcas compoem as entradas (ver COL_DEFS).
  let acumulado = saldoBancario;
  const dados: MesFCComSaldo[] = meses.map((m) => {
    const totalEntradas = m.outrasEntradas + m.boleto + m.cheque + m.lojas + m.cartao + m.multimarcas;
    // ajusteGarantia: pagamento simulado do Uso da Garantia caido nesse mes -
    // nao e uma saida real, so desconta do saldo (ver mesesEfetivos).
    acumulado += totalEntradas - m.totalSaidas - (m.ajusteGarantia || 0);
    return { ...m, totalEntradas, saldoAcumulado: acumulado, saidasAbaixoZero: -m.totalSaidas };
  });
  return (
    <div role="img" aria-label="Saídas, entradas e saldo acumulado projetados por mês">
      <div className="flex items-center gap-5 mb-3 text-xs text-black">
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
          <XAxis dataKey="mes" tickFormatter={fmtMes} axisLine={false} tickLine={false} interval={0} tick={{ fontSize: 13, fill: '#000000', fontWeight: 600 }} dy={6} />
          <YAxis
            tickFormatter={(v: number) => fmtBRLCompacto(v)} tick={{ fontSize: 12, fill: '#000000' }} axisLine={false} tickLine={false} width={88}
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
// Faturamento diario da fabrica (empresa 1) no mes atual - busca sozinho,
// sem depender do filtro de periodo/empresas da tela.
interface FaturamentoFabricaMes {
  mes: string;
  hoje: string;
  dias: { dia: string; valor: number | null }[];
  total: number;
  anoAnterior?: { inicio: string; fim: string; dias: { dia: string; valor: number }[]; total: number };
}

interface ResumoDias { total: number; media: number; melhor: { dia: string; valor: number } | null }

function resumirDias(dias: { dia: string; valor: number | null }[]): ResumoDias {
  const comVenda = dias.filter((d) => (d.valor ?? 0) > 0) as { dia: string; valor: number }[];
  const total = dias.reduce((a, d) => a + (d.valor ?? 0), 0);
  const media = comVenda.length ? comVenda.reduce((a, d) => a + d.valor, 0) / comVenda.length : 0;
  const melhor = comVenda.reduce<{ dia: string; valor: number } | null>((m, d) => (!m || d.valor > m.valor ? d : m), null);
  return { total, media, melhor };
}

// Comparacao com o mesmo periodo do ano anterior embaixo de cada indicador:
// "2025: R$ X" + variacao % (verde se subiu, vermelho se caiu).
function Comparativo({ atual, anterior, ano, sufixo }: { atual: number; anterior: number; ano: string; sufixo?: string }) {
  const variacao = anterior ? (atual / anterior - 1) * 100 : null;
  const subiu = (variacao ?? 0) >= 0;
  return (
    <p className="text-xs text-black mt-0.5 whitespace-nowrap">
      {ano}: <span className="tabular-nums">{fmtBRL(anterior)}</span>{sufixo ? <span> {sufixo}</span> : null}
      {variacao !== null && (
        <span className={`ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 font-semibold tabular-nums ${subiu ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {subiu ? '▲' : '▼'} {Math.abs(variacao).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
        </span>
      )}
    </p>
  );
}

const MESES_EXTENSO = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DIAS_SEMANA_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function TooltipFaturamento({ active, payload, hoje }: { active?: boolean; payload?: { payload: { dia: string; valor: number | null; fabrica?: number | null; lojas?: number | null } }[]; hoje: string }) {
  if (!active || !payload?.length) return null;
  const { dia, valor, fabrica, lojas } = payload[0].payload;
  if (valor === null) return null;
  const dt = new Date(`${dia}T12:00:00`);
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-black">
        {dia.split('-').reverse().join('/')} ({DIAS_SEMANA_CURTO[dt.getDay()]}){dia === hoje ? ' · parcial' : ''}
      </p>
      <p className="tabular-nums text-black mt-0.5 font-semibold">{fmtBRL(valor)}</p>
      {fabrica !== undefined && lojas !== undefined && (
        <div className="mt-1 pt-1 border-t border-gray-100 space-y-0.5 tabular-nums text-black">
          <p className="flex justify-between gap-4"><span>Fábrica</span><span>{fmtBRL(fabrica ?? 0)}</span></p>
          <p className="flex justify-between gap-4"><span>Lojas</span><span>{fmtBRL(lojas ?? 0)}</span></p>
        </div>
      )}
    </div>
  );
}

// Rotulo em dinheiro em cima de cada coluna ("R$ 247 mil", "R$ 873").
// Quando o texto nao cabe na largura da coluna (tela estreita / mes cheio),
// vira vertical: dentro da coluna, em branco, se ela for alta o bastante;
// senao, acima dela. Assim nunca encosta no rotulo do dia vizinho.
function fmtRotuloDia(v: number): string {
  const abs = Math.abs(v);
  const sinal = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sinal}R$ ${(abs / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1000) return `${sinal}R$ ${Math.round(abs / 1000).toLocaleString('pt-BR')} mil`;
  return `${sinal}R$ ${Math.round(abs).toLocaleString('pt-BR')}`;
}

function rotuloFaturamentoDia(corTexto: string, valorColunaClara: number | null) {
  return function RotuloFaturamentoDia(props: LabelProps) {
    const vb = (props.viewBox ?? {}) as { x?: number; y?: number; width?: number; height?: number };
    const valor = Number(props.value ?? 0);
    if (!valor) return null;
    const largura = Number(vb.width ?? props.width ?? 0);
    const altura = Math.abs(Number(vb.height ?? props.height ?? 0));
    const x = Number(vb.x ?? props.x ?? 0) + largura / 2;
    const topo = Number(vb.y ?? props.y ?? 0);
    const texto = fmtRotuloDia(valor);
    const larguraTexto = texto.length * 6.4;
    // barCategoryGap 20%: o espaco do dia e ~largura da coluna / 0,8
    if (larguraTexto <= largura / 0.8 + 2) {
      return (
        <text x={x} y={topo - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill={corTexto}
          stroke="#ffffff" strokeWidth={3} paintOrder="stroke">
          {texto}
        </text>
      );
    }
    const dentro = altura >= larguraTexto + 10;
    const y = dentro ? topo + 6 : topo - 6;
    return (
      <text x={x} y={y} transform={`rotate(-90, ${x}, ${y})`} textAnchor={dentro ? 'end' : 'start'} dominantBaseline="central"
        fontSize={11} fontWeight={600} fill={dentro && valor !== valorColunaClara ? '#ffffff' : corTexto}
        stroke={dentro ? 'none' : '#ffffff'} strokeWidth={dentro ? 0 : 3} paintOrder="stroke">
        {texto}
      </text>
    );
  };
}

interface ConfigFaturamento {
  titulo: string;
  empresas: string;
  cor: string;
  corHoje: string;
  corRotulo: string;
}

type VisaoFaturamento = 'fabrica' | 'lojas' | 'ambos';

const CONFIG_FATURAMENTO: Record<VisaoFaturamento, ConfigFaturamento> = {
  fabrica: { titulo: 'Fábrica', empresas: 'empresa 001', cor: '#4f46e5', corHoje: '#a5b4fc', corRotulo: '#3730a3' },
  lojas: { titulo: 'Lojas', empresas: 'empresas 002 a 120 somadas', cor: '#0891b2', corHoje: '#a5f3fc', corRotulo: '#155e75' },
  ambos: { titulo: 'Fábrica + Lojas', empresas: 'empresas 001 a 120 somadas', cor: '#334155', corHoje: '#94a3b8', corRotulo: '#0f172a' },
};

const CHAVE_VISAO_FATURAMENTO = 'fluxo_caixa_faturamento_visao';

// Acumulado do ano: meses FECHADOS (backend, com cache) + o mes atual ate
// hoje (que ja vem do endpoint do mes) - evita refazer a consulta pesada
// do mes atual duas vezes.
interface FaturamentoAno {
  ano: number;
  ateMes: string | null;
  calculando: boolean;
  mesesPendentes: number;
  fabrica: { atual: number; anterior: number };
  lojas: { atual: number; anterior: number };
}

// Soma fabrica + lojas dia a dia (mesmo mes, mesmos dias). Guarda a parte de
// cada um pro tooltip. Dia futuro (null nos dois) continua null.
function somarDiasFaturamento(x: { dia: string; valor: number | null }[], y: { dia: string; valor: number | null }[]) {
  return x.map((d, i) => {
    const outro = y[i]?.valor ?? null;
    return {
      dia: d.dia,
      valor: d.valor === null && outro === null ? null : (d.valor ?? 0) + (outro ?? 0),
      fabrica: d.valor,
      lojas: outro,
    };
  });
}

function somarFaturamento(a: FaturamentoFabricaMes, b: FaturamentoFabricaMes): FaturamentoFabricaMes {
  return {
    mes: a.mes,
    hoje: a.hoje,
    dias: somarDiasFaturamento(a.dias, b.dias),
    total: a.total + b.total,
    anoAnterior: a.anoAnterior && b.anoAnterior
      ? {
          inicio: a.anoAnterior.inicio,
          fim: a.anoAnterior.fim,
          dias: somarDiasFaturamento(a.anoAnterior.dias, b.anoAnterior.dias).map((d) => ({ dia: d.dia, valor: d.valor ?? 0 })),
          total: a.anoAnterior.total + b.anoAnterior.total,
        }
      : undefined,
  };
}

function GraficoFaturamentoUnificado() {
  const [fabrica, setFabrica] = useState<FaturamentoFabricaMes | null>(null);
  const [lojas, setLojas] = useState<FaturamentoFabricaMes | null>(null);
  const [ano, setAno] = useState<FaturamentoAno | null>(null);
  const [anoErro, setAnoErro] = useState(false);
  const [erro, setErro] = useState('');
  const [visao, setVisao] = useState<VisaoFaturamento>('ambos');

  useEffect(() => {
    try {
      const salva = localStorage.getItem(CHAVE_VISAO_FATURAMENTO);
      if (salva === 'fabrica' || salva === 'lojas' || salva === 'ambos') setVisao(salva);
    } catch { /* sem localStorage: fica no padrao */ }
    const buscarJson = async (url: string) => {
      const r = await fetch(url, { cache: 'no-store' });
      const json = await r.json();
      if (!r.ok) throw new Error(json.detail || json.error || 'Erro ao buscar faturamento');
      return json;
    };
    const msg = (e: unknown) => (e instanceof Error ? e.message : 'Erro ao buscar faturamento');
    buscarJson('/api/fluxo-caixa/faturamento-fabrica-mes').then(setFabrica).catch((e) => setErro(msg(e)));
    buscarJson('/api/fluxo-caixa/faturamento-lojas-mes').then(setLojas).catch((e) => setErro(msg(e)));
    // Primeira vez (cache vazio) o backend calcula em segundo plano e responde
    // calculando=true - tenta de novo a cada 30s ate ficar pronto.
    let tentativa: ReturnType<typeof setTimeout> | undefined;
    const buscarAno = () => {
      buscarJson('/api/fluxo-caixa/faturamento-ano')
        .then((r: FaturamentoAno) => {
          setAno(r);
          if (r.calculando) tentativa = setTimeout(buscarAno, 30000);
        })
        .catch(() => setAnoErro(true));
    };
    buscarAno();
    return () => { if (tentativa) clearTimeout(tentativa); };
  }, []);

  function escolherVisao(v: VisaoFaturamento) {
    setVisao(v);
    try { localStorage.setItem(CHAVE_VISAO_FATURAMENTO, v); } catch { /* ignora */ }
  }

  const config = CONFIG_FATURAMENTO[visao];
  const dados: FaturamentoFabricaMes | null =
    visao === 'fabrica' ? fabrica : visao === 'lojas' ? lojas : fabrica && lojas ? somarFaturamento(fabrica, lojas) : null;

  // Acumulado do ano conforme a visao: meses fechados + mes atual ate hoje.
  const acumulado = (() => {
    if (!ano || ano.calculando || !fabrica || !lojas) return null;
    const partes = visao === 'fabrica' ? [ano.fabrica] : visao === 'lojas' ? [ano.lojas] : [ano.fabrica, ano.lojas];
    const mesAtual = visao === 'fabrica' ? [fabrica] : visao === 'lojas' ? [lojas] : [fabrica, lojas];
    return {
      atual: partes.reduce((a, p) => a + p.atual, 0) + mesAtual.reduce((a, m) => a + m.total, 0),
      anterior: partes.reduce((a, p) => a + p.anterior, 0) + mesAtual.reduce((a, m) => a + (m.anoAnterior?.total ?? 0), 0),
      ate: fabrica.hoje,
      ateAnterior: fabrica.anoAnterior?.fim ?? null,
    };
  })();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-black uppercase tracking-wide mr-1">Faturamento</span>
        <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5" role="group" aria-label="Escolher fábrica, lojas ou os dois">
          {(['fabrica', 'lojas', 'ambos'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => escolherVisao(v)}
              aria-pressed={visao === v}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${visao === v ? 'bg-gray-900 text-white font-semibold' : 'text-black hover:bg-gray-100'}`}
            >
              {CONFIG_FATURAMENTO[v].titulo}
            </button>
          ))}
        </div>
      </div>

      <AcumuladoAno
        acumulado={acumulado}
        carregando={!anoErro && !erro && (!ano || ano.calculando)}
        mensagem={ano?.calculando ? `Calculando o acumulado do ano pela primeira vez (${ano.mesesPendentes} meses) — leva alguns minutos, a tela atualiza sozinha.` : 'Calculando acumulado do ano…'}
        titulo={config.titulo}
      />

      <GraficoFaturamentoDiario config={config} dados={dados} erro={erro} />
    </div>
  );
}

function AcumuladoAno({ acumulado, carregando, mensagem, titulo }: {
  acumulado: { atual: number; anterior: number; ate: string; ateAnterior: string | null } | null;
  carregando: boolean; mensagem: string; titulo: string;
}) {
  if (!acumulado) {
    return carregando ? (
      <div className="bg-white rounded-lg shadow-md p-4 text-sm text-black flex items-center">
        <Loader2 className="w-4 h-4 animate-spin mr-2 text-rose-600" /> {mensagem}
      </div>
    ) : null;
  }
  const variacao = acumulado.anterior ? (acumulado.atual / acumulado.anterior - 1) * 100 : null;
  const subiu = (variacao ?? 0) >= 0;
  const anoAtual = acumulado.ate.slice(0, 4);
  const anoAnt = acumulado.ateAnterior?.slice(0, 4) ?? String(Number(anoAtual) - 1);
  const fmtAte = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return (
    <div className={`bg-white rounded-lg shadow-md p-4 border-l-4 ${subiu ? 'border-green-500' : 'border-red-500'}`}>
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <p className="text-sm font-semibold text-black">Acumulado do ano — {titulo}</p>
          <p className="text-xs text-black mt-0.5">
            01/01 a {fmtAte(acumulado.ate)} de {anoAtual}, comparado com o mesmo período de {anoAnt}
          </p>
        </div>
        <div className="flex items-end gap-8 flex-wrap">
          <div className="text-right">
            <p className="text-xs text-black">{anoAtual}</p>
            <p className="text-2xl font-bold text-black tabular-nums whitespace-nowrap">{fmtBRL(acumulado.atual)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-black">{anoAnt}</p>
            <p className="text-lg font-semibold text-black tabular-nums whitespace-nowrap">{fmtBRL(acumulado.anterior)}</p>
          </div>
          {variacao !== null && (
            <div className="text-right">
              <p className="text-xs text-black">Variação</p>
              <p className={`text-2xl font-bold tabular-nums whitespace-nowrap ${subiu ? 'text-green-700' : 'text-red-700'}`}>
                {subiu ? '▲' : '▼'} {Math.abs(variacao).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
              </p>
              <p className={`text-xs tabular-nums ${subiu ? 'text-green-700' : 'text-red-700'}`}>
                {subiu ? '+' : '−'}{fmtBRL(Math.abs(acumulado.atual - acumulado.anterior))}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GraficoFaturamentoDiario({ config, dados, erro }: { config: ConfigFaturamento; dados: FaturamentoFabricaMes | null; erro: string }) {
  // Coluna de hoje usa tom claro: texto branco dentro dela some, entao vai
  // escuro (identificada pelo valor - o rotulo do recharts nao recebe o indice).
  const rotulo = React.useMemo(
    () => rotuloFaturamentoDia(config.corRotulo, dados?.dias.find((d) => d.dia === dados.hoje)?.valor ?? null),
    [config.corRotulo, dados],
  );
  const [ano, mes] = (dados?.mes ?? '').split('-');
  const { media, melhor } = resumirDias(dados?.dias ?? []);
  const anterior = dados?.anoAnterior ? resumirDias(dados.anoAnterior.dias) : null;
  const anoAnt = dados?.anoAnterior?.inicio.slice(0, 4) ?? '';

  // Marcacoes redondas no eixo (0, 100 mil, 200 mil...) - o automatico do
  // recharts dava 65 mil / 130 mil / 195 mil.
  const maxValor = Math.max(...(dados?.dias ?? []).map((d) => d.valor ?? 0), 0);
  const ticksEixo = (() => {
    if (maxValor <= 0) return [0];
    const bruto = maxValor / 4;
    const mag = 10 ** Math.floor(Math.log10(bruto));
    const passo = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((p) => p >= bruto) ?? 10 * mag;
    const n = Math.ceil(maxValor / passo);
    return Array.from({ length: n + 1 }, (_, i) => i * passo);
  })();

  return (
    <div className="bg-white rounded-lg shadow-md p-4">
      <div className="flex items-start justify-between flex-wrap gap-4 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Faturamento Diário — {config.titulo}</h2>
          <p className="text-xs text-black mt-0.5">
            {dados ? `${MESES_EXTENSO[Number(mes) - 1]}/${ano} · ${config.empresas} · não depende do filtro acima${dados.anoAnterior ? ` · comparação com ${dados.anoAnterior.inicio.split('-').reverse().join('/')} a ${dados.anoAnterior.fim.split('-').reverse().join('/')}` : ''}` : `Mês atual · ${config.empresas}`}
          </p>
        </div>
        {dados && (
          <div className="flex gap-6 text-right">
            <div>
              <p className="text-xs text-black">Total no mês</p>
              <p className="text-lg font-bold text-black whitespace-nowrap">{fmtBRL(dados.total)}</p>
              {anterior && <Comparativo atual={dados.total} anterior={anterior.total} ano={anoAnt} />}
            </div>
            <div>
              <p className="text-xs text-black">Média por dia com venda</p>
              <p className="text-lg font-semibold text-black whitespace-nowrap">{fmtBRL(media)}</p>
              {anterior && <Comparativo atual={media} anterior={anterior.media} ano={anoAnt} />}
            </div>
            {melhor && (
              <div>
                <p className="text-xs text-black">Melhor dia</p>
                <p className="text-lg font-semibold text-black whitespace-nowrap">
                  {fmtBRL(melhor.valor)} <span className="text-xs font-normal text-black">em {melhor.dia.slice(8, 10)}/{mes}</span>
                </p>
                {anterior?.melhor && (
                  <Comparativo atual={melhor.valor} anterior={anterior.melhor.valor} ano={anoAnt}
                    sufixo={`em ${anterior.melhor.dia.slice(8, 10)}/${anterior.melhor.dia.slice(5, 7)}`} />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {erro && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{erro}</span>
        </div>
      )}
      {!dados && !erro && (
        <div className="flex items-center justify-center py-16 text-black text-sm">
          <Loader2 className="w-5 h-5 animate-spin mr-2 text-rose-600" /> Carregando faturamento…
        </div>
      )}
      {dados && (
        <div role="img" aria-label={`${config.titulo} em ${MESES_EXTENSO[Number(mes) - 1]} de ${ano}`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={dados.dias} margin={{ top: 22, right: 16, left: 4, bottom: 0 }} barCategoryGap="20%">
              <CartesianGrid stroke="#f1f2f4" vertical={false} />
              <XAxis
                dataKey="dia" axisLine={{ stroke: '#d1d5db' }} tickLine={false} interval={0} height={44}
                tick={(p: unknown) => {
                  const { x, y, payload } = p as { x: number; y: number; payload: { value: string } };
                  const dt = new Date(`${payload.value}T12:00:00`);
                  const fds = dt.getDay() === 0 || dt.getDay() === 6;
                  return (
                    <g>
                      <text x={x} y={Number(y) + 14} textAnchor="middle" fontSize={11} fontWeight={payload.value === dados.hoje || fds ? 700 : 500} fill="#000000">
                        {payload.value.slice(8, 10)}
                      </text>
                      <text x={x} y={Number(y) + 27} textAnchor="middle" fontSize={10} fontWeight={fds ? 700 : 400} fill="#000000">
                        {DIAS_SEMANA_CURTO[dt.getDay()]}
                      </text>
                    </g>
                  );
                }}
              />
              <YAxis
                tickFormatter={(v: number) => fmtBRLCompacto(v)} tick={{ fontSize: 12, fill: '#000000' }} axisLine={false} tickLine={false} width={88}
                ticks={ticksEixo} domain={[0, ticksEixo[ticksEixo.length - 1] || 1]}
              />
              {media > 0 && (
                <ReferenceLine y={media} stroke="#9ca3af" label={{ value: `média ${fmtBRLCompacto(media)}`, position: 'insideTopRight', fontSize: 11, fill: '#000000' }} />
              )}
              <Tooltip content={<TooltipFaturamento hoje={dados.hoje} />} cursor={{ fill: '#f3f4f6', radius: 4 }} />
              <Bar dataKey="valor" radius={[4, 4, 0, 0]} maxBarSize={36}>
                <LabelList dataKey="valor" content={rotulo} />
                {dados.dias.map((d) => (
                  <Cell key={d.dia} fill={d.dia === dados.hoje ? config.corHoje : config.cor} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-black mt-1 flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: config.corHoje }} />
            Hoje (dia ainda em andamento) · sábado e domingo em negrito no eixo
          </p>
        </div>
      )}
    </div>
  );
}

// Pontos de atencao do periodo: o dia de menor saldo acumulado (e se/quando o
// saldo fica negativo) e os 5 dias com mais saidas. Usa as mesmas linhas da
// Visao Diaria (com toggles de coluna e simulacao), entao bate com a tabela.
interface LinhaAtencao {
  dia: { dia: string };
  effSaidas: number;
  effReal: number;
  effPrev: number;
  effPed: number;
  saldoAcum: number;
}

function fmtDiaSemana(iso: string): string {
  const dt = new Date(`${iso}T12:00:00`);
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} (${DIAS_SEMANA_CURTO[dt.getDay()]})`;
}

function PontosAtencaoCaixa({ linhas, totalSaidas }: { linhas: LinhaAtencao[]; totalSaidas: number }) {
  if (!linhas.length) return null;
  const pior = linhas.reduce((m, l) => (l.saldoAcum < m.saldoAcum ? l : m), linhas[0]);
  const negativos = linhas.filter((l) => l.saldoAcum < 0);
  const primeiroNegativo = negativos[0];
  const ultimoNegativo = negativos[negativos.length - 1];
  const terminaNegativo = linhas[linhas.length - 1].saldoAcum < 0;
  const picos = linhas.filter((l) => l.effSaidas > 0).sort((a, b) => b.effSaidas - a.effSaidas).slice(0, 5);
  const maiorPico = picos[0]?.effSaidas ?? 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className={`bg-white rounded-lg shadow-md p-4 border-l-4 ${pior.saldoAcum < 0 ? 'border-red-500' : 'border-green-500'}`}>
        <div className="flex items-center gap-2 text-black text-xs font-medium">
          <AlertCircle className={`w-4 h-4 ${pior.saldoAcum < 0 ? 'text-red-600' : 'text-green-600'}`} /> Dia crítico do caixa
        </div>
        <p className="text-sm text-black mt-2">Menor saldo acumulado do período</p>
        <p className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-2xl font-bold tabular-nums ${pior.saldoAcum < 0 ? 'text-red-700' : 'text-green-700'}`}>{fmtBRL(pior.saldoAcum)}</span>
          <span className="text-sm text-black">em {fmtDiaSemana(pior.dia.dia)}</span>
        </p>
        <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-black">
          {negativos.length === 0 ? (
            <p>O saldo não fica negativo em nenhum dia do período.</p>
          ) : (
            <p>
              Saldo negativo em <strong>{negativos.length} dia{negativos.length > 1 ? 's' : ''}</strong> do período —
              a partir de <strong>{fmtDiaSemana(primeiroNegativo.dia.dia)}</strong>
              {terminaNegativo
                ? ', e continua negativo até o fim do período.'
                : <> até <strong>{fmtDiaSemana(ultimoNegativo.dia.dia)}</strong>.</>}
            </p>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4 border-l-4 border-red-500">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-black text-xs font-medium">
            <TrendingDown className="w-4 h-4 text-red-600" /> Picos de pagamento
          </div>
          <span className="text-xs text-black">5 dias com mais saídas</span>
        </div>
        {picos.length === 0 ? (
          <p className="text-sm text-black mt-3">Nenhuma saída no período.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {picos.map((l) => {
              const pct = totalSaidas > 0 ? (l.effSaidas / totalSaidas) * 100 : 0;
              const partes = [
                l.effReal > 0 ? `Real ${fmtBRL(l.effReal)}` : null,
                l.effPrev > 0 ? `Prev. ${fmtBRL(l.effPrev)}` : null,
                l.effPed > 0 ? `Pedidos ${fmtBRL(l.effPed)}` : null,
              ].filter(Boolean).join(' · ');
              return (
                <div key={l.dia.dia} title={partes}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-black font-medium tabular-nums">{fmtDiaSemana(l.dia.dia)}</span>
                    <span className="flex items-baseline gap-2">
                      <span className="font-semibold text-red-700 tabular-nums">{fmtBRL(l.effSaidas)}</span>
                      <span className="text-xs text-black tabular-nums w-12 text-right">{pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mt-1">
                    <div className="h-full rounded-full bg-red-500" style={{ width: `${Math.max(3, (l.effSaidas / maxOr1(maiorPico)) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-black pt-1">% sobre o total de saídas do período ({fmtBRL(totalSaidas)}) · passe o mouse para ver a composição</p>
          </div>
        )}
      </div>
    </div>
  );
}

function maxOr1(v: number): number {
  return v > 0 ? v : 1;
}

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
    <span className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 text-black text-lg font-semibold flex items-center justify-center" aria-hidden="true">
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
            <p className="text-base text-black">{p.rotulo}</p>
            <p className={`text-xl font-semibold text-black tabular-nums whitespace-nowrap ${p.ativa ? '' : 'line-through'}`}>{fmtBRL(p.valor)}</p>
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
        {dtIni && <span className="text-sm text-black tabular-nums">{fmtDia(dtIni)} a {fmtDia(dtFim)}</span>}
      </div>
      <div className="p-4 grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-3 min-w-0">
          <LinhaEquacao parcelas={entradas} rotuloTotal="Total de recebimentos" total={totalEntradas} tom="entrada" />
          <LinhaEquacao parcelas={saidas} rotuloTotal="Total de pagamentos" total={totalSaidas} tom="saida" />
        </div>
        <div className={`rounded-xl border-2 p-4 flex flex-col md:flex-row md:items-center md:justify-between xl:flex-col xl:items-stretch xl:justify-center gap-3 ${positivo ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'}`}>
          <div>
            <p className="text-sm font-medium text-black">Saldo final do período</p>
            <p className={`text-4xl font-bold whitespace-nowrap mt-0.5 ${positivo ? 'text-green-700' : 'text-red-700'}`}>{fmtBRL(saldoFinal)}</p>
          </div>
          <div className="pt-3 border-t md:pt-0 md:border-t-0 md:pl-4 md:border-l xl:pl-0 xl:border-l-0 xl:pt-3 xl:border-t border-gray-200 space-y-1 text-sm tabular-nums md:min-w-[300px] xl:min-w-0">
            <div className="flex justify-between gap-3 text-black"><span>Saldo inicial</span><span>{fmtBRL(saldoInicial)}</span></div>
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
function ListaBarrasRanking({ itens, cor, selecionado, onSelecionar }: {
  itens: ItemRanking[]; cor: string;
  // Opcional: linha clicavel (usado nas Despesas pra filtrar os fornecedores)
  selecionado?: string | null;
  onSelecionar?: (item: ItemRanking) => void;
}) {
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  if (!itens.length) {
    return <p className="text-sm text-black py-8 text-center">Sem dados no período.</p>;
  }
  const maxValor = Math.max(...itens.map((i) => i.valor), 1);
  function alternar(nome: string) {
    setAbertos((atual) => {
      const novo = new Set(atual);
      if (novo.has(nome)) novo.delete(nome);
      else novo.add(nome);
      return novo;
    });
  }
  const clicavel = !!onSelecionar;
  return (
    <div className="max-h-[700px] overflow-y-auto pr-1 -mx-2 space-y-0.5">
      {itens.map((item, i) => {
        const temComposicao = !!item.composicao?.length;
        const aberto = abertos.has(item.nome);
        const ativo = selecionado === item.nome;
        return (
          <div key={`${item.nome}-${i}`}>
            <div
              className={`flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors ${
                ativo ? 'bg-amber-100 ring-1 ring-amber-400' : 'hover:bg-gray-50'
              } ${clicavel || temComposicao ? 'cursor-pointer' : ''}`}
              onClick={clicavel ? () => onSelecionar!(item) : temComposicao ? () => alternar(item.nome) : undefined}
              role={clicavel || temComposicao ? 'button' : undefined}
              aria-pressed={clicavel ? ativo : undefined}
              title={clicavel ? `Ver os fornecedores de ${item.nome}` : undefined}
            >
              <span className="w-5 flex-shrink-0 text-right text-xs text-black tabular-nums pt-0.5">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`text-sm text-black truncate ${temComposicao || ativo ? 'font-semibold' : ''}`} title={item.nome}>
                    {temComposicao && (
                      <button
                        type="button"
                        className="inline-block w-4 text-xs hover:text-amber-700"
                        onClick={(e) => { e.stopPropagation(); alternar(item.nome); }}
                        aria-expanded={aberto}
                        aria-label={aberto ? 'Recolher itens' : 'Ver itens'}
                      >
                        {aberto ? '▾' : '▸'}
                      </button>
                    )}
                    {item.nome}
                    {temComposicao && <span className="ml-1.5 text-xs font-normal">({item.composicao!.length} itens)</span>}
                  </span>
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
            {temComposicao && aberto && (
              <div className="ml-9 mr-2 mb-1 border-l-2 pl-3 py-1 space-y-0.5" style={{ borderColor: cor }}>
                {item.composicao!.map((c, j) => (
                  <div
                    key={`${c.nome}-${j}`}
                    className={`flex items-baseline justify-between gap-3 text-xs text-black rounded px-1 -mx-1 ${
                      selecionado === c.nome ? 'bg-amber-100 font-semibold' : clicavel ? 'hover:bg-gray-50' : ''
                    } ${clicavel ? 'cursor-pointer' : ''}`}
                    onClick={clicavel ? () => onSelecionar!(c) : undefined}
                    role={clicavel ? 'button' : undefined}
                    aria-pressed={clicavel ? selecionado === c.nome : undefined}
                  >
                    <span className="truncate" title={c.nome}>{c.nome}</span>
                    <span className="tabular-nums flex-shrink-0">
                      {fmtBRL(-c.valor)}
                      <span className="ml-1.5 inline-block w-10 text-right">
                        {((c.valor / item.valor) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type TipoSaidaDetalhe = 'previsao' | 'real' | 'pedidos';

const TITULO_SAIDA_DETALHE: Record<TipoSaidaDetalhe, { titulo: string; cor: string; doc: string }> = {
  previsao: { titulo: 'Saídas previstas', cor: '#ef4444', doc: 'Duplicata/Parcela' },
  real: { titulo: 'Saídas reais', cor: '#991b1b', doc: 'Duplicata/Parcela' },
  pedidos: { titulo: 'Pedidos de compra', cor: '#dc2626', doc: 'Pedido' },
};

interface SaidaDetalheItem {
  fornecedor: string;
  documento: string;
  empresa: number;
  dtOriginal: string;
  despesa: string | null;
  valor: number;
}

// Clique na celula Prev./Real/Pedidos da Visao Diaria: o que compoe aquele
// valor naquele dia (mesmo filtro de empresas da ultima consulta).
function ModalSaidasDetalhe({ dia, tipo, empresas, onFechar }: {
  dia: string; tipo: TipoSaidaDetalhe; empresas: string | null; onFechar: () => void;
}) {
  const [lista, setLista] = useState<SaidaDetalheItem[] | null>(null);
  const [erro, setErro] = useState('');
  const cfg = TITULO_SAIDA_DETALHE[tipo];

  useEffect(() => {
    let ativo = true;
    const params = new URLSearchParams({ dia, tipo });
    if (empresas) params.set('empresas', empresas);
    fetch(`/api/fluxo-caixa/saidas-detalhe?${params.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.detail || json.error || 'Erro ao buscar o detalhe');
        if (ativo) setLista(json);
      })
      .catch((e) => { if (ativo) { setErro(e instanceof Error ? e.message : 'Erro desconhecido'); setLista([]); } });
    return () => { ativo = false; };
  }, [dia, tipo, empresas]);

  useEffect(() => {
    const fechar = (e: KeyboardEvent) => { if (e.key === 'Escape') onFechar(); };
    window.addEventListener('keydown', fechar);
    return () => window.removeEventListener('keydown', fechar);
  }, [onFechar]);

  const total = (lista ?? []).reduce((a, i) => a + i.valor, 0);
  const fmtData = (iso: string) => iso.split('-').reverse().join('/');

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onFechar}>
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-black">
              {cfg.titulo} — {fmtDiaSemana(dia)}
            </h2>
            {lista !== null && lista.length > 0 && (
              <p className="text-xs text-black mt-0.5">{lista.length} {lista.length === 1 ? 'lançamento' : 'lançamentos'}</p>
            )}
          </div>
          <button onClick={onFechar} className="text-black hover:text-black" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto flex-1">
          {lista === null && (
            <div className="flex items-center justify-center py-12 text-black">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…
            </div>
          )}
          {erro && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md mx-5 mt-4 px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{erro}</span>
            </div>
          )}
          {lista !== null && !erro && lista.length === 0 && (
            <p className="text-sm text-black py-12 text-center">Nenhum lançamento encontrado para esse dia.</p>
          )}
          {lista !== null && lista.length > 0 && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-2 font-medium text-black">Fornecedor</th>
                  <th className="text-left px-3 py-2 font-medium text-black">{cfg.doc}</th>
                  <th className="text-right px-3 py-2 font-medium text-black">Empresa</th>
                  <th className="text-right px-3 py-2 font-medium text-black">{tipo === 'pedidos' ? 'Vencimento da parcela' : 'Vencimento original'}</th>
                  <th className="text-right px-5 py-2 font-medium text-black">Valor</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((item, i) => (
                  <tr key={`${item.documento}-${i}`} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="px-5 py-1.5 text-black">
                      {item.fornecedor}
                      {item.despesa && <span className="block text-xs text-black">{item.despesa}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-black tabular-nums whitespace-nowrap">{item.documento}</td>
                    <td className="px-3 py-1.5 text-right text-black tabular-nums">{String(item.empresa).padStart(3, '0')}</td>
                    <td className="px-3 py-1.5 text-right text-black tabular-nums">{item.dtOriginal ? fmtData(item.dtOriginal) : '—'}</td>
                    <td className="px-5 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap" style={{ color: cfg.cor }}>{fmtBRL(item.valor)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold bg-gray-200 border-t-2 border-gray-400">
                  <td colSpan={4} className="px-5 py-2 text-right uppercase text-xs tracking-wide text-black">Total</td>
                  <td className="px-5 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: cfg.cor }}>{fmtBRL(total)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function CabecalhoFornecedores({ titulo, despesa, carregando, onLimpar }: {
  titulo: string; despesa: DespesaSelecionada | null; carregando: boolean; onLimpar: () => void;
}) {
  return (
    <div className={`px-4 py-3 border-b ${despesa ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
      <h2 className="text-sm font-semibold text-black uppercase tracking-wide">{titulo}</h2>
      {despesa && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-black truncate">
            Só da despesa <strong>{despesa.nome}</strong>
            {carregando && <Loader2 className="inline w-3 h-3 animate-spin ml-1.5" />}
          </span>
          <button
            type="button"
            onClick={onLimpar}
            className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-black bg-white border border-gray-300 rounded px-1.5 py-0.5 hover:bg-gray-100"
            title="Mostrar todos os fornecedores"
          >
            <X className="w-3 h-3" /> Todos
          </button>
        </div>
      )}
    </div>
  );
}

// Mesma regra do backend pra Outras Entradas (_EXPR_DT_OUTRAS_ENTRADAS_EFETIVA):
// sabado/domingo entram no fluxo na terca seguinte.
function diaEntradaOutras(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const somar = d.getDay() === 6 ? 3 : d.getDay() === 0 ? 2 : 0;
  if (!somar) return iso;
  d.setDate(d.getDate() + somar);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function FluxoCaixaPage() {
  const { user } = useAuth();
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
  // Clique numa despesa: os paineis de fornecedor mostram so os dela.
  // Usa a mesma consulta (periodo/empresas) do ultimo "Aplicar".
  const [despesaSel, setDespesaSel] = useState<DespesaSelecionada | null>(null);
  const [fornecedoresDespesa, setFornecedoresDespesa] = useState<SaidaFornecedor[] | null>(null);
  const [carregandoFornDespesa, setCarregandoFornDespesa] = useState(false);
  const consultaRef = useRef('');
  const [saidaDetalhe, setSaidaDetalhe] = useState<{ dia: string; tipo: TipoSaidaDetalhe } | null>(null);
  const fecharSaidaDetalhe = useCallback(() => setSaidaDetalhe(null), []);
  const pedidoFornDespesaRef = useRef(0);
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
  // Simulacao de uso da garantia/limite (cheque especial): valor que
  // entraria em caixa hoje se a conta usasse o limite (soma no saldo
  // inicial da projecao) + data em que esse emprestimo e pago de volta
  // (lanca uma saida automatica nesse dia). COMPARTILHADA no servidor
  // (fcp_simulacao_fluxo_caixa), nao no localStorage - pedido explicito do
  // usuario: qualquer pessoa que abrir a tela, em qualquer computador, ve o
  // mesmo valor/data que outra pessoa configurou.
  // usoGarantiaInput = rascunho digitado (so afeta a projecao e o servidor
  // quando o usuario clica em "Aplicar" - pedido explicito do usuario,
  // substitui o auto-salvar a cada tecla de antes). usoGarantia = valor
  // APLICADO (o que entra no calculo e aparece no card).
  const [usoGarantiaInput, setUsoGarantiaInput] = useState(0);
  const [usoGarantia, setUsoGarantia] = useState(0);
  const [dtPagamentoGarantia, setDtPagamentoGarantia] = useState('');
  const [garantiaInfo, setGarantiaInfo] = useState<{ usuario: string | null; dtAtualizacao: string | null } | null>(null);
  const [garantiaSalvando, setGarantiaSalvando] = useState(false);
  const [garantiaErro, setGarantiaErro] = useState<string | null>(null);
  const garantiaCarregadaRef = useRef(false);
  // Guarda o que o servidor tinha quando a tela carregou/aplicou por ultimo -
  // so a Data de Pagamento se auto-salva (debounced) comparando com isso;
  // o valor so salva no clique do Aplicar.
  const garantiaServidorRef = useRef<{ usoGarantia: number; dtPagamentoGarantia: string }>({ usoGarantia: 0, dtPagamentoGarantia: '' });

  async function salvarGarantiaNoServidor(valor: number, data: string) {
    setGarantiaSalvando(true);
    setGarantiaErro(null);
    try {
      const resp = await fetch('/api/fluxo-caixa/simulacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usoGarantia: valor, dtPagamentoGarantia: data || null, usuario: user?.name || user?.username || null }),
      });
      // fetch() so rejeita em falha de rede - um erro HTTP (ex.: 500 do
      // backend) resolve normalmente e passaria batido como sucesso sem
      // essa checagem, mostrando "salvo" pro usuario sem ter salvo nada.
      if (!resp.ok) {
        const corpo = await resp.json().catch(() => null);
        throw new Error(corpo?.error || corpo?.detail || `Erro HTTP ${resp.status}`);
      }
      garantiaServidorRef.current = { usoGarantia: valor, dtPagamentoGarantia: data };
      setGarantiaInfo({ usuario: user?.name || user?.username || null, dtAtualizacao: new Date().toISOString() });
    } catch (e) {
      console.error('Erro ao salvar simulação (uso da garantia):', e);
      setGarantiaErro(e instanceof Error ? e.message : 'Erro desconhecido ao salvar.');
    } finally {
      setGarantiaSalvando(false);
    }
  }

  function aplicarUsoGarantia() {
    setUsoGarantia(usoGarantiaInput);
    salvarGarantiaNoServidor(usoGarantiaInput, dtPagamentoGarantia);
  }

  const [lojasModalAberto, setLojasModalAberto] = useState(false);
  const [lojasPaste, setLojasPaste] = useState('');
  const [lojasStatus, setLojasStatus] = useState('');
  const [lojasSalvando, setLojasSalvando] = useState(false);

  const [outrasEntradasModalAberto, setOutrasEntradasModalAberto] = useState(false);
  const [outrasEntradasPaste, setOutrasEntradasPaste] = useState('');
  const [outrasEntradasStatus, setOutrasEntradasStatus] = useState('');
  const [outrasEntradasSalvando, setOutrasEntradasSalvando] = useState(false);
  // O que ja esta cadastrado (de hoje em diante) - pra conferir e remover
  // alguma linha e simular o fluxo sem ela (pedido explicito do usuario).
  const [outrasEntradasLista, setOutrasEntradasLista] = useState<{ dia: string; valor: number }[] | null>(null);
  const [outrasEntradasRemovendo, setOutrasEntradasRemovendo] = useState<string | null>(null);

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

    // Uso da Garantia - compartilhado no servidor (nao no localStorage, ver
    // comentario do useState). garantiaCarregadaRef evita que o POST de
    // salvamento (useEffect mais abaixo) dispare com o valor "0" inicial
    // antes do GET responder.
    fetch('/api/fluxo-caixa/simulacao', { cache: 'no-store' })
      .then((r) => {
        // fetch() so rejeita em falha de rede - resposta de erro HTTP (ex.:
        // 500 numa instabilidade passageira do servidor) resolve normal e,
        // se nao checada, seria lida como JSON de erro e "usoGarantia"
        // cairia em 0 por padrao - sobrescrevendo silenciosamente um valor
        // configurado por outra pessoa.
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        const valor = json.usoGarantia || 0;
        const data = json.dtPagamentoGarantia || '';
        setUsoGarantiaInput(valor);
        setUsoGarantia(valor);
        setDtPagamentoGarantia(data);
        setGarantiaInfo({ usuario: json.usuario ?? null, dtAtualizacao: json.dtAtualizacao ?? null });
        garantiaServidorRef.current = { usoGarantia: valor, dtPagamentoGarantia: data };
        garantiaCarregadaRef.current = true;
        // Limpa um eventual erro de uma tentativa anterior que falhou (o
        // React chama este efeito duas vezes em desenvolvimento - se a
        // primeira falhou e so depois a segunda teve sucesso, o erro ficaria
        // preso na tela mesmo com os dados certos ja carregados).
        setGarantiaErro(null);
      })
      .catch((e) => {
        console.error('Erro ao buscar simulação (uso da garantia):', e);
        // So mostra o erro se AINDA nao tiver carregado com sucesso -
        // evita que uma segunda tentativa que falhou por acaso (o React
        // chama este efeito duas vezes em desenvolvimento) sobrescreva um
        // valor ja carregado certo com uma mensagem de erro.
        if (!garantiaCarregadaRef.current) {
          setGarantiaErro('Não foi possível carregar o Uso da Garantia salvo. Recarregue a página antes de aplicar um novo valor.');
          garantiaCarregadaRef.current = true;
        }
      });
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

  // Data de Pagamento - se auto-salva (debounced), separada do valor: o
  // valor (Uso da Garantia) so vai pro servidor quando o usuario clica em
  // "Aplicar" (pedido explicito do usuario - ver aplicarUsoGarantia). So
  // depois que o GET inicial ja respondeu (garantiaCarregadaRef) E so se a
  // data mudou de verdade em relacao ao que o servidor tinha - senao SO
  // ABRIR a tela (o GET ja seta dtPagamentoGarantia) dispararia um POST.
  useEffect(() => {
    if (!garantiaCarregadaRef.current) return;
    if (dtPagamentoGarantia === garantiaServidorRef.current.dtPagamentoGarantia) return;
    const timer = window.setTimeout(() => {
      salvarGarantiaNoServidor(usoGarantia, dtPagamentoGarantia);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dtPagamentoGarantia, usoGarantia]);


  async function buscar() {
    setLoading(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ dt_inicio: dtInicio, dt_fim: dtFim });
      if (empresasSelecionadas.size > 0 && empresasSelecionadas.size < empresasDisponiveis.length) {
        params.set('empresas', Array.from(empresasSelecionadas).join(','));
      }
      const qs = params.toString();
      consultaRef.current = qs;
      limparDespesaSel();
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

  function limparDespesaSel() {
    pedidoFornDespesaRef.current += 1;
    setDespesaSel(null);
    setFornecedoresDespesa(null);
    setCarregandoFornDespesa(false);
  }

  async function selecionarDespesa(item: ItemRanking) {
    if (despesaSel?.nome === item.nome) { limparDespesaSel(); return; }
    const ids = item.ids ?? [];
    if (!ids.length) return;
    const pedido = ++pedidoFornDespesaRef.current;
    setDespesaSel({ nome: item.nome, ids });
    setCarregandoFornDespesa(true);
    try {
      const params = new URLSearchParams(consultaRef.current);
      params.set('despesas', ids.join(','));
      const resp = await fetch(`/api/fluxo-caixa/saidas-por-fornecedor?${params.toString()}`, { cache: 'no-store' });
      const json = resp.ok ? await resp.json() : [];
      if (pedido === pedidoFornDespesaRef.current) setFornecedoresDespesa(Array.isArray(json) ? json : []);
    } catch (e) {
      console.error('Erro ao buscar fornecedores da despesa:', e);
      if (pedido === pedidoFornDespesaRef.current) setFornecedoresDespesa([]);
    } finally {
      if (pedido === pedidoFornDespesaRef.current) setCarregandoFornDespesa(false);
    }
  }

  const fornecedoresVisiveis = despesaSel ? (fornecedoresDespesa ?? []) : saidasFornecedor;

  const fornecedoresOrdenados = [...fornecedoresVisiveis].sort((a, b) => {
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
    setUsoGarantiaInput(0);
    setUsoGarantia(0);
    setDtPagamentoGarantia('');
    // Uso da Garantia e compartilhado no servidor - zera la tambem, senao
    // reabrir a tela (ou outra pessoa abrindo) traria o valor antigo de volta.
    if (garantiaCarregadaRef.current) salvarGarantiaNoServidor(0, '');
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

  async function outrasEntradasCarregarLista() {
    setOutrasEntradasLista(null);
    try {
      const res = await fetch(`/api/fluxo-caixa/outras-entradas-projecao?dt_inicio=${isoHoje()}&dt_fim=2099-12-31`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao carregar');
      setOutrasEntradasLista(json);
    } catch (e) {
      setOutrasEntradasStatus(`Erro ao carregar o que está cadastrado: ${e instanceof Error ? e.message : 'desconhecido'}`);
      setOutrasEntradasLista([]);
    }
  }

  function outrasEntradasAbrir() {
    setOutrasEntradasModalAberto(true);
    setOutrasEntradasStatus('');
    outrasEntradasCarregarLista();
  }

  async function outrasEntradasRemover(dia: string, valor: number) {
    const data = dia.split('-').reverse().join('/');
    if (!confirm(`Remover a entrada de ${data} (${fmtBRL(valor)})? Para voltar, é só colar a linha de novo.`)) return;
    setOutrasEntradasRemovendo(dia);
    try {
      const res = await fetch(`/api/fluxo-caixa/outras-entradas-projecao/${dia}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || json.detail || 'Erro ao remover');
      setOutrasEntradasStatus(`✓ Entrada de ${data} removida.`);
      await outrasEntradasCarregarLista();
      if (dados) buscar();
    } catch (e) {
      setOutrasEntradasStatus(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
    } finally {
      setOutrasEntradasRemovendo(null);
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
      // Fica aberto mostrando a lista atualizada (antes fechava sozinho).
      await outrasEntradasCarregarLista();
      if (dados) buscar();
    } catch (e) {
      setOutrasEntradasStatus(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
    } finally {
      setOutrasEntradasSalvando(false);
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
  const saldoInicialSimulado = (dados?.saldoBancario ?? 0) + usoGarantia;
  let acumLocal = saldoInicialSimulado;
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
    const effCart = ev('cartao', dia.cartao);
    const effMulti = ev('multimarcas', adjMulti);

    const effSaidas = effPrev + effReal + effPed;
    // Cartao: Lojas ja vem do backend sem o cartao, os dois juntos fecham com
    // a meta de lojas. Multimarcas ja com os ajustes de crescimento/inflacao.
    const effEntradas = effOutras + effBol + effCheq + effLoj + effCart + effMulti;
    // Pagamento do Uso da Garantia: lancado SO no dia escolhido (nao entra
    // em nenhuma coluna real - Prev./Real/Pedidos continuam mostrando so
    // despesa de verdade), reduz o saldo acumulado dali pra frente.
    const effGarantiaPagamento = usoGarantia > 0 && dtPagamentoGarantia === dia.dia ? usoGarantia : 0;
    const effSaldoDia = effEntradas - effSaidas - effGarantiaPagamento;
    acumLocal += effSaldoDia;

    return {
      dia, adjLojas, adjMulti, effPrev, effReal, effPed, effOutras, effBol, effCheq, effLoj, effCart, effMulti,
      effSaidas, effEntradas, effGarantiaPagamento, effSaldoDia, saldoAcum: acumLocal,
    };
  });

  // Se a data de pagamento escolhida nao cai dentro do periodo carregado
  // (dados?.dias), a saida nunca e lancada - avisa em vez de simular
  // silenciosamente "pela metade" (so o uso, sem a devolucao).
  const dtPagamentoGarantiaForaDoPeriodo =
    usoGarantia > 0 && !!dtPagamentoGarantia && !linhasDiarias.some((l) => l.dia.dia === dtPagamentoGarantia);

  // Agregado mensal com os MESMOS toggles de coluna e ajustes de simulacao
  // (Crescimento/Inflacao de Multimarcas e Lojas) da Visao Diaria/Resumo do
  // Periodo - pedido explicito do usuario: o grafico "Projecao Mensal" tem
  // que espelhar exatamente o que esta marcado na faixa de Simulacao, nao
  // os valores crus que vem do backend em dados.meses.
  const mesesEfetivos: MesFC[] = (() => {
    const porMes: Record<string, MesFC> = {};
    for (const l of linhasDiarias) {
      const chave = l.dia.dia.slice(0, 7);
      const acc = porMes[chave] ?? {
        mes: chave, previsao: 0, real: 0, pedidos: 0, totalSaidas: 0,
        cartao: 0, boleto: 0, cheque: 0, lojas: 0, outrasEntradas: 0, multimarcas: 0, qtd: 0, ajusteGarantia: 0,
      };
      acc.previsao += l.effPrev;
      acc.real += l.effReal;
      acc.pedidos += l.effPed;
      acc.totalSaidas += l.effSaidas;
      acc.cartao += l.effCart;
      acc.boleto += l.effBol;
      acc.cheque += l.effCheq;
      acc.lojas += l.effLoj;
      acc.outrasEntradas += l.effOutras;
      acc.multimarcas += l.effMulti;
      acc.qtd += l.dia.qtd;
      acc.ajusteGarantia = (acc.ajusteGarantia || 0) + l.effGarantiaPagamento;
      porMes[chave] = acc;
    }
    return Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes));
  })();

  const totais = linhasDiarias.reduce((acc, l) => ({
    previsao: acc.previsao + l.effPrev,
    real: acc.real + l.effReal,
    pedidos: acc.pedidos + l.effPed,
    saidas: acc.saidas + l.effSaidas,
    outrasEntradas: acc.outrasEntradas + l.effOutras,
    boleto: acc.boleto + l.effBol,
    cheque: acc.cheque + l.effCheq,
    lojas: acc.lojas + l.effLoj,
    cartao: acc.cartao + l.effCart,
    multimarcas: acc.multimarcas + l.effMulti,
    entradas: acc.entradas + l.effEntradas,
    qtd: acc.qtd + l.dia.qtd,
    garantiaPagamento: acc.garantiaPagamento + l.effGarantiaPagamento,
  }), { previsao: 0, real: 0, pedidos: 0, saidas: 0, outrasEntradas: 0, boleto: 0, cheque: 0, lojas: 0, cartao: 0, multimarcas: 0, entradas: 0, qtd: 0, garantiaPagamento: 0 });

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
    cartao: acc.cartao + (l.dia.cartao || 0),
    multimarcas: acc.multimarcas + l.adjMulti,
  }), { previsao: 0, real: 0, pedidos: 0, outrasEntradas: 0, boleto: 0, cheque: 0, lojas: 0, cartao: 0, multimarcas: 0 });
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

  function celula(key: ColKey, rawVal: number, cor: string, bgLinha: string, extraClasse = '', onClick?: () => void, dica = 'Ver faturas') {
    const ativa = colsAtivas[key];
    const v = rawVal || 0;
    const clicavel = ativa && v > 0 && !!onClick;
    return (
      <td
        className={`text-right px-3 py-2 tabular-nums border-r border-b border-gray-300 ${bgLinha} ${extraClasse} ${clicavel ? 'cursor-pointer hover:underline' : ''}`}
        style={{ color: ativa ? cor : '#000000', fontWeight: ativa && v > 0 ? 600 : 400 }}
        onClick={clicavel ? onClick : undefined}
        title={clicavel ? dica : undefined}
      >
        {v > 0 ? <span style={!ativa ? { textDecoration: 'line-through' } : undefined}>{fmtBRL(v)}</span> : <span className="text-black">—</span>}
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
            <p className="text-sm text-black">Saídas (duplicatas a pagar) e entradas projetadas/realizadas, com saldo diário acumulado.</p>
          </div>
        </div>
        {dados?.geradoEm && <span className="text-sm text-black">Atualizado em {dados.geradoEm}</span>}
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-black uppercase tracking-wide">De</label>
              <input
                type="date" value={dtInicio}
                onChange={(e) => { setDtInicio(e.target.value); setUltimoAtalho(null); }}
                className="h-9 px-2 border border-gray-300 rounded-md text-sm text-black"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-black uppercase tracking-wide">Até</label>
              <input
                type="date" value={dtFim}
                onChange={(e) => { setDtFim(e.target.value); setUltimoAtalho(null); }}
                className="h-9 px-2 border border-gray-300 rounded-md text-sm text-black"
              />
            </div>
          </div>

          <div className="hidden sm:block self-stretch w-px bg-gray-200" />

          <div className="relative">
            <label className="text-xs font-semibold text-black uppercase tracking-wide block mb-1">Empresa</label>
            <button
              onClick={() => setFiltroEmpresasAberto((v) => !v)}
              className="min-w-[160px] h-9 flex items-center justify-between gap-2 px-3 border border-gray-300 rounded-md text-sm text-black bg-white hover:bg-gray-50"
            >
              Empresas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
              <ChevronDown className="w-4 h-4 text-black" />
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
          <span className="text-xs font-semibold text-black uppercase tracking-wide mr-1">Período rápido</span>
          {ATALHOS_PERIODO_FC.map((atalho) => (
            <button
              key={atalho.id}
              onClick={() => aplicarAtalhoPeriodo(atalho)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                ultimoAtalho === atalho.id ? 'bg-rose-100 text-rose-700 font-medium' : 'bg-gray-100 hover:bg-gray-200 text-black'
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
          <span className="ml-3 text-black">Carregando...</span>
        </div>
      )}

      {!loading && !dados && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
          <CalendarRange className="w-8 h-8 text-black mx-auto mb-2" />
          <p className="text-black">Escolha o período e clique em Aplicar.</p>
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
              <div className="flex items-center gap-2 text-black text-xs font-medium">
                <Wallet className="w-4 h-4" /> Saldo inicial
              </div>
              <p className="text-2xl font-bold tabular-nums mt-1.5 text-black">{fmtBRL(dados.saldoBancario)}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4 border-l-4 border-green-500">
              <div className="flex items-center gap-2 text-black text-xs font-medium">
                <TrendingUp className="w-4 h-4 text-green-600" /> Entradas no período
              </div>
              <p className="text-2xl font-bold tabular-nums mt-1.5 text-green-700">{fmtBRL(totais.entradas)}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4 border-l-4 border-red-500">
              <div className="flex items-center gap-2 text-black text-xs font-medium">
                <TrendingDown className="w-4 h-4 text-red-600" /> Saídas no período
              </div>
              <p className="text-2xl font-bold tabular-nums mt-1.5 text-red-700">{fmtBRL(totais.saidas)}</p>
            </div>
            {(() => {
              const saldoFinalProjetado = linhasDiarias.length > 0 ? linhasDiarias[linhasDiarias.length - 1].saldoAcum : dados.saldoBancario;
              const positivo = saldoFinalProjetado >= 0;
              return (
                <div className={`bg-white rounded-lg shadow-md p-4 border-l-4 ${positivo ? 'border-green-500' : 'border-red-500'}`}>
                  <div className="flex items-center gap-2 text-black text-xs font-medium">
                    <Banknote className={`w-4 h-4 ${positivo ? 'text-green-600' : 'text-red-600'}`} /> Saldo final projetado
                  </div>
                  <p className={`text-2xl font-bold tabular-nums mt-1.5 ${positivo ? 'text-green-700' : 'text-red-700'}`}>{fmtBRL(saldoFinalProjetado)}</p>
                </div>
              );
            })()}
          </div>

          <PontosAtencaoCaixa linhas={linhasDiariasVisiveis} totalSaidas={totais.saidas} />

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
                      <th className="text-right px-4 py-2 font-semibold text-white bg-gray-500 border-b border-r border-gray-600">Saldo</th>
                      <th className="text-right px-4 py-2 font-semibold text-white bg-gray-500 border-b border-r border-gray-600" title="Limite de crédito contratado (ex.: cheque especial) - não entra no saldo usado pelo fluxo de caixa">Limite</th>
                      <th className="text-center px-4 py-2 font-semibold text-white bg-gray-500 border-b border-r border-gray-600">Situação</th>
                      <th className="text-right px-4 py-2 font-semibold text-white bg-gray-500 border-b border-gray-600">Disponível</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saldosBancarios.contas.map((c, i) => {
                      const bgHover = `${i % 2 === 0 ? 'bg-white' : 'bg-gray-300'} group-hover:bg-rose-50`;
                      return (
                      <tr key={`${c.nmBanco}-${c.nrConta}-${i}`} className="group transition-colors">
                        <td className={`px-4 py-2 text-black border-r border-b border-gray-300 ${bgHover}`}>
                          <span className="flex items-center gap-2"><SeloBanco nome={c.nmBanco} />{c.nmBanco}</span>
                        </td>
                        <td className={`px-4 py-2 text-black tabular-nums border-r border-b border-gray-300 ${bgHover}`}>{c.nrAgencia}</td>
                        <td className={`px-4 py-2 text-black tabular-nums border-r border-b border-gray-300 ${bgHover}`}>{c.nrConta}</td>
                        <td className={`px-4 py-2 text-right text-black tabular-nums border-r border-b border-gray-300 ${bgHover}`} title={c.semDados ? `Última posição: ${c.dtPosicao.split('-').reverse().join('/')}` : undefined}>
                          {c.semDados ? <span className="italic text-black">Sem dados</span> : c.dtPosicao.split('-').reverse().join('/')}
                        </td>
                        <td className={`px-4 py-2 text-right font-semibold tabular-nums border-r border-b border-gray-300 ${bgHover} ${c.vlSaldo >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(c.vlSaldo)}</td>
                        <td className={`px-4 py-2 text-right text-black tabular-nums border-r border-b border-gray-300 ${bgHover}`}>
                          {c.vlLimite > 0 ? fmtBRL(c.vlLimite) : <span className="text-black">—</span>}
                        </td>
                        <td className={`px-4 py-2 text-center border-r border-b border-gray-300 ${bgHover}`}>
                          {c.qtDiasCarencia > 0 ? (
                            <span
                              className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 whitespace-nowrap"
                              title={`Franquia de ${c.qtDiasCarencia} dia(s) de cheque especial — ${c.qtDiasUsados} usado(s) na última posição`}
                            >
                              {c.qtDiasRestantes > 0 ? `Restam ${c.qtDiasRestantes} dia(s)` : '0 dias disponíveis'}
                            </span>
                          ) : (
                            <span className="text-black">—</span>
                          )}
                        </td>
                        <td className={`px-4 py-2 text-right font-semibold tabular-nums border-b border-gray-300 ${bgHover} ${c.vlDisponivel >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(c.vlDisponivel)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold bg-gray-400">
                      <td colSpan={4} className="px-4 py-2.5 text-right uppercase text-xs tracking-wide text-black border-t-2 border-r border-gray-400">Total</td>
                      <td className={`px-4 py-2.5 text-right tabular-nums border-t-2 border-r border-gray-400 ${(saldosBancarios?.total ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(saldosBancarios?.total ?? 0)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-black border-t-2 border-r border-gray-400">{fmtBRL(saldosBancarios?.totalLimite ?? 0)}</td>
                      <td className="border-t-2 border-r border-gray-400" />
                      <td className={`px-4 py-2.5 text-right tabular-nums border-t-2 border-gray-400 ${(saldosBancarios?.totalDisponivel ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(saldosBancarios?.totalDisponivel ?? 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="text-sm text-black py-8 text-center">Nenhuma conta bancária cadastrada.</p>
            )}
          </div>

          {/* Grafico mensal */}
          <div className="bg-white rounded-lg shadow-md p-4">
            <h2 className="text-sm font-semibold text-black uppercase tracking-wide mb-3">Projeção Mensal</h2>
            <GraficoMensalFC meses={mesesEfetivos} saldoBancario={saldoInicialSimulado} />
          </div>

          <GraficoFaturamentoUnificado />

          {/* Visao diaria */}
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Visão Diária</h2>
              <div className="flex gap-2">
                <button onClick={() => setLojasModalAberto(true)} className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 text-black rounded px-2 py-1 transition-colors">
                  <Settings className="w-3.5 h-3.5" /> Projeção Lojas
                </button>
                <button onClick={outrasEntradasAbrir} className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 text-black rounded px-2 py-1 transition-colors">
                  <Settings className="w-3.5 h-3.5" /> Outras Entradas
                </button>
              </div>
            </div>

            {/* Simulacao */}
            <div className="flex flex-col gap-1.5 px-4 py-2.5 border-b border-gray-200 bg-amber-50">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-xs font-bold text-black uppercase tracking-wide">Simulação</span>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="font-semibold text-purple-700">Multimarcas</span>
                <span className="text-black">Crescimento</span>
                <input type="number" step={0.5} value={crescMulti} onChange={(e) => setCrescMulti(parseFloat(e.target.value) || 0)} className="w-16 px-1.5 py-1 border border-gray-300 rounded text-right text-sm text-black" />
                <span className="text-black">%</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="font-semibold text-purple-700">Multimarcas</span>
                <span className="text-black">Inflação</span>
                <input type="number" step={0.5} value={inflacaoMulti} onChange={(e) => setInflacaoMulti(parseFloat(e.target.value) || 0)} className="w-16 px-1.5 py-1 border border-gray-300 rounded text-right text-sm text-black" />
                <span className="text-black">%</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="font-semibold text-cyan-700">Lojas</span>
                <span className="text-black">Crescimento</span>
                <input type="number" step={0.5} value={crescLojas} onChange={(e) => setCrescLojas(parseFloat(e.target.value) || 0)} className="w-16 px-1.5 py-1 border border-gray-300 rounded text-right text-sm text-black" />
                <span className="text-black">%</span>
              </label>
              <button onClick={resetarAjustes} className="flex items-center gap-1 text-xs font-medium text-black border border-gray-300 rounded px-2 py-1 hover:bg-white transition-colors">
                <RotateCcw className="w-3.5 h-3.5" /> Resetar
              </button>
            </div>

            {/* Uso da Garantia - linha propria: valor + Aplicar, depois o card
                com o que esta de fato aplicado e a Data de Pagamento do lado
                (pedido explicito do usuario). */}
            <div className="flex items-center gap-3 flex-wrap">
              <label
                className="flex items-center gap-1.5 text-sm"
                title="Valor que entraria no caixa hoje se a conta usasse o limite/garantia (cheque especial) - é um empréstimo. Clique em Aplicar pra confirmar; soma no saldo inicial da projeção."
              >
                <span className="font-semibold text-orange-700">Uso da Garantia</span>
                <span className="text-black">R$</span>
                <input
                  type="number" step={100} value={usoGarantiaInput}
                  onChange={(e) => setUsoGarantiaInput(parseFloat(e.target.value) || 0)}
                  onKeyDown={(e) => { if (e.key === 'Enter') aplicarUsoGarantia(); }}
                  className="w-28 px-1.5 py-1 border border-gray-300 rounded text-right text-sm text-black"
                />
              </label>
              <button
                onClick={aplicarUsoGarantia}
                disabled={garantiaSalvando || usoGarantiaInput === usoGarantia}
                className="flex items-center gap-1 text-xs font-medium text-white bg-orange-600 hover:bg-orange-700 rounded px-3 py-1.5 disabled:opacity-50 transition-colors"
              >
                {garantiaSalvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Aplicar
              </button>

              <div className="flex items-center gap-2 bg-white border border-orange-300 rounded-lg px-3 py-1.5" title="Valor aplicado agora - compartilhado com quem mais abrir esta tela.">
                <span className="text-xs text-black">Garantia em uso</span>
                <span className="text-base font-bold text-orange-700 tabular-nums whitespace-nowrap">{fmtBRL(usoGarantia)}</span>
              </div>

              <label
                className={`flex items-center gap-1.5 text-sm ${usoGarantia <= 0 ? 'opacity-50' : ''}`}
                title={usoGarantia <= 0 ? 'Aplique um valor de Uso da Garantia primeiro.' : 'Data em que o empréstimo é pago de volta - lança uma saída automática nesse dia na projeção.'}
              >
                <span className="font-semibold text-orange-700">Data de Pagamento</span>
                <input
                  type="date" value={dtPagamentoGarantia} disabled={usoGarantia <= 0}
                  onChange={(e) => setDtPagamentoGarantia(e.target.value)}
                  className="px-1.5 py-1 border border-gray-300 rounded text-sm text-black disabled:bg-gray-100"
                />
              </label>
            </div>
            {(garantiaInfo?.dtAtualizacao || dtPagamentoGarantiaForaDoPeriodo || garantiaErro) && (
              <div className="flex items-center gap-3 flex-wrap text-xs">
                {garantiaErro && (
                  <span className="text-red-700 font-medium flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {garantiaErro}
                  </span>
                )}
                {!garantiaErro && garantiaInfo?.dtAtualizacao && (usoGarantia > 0 || dtPagamentoGarantia) && (
                  <span className="text-black">
                    Uso da Garantia salvo para todos{garantiaInfo.usuario ? ` por ${garantiaInfo.usuario}` : ''} em{' '}
                    {new Date(garantiaInfo.dtAtualizacao).toLocaleString('pt-BR')}
                  </span>
                )}
                {dtPagamentoGarantiaForaDoPeriodo && (
                  <span className="text-red-700 font-medium">
                    A Data de Pagamento ({dtPagamentoGarantia.split('-').reverse().join('/')}) está fora do período selecionado acima — a saída
                    não aparece nesta consulta. Mude o período pra ver o efeito.
                  </span>
                )}
              </div>
            )}
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
                        style={{ borderColor: on ? c.color : '#cbd5e1', backgroundColor: on ? `${c.color}18` : '#f1f5f9', color: on ? c.color : '#000000' }}
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
                    <th colSpan={7} className="px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-white bg-green-600 border-b border-green-700 border-l-2 border-l-gray-300">Entradas</th>
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
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Cartão</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Multimarcas</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-white bg-green-700 border-b-2 border-green-300 border-r-2 border-gray-300">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {linhasDiariasVisiveis.length === 0 && (
                    <tr><td colSpan={15} className="text-center text-black py-8">Sem dados no período selecionado</td></tr>
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
                          <span className="tabular-nums font-bold">{dd}/{mm}</span>
                          <span className="text-xs text-black ml-1.5">{dow}</span>
                          {isHoje && <span className="text-xs font-medium bg-sky-600 text-white rounded px-1.5 py-0.5 ml-1.5 align-middle">hoje</span>}
                        </td>
                        {celula('previsao', l.dia.previsao, '#ef4444', bgHover, '', () => setSaidaDetalhe({ dia: l.dia.dia, tipo: 'previsao' }), 'Ver o que compõe esse valor')}
                        {celula('real', l.dia.real, '#991b1b', bgHover, '', () => setSaidaDetalhe({ dia: l.dia.dia, tipo: 'real' }), 'Ver o que compõe esse valor')}
                        {celula('pedidos', l.dia.pedidos, '#dc2626', bgHover, '', () => setSaidaDetalhe({ dia: l.dia.dia, tipo: 'pedidos' }), 'Ver os pedidos desse dia')}
                        <td className={`text-right px-3 py-2 tabular-nums font-bold text-red-800 border-r-2 border-b border-gray-300 ${bgHover}`}>
                          {l.effSaidas > 0 ? fmtBRL(l.effSaidas) : <span className="text-black">—</span>}
                        </td>
                        {celula('outrasEntradas', l.dia.outrasEntradas, '#7c3aed', bgHover)}
                        {celula('boleto', l.dia.boleto, '#0284c7', bgHover, '', () => boletoDetalheAbrir(l.dia.dia))}
                        {celula('cheque', l.dia.cheque, '#059669', bgHover)}
                        {celula('lojas', l.adjLojas, '#0891b2', bgHover)}
                        {celula('cartao', l.dia.cartao, '#4d7c0f', bgHover)}
                        {celula('multimarcas', l.adjMulti, '#9333ea', bgHover)}
                        <td className={`text-right px-3 py-2 tabular-nums font-bold text-green-800 border-r-2 border-b border-gray-300 ${bgHover}`}>
                          {l.effEntradas > 0 ? fmtBRL(l.effEntradas) : <span className="text-black">—</span>}
                        </td>
                        <td
                          className={`text-right px-3 py-2 tabular-nums font-bold border-r border-b border-gray-300 ${bgHover} ${l.effSaldoDia >= 0 ? 'text-green-700' : 'text-red-600'}`}
                          title={l.effGarantiaPagamento > 0 ? `Inclui pagamento do Uso da Garantia (simulação): -${fmtBRL(l.effGarantiaPagamento)}` : undefined}
                        >
                          {fmtBRL(l.effSaldoDia)}
                          {l.effGarantiaPagamento > 0 && <span className="ml-1 text-orange-700" title="Pagamento do Uso da Garantia">⚠</span>}
                        </td>
                        <td className={`text-right px-3 py-2 tabular-nums font-bold border-r-2 border-b border-gray-300 ${bgHover} ${l.saldoAcum >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(l.saldoAcum)}</td>
                        <td className={`text-right px-3 py-2 tabular-nums text-black border-b border-gray-300 ${bgHover}`}>{fmtNum(l.dia.qtd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <ResumoPeriodoFC
            entradas={[
              { rotulo: 'Outras entradas', valor: totaisBrutos.outrasEntradas, ativa: colsAtivas.outrasEntradas },
              { rotulo: 'Boletos', valor: totaisBrutos.boleto, ativa: colsAtivas.boleto },
              { rotulo: 'Cheques', valor: totaisBrutos.cheque, ativa: colsAtivas.cheque },
              { rotulo: 'Lojas', valor: totaisBrutos.lojas, ativa: colsAtivas.lojas },
              { rotulo: 'Cartão', valor: totaisBrutos.cartao, ativa: colsAtivas.cartao },
              { rotulo: 'Multimarcas', valor: totaisBrutos.multimarcas, ativa: colsAtivas.multimarcas },
            ]}
            saidas={[
              { rotulo: 'Previsão', valor: totaisBrutos.previsao, ativa: colsAtivas.previsao },
              { rotulo: 'Real', valor: totaisBrutos.real, ativa: colsAtivas.real },
              { rotulo: 'Pedidos de compra', valor: totaisBrutos.pedidos, ativa: colsAtivas.pedidos },
              ...(totais.garantiaPagamento > 0
                ? [{ rotulo: 'Pagamento Uso Garantia', valor: totais.garantiaPagamento, ativa: true }]
                : []),
            ]}
            totalEntradas={totais.entradas}
            totalSaidas={totais.saidas + totais.garantiaPagamento}
            saldoInicial={saldoInicialSimulado}
            dtIni={dados.dias[0]?.dia ?? ''}
            dtFim={dados.dias[dados.dias.length - 1]?.dia ?? ''}
          />

          {/* Saidas por fornecedor (ranking + detalhado ordenavel) e por
              despesa (mesmo periodo/empresas filtrados acima) - as 3 lado a
              lado, mesma altura (pedido explicito do usuario). */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-white rounded-lg shadow-md overflow-hidden">
              <CabecalhoFornecedores titulo="Fornecedores" despesa={despesaSel} carregando={carregandoFornDespesa} onLimpar={limparDespesaSel} />
              <div className="p-4">
                {despesaSel && carregandoFornDespesa ? (
                  <p className="text-sm text-black py-8 text-center flex items-center justify-center">
                    <Loader2 className="w-4 h-4 animate-spin mr-2 text-rose-600" /> Buscando fornecedores…
                  </p>
                ) : (
                  <ListaBarrasRanking itens={fornecedoresVisiveis} cor="#dc2626" />
                )}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow-md overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Despesas</h2>
                <p className="text-xs text-black mt-0.5">Clique numa despesa para ver os fornecedores dela</p>
              </div>
              <div className="p-4">
                <ListaBarrasRanking
                  itens={agruparMateriaPrima(saidasDespesa)}
                  cor="#f59e0b"
                  selecionado={despesaSel?.nome ?? null}
                  onSelecionar={selecionarDespesa}
                />
              </div>
            </div>
            <div className="bg-white rounded-lg shadow-md overflow-hidden">
              <CabecalhoFornecedores titulo="Todos os Fornecedores" despesa={despesaSel} carregando={carregandoFornDespesa} onLimpar={limparDespesaSel} />
              <div className="overflow-x-auto max-h-[732px] overflow-y-auto [transform:translateZ(0)]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-black cursor-pointer select-none" onClick={() => alternarOrdenacao('nome')}>
                        <span className="inline-flex items-center gap-1">
                          Nome
                          {sortKey === 'nome' ? (sortDir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />) : <ArrowUpDown className="w-3.5 h-3.5 text-black" />}
                        </span>
                      </th>
                      <th className="text-right px-4 py-2 font-medium text-black cursor-pointer select-none" onClick={() => alternarOrdenacao('valor')}>
                        <span className="inline-flex items-center gap-1">
                          Valor Atual
                          {sortKey === 'valor' ? (sortDir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />) : <ArrowUpDown className="w-3.5 h-3.5 text-black" />}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fornecedoresOrdenados.length === 0 && !carregandoFornDespesa && (
                      <tr><td colSpan={2} className="text-center text-black py-8">Sem dados no período selecionado</td></tr>
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
              <button onClick={() => setLojasModalAberto(false)} className="text-black hover:text-black"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5">
              <p className="text-sm text-black mb-3">
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
                <span className="flex-1 text-sm text-black">{lojasStatus}</span>
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
              <button onClick={() => setOutrasEntradasModalAberto(false)} className="text-black hover:text-black"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-semibold text-black">Cadastradas (de hoje em diante)</h3>
                {outrasEntradasLista && outrasEntradasLista.length > 0 && (
                  <span className="text-xs text-black tabular-nums">
                    {outrasEntradasLista.length} {outrasEntradasLista.length === 1 ? 'dia' : 'dias'} ·{' '}
                    <strong>{fmtBRL(outrasEntradasLista.reduce((a, i) => a + i.valor, 0))}</strong>
                  </span>
                )}
              </div>
              <div className="border border-gray-200 rounded max-h-64 overflow-y-auto mb-5">
                {outrasEntradasLista === null ? (
                  <p className="flex items-center justify-center py-6 text-sm text-black">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando…
                  </p>
                ) : outrasEntradasLista.length === 0 ? (
                  <p className="py-6 text-center text-sm text-black">Nenhuma entrada cadastrada de hoje em diante.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {outrasEntradasLista.map((item, i) => (
                        <tr key={item.dia} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                          <td className="px-3 py-1.5 text-black tabular-nums whitespace-nowrap">
                            {item.dia.split('-').reverse().join('/')}{' '}
                            <span className="text-xs">({DIAS_SEMANA_CURTO[new Date(`${item.dia}T12:00:00`).getDay()]})</span>
                            {diaEntradaOutras(item.dia) !== item.dia && (
                              <span className="block text-xs text-violet-700">
                                fim de semana: entra no fluxo na terça {diaEntradaOutras(item.dia).split('-').reverse().slice(0, 2).join('/')}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right font-semibold text-violet-700 tabular-nums whitespace-nowrap">{fmtBRL(item.valor)}</td>
                          <td className="px-2 py-1 text-right w-px">
                            <button
                              type="button"
                              onClick={() => outrasEntradasRemover(item.dia, item.valor)}
                              disabled={outrasEntradasRemovendo !== null}
                              className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:bg-red-50 border border-red-200 rounded px-2 py-0.5 disabled:opacity-50"
                              title="Remover esta entrada (para voltar, cole a linha de novo)"
                            >
                              {outrasEntradasRemovendo === item.dia ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              Remover
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <h3 className="text-sm font-semibold text-black mb-1">Adicionar ou atualizar</h3>
              <p className="text-sm text-black mb-3">
                Cole os dados da planilha abaixo — uma linha por dia (data já cadastrada é substituída).<br />
                Formatos aceitos: <code>DD/MM/AAAA;valor</code> ou <code>DD/MM/AAAA[tab]valor</code> (tab do Excel)
              </p>
              <textarea
                value={outrasEntradasPaste}
                onChange={(e) => setOutrasEntradasPaste(e.target.value)}
                rows={6}
                placeholder={'20/10/2026;390000\n06/11/2026;3539445.01\n...'}
                className="w-full box-border font-mono text-sm text-black p-2.5 border border-gray-300 rounded resize-vertical"
              />
              <div className="flex gap-2 mt-3 justify-end items-center">
                <span className="flex-1 text-sm text-black">{outrasEntradasStatus}</span>
                <button onClick={() => setOutrasEntradasModalAberto(false)} className="px-4 py-2 border border-gray-300 rounded text-sm text-black hover:bg-gray-50">Fechar</button>
                <button onClick={outrasEntradasGravar} disabled={outrasEntradasSalvando} className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-semibold disabled:opacity-50 transition-colors">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {saidaDetalhe && (
        <ModalSaidasDetalhe
          dia={saidaDetalhe.dia}
          tipo={saidaDetalhe.tipo}
          empresas={new URLSearchParams(consultaRef.current).get('empresas')}
          onFechar={fecharSaidaDetalhe}
        />
      )}

      {/* Modal: Detalhe das faturas de Boleto de um dia (clique na celula) */}
      {boletoDetalheDia && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setBoletoDetalheDia(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-black">
                Boletos — {boletoDetalheDia.split('-').reverse().join('/')}
              </h2>
              <button onClick={() => setBoletoDetalheDia(null)} className="text-black hover:text-black"><X className="w-5 h-5" /></button>
            </div>
            <div className="overflow-y-auto flex-1">
              {boletoDetalheLista === null && (
                <div className="flex items-center justify-center py-12 text-black">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…
                </div>
              )}
              {boletoDetalheErro && (
                <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md mx-5 mt-4 px-3 py-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{boletoDetalheErro}</span>
                </div>
              )}
              {boletoDetalheLista !== null && !boletoDetalheErro && boletoDetalheLista.length === 0 && (
                <p className="text-sm text-black py-12 text-center">Nenhuma fatura encontrada para esse dia.</p>
              )}
              {boletoDetalheLista !== null && boletoDetalheLista.length > 0 && (
                <>
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-5 py-2 font-medium text-black">Cliente</th>
                        <th className="text-left px-3 py-2 font-medium text-black">Fatura/Parcela</th>
                        <th className="text-left px-3 py-2 font-medium text-black">Banco</th>
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
                          <td className="px-3 py-1.5 text-black whitespace-nowrap">{item.banco}</td>
                          <td className="px-3 py-1.5 text-right text-black tabular-nums">{item.dtVencimentoOriginal.split('-').reverse().join('/')}</td>
                          <td className="px-5 py-1.5 text-right font-semibold text-sky-700 tabular-nums">{fmtBRL(item.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-bold bg-gray-200 border-t-2 border-gray-400">
                        <td colSpan={4} className="px-5 py-2 text-right uppercase text-xs tracking-wide text-black">Total</td>
                        <td className="px-5 py-2 text-right tabular-nums text-sky-700">
                          {fmtBRL(boletoDetalheLista.reduce((acc, item) => acc + item.valor, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>

                  {/* Resumo por banco - mesmo criterio do detalhe (nr_portador +
                      fcr_fatcodbar.nr_ctapes), pra ver rapido quanto cai em cada
                      conta de cobranca nesse dia. */}
                  <div className="px-5 py-3 border-t-2 border-gray-300 bg-gray-50">
                    <h3 className="text-xs font-semibold text-black uppercase tracking-wide mb-2">Resumo por banco</h3>
                    <table className="w-full text-sm">
                      <tbody>
                        {Object.entries(
                          boletoDetalheLista.reduce<Record<string, { valor: number; qtd: number }>>((acc, item) => {
                            const atual = acc[item.banco] ?? { valor: 0, qtd: 0 };
                            acc[item.banco] = { valor: atual.valor + item.valor, qtd: atual.qtd + 1 };
                            return acc;
                          }, {})
                        )
                          .sort(([, a], [, b]) => b.valor - a.valor)
                          .map(([banco, { valor, qtd }]) => (
                            <tr key={banco}>
                              <td className="py-1 text-black">
                                {banco} <span className="text-xs text-black">({qtd} {qtd === 1 ? 'fatura' : 'faturas'})</span>
                              </td>
                              <td className="py-1 text-right font-semibold text-sky-700 tabular-nums">{fmtBRL(valor)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
