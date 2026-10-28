'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, TrendingUp } from 'lucide-react';
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
  const [abertos, setAbertos] = useState<Set<string>>(new Set());

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

  useEffect(() => { buscar(); }, [buscar]);

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

  return (
    <div className="p-6 space-y-4 text-black">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><TrendingUp className="w-5 h-5" /> DRE Projetada — próximos 12 meses</h1>
          <p className="text-xs">
            Base: mesmo mês do ano anterior ({p ? `${p.baseInicio.split('-').reverse().join('/')} a ${p.baseFim.split('-').reverse().join('/')}` : '…'}).
            Receita por crescimento %; despesas variáveis mantêm o % sobre a receita; despesas fixas sobem pela inflação.
            Fixo/variável segue a classificação da tela de DRE.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="text-xs">Empresa
            <select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="block border border-gray-300 rounded px-2 py-1 text-sm bg-white">
              <option value="consolidado">Consolidado (todas)</option>
              <option value="fabrica">Fábrica</option>
              {lojas.map((l) => <option key={l.valor} value={l.valor}>{l.label}</option>)}
            </select>
          </label>
          <label className="text-xs">Primeiro mês
            <input type="month" value={inicio} onChange={(e) => e.target.value && setInicio(e.target.value)} className="block border border-gray-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="flex items-center gap-1 text-xs pb-1.5">
            <input type="checkbox" checked={comparar} onChange={(e) => setComparar(e.target.checked)} /> Comparar com ano anterior
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
        <div className="bg-white rounded-lg shadow overflow-hidden">
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
      <p className="text-xs">Valores em R$. Despesas aparecem negativas (como na DRE). A/V % = percentual sobre a receita líquida do período.</p>
    </div>
  );
}
