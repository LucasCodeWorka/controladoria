'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Banknote, ChevronDown, Loader2, Settings, X, RotateCcw,
  ArrowUp, ArrowDown, ArrowUpDown, Landmark,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
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

type ColKey = 'previsao' | 'real' | 'pedidos' | 'cartao' | 'boleto' | 'cheque' | 'lojas' | 'multimarcas';

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

function fmtBRL(valor: number | null | undefined, decimais = 0): string {
  if (valor == null || isNaN(valor)) return '—';
  return `R$ ${valor.toLocaleString('pt-BR', { minimumFractionDigits: decimais, maximumFractionDigits: decimais })}`;
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
}

interface TooltipMesPayload {
  payload: MesFCComSaldo;
}

function TooltipMes({ active, payload }: { active?: boolean; payload?: TooltipMesPayload[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const m = payload[0].payload;
  return (
    <div className="bg-gray-900 text-white text-xs rounded px-2.5 py-1.5 shadow-lg space-y-1 max-w-xs">
      <p className="font-semibold">{fmtMes(m.mes)}</p>
      <p>Saídas: {fmtBRL(m.totalSaidas)} (Real {fmtBRL(m.real)} · Prev {fmtBRL(m.previsao)} · Pedidos {fmtBRL(m.pedidos)})</p>
      <p>Entradas: {fmtBRL(m.totalEntradas)} (Boleto {fmtBRL(m.boleto)} · Cheque {fmtBRL(m.cheque)} · Lojas {fmtBRL(m.lojas)})</p>
      <p className={m.saldoAcumulado >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>Saldo acumulado: {fmtBRL(m.saldoAcumulado)}</p>
    </div>
  );
}

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
    const totalEntradas = m.boleto + m.cheque + m.lojas;
    acumulado += totalEntradas - m.totalSaidas;
    return { ...m, totalEntradas, saldoAcumulado: acumulado };
  });
  return (
    <div role="img" aria-label="Saídas, entradas e saldo acumulado projetados por mês">
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={dados} margin={{ top: 32, right: 16, left: 0, bottom: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" vertical={false} />
          <XAxis dataKey="mes" tickFormatter={fmtMes} tick={{ fontSize: 13, fill: '#52514e' }} axisLine={{ stroke: '#c3c2b7' }} tickLine={false} />
          <YAxis tickFormatter={(v: number) => fmtBRLCompacto(v)} tick={{ fontSize: 13, fill: '#898781' }} axisLine={false} tickLine={false} width={80} />
          <Tooltip content={<TooltipMes />} cursor={{ fill: 'rgba(11,11,11,0.04)' }} />
          <Bar dataKey="totalSaidas" name="Saídas" fill="#dc2626" radius={[4, 4, 0, 0]} maxBarSize={40}>
            <LabelList dataKey="totalSaidas" position="top" formatter={(v: React.ReactNode) => fmtBRLCompacto(v as number)} style={{ fontSize: 13, fontWeight: 700, fill: '#991b1b' }} />
          </Bar>
          <Bar dataKey="totalEntradas" name="Entradas" fill="#059669" radius={[4, 4, 0, 0]} maxBarSize={40}>
            <LabelList dataKey="totalEntradas" position="top" formatter={(v: React.ReactNode) => fmtBRLCompacto(v as number)} style={{ fontSize: 13, fontWeight: 700, fill: '#047857' }} />
          </Bar>
          <Line type="monotone" dataKey="saldoAcumulado" name="Saldo Acumulado" stroke="#2563eb" strokeWidth={3} dot={{ r: 5, fill: '#2563eb', strokeWidth: 0 }} activeDot={{ r: 7 }}>
            <LabelList dataKey="saldoAcumulado" position="top" formatter={(v: React.ReactNode) => fmtBRLCompacto(v as number)} style={{ fontSize: 13, fontWeight: 700, fill: '#1d4ed8' }} />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-center gap-6 mt-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-black">
          <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: '#dc2626' }} /> Saídas
        </span>
        <span className="flex items-center gap-1.5 text-sm font-medium text-black">
          <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: '#059669' }} /> Entradas
        </span>
        <span className="flex items-center gap-1.5 text-sm font-medium text-black">
          <span className="w-4 h-0.5 rounded-full inline-block" style={{ backgroundColor: '#2563eb' }} /> Saldo Acumulado
        </span>
      </div>
    </div>
  );
}

