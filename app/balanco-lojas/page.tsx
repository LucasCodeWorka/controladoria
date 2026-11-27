'use client';

// Balanço Lojas: acompanhamento das contagens de estoque (balanços) das lojas -
// quanto, como e com que acuracidade estão sendo feitos. Fonte: views do ERP
// vr_bal_balancoc/vr_bal_balancoi (ver python-backend/routers/balanco_lojas.py).
// Fábrica (empresa 1) fica de fora, por enquanto.

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend,
} from 'recharts';
import { ClipboardCheck, Info, RefreshCw, X, ChevronDown } from 'lucide-react';
import DualScroll from '../components/DualScroll';
import { useOrdenacao, type Getters } from '../components/useOrdenacao';
import { carregarFiltro, salvarFiltro } from '../utils/persistirFiltro';
import {
  COR_STATUS, NOME_TIPO, fmtBRL, fmtBRL0, fmtData, fmtDataHora, fmtInt, fmtNum1, fmtPct, statusDe,
  type Agg, type BalancoRow, type Criticos, type DiaRow, type LojaRow, type Opcoes, type Resumo, type StatusAcur, type StatusSync, type MaiorDif, type Reincidente,
} from './tipos';

const CHAVE_FILTROS = 'balancoLojas_filtros';
const TIPOS_PADRAO = ['ROTATIVO', 'PRINCIPAL', 'RECONTAGEM'];

// Situações do balanço no ERP (as marcadas por padrão são as que entram na acuracidade).
const SITUACOES_OPCOES: { id: number; nome: string }[] = [
  { id: 8, nome: 'Concluído (rotativo)' }, { id: 5, nome: 'Encerrado' }, { id: 3, nome: 'Calculado' },
  { id: 7, nome: 'Situação 7' }, { id: 1, nome: 'Em andamento' }, { id: 6, nome: 'Cancelado' },
];
interface Filtros { inicio: string; fim: string; empresas: number[] | null; tipos: string[]; busca: string; situacoes: number[] }

// Usada se a leitura das opções falhar: o filtro de lojas nunca some da tela.
const LOJAS_FALLBACK = [
  [2, 'MARAPONGA'], [3, 'IGUATEMI'], [4, 'TABOSA'], [5, 'NORTH'], [6, 'DOM LUIS'], [7, 'PARANGABA'], [8, 'RIO MAR'], [10, 'BARRA SHOPPING - RJ'],
  [14, 'SALVADOR SHOPPING - BA'], [15, 'MORUMBI SHOPPING'], [17, 'RIO MAR RECIFE'], [19, 'NORTH JOQUEI'], [20, 'PORTO ALEGRE'], [21, 'RIOMAR KENNEDY'],
  [22, 'INTIMATES'], [120, 'ECOMMERCE'],
].map(([cdEmpresa, nome]) => ({ cdEmpresa: cdEmpresa as number, nome: nome as string }));
const SITUACOES_VALIDAS = [3, 5, 7, 8];
const SITUACOES_PADRAO = [8, 5, 3, 7];

const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ultimosDias = (n: number) => {
  const fim = new Date();
  const ini = new Date();
  ini.setDate(ini.getDate() - (n - 1));
  return { inicio: isoLocal(ini), fim: isoLocal(fim) };
};
const mesAtual = () => {
  const h = new Date();
  return { inicio: isoLocal(new Date(h.getFullYear(), h.getMonth(), 1)), fim: isoLocal(h) };
};
const mesAnterior = () => {
  const h = new Date();
  return { inicio: isoLocal(new Date(h.getFullYear(), h.getMonth() - 1, 1)), fim: isoLocal(new Date(h.getFullYear(), h.getMonth(), 0)) };
};
const rotuloPct = (v: unknown) => (typeof v === 'number' ? `${v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}%` : '');
const rotuloMil = (v: unknown) => {
  if (typeof v !== 'number' || v === 0) return '';
  return Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k` : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
};

const FILTROS_PADRAO = (): Filtros => ({ ...ultimosDias(30), empresas: null, tipos: [...TIPOS_PADRAO], busca: '', situacoes: [...SITUACOES_PADRAO] });

// ---------------------------------------------------------------------------
// explicações (popup) dos indicadores
// ---------------------------------------------------------------------------
interface InfoKpi { titulo: string; texto: string; memoria: (t: Resumo['total']) => [string, string][] }
const INFO_KPI: Record<string, InfoKpi> = {
  acurItens: {
    titulo: 'Acuracidade por itens',
    texto: 'Dos itens (SKU) que tinham saldo ou foram contados, quantos bateram exatamente com o sistema. É o jeito mais rigoroso de medir: um item com 1 peça de diferença conta como erro inteiro. Meta: 98% ou mais (verde); entre 95% e 98% atenção (amarelo); abaixo de 95% crítico (vermelho).',
    memoria: (t) => [
      ['Itens ativos (saldo ou contagem ≠ 0)', fmtInt(t.itensAtivos)],
      ['(−) Itens com diferença', fmtInt(t.itensDivergentes)],
      ['Itens que bateram', fmtInt(t.itensAtivos - t.itensDivergentes)],
      ['Acuracidade por itens', fmtPct(t.acuracidadeItens)],
    ],
  },
  acurPecas: {
    titulo: 'Acuracidade por peças',
    texto: 'Mede o tamanho do erro em quantidade de peças: 1 menos a soma das diferenças (em módulo, faltas + sobras) dividida pela soma, item a item, do maior valor entre saldo e contagem. Perdoa erros pequenos em itens de muito estoque; por isso costuma ficar acima da acuracidade por itens.',
    memoria: (t) => [
      ['Peças a menos (faltas)', fmtInt(t.pecasFalta)],
      ['Peças a mais (sobras)', fmtInt(t.pecasSobra)],
      ['Diferença total em módulo', fmtInt(t.pecasFalta + t.pecasSobra)],
      ['Acuracidade por peças', fmtPct(t.acuracidadePecas)],
    ],
  },
  balancos: {
    titulo: 'Balanços realizados',
    texto: 'Quantidade de balanços válidos (calculados, encerrados ou concluídos) no período e nas lojas/tipos filtrados. Cancelados e em andamento não entram na acuracidade, mas aparecem aqui como indicador de processo: muito cancelamento costuma indicar contagem refeita ou lista gerada errada.',
    memoria: (t) => [
      ['Balanços válidos', fmtInt(t.balancos)],
      ['Cancelados', fmtInt(t.cancelados)],
      ['Em andamento', fmtInt(t.emAndamento)],
      ['Sem nenhum item contado', fmtInt(t.balancosSemContagem)],
      ['Total de balanços no filtro', fmtInt(t.balancosTotal)],
    ],
  },
  divergencia: {
    titulo: 'Balanços com diferença',
    texto: 'Percentual dos balanços válidos em que pelo menos um item divergiu do sistema. Um balanço rotativo pequeno que fecha sempre zerado é o objetivo; se quase todos têm diferença, o problema é de processo e não de itens isolados.',
    memoria: (t) => [
      ['Balanços válidos', fmtInt(t.balancos)],
      ['Com pelo menos 1 diferença', fmtInt(t.balancosComDivergencia)],
      ['Percentual', fmtPct(t.pctBalancosComDivergencia)],
    ],
  },
  falta: {
    titulo: 'Falta (valor)',
    texto: 'Peças que o sistema dizia ter e a contagem não encontrou, valorizadas ao preço de tabela do próprio balanço. É o prejuízo potencial de estoque (perda, furto, erro de baixa ou de entrada).',
    memoria: (t) => [['Peças em falta', fmtInt(t.pecasFalta)], ['Valor da falta', fmtBRL(t.valorFalta)]],
  },
  sobra: {
    titulo: 'Sobra (valor)',
    texto: 'Peças que a contagem encontrou a mais do que o sistema tinha, ao preço de tabela. Sobra grande também é problema: indica venda sem baixa, entrada não lançada ou troca de código na venda.',
    memoria: (t) => [['Peças em sobra', fmtInt(t.pecasSobra)], ['Valor da sobra', fmtBRL(t.valorSobra)], ['Líquido (sobra − falta)', fmtBRL(t.valorLiquido)]],
  },
  tempo: {
    titulo: 'Tempo até contar',
    texto: 'Nos balanços rotativos, as horas médias entre a geração da lista (de manhã cedo) e o registro da contagem. Quanto mais tempo a lista fica aberta, mais vendas acontecem no meio e mais diferença falsa aparece.',
    memoria: (t) => [['Média (horas)', fmtNum1(t.horasAteContar)]],
  },
};

// ---------------------------------------------------------------------------
// componentes pequenos
// ---------------------------------------------------------------------------
function Badge({ status, children }: { status: StatusAcur; children: ReactNode }) {
  const c = COR_STATUS[status];
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-bold ${c.texto} ${c.fundo} ${c.borda}`}>{children}</span>;
}

