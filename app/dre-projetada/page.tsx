'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, TrendingUp } from 'lucide-react';
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
  { chave: 'realista', titulo: 'Realista', descricao: 'Ano anterior + inflação' },
  { chave: 'otimista', titulo: 'Otimista', descricao: 'Ano anterior + inflação + 5% na receita' },
  { chave: 'personalizado', titulo: 'Personalizado', descricao: 'Você define a receita e a inflação' },
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

const brl = (v: number) => (Math.abs(v) < 0.5 ? '-' : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }));
const pct = (atual: number, base: number) => (base === 0 ? '—' : `${(((atual - base) / Math.abs(base)) * 100).toFixed(1).replace('.', ',')}%`);

function mesAtualISO() {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}`;
}

export default function DreProjetadaPage() {
  const [cenario, setCenario] = useState<Cenario>('realista');
  const [inicio, setInicio] = useState(mesAtualISO());
  const [inflacaoTxt, setInflacaoTxt] = useState('');
  const [crescimentoTxt, setCrescimentoTxt] = useState('');
  const [dados, setDados] = useState<RespostaProjecao | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [abertos, setAbertos] = useState<Set<string>>(new Set());

  const buscar = useCallback(async (forcar = false) => {
    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ inicio, cenario });
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
  }, [inicio, cenario, inflacaoTxt, crescimentoTxt]);

  useEffect(() => { buscar(); }, [buscar]);

  async function trocarTipo(conta: string, tipo: 'fixa' | 'variavel') {
    await fetch('/api/dre-projetada/classificacao', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conta, tipo }),
    });
    buscar();
  }

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

  return (
    <div className="p-6 space-y-4 text-black">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><TrendingUp className="w-5 h-5" /> DRE Projetada — próximos 12 meses</h1>
          <p className="text-xs">
            Base: mesmo mês do ano anterior ({p ? `${p.baseInicio.split('-').reverse().join('/')} a ${p.baseFim.split('-').reverse().join('/')}` : '…'}), consolidado.
            Receita por crescimento %; despesas variáveis mantêm o % sobre a receita; despesas fixas sobem pela inflação.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="text-xs">Primeiro mês
            <input type="month" value={inicio} onChange={(e) => e.target.value && setInicio(e.target.value)} className="block border border-gray-300 rounded px-2 py-1 text-sm" />
          </label>
          <button onClick={() => buscar(true)} disabled={carregando} className="flex items-center gap-1 border border-gray-300 rounded px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50" title="Recalcular a base (ignora o cache)">
            {carregando ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Atualizar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        {CENARIOS.map((c) => (
          <button
            key={c.chave}
            onClick={() => setCenario(c.chave)}
            className={`text-left rounded-lg border px-3 py-2 ${cenario === c.chave ? 'border-blue-600 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
          >
            <div className="text-sm font-semibold">{c.titulo}</div>
            <div className="text-xs">{c.descricao}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="text-xs">Inflação (% a.a., contas fixas)
          <input
            value={inflacaoTxt}
            onChange={(e) => setInflacaoTxt(e.target.value)}
            placeholder={p ? String(p.ipca.valor).replace('.', ',') : ''}
            className="block w-28 border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </label>
        {cenario === 'personalizado' && (
          <label className="text-xs">Crescimento da receita (%)
            <input value={crescimentoTxt} onChange={(e) => setCrescimentoTxt(e.target.value)} className="block w-28 border border-gray-300 rounded px-2 py-1 text-sm" />
          </label>
        )}
        {p && (
          <div className="text-xs">
            Em uso: receita <b>{p.crescimentoReceita.toFixed(2).replace('.', ',')}%</b> · fixas <b>{p.inflacaoFixas.toFixed(2).replace('.', ',')}%</b>
            {' '}· {p.ipca.fonte}: {p.ipca.valor.toFixed(2).replace('.', ',')}%{p.ipca.data ? ` (${p.ipca.data})` : ''}
          </div>
        )}
      </div>

      {erro && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{erro}</div>}

      {!dados && carregando && <div className="flex items-center gap-2 py-12 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Calculando a base do ano anterior…</div>}

      {dados && (
        <div className="overflow-auto border border-gray-200 rounded-lg bg-white" style={{ maxHeight: '70vh' }}>
          <table className="text-xs whitespace-nowrap">
            <thead className="sticky top-0 z-20 bg-gray-100">
              <tr>
                <th className="sticky left-0 z-30 bg-gray-100 text-left px-3 py-2 min-w-[340px]">Conta</th>
                <th className="px-3 py-2 text-right">Tipo</th>
                {dados.periodos.map((per) => <th key={per.key} className="px-3 py-2 text-right">{per.label}</th>)}
                <th className="px-3 py-2 text-right bg-blue-100">Total projetado</th>
                <th className="px-3 py-2 text-right bg-gray-200">Ano anterior</th>
                <th className="px-3 py-2 text-right bg-gray-200">Var. %</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map(({ conta, profundidade }) => {
                const proj = dados.projetado[conta.codigo];
                const ant = dados.anoAnterior[conta.codigo];
                const resultado = conta.tipo === 'resultado';
                const filhos = 'filhos' in conta ? conta.filhos : undefined;
                const tipo = dados.tipos[conta.codigo];
                const fundo = resultado ? 'bg-gray-800 text-white font-bold' : profundidade === 0 ? 'bg-blue-100 font-bold' : profundidade === 1 ? 'bg-blue-50' : 'bg-white';
                return (
                  <tr key={conta.codigo} className={`${fundo} border-b border-gray-100`}>
                    <td className={`sticky left-0 z-10 px-3 py-1 ${resultado ? 'bg-gray-800' : profundidade === 0 ? 'bg-blue-100' : profundidade === 1 ? 'bg-blue-50' : 'bg-white'}`} style={{ paddingLeft: 12 + profundidade * 16 }}>
                      <span className="inline-flex items-center gap-1">
                        {filhos && filhos.length > 0 ? (
                          <button onClick={() => alternar(conta.codigo)}>{abertos.has(conta.codigo) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</button>
                        ) : <span className="w-3.5" />}
                        {!resultado && <span className="opacity-60">{conta.codigo}</span>} {conta.nome}
                      </span>
                    </td>
                    <td className="px-3 py-1 text-right">
                      {tipo === 'receita' ? <span className="opacity-60">receita</span> : tipo ? (
                        <select value={tipo} onChange={(e) => trocarTipo(conta.codigo, e.target.value as 'fixa' | 'variavel')} className="border border-gray-300 rounded text-xs bg-white text-black">
                          <option value="fixa">Fixa</option>
                          <option value="variavel">Variável (%)</option>
                        </select>
                      ) : ''}
                    </td>
                    {dados.periodos.map((per) => <td key={per.key} className="px-3 py-1 text-right tabular-nums">{brl(proj?.[per.key] ?? 0)}</td>)}
                    <td className="px-3 py-1 text-right tabular-nums font-semibold">{brl(proj?.total ?? 0)}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{brl(ant?.total ?? 0)}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{pct(proj?.total ?? 0, ant?.total ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs">Valores em R$. Despesas aparecem negativas (como na DRE). A classificação Fixa/Variável é salva e vale para todos os cenários.</p>
    </div>
  );
}
