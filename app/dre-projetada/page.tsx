'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, ChevronRight, Filter, RefreshCw, TrendingUp } from 'lucide-react';
import { formatarValor } from '../utils/formatters';
import { PLANO_CONTAS_DRE_FABRICA, type ContaDRE } from '../dre-fabrica/planoContasDREFabrica';

type Cenario = 'pessimista' | 'realista' | 'otimista' | 'meta' | 'equilibrio' | 'personalizado';
type Valores = Record<string, number>;

interface RespostaProjecao {
  periodos: { key: string; label: string; base: string }[];
  projetado: Record<string, Valores>;
  anoAnterior: Record<string, Valores>;
  tipos: Record<string, 'receita' | 'variavel' | 'fixa' | 'manual'>;
  manuais?: { codigo: string; nome: string }[];
  parametros: {
    cenario: string; inflacao: number; inflacaoFixas: number; crescimentoReceita: number; adicionalOtimista: number;
    ipca: { valor: number; data: string | null; fonte: string }; baseInicio: string; baseFim: string;
  };
}

const CENARIOS: { chave: Cenario; titulo: string; descricao: string }[] = [
  { chave: 'pessimista', titulo: 'Pessimista', descricao: 'Igual ao ano anterior' },
  { chave: 'realista', titulo: 'Realista', descricao: 'Receita do ano anterior + inflação' },
  { chave: 'otimista', titulo: 'Otimista', descricao: 'Receita do ano anterior + inflação + 5%' },
  { chave: 'meta', titulo: 'Meta 10% de lucro', descricao: 'Crescimento sugerido para chegar a 10% de lucro' },
  { chave: 'equilibrio', titulo: 'Meta 0% de lucro', descricao: 'Crescimento sugerido para chegar ao ponto de equilíbrio (lucro zero)' },
  { chave: 'personalizado', titulo: 'Personalizado', descricao: 'Você define o crescimento da receita' },
];

// Totalizadores calculados pelo backend, na ordem em que aparecem depois de cada grupo.
const TOTALIZADOR_APOS: Record<string, { codigo: string; nome: string }> = {
  '02': { codigo: '03', nome: 'RECEITA LIQUIDA' },
  '04': { codigo: '05', nome: 'MARGEM CONTRIBUICAO' },
  '06': { codigo: '07', nome: 'LUCRO BRUTO' },
  '08': { codigo: '09', nome: 'LUCRO OPERACIONAL (EBITDA)' },
  '10': { codigo: '11', nome: 'LUCRO ANTES DO IR/CSLL' },
  '13': { codigo: '14', nome: 'LUCRO LIQUIDO' },
};
const CODIGOS_EXIBIDOS = new Set(['01', '02', '04', '06', '08', '10', '13']);