function Kpi({ id, titulo, valor, sub, status = 'neutro', onInfo }: { id: string; titulo: string; valor: ReactNode; sub?: ReactNode; status?: StatusAcur; onInfo: (id: string) => void }) {
  const cor = status === 'neutro' ? 'text-black' : COR_STATUS[status].texto;
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-5 py-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-semibold text-gray-600">{titulo}</span>
        <button onClick={() => onInfo(id)} title="Explicação e memória de cálculo" className="text-gray-500 hover:text-brand-primary" aria-label={`Explicar ${titulo}`}>
          <Info className="w-4 h-4" />
        </button>
      </div>
      <div className={`text-3xl font-bold tabular-nums mt-1 ${cor}`}>{valor}</div>
      {sub && <div className="text-xs text-gray-600 mt-1">{sub}</div>}
    </div>
  );
}

interface Col<T> {
  id: string;
  titulo: string;
  alinhar?: 'esq' | 'dir' | 'centro';
  get: (r: T) => number | string | null | undefined;
  render: (r: T) => ReactNode;
  total?: ReactNode;
  largura?: number;
}

function Tabela<T>({ linhas, cols, chave, onLinha, selecionada, vazio = 'Nenhum registro para o filtro.', ordInicial, minWidth = 900 }: {
  linhas: T[]; cols: Col<T>[]; chave: (r: T) => string; onLinha?: (r: T) => void; selecionada?: (r: T) => boolean;
  vazio?: string; ordInicial?: { campo: string; dir: 'asc' | 'desc' }; minWidth?: number;
}) {
  const getters = useMemo(() => Object.fromEntries(cols.map((c) => [c.id, c.get])) as Getters<T>, [cols]);
  const { sorted, alternar, seta, ariaSort, ord } = useOrdenacao(linhas, getters, ordInicial ?? null);
  const alinhar = (a?: string) => (a === 'esq' ? 'text-left' : a === 'centro' ? 'text-center' : 'text-right');
  const temTotal = cols.some((c) => c.total !== undefined);
  return (
    <DualScroll>
      <table className="w-full text-[13px] text-black border-separate border-spacing-0" style={{ minWidth }}>
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th
                key={c.id}
                aria-sort={ariaSort(c.id)}
                onClick={() => alternar(c.id)}
                style={c.largura ? { minWidth: c.largura } : undefined}
                className={`sticky top-0 z-[2] px-3 py-2 border-b border-gray-200 text-xs font-bold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap ${alinhar(c.alinhar)} ${ord?.campo === c.id ? 'bg-brand-soft text-brand-text' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'} ${i === 0 ? 'left-0 z-[3]' : ''}`}
              >
                {c.titulo} <span className="text-[10px] opacity-70">{seta(c.id)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-gray-600">{vazio}</td></tr>
          )}
          {sorted.map((r) => (
            <tr
              key={chave(r)}
              onClick={onLinha ? () => onLinha(r) : undefined}
              aria-selected={selecionada?.(r) || undefined}
              className={`${onLinha ? 'cursor-pointer' : ''} ${selecionada?.(r) ? 'bg-brand-soft' : 'hover:bg-brand-soft'}`}
            >
              {cols.map((c, i) => (
                <td key={c.id} className={`px-3 py-2 border-b border-gray-100 whitespace-nowrap font-medium tabular-nums ${alinhar(c.alinhar)} ${i === 0 ? `sticky left-0 z-[1] ${selecionada?.(r) ? 'bg-brand-soft' : 'bg-white'}` : ''}`}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {temTotal && sorted.length > 0 && (
          <tfoot>
            <tr>
              {cols.map((c, i) => (
                <td key={c.id} className={`sticky bottom-0 px-3 py-2 bg-gray-100 border-t-2 border-gray-300 font-bold whitespace-nowrap tabular-nums ${alinhar(c.alinhar)} ${i === 0 ? 'left-0 z-[1]' : ''}`}>
                  {i === 0 && c.total === undefined ? 'Total' : c.total}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </DualScroll>
  );
}

function Modal({ titulo, onFechar, children, largo }: { titulo: string; onFechar: () => void; children: ReactNode; largo?: boolean }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onFechar();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onFechar]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onFechar} role="dialog" aria-modal="true">
      <div className={`bg-white rounded-lg shadow-lg w-full ${largo ? 'max-w-5xl' : 'max-w-lg'} max-h-[90vh] overflow-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 sticky top-0 bg-white z-10">
          <h3 className="text-lg font-bold text-black">{titulo}</h3>
          <button onClick={onFechar} aria-label="Fechar" className="text-gray-600 hover:text-black"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// página
// ---------------------------------------------------------------------------
export default function BalancoLojasPage() {
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_PADRAO);
  const [filtroSalvo, setFiltroSalvo] = useState(false);
  const [opcoes, setOpcoes] = useState<Opcoes | null>(null);
  const [dados, setDados] = useState<Resumo | null>(null);
  const [balancos, setBalancos] = useState<BalancoRow[]>([]);
  const [criticos, setCriticos] = useState<Criticos | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [atualizando, setAtualizando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusSync | null>(null);
  const [aba, setAba] = useState<'balancos' | 'operadores' | 'criticos' | 'tipos'>('balancos');
  const [lojaSel, setLojaSel] = useState<number | null>(null);
  const [popup, setPopup] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<BalancoRow | null>(null);
  const [lojasAbertas, setLojasAbertas] = useState(false);
  const [situacoesAbertas, setSituacoesAbertas] = useState(false);
  const jaConsultou = useRef(false);
  const ultimoHistoricoCompleto = useRef<boolean | null>(null);

  // filtros salvos + opções
  useEffect(() => {
    const salvo = carregarFiltro<Filtros>(CHAVE_FILTROS);
    (async () => {
      let op: Opcoes | null = null;
      try {
        const r = await fetch('/api/balanco-lojas/opcoes');
        if (r.ok) op = await r.json();
      } catch { /* segue sem opções */ }
      setOpcoes(op);
      if (salvo) {
        const ids = new Set((op?.lojas ?? []).map((l) => l.cdEmpresa));
        const tiposValidos = (salvo.tipos ?? []).filter((t) => t in NOME_TIPO);
        const emp = Array.isArray(salvo.empresas) ? salvo.empresas.filter((e) => ids.size === 0 || ids.has(e)) : null;
        setFiltros({
          inicio: salvo.inicio || FILTROS_PADRAO().inicio,
          fim: salvo.fim || FILTROS_PADRAO().fim,
          empresas: emp && emp.length ? emp : null,
          tipos: tiposValidos.length ? tiposValidos : [...TIPOS_PADRAO],
          busca: typeof salvo.busca === 'string' ? salvo.busca : '',
          situacoes: Array.isArray(salvo.situacoes) && salvo.situacoes.some((x) => SITUACOES_OPCOES.some((o) => o.id === x)) ? salvo.situacoes.filter((x) => SITUACOES_OPCOES.some((o) => o.id === x)) : [...SITUACOES_PADRAO],
        });
        setFiltroSalvo(true);
      }
    })();
  }, []);

  const consultar = useCallback(async (f: Filtros) => {
    setCarregando(true);
    setErro(null);
    jaConsultou.current = true;
    const q = new URLSearchParams({ inicio: f.inicio, fim: f.fim, tipos: f.tipos.join(',') });
    if (f.busca.trim()) q.set('busca', f.busca.trim());
    q.set('situacoes', f.situacoes.join(','));
    if (f.empresas && f.empresas.length) q.set('empresas', f.empresas.join(','));
    try {
      const [rr, rb, rc] = await Promise.all([
        fetch(`/api/balanco-lojas/resumo?${q}`),
        fetch(`/api/balanco-lojas/balancos?${q}`),
        fetch(`/api/balanco-lojas/produtos-criticos?${q}`),
      ]);
      const resumo = await rr.json();
      if (!rr.ok) throw new Error(resumo.detail || resumo.error || 'Erro ao consultar');
      setDados(resumo);
      const b = await rb.json();
      setBalancos(rb.ok ? b.itens : []);
      const c = await rc.json();
      setCriticos(rc.ok ? c : null);
      salvarFiltro(CHAVE_FILTROS, f);
      setFiltroSalvo(true);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao consultar');
    } finally {
      setCarregando(false);
    }
  }, []);

  // andamento da leitura do histórico (só enquanto estiver rodando / incompleto)
  useEffect(() => {
    let vivo = true;
    let timer: ReturnType<typeof setTimeout>;
    const buscar = async () => {
      try {
        const r = await fetch('/api/balanco-lojas/status');
        if (r.ok && vivo) {
          const s: StatusSync = await r.json();
          setStatus(s);
          if (ultimoHistoricoCompleto.current === false && s.historicoCompleto && jaConsultou.current) consultar(filtrosRef.current);
          ultimoHistoricoCompleto.current = s.historicoCompleto;
          timer = setTimeout(buscar, s.rodando || !s.historicoCompleto ? 5000 : 60000);
          return;
        }
      } catch { /* tenta de novo */ }
      if (vivo) timer = setTimeout(buscar, 15000);
    };
    buscar();
    return () => { vivo = false; clearTimeout(timer); };
  }, [consultar]);

  const filtrosRef = useRef(filtros);
  useEffect(() => { filtrosRef.current = filtros; }, [filtros]);

  const atualizarDados = async () => {
    setAtualizando(true);
    try {
      await fetch('/api/balanco-lojas/sincronizar?dias=14', { method: 'POST' });
    } catch { /* a consulta abaixo mostra o que houver */ }
    await consultar(filtros);
    setAtualizando(false);
  };

  const limpar = () => {
    try { localStorage.removeItem(CHAVE_FILTROS); } catch { /* ignora */ }
    const p = FILTROS_PADRAO();
    setFiltros(p);
    setFiltroSalvo(false);
    setLojaSel(null);
    consultar(p);
  };

  const lojasSelecionadas = filtros.empresas;
  const listaLojas = opcoes?.lojas?.length ? opcoes.lojas : LOJAS_FALLBACK;
  const alternarLoja = (id: number) => {
    const todas = listaLojas.map((l) => l.cdEmpresa);
    const atual = new Set(lojasSelecionadas ?? todas);
    if (atual.has(id)) atual.delete(id); else atual.add(id);
    setFiltros({ ...filtros, empresas: atual.size === 0 || atual.size === todas.length ? null : Array.from(atual) });
  };
  const alternarSituacao = (id: number) => {
    const atual = new Set(filtros.situacoes);
    if (atual.has(id)) atual.delete(id); else atual.add(id);
    setFiltros({ ...filtros, situacoes: atual.size === 0 ? [...SITUACOES_PADRAO] : Array.from(atual) });
  };
  const alternarTipo = (t: string) => {
    const atual = new Set(filtros.tipos);
    if (atual.has(t)) atual.delete(t); else atual.add(t);
    setFiltros({ ...filtros, tipos: atual.size === 0 ? [...TIPOS_PADRAO] : Array.from(atual) });
  };

  const balancosFiltrados = useMemo(() => (lojaSel == null ? balancos : balancos.filter((b) => b.cdEmpresa === lojaSel)), [balancos, lojaSel]);
  const metas = dados?.metas ?? { ok: opcoes?.metaOk ?? 98, atencao: opcoes?.metaAtencao ?? 95 };
  const t = dados?.total;
  const textoLojas = `Lojas (${lojasSelecionadas ? lojasSelecionadas.length : listaLojas.length}/${listaLojas.length})`;

  // --- colunas ---------------------------------------------------------------
  const totalLojas = t;
  const colsLoja: Col<LojaRow>[] = useMemo(() => [
    { id: 'loja', titulo: 'Loja', alinhar: 'esq', get: (r) => r.loja, render: (r) => <span className="font-semibold">{r.loja}</span>, total: 'Total', largura: 150 },
    { id: 'balancos', titulo: 'Balanços', get: (r) => r.balancos, render: (r) => fmtInt(r.balancos), total: fmtInt(totalLojas?.balancos) },
    { id: 'cobertura', titulo: 'Cobertura', get: (r) => r.cobertura, render: (r) => (r.cobertura == null ? '-' : <span title={`${r.diasComBalanco} de ${r.diasUteis} dias úteis`} className={r.cobertura < 70 ? 'text-red-700 font-bold' : r.cobertura < 90 ? 'text-amber-700 font-bold' : ''}>{fmtPct(r.cobertura)}</span>), total: '' },
    { id: 'ultimo', titulo: 'Último balanço', get: (r) => r.ultimoBalanco, render: (r) => (r.ultimoBalanco ? <span className={(r.diasSemBalanco ?? 0) >= 4 ? 'text-red-700 font-bold' : ''}>{fmtData(r.ultimoBalanco)}{r.diasSemBalanco != null ? ` (${r.diasSemBalanco}d)` : ''}</span> : '-') },
    { id: 'itens', titulo: 'Itens ativos', get: (r) => r.itensAtivos, render: (r) => fmtInt(r.itensAtivos), total: fmtInt(totalLojas?.itensAtivos) },
    { id: 'div', titulo: 'Itens c/ dif.', get: (r) => r.itensDivergentes, render: (r) => fmtInt(r.itensDivergentes), total: fmtInt(totalLojas?.itensDivergentes) },
    { id: 'acurI', titulo: 'Acur. itens', alinhar: 'centro', get: (r) => r.acuracidadeItens, render: (r) => (r.acuracidadeItens == null ? '-' : <Badge status={r.status}>{fmtPct(r.acuracidadeItens)}</Badge>), total: totalLojas ? <Badge status={totalLojas.status}>{fmtPct(totalLojas.acuracidadeItens)}</Badge> : '' },
    { id: 'acurP', titulo: 'Acur. peças', get: (r) => r.acuracidadePecas, render: (r) => fmtPct(r.acuracidadePecas), total: fmtPct(totalLojas?.acuracidadePecas) },
    { id: 'pf', titulo: 'Falta (pç)', get: (r) => r.pecasFalta, render: (r) => fmtInt(r.pecasFalta), total: fmtInt(totalLojas?.pecasFalta) },
    { id: 'ps', titulo: 'Sobra (pç)', get: (r) => r.pecasSobra, render: (r) => fmtInt(r.pecasSobra), total: fmtInt(totalLojas?.pecasSobra) },
    { id: 'vf', titulo: 'Falta (R$)', get: (r) => r.valorFalta, render: (r) => <span className="text-red-700">{fmtBRL(r.valorFalta)}</span>, total: fmtBRL(totalLojas?.valorFalta) },
    { id: 'vs', titulo: 'Sobra (R$)', get: (r) => r.valorSobra, render: (r) => <span className="text-blue-700">{fmtBRL(r.valorSobra)}</span>, total: fmtBRL(totalLojas?.valorSobra) },
    { id: 'vl', titulo: 'Líquido (R$)', get: (r) => r.valorLiquido, render: (r) => <span className={r.valorLiquido < 0 ? 'text-red-700' : ''}>{fmtBRL(r.valorLiquido)}</span>, total: fmtBRL(totalLojas?.valorLiquido) },
    { id: 'canc', titulo: 'Cancelados', get: (r) => r.cancelados, render: (r) => fmtInt(r.cancelados), total: fmtInt(totalLojas?.cancelados) },
  ], [totalLojas]);

  const colsBalanco: Col<BalancoRow>[] = useMemo(() => {
    const somar = (f: (b: BalancoRow) => number) => balancosFiltrados.reduce((s, b) => s + f(b), 0);
    const validos = balancosFiltrados.filter((b) => [3, 5, 7, 8].includes(b.tpSituacao));
    const at = validos.reduce((s, b) => s + b.itensAtivos, 0);
    const dv = validos.reduce((s, b) => s + b.itensDivergentes, 0);
    return [
      { id: 'data', titulo: 'Data', alinhar: 'esq', get: (r) => r.data, render: (r) => <span className="font-semibold">{fmtData(r.data)}</span>, total: 'Total', largura: 100 },
      { id: 'loja', titulo: 'Loja', alinhar: 'esq', get: (r) => r.loja, render: (r) => r.loja },
      { id: 'nr', titulo: 'Nº', get: (r) => r.nrBalanco, render: (r) => r.nrBalanco },
      { id: 'desc', titulo: 'Descrição', alinhar: 'esq', get: (r) => r.descricao, render: (r) => <span className="inline-block max-w-[260px] truncate align-bottom" title={r.descricao ?? ''}>{r.descricao}</span> },
      { id: 'tipo', titulo: 'Tipo', alinhar: 'esq', get: (r) => r.tipo, render: (r) => NOME_TIPO[r.tipo] ?? r.tipo },
      { id: 'sit', titulo: 'Situação', alinhar: 'centro', get: (r) => r.situacao, render: (r) => <span className={r.tpSituacao === 6 ? 'text-red-700 font-bold' : r.tpSituacao === 1 ? 'text-amber-700 font-bold' : ''}>{r.situacao}</span> },
      { id: 'op', titulo: 'Operador', alinhar: 'esq', get: (r) => r.operador, render: (r) => r.operador ?? '-' },
      { id: 'itens', titulo: 'Itens ativos', get: (r) => r.itensAtivos, render: (r) => fmtInt(r.itensAtivos), total: fmtInt(somar((b) => b.itensAtivos)) },
      { id: 'div', titulo: 'Itens c/ dif.', get: (r) => r.itensDivergentes, render: (r) => fmtInt(r.itensDivergentes), total: fmtInt(somar((b) => b.itensDivergentes)) },
      { id: 'acur', titulo: 'Acur. itens', alinhar: 'centro', get: (r) => r.acuracidadeItens, render: (r) => (r.acuracidadeItens == null ? '-' : <Badge status={r.status}>{fmtPct(r.acuracidadeItens)}</Badge>), total: at ? fmtPct((100 * (at - dv)) / at) : '-' },
      { id: 'acurp', titulo: 'Acur. peças', get: (r) => r.acuracidadePecas, render: (r) => fmtPct(r.acuracidadePecas) },
      { id: 'pf', titulo: 'Falta (pç)', get: (r) => r.pecasFalta, render: (r) => fmtInt(r.pecasFalta), total: fmtInt(somar((b) => b.pecasFalta)) },
      { id: 'ps', titulo: 'Sobra (pç)', get: (r) => r.pecasSobra, render: (r) => fmtInt(r.pecasSobra), total: fmtInt(somar((b) => b.pecasSobra)) },
      { id: 'vf', titulo: 'Falta (R$)', get: (r) => r.valorFalta, render: (r) => <span className="text-red-700">{fmtBRL(r.valorFalta)}</span>, total: fmtBRL(somar((b) => b.valorFalta)) },
      { id: 'vs', titulo: 'Sobra (R$)', get: (r) => r.valorSobra, render: (r) => <span className="text-blue-700">{fmtBRL(r.valorSobra)}</span>, total: fmtBRL(somar((b) => b.valorSobra)) },
      { id: 'h', titulo: 'Horas até contar', get: (r) => r.horasAteContar, render: (r) => fmtNum1(r.horasAteContar) },
    ];
  }, [balancosFiltrados]);

  const colsOperador: Col<Resumo['porOperador'][number]>[] = useMemo(() => {
    const ops = dados?.porOperador ?? [];
    return [
      { id: 'op', titulo: 'Operador', alinhar: 'esq', get: (r) => r.operador, render: (r) => <span className="font-semibold">{r.operador}</span>, total: 'Total', largura: 200 },
      { id: 'bal', titulo: 'Balanços', get: (r) => r.balancos, render: (r) => fmtInt(r.balancos), total: fmtInt(ops.reduce((s, o) => s + o.balancos, 0)) },
      { id: 'itens', titulo: 'Itens ativos', get: (r) => r.itensAtivos, render: (r) => fmtInt(r.itensAtivos), total: fmtInt(ops.reduce((s, o) => s + o.itensAtivos, 0)) },
      { id: 'div', titulo: 'Itens c/ dif.', get: (r) => r.itensDivergentes, render: (r) => fmtInt(r.itensDivergentes), total: fmtInt(ops.reduce((s, o) => s + o.itensDivergentes, 0)) },
      { id: 'acur', titulo: 'Acur. itens', alinhar: 'centro', get: (r) => r.acuracidadeItens, render: (r) => (r.acuracidadeItens == null ? '-' : <Badge status={r.status}>{fmtPct(r.acuracidadeItens)}</Badge>) },
      { id: 'acurp', titulo: 'Acur. peças', get: (r) => r.acuracidadePecas, render: (r) => fmtPct(r.acuracidadePecas) },
      { id: 'vf', titulo: 'Falta (R$)', get: (r) => r.valorFalta, render: (r) => <span className="text-red-700">{fmtBRL(r.valorFalta)}</span>, total: fmtBRL(ops.reduce((s, o) => s + o.valorFalta, 0)) },
      { id: 'vs', titulo: 'Sobra (R$)', get: (r) => r.valorSobra, render: (r) => <span className="text-blue-700">{fmtBRL(r.valorSobra)}</span>, total: fmtBRL(ops.reduce((s, o) => s + o.valorSobra, 0)) },
    ];
  }, [dados]);

  const colsTipo: Col<Resumo['porTipo'][number]>[] = useMemo(() => [
    { id: 'tipo', titulo: 'Tipo de balanço', alinhar: 'esq', get: (r) => NOME_TIPO[r.tipo] ?? r.tipo, render: (r) => <span className="font-semibold">{NOME_TIPO[r.tipo] ?? r.tipo}</span> },
    { id: 'bal', titulo: 'Balanços', get: (r) => r.balancos, render: (r) => fmtInt(r.balancos) },
    { id: 'itens', titulo: 'Itens ativos', get: (r) => r.itensAtivos, render: (r) => fmtInt(r.itensAtivos) },
    { id: 'div', titulo: 'Itens c/ dif.', get: (r) => r.itensDivergentes, render: (r) => fmtInt(r.itensDivergentes) },
    { id: 'acur', titulo: 'Acur. itens', alinhar: 'centro', get: (r) => r.acuracidadeItens, render: (r) => (r.acuracidadeItens == null ? '-' : <Badge status={r.status}>{fmtPct(r.acuracidadeItens)}</Badge>) },
    { id: 'acurp', titulo: 'Acur. peças', get: (r) => r.acuracidadePecas, render: (r) => fmtPct(r.acuracidadePecas) },
    { id: 'vf', titulo: 'Falta (R$)', get: (r) => r.valorFalta, render: (r) => <span className="text-red-700">{fmtBRL(r.valorFalta)}</span> },
    { id: 'vs', titulo: 'Sobra (R$)', get: (r) => r.valorSobra, render: (r) => <span className="text-blue-700">{fmtBRL(r.valorSobra)}</span> },
  ], []);

  const nomeProd = (p: { referencia: string | null; produto: string | null; cdProduto: number }) => p.produto ?? `Produto ${p.cdProduto}`;
  const colsReinc: Col<Reincidente>[] = useMemo(() => [
    { id: 'ref', titulo: 'Referência', alinhar: 'esq', get: (r) => r.referencia, render: (r) => <span className="font-semibold">{r.referencia ?? r.cdProduto}</span>, largura: 110 },
    { id: 'prod', titulo: 'Produto', alinhar: 'esq', get: (r) => r.produto, render: (r) => <span className="inline-block max-w-[260px] truncate align-bottom" title={nomeProd(r)}>{nomeProd(r)}</span> },
    { id: 'cor', titulo: 'Cor', alinhar: 'esq', get: (r) => r.cor, render: (r) => r.cor ?? '-' },
    { id: 'tam', titulo: 'Tam.', alinhar: 'centro', get: (r) => r.tamanho, render: (r) => r.tamanho ?? '-' },
    { id: 'vezes', titulo: 'Balanços c/ dif.', get: (r) => r.vezes, render: (r) => <span className="font-bold">{r.vezes}</span> },
    { id: 'lojas', titulo: 'Lojas', get: (r) => r.lojas, render: (r) => r.lojas },
    { id: 'pa', titulo: 'Peças (módulo)', get: (r) => r.pecasAbs, render: (r) => fmtInt(r.pecasAbs) },
    { id: 'pl', titulo: 'Peças (líquido)', get: (r) => r.pecasLiquidas, render: (r) => <span className={r.pecasLiquidas < 0 ? 'text-red-700' : 'text-blue-700'}>{fmtInt(r.pecasLiquidas)}</span> },
    { id: 'va', titulo: 'Valor (módulo)', get: (r) => r.valorAbs, render: (r) => fmtBRL(r.valorAbs) },
    { id: 'ult', titulo: 'Última', get: (r) => r.ultima, render: (r) => fmtData(r.ultima) },
  ], []);
  const colsMaiores: Col<MaiorDif>[] = useMemo(() => [
    { id: 'ref', titulo: 'Referência', alinhar: 'esq', get: (r) => r.referencia, render: (r) => <span className="font-semibold">{r.referencia ?? r.cdProduto}</span>, largura: 110 },
    { id: 'prod', titulo: 'Produto', alinhar: 'esq', get: (r) => r.produto, render: (r) => <span className="inline-block max-w-[260px] truncate align-bottom" title={nomeProd(r)}>{nomeProd(r)}</span> },
    { id: 'cor', titulo: 'Cor', alinhar: 'esq', get: (r) => r.cor, render: (r) => r.cor ?? '-' },
    { id: 'tam', titulo: 'Tam.', alinhar: 'centro', get: (r) => r.tamanho, render: (r) => r.tamanho ?? '-' },
    { id: 'loja', titulo: 'Loja', alinhar: 'esq', get: (r) => r.loja, render: (r) => r.loja },
    { id: 'data', titulo: 'Data', get: (r) => r.data, render: (r) => fmtData(r.data) },
    { id: 'saldo', titulo: 'Saldo', get: (r) => r.saldo, render: (r) => fmtInt(r.saldo) },
    { id: 'cont', titulo: 'Contagem', get: (r) => r.contagem, render: (r) => fmtInt(r.contagem) },
    { id: 'dif', titulo: 'Diferença', get: (r) => r.diferenca, render: (r) => <span className={r.diferenca < 0 ? 'text-red-700 font-bold' : 'text-blue-700 font-bold'}>{fmtInt(r.diferenca)}</span> },
    { id: 'preco', titulo: 'Preço', get: (r) => r.preco, render: (r) => fmtBRL(r.preco) },
    { id: 'vd', titulo: 'Valor da dif.', get: (r) => r.valorDiferenca, render: (r) => <span className={r.valorDiferenca < 0 ? 'text-red-700' : 'text-blue-700'}>{fmtBRL(r.valorDiferenca)}</span> },
  ], []);

  const serieLoja = useMemo(
    () => (dados?.porLoja ?? []).filter((l) => l.itensAtivos > 0).sort((a, b) => (a.acuracidadeItens ?? 0) - (b.acuracidadeItens ?? 0)),
    [dados],
  );
  const serieDia = useMemo(() => (dados?.porDia ?? []).map((d) => ({ ...d, rotulo: `${d.data.slice(8, 10)}/${d.data.slice(5, 7)}` })), [dados]);
  const minAcur = useMemo(() => {
    const vs = serieDia.flatMap((d) => [d.acuracidadeItens, d.acuracidadePecas]).filter((v): v is number => v != null);
    return vs.length ? Math.max(0, Math.floor(Math.min(...vs, metas.atencao) - 2)) : 80;
  }, [serieDia, metas]);

  const historicoIncompleto = status && (!status.historicoCompleto || status.rodando);
  const botaoBase = 'px-3 py-2 text-sm rounded-md border transition-colors';

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-5">
      <div className="flex items-start gap-3">
        <div className="p-3 rounded-lg bg-brand-soft"><ClipboardCheck className="w-6 h-6 text-brand-text" /></div>
        <div>
          <h1 className="text-3xl font-bold text-brand-dark">BALANÇO LOJAS</h1>
          <p className="text-sm text-gray-700 mt-1">
            Acompanhamento das contagens de estoque das lojas: acuracidade, faltas e sobras, cobertura de balanços por loja e produtos que mais erram. Fábrica fica de fora, por enquanto.
          </p>
        </div>
      </div>

      {historicoIncompleto && (
        <div className="flex items-center gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-4 py-2" role="status">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Lendo o histórico de balanços do ERP ({status!.janelasGravadas} de {status!.janelasHistorico} semanas já gravadas). Os números vão se completando; a tela atualiza sozinha ao terminar.
        </div>
      )}

      {/* filtros */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-700 font-medium">
            De
            <input type="date" value={filtros.inicio} max={filtros.fim} onChange={(e) => setFiltros({ ...filtros, inicio: e.target.value })} className="block mt-1 border border-gray-300 rounded-md px-2 py-1.5 text-sm text-black" />
          </label>
          <label className="text-sm text-gray-700 font-medium">
            Até
            <input type="date" value={filtros.fim} min={filtros.inicio} onChange={(e) => setFiltros({ ...filtros, fim: e.target.value })} className="block mt-1 border border-gray-300 rounded-md px-2 py-1.5 text-sm text-black" />
          </label>
          <div className="flex flex-wrap gap-2">
            {[
              ['7 dias', () => ultimosDias(7)], ['30 dias', () => ultimosDias(30)], ['90 dias', () => ultimosDias(90)],
              ['Mês atual', mesAtual], ['Mês anterior', mesAnterior],
              ['Ano atual', () => ({ inicio: `${new Date().getFullYear()}-01-01`, fim: isoLocal(new Date()) })],
            ].map(([nome, fn]) => (
              <button key={nome as string} onClick={() => setFiltros({ ...filtros, ...(fn as () => { inicio: string; fim: string })() })} className={`${botaoBase} bg-gray-100 hover:bg-gray-200 text-gray-700 border-transparent`}>
                {nome as string}
              </button>
            ))}
          </div>

          <div className="relative text-sm text-gray-700 font-medium">
            Lojas
            <button onClick={() => setLojasAbertas((v) => !v)} className={`${botaoBase} mt-1 bg-white border-gray-300 text-black inline-flex items-center gap-2 w-full justify-between`} aria-expanded={lojasAbertas}>
              {textoLojas} <ChevronDown className="w-4 h-4" />
            </button>
            {lojasAbertas && (
              <div className="absolute z-30 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg p-2 max-h-80 overflow-auto">
                <div className="flex gap-3 px-2 py-1 text-xs font-semibold text-brand-text">
                  <button onClick={() => setFiltros({ ...filtros, empresas: null })}>Todas</button>
                  <button onClick={() => setLojasAbertas(false)} className="ml-auto text-gray-600">Fechar</button>
                </div>
                {listaLojas.map((l) => (
                  <label key={l.cdEmpresa} className="flex items-center gap-2 px-2 py-1 text-sm text-black hover:bg-brand-soft rounded cursor-pointer">
                    <input type="checkbox" checked={!lojasSelecionadas || lojasSelecionadas.includes(l.cdEmpresa)} onChange={() => alternarLoja(l.cdEmpresa)} />
                    {l.nome}
                  </label>
                ))}
              </div>
            )}
          </div>

          <label className="text-sm text-gray-700 font-medium">
            Balanço (nº ou descrição)
            <input type="text" value={filtros.busca} onChange={(e) => setFiltros({ ...filtros, busca: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && consultar(filtros)} placeholder="Ex: 1731 ou RECONTAGEM" className="block mt-1 w-52 border border-gray-300 rounded-md px-2 py-1.5 text-sm text-black" />
          </label>
          <div className="relative text-sm text-gray-700 font-medium">
            Situação
            <button onClick={() => setSituacoesAbertas((v) => !v)} className={`${botaoBase} mt-1 bg-white border-gray-300 text-black inline-flex items-center gap-2 w-full justify-between`} aria-expanded={situacoesAbertas}>
              Situação ({filtros.situacoes.length}/{SITUACOES_OPCOES.length}) <ChevronDown className="w-4 h-4" />
            </button>
            {situacoesAbertas && (
              <div className="absolute z-30 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg p-2">
                <div className="flex gap-3 px-2 py-1 text-xs font-semibold text-brand-text">
                  <button onClick={() => setFiltros({ ...filtros, situacoes: [...SITUACOES_PADRAO] })}>Padrão (válidos)</button>
                  <button onClick={() => setSituacoesAbertas(false)} className="ml-auto text-gray-600">Fechar</button>
                </div>
                {SITUACOES_OPCOES.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 px-2 py-1 text-sm text-black hover:bg-brand-soft rounded cursor-pointer">
                    <input type="checkbox" checked={filtros.situacoes.includes(o.id)} onChange={() => alternarSituacao(o.id)} />
                    {o.nome}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm text-black">
            <span className="font-medium text-gray-700">Tipos de balanço:</span>
            {Object.keys(NOME_TIPO).map((tp) => (
              <label key={tp} className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filtros.tipos.includes(tp)} onChange={() => alternarTipo(tp)} />
                {NOME_TIPO[tp]}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => consultar(filtros)} disabled={carregando} className="px-5 py-2 text-sm font-semibold rounded-md bg-green-600 hover:bg-green-700 text-white disabled:opacity-60">
            {carregando ? 'Consultando…' : 'Consultar'}
          </button>
          <button onClick={atualizarDados} disabled={atualizando || carregando} title="Relê do ERP os balanços dos últimos 14 dias e consulta de novo" className={`${botaoBase} bg-white border-brand-primary text-brand-text hover:bg-brand-soft inline-flex items-center gap-2 disabled:opacity-60`}>
            <RefreshCw className={`w-4 h-4 ${atualizando ? 'animate-spin' : ''}`} /> Atualizar dados
          </button>
          <button onClick={limpar} className="text-sm text-gray-700 underline hover:text-black">Limpar filtros</button>
          {filtroSalvo && <span className="text-xs text-gray-600">Filtros salvos aplicados</span>}
          {status?.atualizadoEm && <span className="text-xs text-gray-600 ml-auto">Dados do ERP lidos em {fmtDataHora(status.atualizadoEm)}</span>}
        </div>
      </div>

      {erro && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-red-700 bg-red-50 border border-red-300 rounded-lg px-4 py-2" role="alert">
          {erro}
          <button onClick={() => consultar(filtros)} className="px-3 py-1 rounded-full border border-red-400 hover:bg-red-100">Tentar de novo</button>
        </div>
      )}

      {!dados && carregando && <div className="text-center text-gray-700 py-16">Carregando os balanços…</div>}
      {!dados && !carregando && !erro && (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-gray-700">
          Escolha o período, as lojas e o tipo de balanço e clique em Consultar.
        </div>
      )}

      {dados && t && (
        <>
          {t.balancos === 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-700">
              Nenhum balanço válido para o filtro. {historicoIncompleto ? 'O histórico ainda está sendo lido.' : 'Ajuste o período, as lojas ou os tipos.'}
            </div>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi id="acurItens" titulo="Acuracidade por itens" valor={fmtPct(t.acuracidadeItens)} status={t.status} onInfo={setPopup}
              sub={`${fmtInt(t.itensDivergentes)} de ${fmtInt(t.itensAtivos)} itens com diferença · meta ${metas.ok}%`} />
            <Kpi id="acurPecas" titulo="Acuracidade por peças" valor={fmtPct(t.acuracidadePecas)} status={statusDe(t.acuracidadePecas, metas)} onInfo={setPopup}
              sub={`${fmtInt(t.pecasFalta + t.pecasSobra)} peças de diferença`} />
            <Kpi id="balancos" titulo="Balanços realizados" valor={fmtInt(t.balancos)} onInfo={setPopup}
              sub={`${fmtInt(t.cancelados)} cancelados (${fmtPct(t.pctCancelados)}) · ${fmtInt(t.emAndamento)} em andamento`} />
            <Kpi id="divergencia" titulo="Balanços com diferença" valor={fmtPct(t.pctBalancosComDivergencia)} onInfo={setPopup}
              sub={`${fmtInt(t.balancosComDivergencia)} de ${fmtInt(t.balancos)} balanços`} />
            <Kpi id="falta" titulo="Falta (valor)" valor={fmtBRL0(t.valorFalta)} status={t.valorFalta > 0 ? 'ruim' : 'neutro'} onInfo={setPopup} sub={`${fmtInt(t.pecasFalta)} peças a menos`} />
            <Kpi id="sobra" titulo="Sobra (valor)" valor={fmtBRL0(t.valorSobra)} onInfo={setPopup} sub={`${fmtInt(t.pecasSobra)} peças a mais · líquido ${fmtBRL0(t.valorLiquido)}`} />
            <Kpi id="tempo" titulo="Tempo até contar" valor={t.horasAteContar == null ? '-' : `${fmtNum1(t.horasAteContar)} h`} onInfo={setPopup} sub="Da geração da lista ao registro (rotativo)" />
            <div className="bg-white border border-gray-200 rounded-lg px-5 py-4 shadow-sm">
              <span className="text-[13px] font-semibold text-gray-600">Cobertura de balanços</span>
              {(() => {
                const cs = dados.porLoja.filter((l) => l.cobertura != null);
                const media = cs.length ? cs.reduce((s, l) => s + (l.cobertura ?? 0), 0) / cs.length : null;
                return (
                  <>
                    <div className="text-3xl font-bold tabular-nums mt-1 text-black">{fmtPct(media)}</div>
                    <div className="text-xs text-gray-600 mt-1">
                      {dados.diasUteis > 0
                        ? `Média das lojas sobre ${dados.diasUteis} dias úteis (dias em que a maioria das lojas fez balanço dos tipos filtrados)`
                        : 'Não se aplica aos tipos filtrados: só faz sentido para o balanço rotativo (diário).'}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* acuracidade por loja */}
          <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
            <h2 className="text-lg font-bold text-black">Acuracidade por loja</h2>
            <p className="text-xs text-gray-600 mb-2">Por itens e por peças, da pior para a melhor loja. Linhas tracejadas: meta de {metas.ok}% (verde) e piso de {metas.atencao}% (amarelo).</p>
            <div style={{ height: Math.max(260, serieLoja.length * 52 + 60) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={serieLoja} layout="vertical" margin={{ top: 8, right: 56, bottom: 8, left: 8 }} barCategoryGap="22%">
                  <CartesianGrid stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 12, fill: '#4b5563' }} tickFormatter={(v) => `${v}%`} />
                  <YAxis type="category" dataKey="loja" width={170} tick={{ fontSize: 12, fill: '#1d1d1d' }} interval={0} />
                  <Tooltip formatter={(v) => fmtPct(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine x={metas.ok} stroke="#15803d" strokeDasharray="4 4" />
                  <ReferenceLine x={metas.atencao} stroke="#b45309" strokeDasharray="4 4" />
                  <Bar dataKey="acuracidadeItens" name="Por itens" fill="#8e5e68">
                    <LabelList dataKey="acuracidadeItens" position="right" formatter={rotuloPct} style={{ fontSize: 11, fontWeight: 600, fill: '#8e5e68' }} />
                  </Bar>
                  <Bar dataKey="acuracidadePecas" name="Por peças" fill="#9ca3af">
                    <LabelList dataKey="acuracidadePecas" position="right" formatter={rotuloPct} style={{ fontSize: 11, fontWeight: 600, fill: '#4b5563' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* gráficos */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
              <h2 className="text-lg font-bold text-black">Acuracidade por dia</h2>
              <p className="text-xs text-gray-600 mb-2">Linhas tracejadas: meta de {metas.ok}% (verde) e piso de {metas.atencao}% (amarelo).</p>
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={serieDia} margin={{ top: 22, right: 16, bottom: 12, left: 0 }}>
                    <CartesianGrid stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="rotulo" tick={{ fontSize: 12, fill: '#4b5563' }} interval="preserveStartEnd" />
                    <YAxis domain={[minAcur, 100]} tick={{ fontSize: 12, fill: '#4b5563' }} tickFormatter={(v) => `${v}%`} width={48} />
                    <Tooltip formatter={(v) => fmtPct(Number(v))} labelFormatter={(l) => `Dia ${l}`} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <ReferenceLine y={metas.ok} stroke="#15803d" strokeDasharray="4 4" />
                    <ReferenceLine y={metas.atencao} stroke="#b45309" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="acuracidadeItens" name="Por itens" stroke="#8e5e68" strokeWidth={2.5} dot={{ r: 3 }} connectNulls>
                      <LabelList dataKey="acuracidadeItens" position="bottom" formatter={rotuloPct} style={{ fontSize: 11, fontWeight: 600, fill: '#8e5e68' }} />
                    </Line>
                    <Line type="monotone" dataKey="acuracidadePecas" name="Por peças" stroke="#6b7280" strokeWidth={2} dot={{ r: 2 }} connectNulls>
                      <LabelList dataKey="acuracidadePecas" position="top" formatter={rotuloPct} style={{ fontSize: 11, fontWeight: 600, fill: '#4b5563' }} />
                    </Line>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
              <h2 className="text-lg font-bold text-black">Falta e sobra por dia (R$)</h2>
              <p className="text-xs text-gray-600 mb-2">A preço de tabela do balanço. Falta em vermelho, sobra em azul.</p>
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={serieDia} margin={{ top: 22, right: 16, bottom: 12, left: 0 }}>
                    <CartesianGrid stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="rotulo" tick={{ fontSize: 12, fill: '#4b5563' }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 12, fill: '#4b5563' }} tickFormatter={(v) => fmtBRL0(v)} width={72} />
                    <Tooltip formatter={(v) => fmtBRL(Number(v))} labelFormatter={(l) => `Dia ${l}`} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="valorFalta" name="Falta" fill="#b91c1c">
                      <LabelList dataKey="valorFalta" position="top" formatter={rotuloMil} style={{ fontSize: 10, fontWeight: 600, fill: '#b91c1c' }} />
                    </Bar>
                    <Bar dataKey="valorSobra" name="Sobra" fill="#1d4ed8">
                      <LabelList dataKey="valorSobra" position="top" formatter={rotuloMil} style={{ fontSize: 10, fontWeight: 600, fill: '#1d4ed8' }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* por loja */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-xl font-bold text-black">Por loja</h2>
              <span className="text-xs text-gray-600">Clique numa loja para filtrar a lista de balanços abaixo.</span>
              {lojaSel != null && <button onClick={() => setLojaSel(null)} className="text-xs underline text-brand-text">Ver todas</button>}
            </div>
            <Tabela
              linhas={dados.porLoja}
              cols={colsLoja}
              chave={(r) => String(r.cdEmpresa)}
              onLinha={(r) => setLojaSel(lojaSel === r.cdEmpresa ? null : r.cdEmpresa)}
              selecionada={(r) => lojaSel === r.cdEmpresa}
              ordInicial={{ campo: 'acurI', dir: 'asc' }}
              minWidth={1250}
            />
          </div>

          {/* abas */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2 border-b border-gray-200" role="tablist">
              {([['balancos', `Balanços${lojaSel != null ? ' (loja filtrada)' : ''}`], ['operadores', 'Por operador'], ['criticos', 'Produtos críticos'], ['tipos', 'Por tipo']] as const).map(([id, nome]) => (
                <button key={id} role="tab" aria-selected={aba === id} onClick={() => setAba(id)}
                  className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 ${aba === id ? 'border-brand-primary text-brand-text' : 'border-transparent text-gray-700 hover:text-black'}`}>
                  {nome}
                </button>
              ))}
            </div>

            {aba === 'balancos' && (
              <>
                <p className="text-xs text-gray-600">Clique numa linha para ver os itens divergentes do balanço.{balancos.length >= 3000 ? ' Mostrando os 3.000 mais recentes.' : ''}</p>
                <Tabela linhas={balancosFiltrados} cols={colsBalanco} chave={(r) => `${r.cdEmpresa}-${r.nrBalanco}`} onLinha={setDetalhe} ordInicial={{ campo: 'data', dir: 'desc' }} minWidth={1700} />
              </>
            )}
            {aba === 'operadores' && (
              <>
                <p className="text-xs text-gray-600">Código do operador do ERP que registrou a contagem (o nome não existe nas tabelas de balanço). Só aparecem operadores com algum item contado nos balanços válidos.</p>
                <Tabela linhas={dados.porOperador} cols={colsOperador} chave={(r) => String(r.cdOperador)} ordInicial={{ campo: 'acur', dir: 'asc' }} minWidth={900} />
              </>
            )}
            {aba === 'criticos' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-base font-bold text-black">Produtos que divergem sempre</h3>
                  <p className="text-xs text-gray-600 mb-2">Mesmo SKU com diferença em 2 ou mais balanços do período: costuma ser problema de cadastro, etiqueta ou local de armazenagem, não de contagem.</p>
                  <Tabela linhas={criticos?.reincidentes ?? []} cols={colsReinc} chave={(r) => String(r.cdProduto)} ordInicial={{ campo: 'vezes', dir: 'desc' }} vazio="Nenhum produto divergiu em mais de um balanço." minWidth={1100} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-black">Maiores diferenças em valor</h3>
                  <p className="text-xs text-gray-600 mb-2">Os 60 itens com maior diferença (falta ou sobra) em R$, dentro do filtro.</p>
                  <Tabela linhas={criticos?.maiores ?? []} cols={colsMaiores} chave={(r) => `${r.cdEmpresa}-${r.nrBalanco}-${r.cdProduto}`} ordInicial={{ campo: 'vd', dir: 'asc' }} vazio="Nenhuma diferença no período." minWidth={1200} />
                </div>
              </div>
            )}
            {aba === 'tipos' && (
              <>
                <p className="text-xs text-gray-600">Comparativo entre os tipos de balanço (ignora o filtro de tipos). Rotativo é a contagem diária por loja; principal é a contagem geral; ajuste é correção pontual de estoque.</p>
                <Tabela linhas={dados.porTipo} cols={colsTipo} chave={(r) => r.tipo} minWidth={800} />
              </>
            )}
          </div>
        </>
      )}

      {/* popup de explicação */}
      {popup && t && INFO_KPI[popup] && (
        <Modal titulo={INFO_KPI[popup].titulo} onFechar={() => setPopup(null)}>
          <p className="text-sm text-black leading-relaxed">{INFO_KPI[popup].texto}</p>
          <h4 className="text-sm font-bold text-black mt-4 mb-1">Memória de cálculo (filtro atual)</h4>
          <table className="w-full text-[13px]">
            <tbody>
              {INFO_KPI[popup].memoria(t).map(([k, v], i, arr) => (
                <tr key={k} className="border-t border-gray-100">
                  <td className={`py-1.5 pr-3 text-black ${i === arr.length - 1 ? 'font-bold' : ''}`}>{k}</td>
                  <td className={`py-1.5 text-right tabular-nums text-black ${i === arr.length - 1 ? 'font-bold' : 'font-medium'}`}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {/* detalhe do balanço */}
      {detalhe && <DetalheBalanco b={detalhe} onFechar={() => setDetalhe(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// detalhe de um balanço (itens)
// ---------------------------------------------------------------------------
interface ItemBal { cdProduto: number; referencia: string | null; produto: string | null; cor: string | null; tamanho: string | null; saldo: number; contagem: number; diferenca: number; preco: number; valorDiferenca: number }

function DetalheBalanco({ b, onFechar }: { b: BalancoRow; onFechar: () => void }) {
  const [somenteDiv, setSomenteDiv] = useState(true);
  const [itens, setItens] = useState<ItemBal[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setItens(null);
    setErro(null);
    fetch(`/api/balanco-lojas/itens?cdEmpresa=${b.cdEmpresa}&nrBalanco=${b.nrBalanco}&somenteDivergentes=${somenteDiv}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || d.error || 'Erro');
        if (vivo) setItens(d.itens);
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Erro ao buscar os itens'));
    return () => { vivo = false; };
  }, [b, somenteDiv]);

  const cols: Col<ItemBal>[] = useMemo(() => {
    const l = itens ?? [];
    const soma = (f: (i: ItemBal) => number) => l.reduce((s, i) => s + f(i), 0);
    return [
      { id: 'ref', titulo: 'Referência', alinhar: 'esq', get: (r) => r.referencia, render: (r) => <span className="font-semibold">{r.referencia ?? r.cdProduto}</span>, total: 'Total', largura: 110 },
      { id: 'prod', titulo: 'Produto', alinhar: 'esq', get: (r) => r.produto, render: (r) => <span className="inline-block max-w-[260px] truncate align-bottom" title={r.produto ?? ''}>{r.produto ?? '-'}</span> },
      { id: 'cor', titulo: 'Cor', alinhar: 'esq', get: (r) => r.cor, render: (r) => r.cor ?? '-' },
      { id: 'tam', titulo: 'Tam.', alinhar: 'centro', get: (r) => r.tamanho, render: (r) => r.tamanho ?? '-' },
      { id: 'saldo', titulo: 'Saldo', get: (r) => r.saldo, render: (r) => fmtInt(r.saldo), total: fmtInt(soma((i) => i.saldo)) },
      { id: 'cont', titulo: 'Contagem', get: (r) => r.contagem, render: (r) => fmtInt(r.contagem), total: fmtInt(soma((i) => i.contagem)) },
      { id: 'dif', titulo: 'Diferença', get: (r) => r.diferenca, render: (r) => <span className={r.diferenca < 0 ? 'text-red-700 font-bold' : r.diferenca > 0 ? 'text-blue-700 font-bold' : ''}>{fmtInt(r.diferenca)}</span>, total: fmtInt(soma((i) => i.diferenca)) },
      { id: 'preco', titulo: 'Preço', get: (r) => r.preco, render: (r) => fmtBRL(r.preco) },
      { id: 'vd', titulo: 'Valor da dif.', get: (r) => r.valorDiferenca, render: (r) => fmtBRL(r.valorDiferenca), total: fmtBRL(soma((i) => i.valorDiferenca)) },
    ];
  }, [itens]);

  return (
    <Modal titulo={`${b.loja} · balanço ${b.nrBalanco} · ${fmtData(b.data)}`} onFechar={onFechar} largo>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-black mb-3">
        <span>{b.descricao}</span>
        <span>{NOME_TIPO[b.tipo] ?? b.tipo} · {b.situacao}</span>
        {b.operador && <span>Operador: {b.operador}</span>}
        <span>Acuracidade: <b>{fmtPct(b.acuracidadeItens)}</b> ({fmtInt(b.itensDivergentes)} de {fmtInt(b.itensAtivos)} itens com diferença)</span>
        <label className="inline-flex items-center gap-1.5 ml-auto cursor-pointer">
          <input type="checkbox" checked={somenteDiv} onChange={(e) => setSomenteDiv(e.target.checked)} /> Só itens com diferença
        </label>
      </div>
      {erro && <p className="text-sm text-red-700">{erro}</p>}
      {!itens && !erro && <p className="text-sm text-gray-700 py-8 text-center">Carregando itens…</p>}
      {itens && <Tabela linhas={itens} cols={cols} chave={(r) => String(r.cdProduto)} ordInicial={{ campo: 'vd', dir: 'asc' }} vazio={somenteDiv ? 'Este balanço fechou sem nenhuma diferença.' : 'Sem itens.'} minWidth={900} />}
    </Modal>
  );
}