// Lista ranqueada estilo "barra horizontal com rotulo" (valor a esquerda,
// barra proporcional ao maior valor da lista, nome a direita) - mesmo
// layout do relatorio de referencia que o usuario pediu pra replicar aqui.
function ListaBarrasRanking({ itens, cor }: { itens: { nome: string; valor: number }[]; cor: string }) {
  if (!itens.length) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem dados no período.</p>;
  }
  const maxValor = Math.max(...itens.map((i) => i.valor), 1);
  return (
    <div className="max-h-[520px] overflow-y-auto pr-1 space-y-1.5">
      {itens.map((item, i) => (
        <div key={`${item.nome}-${i}`} className="flex items-center gap-2 text-sm">
          <span className="w-28 flex-shrink-0 text-right font-semibold text-black tabular-nums">{fmtBRL(-item.valor)}</span>
          <div className="flex-1 flex items-center min-w-0">
            <div className="h-5 rounded-sm" style={{ width: `${Math.max(2, (item.valor / maxValor) * 100)}%`, backgroundColor: cor }} />
            <span className="ml-2 truncate text-black" title={item.nome}>{item.nome}</span>
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
    cartao: true, boleto: true, cheque: true, lojas: true, multimarcas: true,
  });

  const [crescMulti, setCrescMulti] = useState(0);
  const [inflacaoMulti, setInflacaoMulti] = useState(0);
  const [crescLojas, setCrescLojas] = useState(0);

  const [lojasModalAberto, setLojasModalAberto] = useState(false);
  const [lojasPaste, setLojasPaste] = useState('');
  const [lojasStatus, setLojasStatus] = useState('');
  const [lojasSalvando, setLojasSalvando] = useState(false);

  const [faturasModalAberto, setFaturasModalAberto] = useState(false);
  const [faturasLista, setFaturasLista] = useState<FaturaDescontada[] | null>(null);
  const [faturasPaste, setFaturasPaste] = useState('');
  const [faturasStatus, setFaturasStatus] = useState('');
  const [faturasSalvando, setFaturasSalvando] = useState(false);

  useEffect(() => {
    fetch('/api/fluxo-caixa/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((lista: EmpresaFC[]) => {
        setEmpresasDisponiveis(lista || []);
        const salvo = carregarFiltro<{ empresas: number[]; dtInicio: string; dtFim: string; ultimoAtalho?: string | null }>(FILTRO_KEY);
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
      .catch((e) => console.error('Erro ao buscar empresas do fluxo de caixa:', e));

    // Toggles de coluna e simulacao de cenario tambem ficam salvos entre
    // visitas - nao dependem da lista de empresas, carrega direto.
    const salvo = carregarFiltro<{
      colsAtivas?: Record<ColKey, boolean>; crescMulti?: number; inflacaoMulti?: number; crescLojas?: number;
    }>(FILTRO_KEY);
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

  const primeiraRenderizacaoFiltroRef = useRef(true);
  useEffect(() => {
    if (primeiraRenderizacaoFiltroRef.current) {
      primeiraRenderizacaoFiltroRef.current = false;
      return;
    }
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

  useEffect(() => {
    if (empresasDisponiveis.length > 0) {
      buscar();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresasDisponiveis.length]);

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
    const effBol = ev('boleto', dia.boleto);
    const effCheq = ev('cheque', dia.cheque);
    const effLoj = ev('lojas', adjLojas);

    const effSaidas = effPrev + effReal + effPed;
    // Cartao e Multimarcas tirados temporariamente (pedido explicito do
    // usuario) - nao compoem mais o saldo, so volta se pedir de novo.
    const effEntradas = effBol + effCheq + effLoj;
    const effSaldoDia = effEntradas - effSaidas;
    acumLocal += effSaldoDia;

    return {
      dia, adjLojas, adjMulti, effPrev, effReal, effPed, effBol, effCheq, effLoj,
      effSaidas, effEntradas, effSaldoDia, saldoAcum: acumLocal,
    };
  });

  const totais = linhasDiarias.reduce((acc, l) => ({
    previsao: acc.previsao + l.effPrev,
    real: acc.real + l.effReal,
    pedidos: acc.pedidos + l.effPed,
    saidas: acc.saidas + l.effSaidas,
    boleto: acc.boleto + l.effBol,
    cheque: acc.cheque + l.effCheq,
    lojas: acc.lojas + l.effLoj,
    entradas: acc.entradas + l.effEntradas,
    qtd: acc.qtd + l.dia.qtd,
  }), { previsao: 0, real: 0, pedidos: 0, saidas: 0, boleto: 0, cheque: 0, lojas: 0, entradas: 0, qtd: 0 });

  const saldoFinal = totais.entradas - totais.saidas;
  const DIAS_SEMANA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  const hoje = isoHoje();

  function celula(key: ColKey, rawVal: number, cor: string, extraClasse = '') {
    const ativa = colsAtivas[key];
    const v = rawVal || 0;
    return (
      <td className={`text-right px-3 py-2 border-r border-gray-300 ${extraClasse}`} style={{ color: ativa ? cor : '#94a3b8', fontWeight: ativa && v > 0 ? 600 : 400 }}>
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
        <div className="flex items-center gap-3 flex-wrap">
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
            className="h-9 self-end flex items-center gap-2 px-4 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Aplicar
          </button>

          {ATALHOS_PERIODO_FC.map((atalho) => (
            <button
              key={atalho.id}
              onClick={() => aplicarAtalhoPeriodo(atalho)}
              className={`px-3 py-2 text-sm rounded-md transition-colors ${
                ultimoAtalho === atalho.id ? 'bg-rose-100 text-rose-700 font-medium' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              }`}
            >
              {atalho.label}
            </button>
          ))}
        </div>
        {erro && <p className="text-sm text-red-600 mt-3">{erro}</p>}
      </div>

      {loading && !dados && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-green-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {dados && (
        <>
          {/* Cards de KPI (Vencidos/30d/90d/12m) e alerta de vencidos
              tirados temporariamente (pedido explicito do usuario) - os
              dados continuam vindo da API, so nao sao mostrados aqui. */}

          {/* Saldos bancarios - posicao de caixa atual, entra compondo o
              Saldo Acum. da tabela diaria abaixo (ver acumLocal) */}
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold text-black uppercase tracking-wide flex items-center gap-2">
                <Landmark className="w-4 h-4 text-rose-600" /> Saldos Bancários
              </h2>
              <span className={`text-lg font-bold ${(saldosBancarios?.total ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                {fmtBRL(saldosBancarios?.total ?? 0)}
              </span>
            </div>
            {saldosBancarios && saldosBancarios.contas.length > 0 ? (
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {saldosBancarios.contas.map((c, i) => (
                  <div
                    key={`${c.nmBanco}-${c.nrConta}-${i}`}
                    className={`rounded-lg bg-gray-50 border-l-4 p-3 ${c.vlSaldo >= 0 ? 'border-green-500' : 'border-red-500'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-black truncate">{c.nmBanco}</span>
                      <span className="text-xs text-gray-500 whitespace-nowrap">{c.dtPosicao.split('-').reverse().join('/')}</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">Ag {c.nrAgencia} · Conta {c.nrConta}</p>
                    <p className={`text-xl font-bold mt-1.5 tabular-nums ${c.vlSaldo >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(c.vlSaldo)}</p>
                  </div>
                ))}
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

            <div className="overflow-x-auto max-h-[78vh] overflow-y-auto">
              <table className="w-full text-sm min-w-[1100px] border-separate [border-spacing:0]">
                <thead className="sticky top-0 z-10">
                  <tr className="text-left">
                    <th rowSpan={2} className="px-3 py-2 min-w-[90px] align-middle font-medium text-black bg-gray-100 border-b-2 border-r-2 border-gray-300">Data</th>
                    <th colSpan={4} className="px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-white bg-red-600 border-b border-red-700">Saídas</th>
                    <th colSpan={4} className="px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-white bg-green-600 border-b border-green-700 border-l-2 border-l-gray-300">Entradas</th>
                    <th rowSpan={2} className="px-3 py-2 text-right whitespace-nowrap align-middle font-medium text-black bg-gray-100 border-b-2 border-r border-gray-300 border-l-2 border-l-gray-300">Saldo Dia</th>
                    <th rowSpan={2} className="px-3 py-2 text-right whitespace-nowrap align-middle font-medium text-black bg-gray-100 border-b-2 border-r-2 border-gray-300">Saldo Acum.</th>
                    <th rowSpan={2} className="px-3 py-2 text-right align-middle font-medium text-black bg-gray-100 border-b-2 border-gray-300">Qtd</th>
                  </tr>
                  <tr className="text-left">
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-red-500 border-b-2 border-red-300 border-r border-red-400">Prev.</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-red-500 border-b-2 border-red-300 border-r border-red-400">Real</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-red-500 border-b-2 border-red-300 border-r border-red-400">Pedidos</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-white bg-red-700 border-b-2 border-red-300 border-r-2 border-gray-300">Total</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Boleto</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Cheque</th>
                    <th className="px-3 py-1.5 text-right font-medium text-white/90 bg-green-500 border-b-2 border-green-300 border-r border-green-400">Lojas</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-white bg-green-700 border-b-2 border-green-300 border-r-2 border-gray-300">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {linhasDiarias.length === 0 && (
                    <tr><td colSpan={12} className="text-center text-gray-500 py-8">Sem dados no período selecionado</td></tr>
                  )}
                  {linhasDiarias.map((l, i) => {
                    const dt = new Date(`${l.dia.dia}T12:00:00`);
                    const dow = DIAS_SEMANA[dt.getDay()];
                    const isHoje = l.dia.dia === hoje;
                    const isFds = dt.getDay() === 0 || dt.getDay() === 6;
                    const [, mm, dd] = l.dia.dia.split('-');
                    const bg = isHoje ? 'bg-sky-50' : isFds ? 'bg-gray-100' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50';
                    return (
                      <tr key={l.dia.dia} className={`${bg} ${isHoje ? 'font-bold' : ''} hover:bg-rose-50 transition-colors`}>
                        <td className="px-3 py-2 whitespace-nowrap text-black border-r-2 border-gray-300">
                          <span className="tabular-nums">{dd}/{mm}</span>
                          <span className="text-xs text-gray-500 ml-1.5">{dow}</span>
                          {isHoje && <span className="text-xs font-medium bg-sky-600 text-white rounded px-1.5 py-0.5 ml-1.5 align-middle">hoje</span>}
                        </td>
                        {celula('previsao', l.dia.previsao, '#ef4444')}
                        {celula('real', l.dia.real, '#991b1b')}
                        {celula('pedidos', l.dia.pedidos, '#dc2626')}
                        <td className="text-right px-3 py-2 font-bold text-red-800 border-r-2 border-gray-300">
                          {l.effSaidas > 0 ? fmtBRL(l.effSaidas) : <span className="text-gray-400">—</span>}
                        </td>
                        {celula('boleto', l.dia.boleto, '#0284c7')}
                        {celula('cheque', l.dia.cheque, '#059669')}
                        {celula('lojas', l.adjLojas, '#0891b2')}
                        <td className="text-right px-3 py-2 font-bold text-green-800 border-r-2 border-gray-300">
                          {l.effEntradas > 0 ? fmtBRL(l.effEntradas) : <span className="text-gray-400">—</span>}
                        </td>
                        <td className={`text-right px-3 py-2 font-bold border-r border-gray-300 ${l.effSaldoDia >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(l.effSaldoDia)}</td>
                        <td className={`text-right px-3 py-2 font-bold border-r-2 border-gray-300 ${l.saldoAcum >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(l.saldoAcum)}</td>
                        <td className="text-right px-3 py-2 text-black">{fmtNum(l.dia.qtd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {linhasDiarias.length > 0 && (
                  <tfoot>
                    <tr className="font-bold text-sm bg-gray-100">
                      <td className="px-3 py-2.5 uppercase text-xs tracking-wide text-black border-t-2 border-r-2 border-gray-400">Total</td>
                      <td className="text-right px-3 py-2.5 text-red-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.previsao)}</td>
                      <td className="text-right px-3 py-2.5 text-red-800 border-t-2 border-r border-gray-400">{fmtBRL(totais.real)}</td>
                      <td className="text-right px-3 py-2.5 text-red-600 border-t-2 border-r border-gray-400">{fmtBRL(totais.pedidos)}</td>
                      <td className="text-right px-3 py-2.5 text-red-800 border-t-2 border-r-2 border-gray-400">{fmtBRL(totais.saidas)}</td>
                      <td className="text-right px-3 py-2.5 text-sky-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.boleto)}</td>
                      <td className="text-right px-3 py-2.5 text-green-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.cheque)}</td>
                      <td className="text-right px-3 py-2.5 text-cyan-700 border-t-2 border-r border-gray-400">{fmtBRL(totais.lojas)}</td>
                      <td className="text-right px-3 py-2.5 text-green-800 border-t-2 border-r-2 border-gray-400">{fmtBRL(totais.entradas)}</td>
                      <td className={`text-right px-3 py-2.5 border-t-2 border-r border-gray-400 ${saldoFinal >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(saldoFinal)}</td>
                      <td className={`text-right px-3 py-2.5 border-t-2 border-r-2 border-gray-400 ${saldoFinal >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtBRL(saldoFinal)}</td>
                      <td className="text-right px-3 py-2.5 text-black border-t-2 border-gray-400">{fmtNum(totais.qtd)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Saidas por fornecedor e por despesa (mesmo periodo/empresas
              filtrados acima) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg shadow-md p-4">
              <h2 className="text-sm font-semibold text-black uppercase tracking-wide mb-3">Fornecedores</h2>
              <ListaBarrasRanking itens={saidasFornecedor} cor="#dc2626" />
            </div>
            <div className="bg-white rounded-lg shadow-md p-4">
              <h2 className="text-sm font-semibold text-black uppercase tracking-wide mb-3">Despesas</h2>
              <ListaBarrasRanking itens={saidasDespesa} cor="#f59e0b" />
            </div>
          </div>

          {/* Tabela ordenavel de fornecedores */}
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold text-black uppercase tracking-wide">Fornecedores</h2>
            </div>
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
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
                <tbody className="divide-y divide-gray-100">
                  {fornecedoresOrdenados.length === 0 && (
                    <tr><td colSpan={2} className="text-center text-gray-500 py-8">Sem dados no período selecionado</td></tr>
                  )}
                  {fornecedoresOrdenados.map((f, i) => (
                    <tr key={`${f.cdFornecedor}-${i}`} className={`${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-rose-50 transition-colors`}>
                      <td className="px-4 py-2 text-black">{f.nome}</td>
                      <td className="px-4 py-2 text-right font-semibold text-red-600 tabular-nums">{fmtBRL(-f.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
    </div>
  );
}
