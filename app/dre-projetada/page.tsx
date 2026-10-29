'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, ChevronRight, Filter, RefreshCw, TrendingUp } from 'lucide-react';
import { formatarValor } from '../utils/formatters';
import { PLANO_CONTAS_DRE_FABRICA, type ContaDRE } from '../dre-fabrica/planoContasDREFabrica';

type Cenario = 'pessimista' | 'realista' | 'otimista' | 'personalizado';
type Valores = Record<string, number>;

interface RespostaProjecao {
  periodos: { key: string; label: string; base: string }[];
  projetado: Record<string, Valores>;
  anoAnterior: Record<string, Valores>;
  tipos: Record<string, 'receita' | 'variavel' | 'fixa'>;
  parametros: {
    cenario: string; inflacao: number; inflacaoFixas: number; crescimentoReceita: number; adicionalOtimista: number;
    ipca: { valor: number; data: string | null; fonte: string }; baseInicio: string; baseFim: string;
  };
}

const CENARIOS: { chave: Cenario; titulo: string; descricao: string }[] = [
  { chave: 'pessimista', titulo: 'Pessimista', descricao: 'Igual ao ano anterior' },
  { chave: 'realista', titulo: 'Realista', descricao: 'Receita do ano anterior + inflação' },
  { chave: 'otimista', titulo: 'Otimista', descricao: 'Receita do ano anterior + inflação + 5%' },
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

interface ResumoCenario { receitaLiquida: number; lucro: number; percentual: number | null }
interface ResumoEmpresa {
  filtro: string; nome: string; carregando: boolean; erro?: string;
  anoAnterior?: ResumoCenario; cenarios?: Record<string, ResumoCenario>; crescimentoNecessario?: number | null;
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

  const buscar = useCallback(async (forcar = false) => {
    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ inicio, cenario, filtro });
      const infl = Number(inflacaoTxt.replace(',', '.'));
      if (inflacaoTxt.trim() !== '' && !Number.isNaN(infl)) params.set('inflacao', String(infl));
      const cresc = Number(crescimentoTxt.replace(',', '.'));
      if (cenario === 'personalizado' && crescimentoTxt.trim() !== '' && !Number.isNaN(cresc)) params.set('crescimentoReceita', String(cresc));
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
  }, [inicio, cenario, filtro, inflacaoTxt, crescimentoTxt]);

  const buscarResumo = useCallback(async (forcar = false) => {
    const id = ++execResumo.current;
    const empresas = [
      { filtro: 'consolidado', nome: 'CONSOLIDADO (TODAS)' },
      { filtro: 'fabrica', nome: 'FABRICA' },
      ...lojas.map((l) => ({ filtro: l.valor, nome: l.label })),
    ];
    setResumo(empresas.map((e) => ({ ...e, carregando: true })));
    const personalizado = cenario === 'personalizado' ? Number(crescimentoTxt.replace(',', '.')) : NaN;
    for (const e of empresas) {
      if (id !== execResumo.current) return;
      let novo: Partial<ResumoEmpresa>;
      try {
        const params = new URLSearchParams({ inicio, filtro: e.filtro });
        const infl = Number(inflacaoTxt.replace(',', '.'));
        if (inflacaoTxt.trim() !== '' && !Number.isNaN(infl)) params.set('inflacao', String(infl));
        if (!Number.isNaN(personalizado) && crescimentoTxt.trim() !== '') params.set('crescimentoReceita', String(personalizado));
        if (forcar) params.set('forcar', 'true');
        const resp = await fetch(`/api/dre-projetada/resumo?${params.toString()}`, { cache: 'no-store' });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.detail || json.error || 'Erro');
        novo = { anoAnterior: json.anoAnterior, cenarios: json.cenarios, crescimentoNecessario: json.crescimentoNecessario, carregando: false };
      } catch (err) {
        novo = { carregando: false, erro: err instanceof Error ? err.message : 'Erro' };
      }
      if (id !== execResumo.current) return;
      setResumo((prev) => prev && prev.map((r) => (r.filtro === e.filtro ? { ...r, ...novo } : r)));
    }
  }, [inicio, cenario, inflacaoTxt, crescimentoTxt, lojas]);

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
      if (c.filhos && abertos.has(c.codigo)) c.filhos.forEach((f) => percorrer(f, prof + 1));
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
                  Base: mesmo mês do ano anterior ({p.baseInicio.split('-').reverse().join('/')} a {p.baseFim.split('-').reverse().join('/')}).
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
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
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
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-700">
                  <th className="px-3 py-2 text-left border-b border-gray-200">Empresa</th>
                  {[['anterior', 'Ano anterior'], ['pessimista', 'Pessimista'], ['realista', 'Realista'], ['otimista', 'Otimista'], ...(cenario === 'personalizado' && crescimentoTxt.trim() !== '' ? [['personalizado', 'Personalizado']] : [])].map(([k, t]) => (
                    <th key={k} className="px-3 py-2 text-right border-b border-gray-200" colSpan={1}>{t}</th>
                  ))}
                  <th className="px-3 py-2 text-right border-b border-gray-200 bg-amber-50" title="Crescimento da receita, além da inflação, para chegar a 10% de lucro líquido (fixas constantes, variáveis crescem com a venda)">Crescimento após inflação p/ 10% de lucro</th>
                </tr>
              </thead>
              <tbody>
                {resumo.map((r) => {
                  const colunas: [string, ResumoCenario | undefined][] = [
                    ['anterior', r.anoAnterior],
                    ...['pessimista', 'realista', 'otimista', 'personalizado']
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                  Período: {periodos[0]?.label} a {periodos[periodos.length - 1]?.label} · Cenário {CENARIOS.find((c) => c.chave === cenario)?.titulo}
                </p>
                <p className="text-xs text-gray-600 mt-1 flex items-center gap-2">
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-200 text-slate-700">Fixa</span> mesmo valor do ano anterior
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800">Variável</span> mesmo % sobre a receita
                  <span className="text-gray-400">(etiquetas no último nível da conta)</span>
                </p>
              </div>
              <div className="flex items-center gap-3">
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
                  const proj = dados.projetado[conta.codigo];
                  const ant = dados.anoAnterior[conta.codigo];
                  const resultado = conta.tipo === 'resultado';
                  const filhos = 'filhos' in conta ? conta.filhos : undefined;
                  const temFilhos = !!filhos?.length;
                  const tipo = dados.tipos[conta.codigo];
                  const corLinha = resultado ? 'bg-green-50 font-bold text-green-800' : CORES_NIVEL[Math.min(profundidade + 1, 4)];
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
                            <span className={`px-1.5 py-0.5 text-[10px] rounded ${tipo === 'fixa' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-800'}`}>
                              {tipo === 'fixa' ? 'Fixa' : 'Variável'}
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
                            <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-50 ${v < 0 ? 'text-red-500' : 'text-gray-500'}`}>{av(v, recLiqPeriodo(per.key))}</td>
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
                      <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm ${totalProj < 0 ? 'text-red-500' : 'text-gray-600'}`}>{av(totalProj, recLiqTotal)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-xs text-gray-500">Valores em R$. Despesas aparecem negativas (como na DRE). A/V % = percentual sobre a receita líquida do período.</p>
    </div>
  );
}