const NOMES_MES = ['', 'JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const CORES_NIVEL: Record<number, string> = { 1: 'bg-blue-100 font-bold', 2: 'bg-blue-50', 3: 'bg-white', 4: 'bg-white' };

// A/V: % sobre a receita liquida do periodo, com o sinal do valor (igual a DRE).
function av(valor: number, receitaLiquida: number): string {
  if (!receitaLiquida) return '-';
  const p = (Math.abs(valor) / Math.abs(receitaLiquida)) * 100;
  return `${(valor < 0 ? -p : p).toFixed(2)}%`;
}

// Projecao comeca no mes seguinte ao atual (o mes em andamento fica de fora).
function proximoMesISO() {
  const h = new Date();
  const d = new Date(h.getFullYear(), h.getMonth() + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Edicoes de A/V %: codigo da conta -> periodo (YYYY-MM) -> % sobre a receita liquida (com sinal, como na DRE).
type Edicoes = Record<string, Record<string, number>>;
const CHAVE_EDICOES = 'dre_projetada_edicoes_v1';
// Cada grupo alimenta estes totalizadores (cascata: margem -> lucro bruto -> EBITDA -> ... -> lucro liquido).
const CADEIA_TOTALIZADORES: Record<string, string[]> = {
  '04': ['05', '07', '09', '11', '14'],
  '06': ['07', '09', '11', '14'],
  '08': ['09', '11', '14'],
  '10': ['11', '14'],
  '13': ['14'],
};

const fmtPctTxt = (n: number) => n.toFixed(2).replace('.', ',');

// Celula de A/V % editavel: clique para digitar o novo percentual (Enter aplica, Esc cancela, vazio desfaz a edicao).
function CelulaPct({ texto, pctAtual, editado, onCommit, className, titulo }: {
  texto: string; pctAtual: number | null; editado: boolean; onCommit: (txt: string) => void; className: string; titulo: string;
}) {
  const [editando, setEditando] = useState(false);
  const [txt, setTxt] = useState('');
  const confirmar = () => { setEditando(false); onCommit(txt); };
  return (
    <td
      className={`${className} ${editado ? 'bg-yellow-100 font-semibold ring-1 ring-inset ring-yellow-400' : ''} ${editando ? '' : 'cursor-pointer hover:bg-yellow-50'}`}
      title={editado ? `${titulo} (editado - apague o valor para desfazer)` : titulo}
      onClick={() => { if (!editando) { setTxt(pctAtual === null ? '' : fmtPctTxt(pctAtual)); setEditando(true); } }}
    >
      {editando ? (
        <input
          autoFocus
          value={txt}
          onChange={(e) => setTxt(e.target.value)}
          onBlur={confirmar}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirmar();
            if (e.key === 'Escape') setEditando(false);
          }}
          className="w-16 px-1 py-0.5 text-right text-xs border border-yellow-500 rounded bg-white text-black"
        />
      ) : texto}
    </td>
  );
}


type LinhaTabela = { conta: ContaDRE | { codigo: string; nome: string; nivel: number; tipo: 'resultado' }; profundidade: number };
interface OrcamentoResumo {
  id: number; nome: string; filtro: string; inicio: string; cenario: string; qtdEdicoes: number;
  receitaLiquida: number; lucro: number; atualizadoEm: string | null;
}
interface RealizadoResp { periodos: string[]; fechados: string[]; abertos: string[]; realizado: Record<string, Valores> }

// Totalizadores do realizado calculados aqui (mesma regra da DRE), pra nao depender de quais o servidor devolve.
function completarTotalizadores(real: Record<string, Valores>, meses: string[]): Record<string, Valores> {
  const out: Record<string, Valores> = { ...real };
  const v = (c: string, m: string) => out[c]?.[m] ?? 0;
  const regras: [string, string, string][] = [['03', '01', '02'], ['05', '03', '04'], ['07', '05', '06'], ['09', '07', '08'], ['11', '09', '10'], ['14', '11', '13']];
  for (const [tot, a, b] of regras) {
    const linha: Valores = { total: 0 };
    for (const m of meses) { linha[m] = v(a, m) + v(b, m); linha.total += linha[m]; }
    out[tot] = linha;
  }
  return out;
}

const mesRotulo = (m: string) => `${NOMES_MES[parseInt(m.split('-')[1], 10)]}/${m.split('-')[0].slice(2)}`;
const corDif = (d: number) => (Math.abs(d) < 0.005 ? 'text-gray-500' : d > 0 ? 'text-green-700' : 'text-red-600');
const fmtDifPct = (real: number, proj: number) => (proj ? `${(((real - proj) / Math.abs(proj)) * 100).toFixed(1).replace('.', ',')}%` : '-');

// Projetado (ou orcamento) x realizado, acumulado nos meses escolhidos. Diferenca = realizado - projetado:
// positiva = favoravel (receita maior ou despesa menor, ja que despesa e negativa).
function ComparacaoRealizado({ linhas, abertos, alternar, projetado, real, fechados, de, ate, setDe, setAte }: {
  linhas: LinhaTabela[]; abertos: Set<string>; alternar: (c: string) => void; projetado: Record<string, Valores>;
  real: Record<string, Valores>; fechados: string[]; de: string; ate: string; setDe: (m: string) => void; setAte: (m: string) => void;
}) {
  const meses = fechados.filter((m) => m >= de && m <= ate);
  const soma = (d: Record<string, Valores>, c: string) => meses.reduce((s, m) => s + (d[c]?.[m] ?? 0), 0);
  const recP = soma(projetado, '03');
  const recR = soma(real, '03');
  const cartoes: { cod: string; titulo: string }[] = [
    { cod: '03', titulo: 'Receita líquida' }, { cod: '09', titulo: 'EBITDA' }, { cod: '14', titulo: 'Lucro líquido' },
  ];
  if (fechados.length === 0) {
    return <div className="p-6 text-sm text-gray-700">Nenhum mês deste período já fechou, então ainda não há realizado para comparar.</div>;
  }
  return (
    <div>
      <div className="px-5 py-3 border-b border-gray-200 flex flex-wrap items-center gap-3 text-sm text-black">
        <span className="font-semibold">Meses comparados:</span>
        <select value={de} onChange={(e) => { setDe(e.target.value); if (e.target.value > ate) setAte(e.target.value); }} className="px-2 py-1 border border-gray-300 rounded bg-white">
          {fechados.map((m) => <option key={m} value={m}>{mesRotulo(m)}</option>)}
        </select>
        <span>até</span>
        <select value={ate} onChange={(e) => { setAte(e.target.value); if (e.target.value < de) setDe(e.target.value); }} className="px-2 py-1 border border-gray-300 rounded bg-white">
          {fechados.map((m) => <option key={m} value={m}>{mesRotulo(m)}</option>)}
        </select>
        <span className="text-xs text-gray-600">Só meses já fechados entram. Diferença = realizado − projetado (positiva = favorável).</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-5">
        {cartoes.map(({ cod, titulo }) => {
          const p = soma(projetado, cod); const r = soma(real, cod); const d = r - p;
          return (
            <div key={cod} className="rounded-lg border border-gray-200 p-3">
              <div className="text-xs font-semibold text-black uppercase">{titulo}</div>
              <div className="mt-1 text-xs text-black">Projetado <strong>{formatarValor(p)}</strong></div>
              <div className="text-xs text-black">Realizado <strong>{formatarValor(r)}</strong></div>
              <div className={`mt-1 text-sm font-bold ${corDif(d)}`}>{formatarValor(d)} ({fmtDifPct(r, p)})</div>
            </div>
          );
        })}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-gray-100 text-black text-xs">
              <th className="px-4 py-2 text-left sticky left-0 bg-gray-100 z-20 min-w-[320px]">CONTA</th>
              <th className="px-3 py-2 text-right">PROJETADO</th>
              <th className="px-3 py-2 text-right">A/V %</th>
              <th className="px-3 py-2 text-right">REALIZADO</th>
              <th className="px-3 py-2 text-right">A/V %</th>
              <th className="px-3 py-2 text-right">DIFERENÇA</th>
              <th className="px-3 py-2 text-right">DIF. %</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map(({ conta, profundidade }) => {
              const resultado = conta.tipo === 'resultado';
              const filhos = 'filhos' in conta ? conta.filhos : undefined;
              const temFilhos = !!filhos?.length;
              const p = soma(projetado, conta.codigo);
              const r = soma(real, conta.codigo);
              const d = r - p;
              const cor = resultado ? 'bg-green-50 font-bold' : CORES_NIVEL[Math.min(profundidade + 1, 4)];
              return (
                <tr key={conta.codigo} className={`${cor} text-black hover:bg-gray-100`}>
                  <td className="px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10">
                    <div className="flex items-center gap-2" style={{ paddingLeft: `${profundidade * 16}px` }}>
                      {temFilhos ? (
                        <button onClick={() => alternar(conta.codigo)}>{abertos.has(conta.codigo) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button>
                      ) : <div className="w-4" />}
                      {!resultado && <span className="font-mono text-xs">{conta.codigo}</span>}
                      <span className="text-sm">{conta.nome}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 border-b border-gray-200 text-right text-sm">{formatarValor(p)}</td>
                  <td className="px-3 py-2 border-b border-gray-200 text-right text-xs">{av(p, recP)}</td>
                  <td className="px-3 py-2 border-b border-gray-200 text-right text-sm">{formatarValor(r)}</td>
                  <td className="px-3 py-2 border-b border-gray-200 text-right text-xs">{av(r, recR)}</td>
                  <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-semibold ${corDif(d)}`}>{formatarValor(d)}</td>
                  <td className={`px-3 py-2 border-b border-gray-200 text-right text-xs ${corDif(d)}`}>{fmtDifPct(r, p)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto border-t border-gray-200">
        <table className="w-full border-collapse text-black">
          <thead>
            <tr className="bg-gray-100 text-xs">
              <th className="px-4 py-2 text-left">MÊS</th>
              <th className="px-3 py-2 text-right">REC. LÍQ. PROJ.</th>
              <th className="px-3 py-2 text-right">REC. LÍQ. REAL.</th>
              <th className="px-3 py-2 text-right">DIF.</th>
              <th className="px-3 py-2 text-right">LUCRO PROJ.</th>
              <th className="px-3 py-2 text-right">LUCRO REAL.</th>
              <th className="px-3 py-2 text-right">DIF.</th>
            </tr>
          </thead>
          <tbody>
            {meses.map((m) => {
              const rp = projetado['03']?.[m] ?? 0; const rr = real['03']?.[m] ?? 0;
              const lp = projetado['14']?.[m] ?? 0; const lr = real['14']?.[m] ?? 0;
              return (
                <tr key={m} className="border-t border-gray-100 text-sm">
                  <td className="px-4 py-1.5 font-semibold">{mesRotulo(m)}</td>
                  <td className="px-3 py-1.5 text-right">{formatarValor(rp)}</td>
                  <td className="px-3 py-1.5 text-right">{formatarValor(rr)}</td>
                  <td className={`px-3 py-1.5 text-right ${corDif(rr - rp)}`}>{formatarValor(rr - rp)}</td>
                  <td className="px-3 py-1.5 text-right">{formatarValor(lp)}</td>
                  <td className="px-3 py-1.5 text-right">{formatarValor(lr)}</td>
                  <td className={`px-3 py-1.5 text-right ${corDif(lr - lp)}`}>{formatarValor(lr - lp)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ResumoCenario { receitaLiquida: number; lucro: number; percentual: number | null }
interface ResumoEmpresa {
  filtro: string; nome: string; carregando: boolean; erro?: string;
  anoAnterior?: ResumoCenario; cenarios?: Record<string, ResumoCenario>; crescimentoNecessario?: number | null; receitaNecessaria?: number | null; crescimentoNecessario0?: number | null; receitaNecessaria0?: number | null;
}

export default function DreProjetadaPage() {
  const [cenario, setCenario] = useState<Cenario>('realista');
  const [inicio, setInicio] = useState(proximoMesISO());
  const [inflacaoTxt, setInflacaoTxt] = useState('');
  const [crescimentoTxt, setCrescimentoTxt] = useState('');
  const [filtro, setFiltro] = useState('consolidado');
  const [lojas, setLojas] = useState<{ valor: string; label: string }[]>([]);
  const [dados, setDados] = useState<RespostaProjecao | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [comparar, setComparar] = useState(false);
  const [filtroAberto, setFiltroAberto] = useState(false);
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [resumo, setResumo] = useState<ResumoEmpresa[] | null>(null);
  const execResumo = useRef(0);
  const [semGerente, setSemGerente] = useState(false);
  const montou = useRef(false);
  // Orcamentos salvos (valores congelados da projecao) e comparacao com o realizado
  const [orcamentos, setOrcamentos] = useState<OrcamentoResumo[]>([]);
  const [orcamentoAtivo, setOrcamentoAtivo] = useState<{ id: number; nome: string } | null>(null);
  const [orcamentosAberto, setOrcamentosAberto] = useState(false);
  const [nomeNovoOrc, setNomeNovoOrc] = useState('');
  const [salvandoOrc, setSalvandoOrc] = useState(false);
  const [msgOrc, setMsgOrc] = useState<string | null>(null);
  const [comparacao, setComparacao] = useState(false);
  const [realizadoResp, setRealizadoResp] = useState<(RealizadoResp & { chave: string }) | null>(null);
  const [carregandoReal, setCarregandoReal] = useState(false);
  const [erroReal, setErroReal] = useState<string | null>(null);
  const [compDe, setCompDe] = useState('');
  const [compAte, setCompAte] = useState('');

  const buscar = useCallback(async (forcar = false) => {
    setCarregando(true);
    setErro(null);
    setOrcamentoAtivo(null);
    try {
      const params = new URLSearchParams({ inicio, cenario, filtro });
      const infl = Number(inflacaoTxt.replace(',', '.'));
      if (inflacaoTxt.trim() !== '' && !Number.isNaN(infl)) params.set('inflacao', String(infl));
      const cresc = Number(crescimentoTxt.replace(',', '.'));
      if (cenario === 'personalizado' && crescimentoTxt.trim() !== '' && !Number.isNaN(cresc)) params.set('crescimentoReceita', String(cresc));
      if (semGerente) params.set('semGerente', 'true');
      if (forcar) params.set('forcar', 'true');
      const resp = await fetch(`/api/dre-projetada?${params.toString()}`, { cache: 'no-store' });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.detail || json.error || 'Erro ao buscar a DRE projetada');
      setDados(json);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro desconhecido');
    } finally {
      setCarregando(false);
    }
  }, [inicio, cenario, filtro, inflacaoTxt, crescimentoTxt, semGerente]);

  const buscarResumo = useCallback(async (forcar = false) => {
    const id = ++execResumo.current;
    const todas = [
      { filtro: 'consolidado', nome: 'CONSOLIDADO (TODAS)' },
      { filtro: 'fabrica', nome: 'FABRICA' },
      ...lojas.map((l) => ({ filtro: l.valor, nome: l.label })),
    ];
    // O resumo acompanha o filtro da tela: consolidado = todas as empresas;
    // senao so a fabrica ou as lojas selecionadas.
    const selecionadas = filtro.split(',');
    const empresas = filtro === 'consolidado' ? todas : todas.filter((e) => selecionadas.includes(e.filtro));
    setResumo(empresas.map((e) => ({ ...e, carregando: true })));
    const personalizado = cenario === 'personalizado' ? Number(crescimentoTxt.replace(',', '.')) : NaN;
    // 4 empresas por vez (o backend ainda calcula uma base pesada de cada vez,
    // entao o ganho maior vem do cache pre-aquecido)
    const fila = [...empresas];
    const processar = async () => {
    for (let e = fila.shift(); e; e = fila.shift()) {
      if (id !== execResumo.current) return;
      let novo: Partial<ResumoEmpresa>;
      try {
        const params = new URLSearchParams({ inicio, filtro: e.filtro });
        const infl = Number(inflacaoTxt.replace(',', '.'));
        if (inflacaoTxt.trim() !== '' && !Number.isNaN(infl)) params.set('inflacao', String(infl));
        if (!Number.isNaN(personalizado) && crescimentoTxt.trim() !== '') params.set('crescimentoReceita', String(personalizado));
        if (semGerente) params.set('semGerente', 'true');
        if (forcar) params.set('forcar', 'true');
        const resp = await fetch(`/api/dre-projetada/resumo?${params.toString()}`, { cache: 'no-store' });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.detail || json.error || 'Erro');
        novo = { anoAnterior: json.anoAnterior, cenarios: json.cenarios, crescimentoNecessario: json.crescimentoNecessario, receitaNecessaria: json.receitaNecessaria, crescimentoNecessario0: json.crescimentoNecessario0, receitaNecessaria0: json.receitaNecessaria0, carregando: false };
      } catch (err) {
        novo = { carregando: false, erro: err instanceof Error ? err.message : 'Erro' };
      }
      if (id !== execResumo.current) return;
      const filtroAtual = e.filtro;
      setResumo((prev) => prev && prev.map((r) => (r.filtro === filtroAtual ? { ...r, ...novo } : r)));
    }
    };
    await Promise.all(Array.from({ length: 4 }, processar));
  }, [inicio, cenario, filtro, inflacaoTxt, crescimentoTxt, lojas, semGerente]);

  // Recalcula ao marcar/desmarcar o gerente (so depois da primeira consulta)
  useEffect(() => {
    if (!montou.current) { montou.current = true; return; }
    if (dados || resumo) { buscar(); buscarResumo(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semGerente]);

  useEffect(() => {
    fetch('/api/dre/centros-custo', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setLojas((d.opcoes || []).filter((o: { tipo: string }) => o.tipo === 'loja')))
      .catch((e) => console.error('Erro ao buscar centros de custo:', e));
  }, []);

  function alternar(codigo: string) {
    setAbertos((prev) => {
      const n = new Set(prev);
      if (n.has(codigo)) n.delete(codigo); else n.add(codigo);
      return n;
    });
  }

  const linhas = useMemo(() => {
    if (!dados) return [] as { conta: ContaDRE | { codigo: string; nome: string; nivel: number; tipo: 'resultado' }; profundidade: number }[];
    const saida: { conta: ContaDRE | { codigo: string; nome: string; nivel: number; tipo: 'resultado' }; profundidade: number }[] = [];
    const percorrer = (c: ContaDRE, prof: number) => {
      if (!dados.projetado[c.codigo] && !dados.anoAnterior[c.codigo]) return;
      saida.push({ conta: c, profundidade: prof });
      if (c.filhos && abertos.has(c.codigo)) {
        c.filhos.forEach((f) => percorrer(f, prof + 1));
        // linhas projetadas manualmente (sem base no ano anterior) dentro do grupo
        (dados.manuais || []).filter((m) => m.codigo.startsWith(c.codigo + '.') && m.codigo.split('.').length === c.codigo.split('.').length + 1)
          .forEach((m) => saida.push({ conta: { codigo: m.codigo, nome: m.nome, nivel: 3, tipo: 'conta' } as ContaDRE, profundidade: prof + 1 }));
      }
    };
    for (const c of PLANO_CONTAS_DRE_FABRICA) {
      if (!CODIGOS_EXIBIDOS.has(c.codigo)) continue;
      percorrer(c, 0);
      const t = TOTALIZADOR_APOS[c.codigo];
      if (t) saida.push({ conta: { ...t, nivel: 1, tipo: 'resultado' }, profundidade: 0 });
    }
    return saida;
  }, [dados, abertos]);

  const p = dados?.parametros;
  const periodos = dados?.periodos ?? [];
  const recLiqPeriodo = (key: string) => dados?.projetado['03']?.[key] ?? 0;
  const recLiqTotal = dados?.projetado['03']?.total ?? 0;
  // ── Edicao de A/V % no ultimo nivel: recalcula grupos, totalizadores e lucro na propria tela ──
  const [edicoesPorChave, setEdicoesPorChave] = useState<Record<string, Edicoes>>({});
  const edicoesCarregadas = useRef(false);
  useEffect(() => {
    try { const bruto = localStorage.getItem(CHAVE_EDICOES); if (bruto) setEdicoesPorChave(JSON.parse(bruto)); } catch { /* sem edicoes salvas */ }
    edicoesCarregadas.current = true;
  }, []);
  useEffect(() => {
    if (!edicoesCarregadas.current) return;
    try { localStorage.setItem(CHAVE_EDICOES, JSON.stringify(edicoesPorChave)); } catch { /* segue sem salvar */ }
  }, [edicoesPorChave]);
  const chaveEdicoes = orcamentoAtivo ? `orc:${orcamentoAtivo.id}` : `${filtro}|${inicio}`;
  const edicoes = useMemo<Edicoes>(() => edicoesPorChave[chaveEdicoes] ?? {}, [edicoesPorChave, chaveEdicoes]);
  const qtdEdicoes = Object.values(edicoes).reduce((n, o) => n + Object.keys(o).length, 0);

  const projetadoEd = useMemo(() => {
    if (!dados) return {} as Record<string, Valores>;
    const base = dados.projetado;
    if (qtdEdicoes === 0) return base;
    const out: Record<string, Valores> = {};
    const obter = (c: string) => (out[c] ??= { ...(base[c] ?? { total: 0 }) });
    for (const [cod, porPeriodo] of Object.entries(edicoes)) {
      const partes = cod.split('.');
      for (const [per, pct] of Object.entries(porPeriodo)) {
        const rec = Math.abs(base['03']?.[per] ?? 0);
        const novo = (pct / 100) * rec;
        const delta = novo - (base[cod]?.[per] ?? 0);
        if (!delta) continue;
        const somar = (c: string) => { const l = obter(c); l[per] = (l[per] ?? 0) + delta; l.total = (l.total ?? 0) + delta; };
        somar(cod);
        for (let n = 1; n < partes.length; n++) somar(partes.slice(0, n).join('.'));
        (CADEIA_TOTALIZADORES[partes[0]] ?? []).forEach(somar);
      }
    }
    return { ...base, ...out };
  }, [dados, edicoes, qtdEdicoes]);

  // Aplica o texto digitado a um ou mais periodos da conta. O sinal segue o da linha (despesa continua negativa).
  function editarPct(codigo: string, periodosAlvo: string[], texto: string) {
    if (!dados) return;
    const limpo = texto.trim();
    const numero = Number(limpo.replace(',', '.'));
    setEdicoesPorChave((prev) => {
      const atuais: Edicoes = { ...(prev[chaveEdicoes] ?? {}) };
      const linha = { ...(atuais[codigo] ?? {}) };
      for (const per of periodosAlvo) {
        if (limpo === '') { delete linha[per]; continue; }
        if (Number.isNaN(numero)) continue;
        const original = dados.projetado[codigo]?.[per] ?? 0;
        const sinal = original !== 0 ? Math.sign(original) : (dados.anoAnterior[codigo]?.[per] ?? 0) !== 0 ? Math.sign(dados.anoAnterior[codigo][per]) : (numero < 0 ? -1 : 1);
        const rec = Math.abs(dados.projetado['03']?.[per] ?? 0);
        const pctOriginal = rec ? (Math.abs(original) / rec) * 100 : 0;
        const pctNovo = Math.abs(numero);
        if (Math.abs(pctNovo - pctOriginal) < 0.005) delete linha[per]; else linha[per] = sinal * pctNovo;
      }
      if (Object.keys(linha).length) atuais[codigo] = linha; else delete atuais[codigo];
      return { ...prev, [chaveEdicoes]: atuais };
    });
  }
  function restaurarEdicoes() {
    setEdicoesPorChave((prev) => { const n = { ...prev }; delete n[chaveEdicoes]; return n; });
  }

  // ── Orcamentos salvos ──
  const listarOrcamentos = useCallback(async () => {
    try {
      const r = await fetch('/api/dre-projetada/orcamentos', { cache: 'no-store' });
      const j = await r.json();
      if (r.ok && Array.isArray(j.orcamentos)) setOrcamentos(j.orcamentos);
    } catch (e) { console.error('Erro ao listar orçamentos:', e); }
  }, []);
  useEffect(() => { listarOrcamentos(); }, [listarOrcamentos]);

  const arred = (o: Record<string, Valores>) => {
    const r: Record<string, Valores> = {};
    for (const [c, l] of Object.entries(o)) { r[c] = {}; for (const [k, v] of Object.entries(l)) r[c][k] = Math.round(v * 100) / 100; }
    return r;
  };

  async function salvarOrcamento(modo: 'novo' | 'atualizar') {
    if (!dados) return;
    const nome = modo === 'atualizar' && orcamentoAtivo ? orcamentoAtivo.nome : nomeNovoOrc.trim();
    if (!nome) { setMsgOrc('Informe o nome do orçamento.'); return; }
    setSalvandoOrc(true);
    setMsgOrc(null);
    try {
      const corpo = {
        nome, filtro: dados.parametros && (dados.parametros as { filtro?: string }).filtro ? (dados.parametros as { filtro?: string }).filtro : filtro,
        inicio: dados.periodos[0]?.key ?? inicio, cenario,
        parametros: { ...dados.parametros, semGerente, orcamentoBase: cenario },
        periodos: dados.periodos, valores: arred(projetadoEd), anoAnterior: arred(dados.anoAnterior),
        tipos: dados.tipos, manuais: dados.manuais ?? [], qtdEdicoes,
      };
      const atualizando = modo === 'atualizar' && orcamentoAtivo;
      const r = await fetch(atualizando ? `/api/dre-projetada/orcamentos/${orcamentoAtivo!.id}` : '/api/dre-projetada/orcamentos', {
        method: atualizando ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || 'Erro ao salvar o orçamento');
      const id = atualizando ? orcamentoAtivo!.id : j.id;
      setMsgOrc(atualizando ? 'Orçamento atualizado.' : 'Orçamento salvo.');
      setNomeNovoOrc('');
      await listarOrcamentos();
      await carregarOrcamento(id, true);
    } catch (e) {
      setMsgOrc(e instanceof Error ? e.message : 'Erro ao salvar o orçamento');
    } finally {
      setSalvandoOrc(false);
    }
  }

  async function carregarOrcamento(id: number, mantemMensagem = false) {
    if (!mantemMensagem) setMsgOrc(null);
    setCarregando(true);
    try {
      const r = await fetch(`/api/dre-projetada/orcamentos/${id}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || 'Erro ao abrir o orçamento');
      setFiltro(j.filtro);
      setInicio(j.inicio);
      if (CENARIOS.some((c) => c.chave === j.cenario)) setCenario(j.cenario as Cenario);
      setEdicoesPorChave((prev) => { const n = { ...prev }; delete n[`orc:${id}`]; return n; });
      setOrcamentoAtivo({ id, nome: j.nome });
      setRealizadoResp(null);
      setDados({ periodos: j.periodos, projetado: j.valores, anoAnterior: j.anoAnterior, tipos: j.tipos, manuais: j.manuais, parametros: j.parametros });
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao abrir o orçamento');
    } finally {
      setCarregando(false);
    }
  }

  async function excluirOrcamento(id: number, nome: string) {
    if (!window.confirm(`Excluir o orçamento "${nome}"?`)) return;
    try {
      await fetch(`/api/dre-projetada/orcamentos/${id}`, { method: 'DELETE' });
      if (orcamentoAtivo?.id === id) setOrcamentoAtivo(null);
      await listarOrcamentos();
    } catch (e) { console.error('Erro ao excluir orçamento:', e); }
  }

  // ── Comparacao com o realizado ──
  const filtroDosDados = (dados?.parametros as { filtro?: string } | undefined)?.filtro ?? filtro;
  const chaveReal = dados ? `${dados.periodos[0]?.key}|${filtroDosDados}` : '';
  const buscarRealizado = useCallback(async (forcar = false) => {
    if (!dados) return;
    setCarregandoReal(true);
    setErroReal(null);
    try {
      const params = new URLSearchParams({ inicio: dados.periodos[0].key, filtro: filtroDosDados });
      if (forcar) params.set('forcar', 'true');
      const r = await fetch(`/api/dre-projetada/realizado?${params.toString()}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || 'Erro ao buscar o realizado');
      setRealizadoResp({ ...j, chave: `${dados.periodos[0].key}|${filtroDosDados}` });
      const f: string[] = j.fechados ?? [];
      setCompDe(f[0] ?? ''); setCompAte(f[f.length - 1] ?? '');
    } catch (e) {
      setErroReal(e instanceof Error ? e.message : 'Erro ao buscar o realizado');
    } finally {
      setCarregandoReal(false);
    }
  }, [dados, filtroDosDados]);
  useEffect(() => {
    if (comparacao && dados && (!realizadoResp || realizadoResp.chave !== chaveReal) && !carregandoReal && !erroReal) buscarRealizado();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparacao, chaveReal, realizadoResp]);
  useEffect(() => { setErroReal(null); }, [chaveReal]);
  const realizadoCompleto = useMemo(
    () => (realizadoResp && realizadoResp.chave === chaveReal ? completarTotalizadores(realizadoResp.realizado, realizadoResp.fechados) : null),
    [realizadoResp, chaveReal],
  );
  const gruposPorAno = useMemo(() => {
    const g: { ano: string; qtd: number }[] = [];
    for (const per of periodos) {
      const ano = per.key.split('-')[0];
      const ult = g[g.length - 1];
      if (ult && ult.ano === ano) ult.qtd++; else g.push({ ano, qtd: 1 });
    }
    return g;
  }, [periodos]);

  const corTexto = (v: number) => (v < 0 ? 'text-red-600' : '');

  const fimProjecao = (() => {
    const [a, m] = inicio.split('-').map(Number);
    const d = new Date(a, m - 1 + 12, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const lojasSelecionadas = filtro.includes(',') || lojas.some((l) => l.valor === filtro) ? filtro.split(',') : [];
  const filtroLabel =
    filtro === 'consolidado' ? 'CONSOLIDADO (TODAS)'
    : filtro === 'fabrica' ? 'FABRICA'
    : lojasSelecionadas.length === 1 ? (lojas.find((l) => l.valor === lojasSelecionadas[0])?.label || filtro)
    : `${lojasSelecionadas.length} LOJAS`;
  function alternarLoja(valor: string) {
    const novas = lojasSelecionadas.includes(valor) ? lojasSelecionadas.filter((v) => v !== valor) : [...lojasSelecionadas, valor];
    setFiltro(novas.length ? novas.join(',') : 'consolidado');
  }
  function escolher(valor: string) { setFiltro(valor); setFiltroAberto(false); }
  const anosTitulo = periodos.length > 0
    ? (() => { const a1 = periodos[0].key.split('-')[0]; const a2 = periodos[periodos.length - 1].key.split('-')[0]; return a1 === a2 ? a1 : `${a1}-${a2}`; })()
    : '';

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <TrendingUp className="w-8 h-8 text-green-600" />
            <div>
              <h1 className="text-3xl font-bold text-brand-dark">DRE Projetada - {filtroLabel}</h1>
              <p className="text-gray-600">Projeção do Resultado dos próximos 12 meses</p>
              {p && (
                <p className="text-xs text-gray-400 mt-1">
                  Base: mesmo mês do calendário, sempre de meses fechados ({p.baseInicio.split('-').reverse().join('/')} a {p.baseFim.split('-').reverse().join('/')}).
                  Receita por crescimento %; variáveis mantêm o % sobre a receita; fixas repetem o valor do ano anterior (fixo/variável da classificação da DRE).
                </p>
              )}
            </div>
          </div>

          {/* Filtro */}
          <div className="flex items-center gap-3">
            <Filter className="w-5 h-5 text-gray-500" />
            <div className="relative">
              <button
                type="button"
                onClick={() => setFiltroAberto((aberto) => !aberto)}
                className="min-w-[280px] max-w-[360px] flex items-center justify-between gap-2 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white hover:bg-gray-50"
              >
                <span className="truncate text-left">{filtroLabel}</span>
                <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
              </button>
              {filtroAberto && (
                <div className="absolute right-0 z-40 mt-2 w-[320px] max-h-[420px] overflow-auto rounded-lg border border-gray-200 bg-white shadow-xl">
                  <div className="border-b border-gray-100 p-2 space-y-1">
                    <button type="button" onClick={() => escolher('consolidado')} className={`w-full text-left px-3 py-2 rounded-md text-sm ${filtro === 'consolidado' ? 'bg-green-50 text-green-800 font-semibold' : 'hover:bg-gray-50 text-gray-700'}`}>CONSOLIDADO (TODAS)</button>
                    <button type="button" onClick={() => escolher('fabrica')} className={`w-full text-left px-3 py-2 rounded-md text-sm ${filtro === 'fabrica' ? 'bg-blue-50 text-blue-800 font-semibold' : 'hover:bg-gray-50 text-gray-700'}`}>FABRICA</button>
                  </div>
                  <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-gray-100 bg-white px-3 py-2">
                    <span className="text-xs font-semibold text-gray-500 uppercase">Lojas</span>
                    <div className="flex items-center gap-3">
                      <button type="button" onClick={() => setFiltro(lojas.map((l) => l.valor).join(','))} className="text-xs font-medium text-purple-700 hover:text-purple-900">Todas</button>
                      <button type="button" onClick={() => setFiltro('consolidado')} className="text-xs font-medium text-gray-600 hover:text-gray-900">Limpar</button>
                    </div>
                  </div>
                  <div className="py-1">
                    {lojas.map((l) => (
                      <label key={l.valor} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                        <input type="checkbox" checked={lojasSelecionadas.includes(l.valor)} onChange={() => alternarLoja(l.valor)} className="rounded border-gray-300" />
                        <span>{l.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Cenario e parametros */}
      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Cenário e período</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-2 mb-3">
          {CENARIOS.map((c) => (
            <button
              key={c.chave}
              onClick={() => setCenario(c.chave)}
              className={`text-left rounded-md border px-3 py-2 ${cenario === c.chave ? 'border-green-600 bg-green-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
            >
              <div className="text-sm font-semibold text-gray-800">{c.titulo}</div>
              <div className="text-xs text-gray-600">{c.descricao}</div>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="date"
            value={`${inicio}-01`}
            onChange={(e) => e.target.value && setInicio(e.target.value.slice(0, 7))}
            title="A projeção sempre começa no dia 1 do mês escolhido"
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
          <span className="text-gray-500">ate</span>
          <input
            type="date"
            value={fimProjecao}
            readOnly
            title="12 meses a partir do primeiro mês"
            className="px-3 py-2 text-sm border border-gray-300 rounded-md bg-gray-50 text-gray-700 cursor-default"
          />
          <span className="text-gray-500 ml-2">Inflação da receita (% a.a.)</span>
          <input
            value={inflacaoTxt}
            onChange={(e) => setInflacaoTxt(e.target.value)}
            placeholder={p ? String(p.ipca.valor).replace('.', ',') : ''}
            className="w-24 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
          {cenario === 'personalizado' && (
            <>
              <span className="text-gray-500">Crescimento da receita (%)</span>
              <input
                value={crescimentoTxt}
                onChange={(e) => setCrescimentoTxt(e.target.value)}
                className="w-24 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
              />
            </>
          )}
          <button
            onClick={() => { buscar(); buscarResumo(); }}
            disabled={carregando}
            className="px-5 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {carregando ? 'Carregando...' : 'Consultar'}
          </button>
          <button
            onClick={() => { buscar(true); buscarResumo(true); }}
            disabled={carregando}
            title="Atualizar dados (ignora o cache e busca de novo)"
            className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
          </button>
          {p && (
            <span className="text-xs text-gray-600">
              Em uso: receita <b>{p.crescimentoReceita.toFixed(2).replace('.', ',')}%</b>
              {' '}· {p.ipca.fonte}: {p.ipca.valor.toFixed(2).replace('.', ',')}%{p.ipca.data ? ` (${p.ipca.data})` : ''}
            </span>
          )}
        </div>
        {erro && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{erro}</div>}
      </div>

      {resumo && (
        <div className="bg-white rounded-xl shadow-lg overflow-hidden border border-gray-200 mb-6">
          <div className="p-4 border-b-2 bg-gradient-to-r from-green-50 to-green-100 border-green-200">
            <h2 className="text-lg font-bold text-gray-800">Resumo por empresa - Lucro líquido e % sobre a receita líquida</h2>
            <p className="text-xs text-gray-600 mt-1">Total dos 12 meses projetados em cada cenário, comparado ao ano anterior.</p>
            <label className="mt-2 inline-flex items-center gap-2 text-sm text-gray-800 cursor-pointer" title="Vale para o E-COMMERCE e para o consolidado/lojas que o incluem">
              <input type="checkbox" checked={semGerente} onChange={(e) => setSemGerente(e.target.checked)} className="h-4 w-4 accent-green-600" />
              Desconsiderar o salário completo do gerente (R$ 13.000/mês no e-commerce)
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-700">
                  <th className="px-3 py-2 text-left border-b border-gray-200">Empresa</th>
                  {[['anterior', 'Ano anterior'], ['pessimista', 'Pessimista'], ['realista', 'Realista'], ['otimista', 'Otimista'], ['meta', 'Meta 10%'], ['equilibrio', 'Meta 0%'], ...(cenario === 'personalizado' && crescimentoTxt.trim() !== '' ? [['personalizado', 'Personalizado']] : [])].map(([k, t]) => (
                    <th key={k} className="px-3 py-2 text-right border-b border-gray-200" colSpan={1}>{t}</th>
                  ))}
                  <th className="px-3 py-2 text-right border-b border-gray-200 bg-amber-50" title="Crescimento da receita, além da inflação, para chegar a 10% de lucro líquido (fixas constantes, variáveis crescem com a venda)">Crescimento após inflação p/ 10% de lucro</th>
                  <th className="px-3 py-2 text-right border-b border-gray-200 bg-amber-50" title="Receita líquida dos 12 meses necessária para 10% de lucro (já com a inflação)">Receita líquida necessária (12 meses)</th>
                  <th className="px-3 py-2 text-right border-b border-gray-200 bg-amber-50" title="Receita líquida necessária dividida por 12">Média mensal necessária</th>
                  <th className="px-3 py-2 text-right border-b border-gray-200 bg-emerald-50" title="Crescimento da receita, além da inflação, para chegar a lucro zero (ponto de equilíbrio) (fixas constantes, variáveis crescem com a venda)">Crescimento após inflação p/ 0% de lucro</th>
                  <th className="px-3 py-2 text-right border-b border-gray-200 bg-emerald-50" title="Receita líquida dos 12 meses necessária para lucro zero (já com a inflação)">Receita líquida necessária (12 meses)</th>
                  <th className="px-3 py-2 text-right border-b border-gray-200 bg-emerald-50" title="Receita líquida necessária dividida por 12">Média mensal necessária</th>
                </tr>
              </thead>
              <tbody>
                {resumo.map((r) => {
                  const colunas: [string, ResumoCenario | undefined][] = [
                    ['anterior', r.anoAnterior],
                    ...['pessimista', 'realista', 'otimista', 'meta', 'equilibrio', 'personalizado']
                      .filter((k) => cenario === 'personalizado' || k !== 'personalizado')
                      .map((k) => [k, r.cenarios?.[k]] as [string, ResumoCenario | undefined]),
                  ].filter(([k]) => k !== 'personalizado' || crescimentoTxt.trim() !== '') as [string, ResumoCenario | undefined][];
                  return (
                    <tr key={r.filtro} className="hover:bg-gray-50">
                      <td className="px-3 py-2 border-b border-gray-200 font-medium text-gray-800">{r.nome}</td>
                      {colunas.map(([k, c]) => (
                        <td key={k} className={`px-3 py-2 border-b border-gray-200 text-right ${k === 'anterior' ? 'bg-gray-100' : ''} ${c && c.lucro < 0 ? 'text-red-600' : ''}`}>
                          {r.carregando ? <RefreshCw className="w-3.5 h-3.5 animate-spin inline text-gray-400" />
                            : r.erro ? <span className="text-xs text-red-600" title={r.erro}>erro</span>
                            : c ? (<><div className="font-semibold">{formatarValor(c.lucro)}</div><div className="text-xs">{c.percentual === null ? '-' : `${c.percentual.toFixed(2).replace('.', ',')}%`}</div></>)
                            : '-'}
                        </td>
                      ))}
                      <td className="px-3 py-2 border-b border-gray-200 text-right font-semibold bg-amber-50">
                        {r.carregando ? <RefreshCw className="w-3.5 h-3.5 animate-spin inline text-gray-400" />
                          : r.erro ? '-'
                          : r.crescimentoNecessario === undefined ? '-'
                          : r.crescimentoNecessario === null ? <span className="text-xs font-normal text-red-600" title="Só com venda não chega à meta">não atinge</span>
                          : r.crescimentoNecessario === 0 ? <span className="text-green-700">0% (já tem)</span>
                          : `+${r.crescimentoNecessario.toFixed(2).replace('.', ',')}%`}
                      </td>
                      {[1, 12].map((div) => (
                        <td key={div} className="px-3 py-2 border-b border-gray-200 text-right bg-amber-50">
                          {r.carregando ? <RefreshCw className="w-3.5 h-3.5 animate-spin inline text-gray-400" />
                            : r.receitaNecessaria == null ? '-'
                            : formatarValor(r.receitaNecessaria / div)}
                        </td>
                      ))}
                      <td className="px-3 py-2 border-b border-gray-200 text-right font-semibold bg-emerald-50">
                        {r.carregando ? <RefreshCw className="w-3.5 h-3.5 animate-spin inline text-gray-400" />
                          : r.erro ? '-'
                          : r.crescimentoNecessario0 === undefined ? '-'
                          : r.crescimentoNecessario0 === null ? <span className="text-xs font-normal text-red-600" title="Só com venda não chega à meta">não atinge</span>
                          : r.crescimentoNecessario0 === 0 ? <span className="text-green-700">0% (já tem)</span>
                          : `+${r.crescimentoNecessario0.toFixed(2).replace('.', ',')}%`}
                      </td>
                      {[1, 12].map((div) => (
                        <td key={`z${div}`} className="px-3 py-2 border-b border-gray-200 text-right bg-emerald-50">
                          {r.carregando ? <RefreshCw className="w-3.5 h-3.5 animate-spin inline text-gray-400" />
                            : r.receitaNecessaria0 == null ? '-'
                            : formatarValor(r.receitaNecessaria0 / div)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Orcamentos salvos */}
      <div className="bg-white rounded-lg shadow-md p-4 text-black">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-base font-semibold">Orçamentos salvos</h2>
          <button onClick={() => setOrcamentosAberto((v) => !v)} className="text-xs font-medium underline">
            {orcamentosAberto ? 'Recolher lista' : `Ver lista (${orcamentos.length})`}
          </button>
        </div>
        <p className="text-xs mt-1">Depois de editar os percentuais, salve o cenário como orçamento: os valores ficam congelados e podem ser comparados com o realizado (botão &quot;Projetado × Realizado&quot; acima da tabela).</p>
        {dados && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={nomeNovoOrc}
              onChange={(e) => setNomeNovoOrc(e.target.value)}
              placeholder="Nome do orçamento (ex.: Orçamento 2027 - base realista)"
              className="px-3 py-2 text-sm border border-gray-300 rounded-md w-[360px] max-w-full"
            />
            <button
              onClick={() => salvarOrcamento('novo')}
              disabled={salvandoOrc || !nomeNovoOrc.trim()}
              className="px-4 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {salvandoOrc ? 'Salvando...' : 'Salvar como novo orçamento'}
            </button>
            {orcamentoAtivo && (
              <button
                onClick={() => salvarOrcamento('atualizar')}
                disabled={salvandoOrc}
                className="px-4 py-2 text-sm border border-green-600 text-green-800 rounded-md bg-white hover:bg-green-50 disabled:opacity-50"
              >
                Atualizar &quot;{orcamentoAtivo.nome}&quot; com as edições
              </button>
            )}
            {msgOrc && <span className="text-sm">{msgOrc}</span>}
          </div>
        )}
        {orcamentosAberto && (
          <div className="mt-3 overflow-x-auto">
            {orcamentos.length === 0 ? (
              <p className="text-sm">Nenhum orçamento salvo ainda.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-100 text-xs">
                    <th className="px-3 py-2 text-left">NOME</th>
                    <th className="px-3 py-2 text-left">EMPRESA</th>
                    <th className="px-3 py-2 text-left">INÍCIO</th>
                    <th className="px-3 py-2 text-right">REC. LÍQUIDA</th>
                    <th className="px-3 py-2 text-right">LUCRO</th>
                    <th className="px-3 py-2 text-right">EDIÇÕES</th>
                    <th className="px-3 py-2 text-left">ATUALIZADO</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {orcamentos.map((o) => (
                    <tr key={o.id} className={`border-t border-gray-100 ${orcamentoAtivo?.id === o.id ? 'bg-green-50' : ''}`}>
                      <td className="px-3 py-2 font-semibold">{o.nome}</td>
                      <td className="px-3 py-2">{o.filtro === 'consolidado' ? 'Consolidado' : o.filtro === 'fabrica' ? 'Fábrica' : o.filtro}</td>
                      <td className="px-3 py-2">{o.inicio.split('-').reverse().join('/')}</td>
                      <td className="px-3 py-2 text-right">{formatarValor(o.receitaLiquida)}</td>
                      <td className={`px-3 py-2 text-right ${o.lucro < 0 ? 'text-red-600' : ''}`}>{formatarValor(o.lucro)}</td>
                      <td className="px-3 py-2 text-right">{o.qtdEdicoes}</td>
                      <td className="px-3 py-2">{o.atualizadoEm ? new Date(o.atualizadoEm).toLocaleString('pt-BR') : ''}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button onClick={() => carregarOrcamento(o.id)} className="px-3 py-1 text-xs border border-gray-300 rounded bg-white hover:bg-gray-50 mr-2">Abrir</button>
                        <button onClick={() => excluirOrcamento(o.id, o.nome)} className="px-3 py-1 text-xs border border-red-300 text-red-700 rounded bg-white hover:bg-red-50">Excluir</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {!dados && carregando && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 flex items-center justify-center gap-2 text-gray-600">
          <RefreshCw className="w-6 h-6 animate-spin text-green-600" /> Calculando a base do ano anterior…
        </div>
      )}

      {!dados && !carregando && !erro && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
          Escolha o cenário e o período e clique em Consultar para carregar a DRE projetada.
        </div>
      )}

      {dados && (
        <div className="bg-white rounded-xl shadow-lg overflow-hidden border border-gray-200">
          <div className="p-5 border-b-2 bg-gradient-to-r from-green-50 to-green-100 border-green-200">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-800">Projeção de Resultado - {filtroLabel}</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Período: {periodos[0]?.label} a {periodos[periodos.length - 1]?.label} · {orcamentoAtivo ? <>Orçamento <strong>{orcamentoAtivo.nome}</strong></> : <>Cenário {CENARIOS.find((c) => c.chave === cenario)?.titulo}</>}
                </p>
                <p className="text-xs text-gray-600 mt-1 flex items-center gap-2">
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-200 text-slate-700">Fixa</span> mesmo valor do ano anterior
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800">Variável</span> mesmo % sobre a receita
                  <span className="text-gray-400">(etiquetas no último nível da conta)</span>
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setComparacao((v) => !v)}
                  title="Compara o projetado (ou o orçamento aberto) com o realizado dos meses já fechados"
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md border ${comparacao ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-black border-gray-300 hover:bg-gray-50'}`}
                >
                  {carregandoReal ? 'Buscando realizado...' : 'Projetado × Realizado'}
                </button>
                {comparacao && (
                  <button onClick={() => buscarRealizado(true)} disabled={carregandoReal} title="Recalcular o realizado ignorando o cache" className="px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50">
                    <RefreshCw className={`w-3.5 h-3.5 ${carregandoReal ? 'animate-spin' : ''}`} />
                  </button>
                )}
                <label className="flex items-center gap-2 text-xs font-medium text-gray-600 cursor-pointer select-none">
                  Comparar com ano anterior
                  <button
                    role="switch"
                    aria-checked={comparar}
                    onClick={() => setComparar(!comparar)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${comparar ? 'bg-blue-600' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${comparar ? 'translate-x-5' : 'translate-x-1'}`} />
                  </button>
                </label>
                <div className="px-4 py-2 rounded-lg text-sm font-semibold bg-green-200 text-green-800">{anosTitulo}</div>
              </div>
            </div>
          </div>
          {qtdEdicoes > 0 && (
            <div className="px-5 py-2 bg-yellow-50 border-b border-yellow-200 flex items-center justify-between gap-3 text-sm text-yellow-900">
              <span>
                {qtdEdicoes} {qtdEdicoes === 1 ? 'célula editada' : 'células editadas'} · Lucro líquido projetado com as edições:{' '}
                <strong>{formatarValor(projetadoEd['14']?.total ?? 0)}</strong>{' '}
                ({av(projetadoEd['14']?.total ?? 0, recLiqTotal)} da receita líquida)
              </span>
              <button onClick={restaurarEdicoes} className="px-3 py-1 text-xs font-medium border border-yellow-400 rounded bg-white hover:bg-yellow-100">
                Restaurar valores do cenário
              </button>
            </div>
          )}
          {comparacao ? (
            erroReal ? (
              <div className="p-6 text-sm text-red-700">{erroReal}</div>
            ) : realizadoCompleto && realizadoResp ? (
              <ComparacaoRealizado
                linhas={linhas}
                abertos={abertos}
                alternar={alternar}
                projetado={projetadoEd}
                real={realizadoCompleto}
                fechados={realizadoResp.fechados}
                de={compDe}
                ate={compAte}
                setDe={setCompDe}
                setAte={setCompAte}
              />
            ) : (
              <div className="p-8 flex items-center justify-center gap-2 text-gray-700">
                <RefreshCw className="w-5 h-5 animate-spin text-green-600" /> Buscando o realizado dos meses fechados…
              </div>
            )
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gradient-to-r from-blue-600 to-blue-700">
                  <th className="px-4 py-2 text-left text-sm font-bold text-white border-b border-blue-500 sticky left-0 bg-blue-600 z-20 min-w-[320px]">CONTA</th>
                  {gruposPorAno.map((g) => (
                    <th key={g.ano} colSpan={g.qtd * (comparar ? 4 : 2)} className="px-3 py-2 text-center text-sm font-bold text-white border-b border-blue-500 border-r border-blue-400 last:border-r-0">
                      PROJEÇÃO {g.ano}{comparar ? ` vs ${parseInt(g.ano, 10) - 1}` : ''}
                    </th>
                  ))}
                  <th colSpan={comparar ? 4 : 2} className="px-3 py-2 text-center text-sm font-bold text-white border-b border-blue-500 bg-blue-800">ACUMULADO 12 MESES</th>
                </tr>
                <tr className="bg-gray-100">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 border-b border-gray-300 sticky left-0 bg-gray-100 z-20"></th>
                  {periodos.map((per) => {
                    const [ano, mes] = per.key.split('-');
                    const [anoB] = per.base.split('-');
                    return (
                      <React.Fragment key={per.key}>
                        {comparar && (
                          <th colSpan={2} className="px-2 py-2 text-center text-xs font-bold text-gray-500 border-b border-gray-300 bg-gray-200">{NOMES_MES[parseInt(mes, 10)]}/{anoB.slice(2)}</th>
                        )}
                        <th colSpan={2} className="px-2 py-2 text-center text-xs font-bold text-gray-700 border-b border-gray-300 bg-gray-50">
                          {comparar ? `${NOMES_MES[parseInt(mes, 10)]}/${ano.slice(2)}` : NOMES_MES[parseInt(mes, 10)]}
                        </th>
                      </React.Fragment>
                    );
                  })}
                  {comparar && <th colSpan={2} className="px-3 py-2 text-center text-xs font-bold text-gray-500 border-b border-gray-300 bg-gray-200">ANO ANTERIOR</th>}
                  <th className="px-3 py-2 text-center text-xs font-bold text-blue-700 border-b border-gray-300 bg-blue-50">TOTAL</th>
                  <th className="px-3 py-2 text-center text-xs font-bold text-green-700 border-b border-gray-300 bg-green-50">A/V %</th>
                </tr>
                <tr className="bg-gray-50">
                  <th className="px-4 py-1 border-b border-gray-200 sticky left-0 bg-gray-50 z-20"></th>
                  {periodos.map((per) => (
                    <React.Fragment key={`sub-${per.key}`}>
                      {comparar && (
                        <>
                          <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-200">R$</th>
                          <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-200">%</th>
                        </>
                      )}
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200">R$</th>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-100">%</th>
                    </React.Fragment>
                  ))}
                  {comparar && (
                    <>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-200">R$</th>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-200">%</th>
                    </>
                  )}
                  <th className="px-3 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-blue-50">R$</th>
                  <th className="px-3 py-1 border-b border-gray-200 bg-green-50"></th>
                </tr>
              </thead>
              <tbody>
                {linhas.map(({ conta, profundidade }) => {
                  const proj = projetadoEd[conta.codigo];
                  const ant = dados.anoAnterior[conta.codigo];
                  const resultado = conta.tipo === 'resultado';
                  const filhos = 'filhos' in conta ? conta.filhos : undefined;
                  const temFilhos = !!filhos?.length;
                  const editavel = !resultado && !temFilhos && ['04', '06', '08', '10', '13'].includes(conta.codigo.split('.')[0]);
                  const tipo = dados.tipos[conta.codigo];
                  const manual = tipo === 'manual';
                  const corLinha = manual ? 'bg-amber-100 text-amber-900 font-medium' : resultado ? 'bg-green-50 font-bold text-green-800' : CORES_NIVEL[Math.min(profundidade + 1, 4)];
                  const totalProj = proj?.total ?? 0;
                  const totalAnt = ant?.total ?? 0;
                  return (
                    <tr key={conta.codigo} className={`${corLinha} hover:bg-gray-100`}>
                      <td className="px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10">
                        <div className="flex items-center gap-2" style={{ paddingLeft: `${profundidade * 16}px` }}>
                          {temFilhos ? (
                            <button onClick={() => alternar(conta.codigo)}>{abertos.has(conta.codigo) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button>
                          ) : <div className="w-4" />}
                          {!resultado && <span className="font-mono text-xs text-gray-500">{conta.codigo}</span>}
                          <span className={`text-sm ${resultado ? 'font-bold' : ''}`}>{conta.nome}</span>
                          {tipo && tipo !== 'receita' && (
                            <span className={`px-1.5 py-0.5 text-[10px] rounded ${tipo === 'fixa' ? 'bg-slate-200 text-slate-700' : tipo === 'manual' ? 'bg-amber-300 text-amber-950' : 'bg-amber-100 text-amber-800'}`}>
                              {tipo === 'fixa' ? 'Fixa' : tipo === 'manual' ? 'Projeção manual' : 'Variável'}
                            </span>
                          )}
                        </div>
                      </td>
                      {periodos.map((per) => {
                        const v = proj?.[per.key] ?? 0;
                        const vb = ant?.[per.key] ?? 0;
                        const recBase = dados.anoAnterior['03']?.[per.key] ?? 0;
                        return (
                          <React.Fragment key={per.key}>
                            {comparar && (
                              <>
                                <td className={`px-2 py-2 border-b border-gray-200 text-right text-sm bg-gray-100 ${vb < 0 ? 'text-red-500' : 'text-gray-600'}`}>{formatarValor(vb)}</td>
                                <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-100 ${vb < 0 ? 'text-red-400' : 'text-gray-400'}`}>{av(vb, recBase)}</td>
                              </>
                            )}
                            <td className={`px-2 py-2 border-b border-gray-200 text-right text-sm ${corTexto(v)}`}>{formatarValor(v)}</td>
                            {editavel ? (
                              <CelulaPct
                                texto={av(v, recLiqPeriodo(per.key))}
                                pctAtual={recLiqPeriodo(per.key) ? (Math.abs(v) / Math.abs(recLiqPeriodo(per.key))) * 100 : null}
                                editado={edicoes[conta.codigo]?.[per.key] !== undefined}
                                onCommit={(t) => editarPct(conta.codigo, [per.key], t)}
                                className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-50 ${v < 0 ? 'text-red-500' : 'text-gray-500'}`}
                                titulo="Clique para alterar o % sobre a receita líquida deste mês"
                              />
                            ) : (
                              <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-50 ${v < 0 ? 'text-red-500' : 'text-gray-500'}`}>{av(v, recLiqPeriodo(per.key))}</td>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {comparar && (
                        <>
                          <td className={`px-2 py-2 border-b border-gray-200 text-right text-sm bg-gray-100 ${totalAnt < 0 ? 'text-red-500' : 'text-gray-600'}`}>{formatarValor(totalAnt)}</td>
                          <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-100 ${totalAnt < 0 ? 'text-red-400' : 'text-gray-400'}`}>{av(totalAnt, dados.anoAnterior['03']?.total ?? 0)}</td>
                        </>
                      )}
                      <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold ${corTexto(totalProj)}`}>{formatarValor(totalProj)}</td>
                      {editavel ? (
                        <CelulaPct
                          texto={av(totalProj, recLiqTotal)}
                          pctAtual={recLiqTotal ? (Math.abs(totalProj) / Math.abs(recLiqTotal)) * 100 : null}
                          editado={false}
                          onCommit={(t) => editarPct(conta.codigo, periodos.map((x) => x.key), t)}
                          className={`px-3 py-2 border-b border-gray-200 text-right text-sm ${totalProj < 0 ? 'text-red-500' : 'text-gray-600'}`}
                          titulo="Clique para aplicar o mesmo % a todos os 12 meses"
                        />
                      ) : (
                        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm ${totalProj < 0 ? 'text-red-500' : 'text-gray-600'}`}>{av(totalProj, recLiqTotal)}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}
      <p className="text-xs text-gray-500">Valores em R$. Despesas aparecem negativas (como na DRE). A/V % = percentual sobre a receita líquida do período. Nas contas do último nível (custos e despesas), clique no A/V % de um mês para alterá-lo (ou na coluna total para aplicar aos 12 meses): grupos, totalizadores e lucro recalculam na hora.</p>
    </div>
  );
}
