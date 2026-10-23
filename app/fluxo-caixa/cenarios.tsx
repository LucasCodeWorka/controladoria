'use client';

// Cenarios do Fluxo de Caixa - "foto" das contas a pagar e pedidos de compra em
// aberto num periodo, comparada depois com a situacao de agora. Compartilhado
// (todos veem os mesmos cenarios). So INFORMATIVO: nada daqui entra no saldo do
// dia nem no acumulado - a tela normal do fluxo nao muda sem um cenario escolhido.

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, X, Camera, RefreshCw, Trash2, ChevronDown, ChevronRight, BarChart3 } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface CenarioResumo {
  id: number;
  nome: string;
  dtInicio: string;
  dtFim: string;
  empresas: string | null;
  criadoPor: string | null;
  criadoEm: string | null;
  qtdDuplicatas: number;
  vlDuplicatas: number;
  qtdPedidos: number;
  vlPedidos: number;
}

interface CatVal { qtd: number; valor: number }
interface DiaBloco {
  cenario: number;
  atual: number;
  aberto: number;
  pago: number;
  variacao: number;
  categorias: Record<string, CatVal>;
}
interface ItemComp {
  tipo: 'duplicata' | 'pedido';
  categoria: string;
  documento: string;
  empresa: number;
  fornecedor: string | null;
  diaCenario: string | null;
  diaAtual: string | null;
  valorCenario: number;
  valorAtual: number;
  aberto: number;
  pago: number;
  situacao: string;
}
export interface Comparacao {
  cenario: { id: number; nome: string; dtInicio: string; dtFim: string; criadoPor: string | null; criadoEm: string | null };
  geradoEm: string;
  duplicatas: Record<string, DiaBloco>;
  pedidos: Record<string, DiaBloco>;
  itens: ItemComp[];
}

const fmt = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
const fmtSinal = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`;
const dataBR = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '—');

// Categorias INFORMATIVAS: mostram o valor pago, nao entram na variacao do total.
const CATEGORIAS_INFORMATIVAS = new Set(['paga', 'paga_parcial']);

const ROTULO_DUP: Record<string, string> = {
  nova: 'Novas',
  nova_paga: 'Novas já pagas',
  entrou_no_periodo: 'Entraram no período (data mudou ou já existiam)',
  alterada: 'Valor aumentou',
  movida_entrada: 'Mudaram de dia (entraram)',
  movida_saida: 'Mudaram de dia (saíram)',
  paga: 'Pagas desde a foto (informativo)',
  paga_parcial: 'Pagas em parte (informativo)',
  cancelada: 'Canceladas / substituídas',
  outra_situacao: 'Outra situação',
  sumiu: 'Não encontradas',
};
const ROTULO_PED: Record<string, string> = {
  nova: 'Novos',
  alterada: 'Valor mudou',
  movida_entrada: 'Mudaram de dia (entraram)',
  movida_saida: 'Mudaram de dia (saíram)',
  saiu: 'Saíram da lista (entregue, faturado ou cancelado)',
};
const ROTULO_ITEM: Record<string, string> = {
  nova: 'Nova', nova_paga: 'Nova (já paga)', entrou_no_periodo: 'Entrou no período', alterada: 'Valor aumentou',
  movida: 'Mudou de dia', paga: 'Paga', paga_parcial: 'Paga em parte', cancelada: 'Cancelada/substituída',
  outra_situacao: 'Outra situação', sumiu: 'Não encontrada', saiu: 'Saiu da lista',
};
const COR_ITEM: Record<string, string> = {
  nova: 'bg-red-100 text-red-800', nova_paga: 'bg-gray-100 text-black', entrou_no_periodo: 'bg-amber-100 text-amber-800',
  alterada: 'bg-red-100 text-red-800', movida: 'bg-sky-100 text-sky-800', paga: 'bg-green-100 text-green-800',
  paga_parcial: 'bg-green-100 text-green-800', cancelada: 'bg-gray-200 text-black', outra_situacao: 'bg-gray-200 text-black',
  sumiu: 'bg-gray-200 text-black', saiu: 'bg-green-100 text-green-800',
};

// ── Hook: estado compartilhado entre a barra, o painel, o modal e os marcadores ──
export function useCenarios(getConsulta: () => string, usuario: string | null) {
  const [lista, setLista] = useState<CenarioResumo[]>([]);
  const [selecionadoId, setSelecionadoId] = useState<number | null>(null);
  const [comparacao, setComparacao] = useState<Comparacao | null>(null);
  const [comparando, setComparando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [diaDetalhe, setDiaDetalhe] = useState<string | null>(null);

  const carregarLista = useCallback(async () => {
    try {
      const resp = await fetch('/api/fluxo-caixa/cenarios', { cache: 'no-store' });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.detail || json.error || 'Erro ao listar cenários');
      setLista(Array.isArray(json) ? json : []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao listar cenários');
    }
  }, []);

  useEffect(() => { carregarLista(); }, [carregarLista]);

  const comparar = useCallback(async (id: number) => {
    setComparando(true);
    setErro(null);
    try {
      const resp = await fetch(`/api/fluxo-caixa/cenarios/${id}/comparar`, { cache: 'no-store' });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.detail || json.error || 'Erro ao comparar');
      setComparacao(json);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao comparar');
      setComparacao(null);
    } finally {
      setComparando(false);
    }
  }, []);

  const selecionar = useCallback((id: number | null) => {
    setSelecionadoId(id);
    setDiaDetalhe(null);
    if (id === null) { setComparacao(null); return; }
    comparar(id);
  }, [comparar]);

  const salvar = useCallback(async (nome: string): Promise<boolean> => {
    const qs = new URLSearchParams(getConsulta());
    const dtInicio = qs.get('dt_inicio');
    const dtFim = qs.get('dt_fim');
    if (!dtInicio || !dtFim) { setErro('Clique em Aplicar antes de salvar o cenário.'); return false; }
    setSalvando(true);
    setErro(null);
    try {
      const resp = await fetch('/api/fluxo-caixa/cenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, dtInicio, dtFim, empresas: qs.get('empresas'), criadoPor: usuario }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.detail || json.error || 'Erro ao salvar o cenário');
      await carregarLista();
      return true;
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao salvar o cenário');
      return false;
    } finally {
      setSalvando(false);
    }
  }, [getConsulta, usuario, carregarLista]);

  const excluir = useCallback(async (id: number) => {
    try {
      const resp = await fetch(`/api/fluxo-caixa/cenarios/${id}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error('Erro ao excluir o cenário');
      if (selecionadoId === id) { setSelecionadoId(null); setComparacao(null); setDiaDetalhe(null); }
      await carregarLista();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao excluir o cenário');
    }
  }, [selecionadoId, carregarLista]);

  return { lista, selecionadoId, comparacao, comparando, salvando, erro, setErro, diaDetalhe, setDiaDetalhe, selecionar, comparar, salvar, excluir };
}

export type CenariosState = ReturnType<typeof useCenarios>;

// Marcador do dia na tabela: variacao de contas a pagar + pedidos naquele dia.
export function marcadorDia(c: Comparacao | null, dia: string): { variacao: number; titulo: string; informativo: boolean } | null {
  if (!c) return null;
  const d = c.duplicatas[dia];
  const p = c.pedidos[dia];
  const mudou = (b?: DiaBloco) => !!b && (Math.abs(b.variacao) >= 0.005 || Object.keys(b.categorias).length > 0);
  if (!mudou(d) && !mudou(p)) return null;
  const variacao = (d?.variacao ?? 0) + (p?.variacao ?? 0);
  const linhas: string[] = [`Cenário "${c.cenario.nome}"`];
  if (d && mudou(d)) linhas.push(`Contas a pagar: ${fmt(d.cenario)} → ${fmt(d.atual)} (${fmtSinal(d.variacao)}${d.pago > 0 ? ` · pago ${fmt(d.pago)}` : ''})`);
  if (p && mudou(p)) linhas.push(`Pedidos: ${fmt(p.cenario)} → ${fmt(p.atual)} (${fmtSinal(p.variacao)})`);
  linhas.push('Clique para ver o que mudou');
  return { variacao, titulo: linhas.join('\n'), informativo: Math.abs(variacao) < 0.005 };
}

// ── Barra: seletor "Comparar com" + Salvar cenario ──
export function BarraCenarios({ c, podeSalvar }: { c: CenariosState; podeSalvar: boolean }) {
  const [nomeAberto, setNomeAberto] = useState(false);
  const [nome, setNome] = useState('');

  async function confirmarSalvar() {
    if (!nome.trim()) return;
    const ok = await c.salvar(nome.trim());
    if (ok) { setNome(''); setNomeAberto(false); }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={c.selecionadoId ?? ''}
        onChange={(e) => c.selecionar(e.target.value ? Number(e.target.value) : null)}
        className="h-7 text-xs border border-gray-300 rounded px-2 bg-white text-black max-w-[260px]"
        title="Compara o que está em aberto agora com a foto salva (só informativo — não altera saldo)"
      >
        <option value="">Comparar com cenário…</option>
        {c.lista.map((s) => (
          <option key={s.id} value={s.id}>
            {s.nome} — {s.criadoEm}{s.criadoPor ? ` (${s.criadoPor})` : ''}
          </option>
        ))}
      </select>
      {c.selecionadoId !== null && (
        <>
          <button
            onClick={() => c.comparar(c.selecionadoId!)}
            disabled={c.comparando}
            className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 text-black rounded px-2 py-1 disabled:opacity-50"
            title="Refaz a comparação com os dados de agora"
          >
            {c.comparando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Atualizar
          </button>
          <button
            onClick={() => { if (window.confirm('Excluir este cenário para todos os usuários?')) c.excluir(c.selecionadoId!); }}
            className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-red-100 text-black rounded px-2 py-1"
            title="Exclui o cenário salvo (vale para todos)"
          >
            <Trash2 className="w-3.5 h-3.5" /> Excluir
          </button>
        </>
      )}
      <button
        onClick={() => setNomeAberto(true)}
        disabled={!podeSalvar}
        className="flex items-center gap-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 text-black rounded px-2 py-1 disabled:opacity-50"
        title={podeSalvar ? 'Salva uma foto das contas a pagar e pedidos em aberto do período aplicado' : 'Clique em Aplicar antes'}
      >
        <Camera className="w-3.5 h-3.5" /> Salvar cenário
      </button>

      {nomeAberto && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !c.salvando && setNomeAberto(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-black mb-1">Salvar cenário</h2>
            <p className="text-xs text-black mb-3">
              Guarda uma foto das contas a pagar e pedidos de compra <strong>em aberto</strong> no período aplicado agora. Todos
              os usuários poderão compará-la depois. Não altera o fluxo.
            </p>
            <input
              autoFocus
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmarSalvar(); }}
              placeholder="Nome do cenário (ex: Fechamento 22/10)"
              className="w-full h-9 border border-gray-300 rounded px-3 text-sm text-black"
              maxLength={80}
            />
            {c.erro && <p className="text-xs text-red-700 mt-2">{c.erro}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setNomeAberto(false)} disabled={c.salvando} className="h-8 px-3 text-sm bg-gray-100 hover:bg-gray-200 rounded text-black">Cancelar</button>
              <button
                onClick={confirmarSalvar}
                disabled={c.salvando || !nome.trim()}
                className="h-8 px-3 text-sm bg-green-600 hover:bg-green-700 text-white rounded flex items-center gap-1.5 disabled:opacity-50"
              >
                {c.salvando && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Soma uma categoria em todos os dias.
function somarCategorias(bloco: Record<string, DiaBloco>): Record<string, CatVal> {
  const acc: Record<string, CatVal> = {};
  Object.values(bloco).forEach((d) => {
    Object.entries(d.categorias).forEach(([k, v]) => {
      const a = acc[k] ?? { qtd: 0, valor: 0 };
      acc[k] = { qtd: a.qtd + v.qtd, valor: a.valor + v.valor };
    });
  });
  return acc;
}
function somar(bloco: Record<string, DiaBloco>, campo: 'cenario' | 'atual' | 'aberto' | 'pago' | 'variacao') {
  return Object.values(bloco).reduce((s, d) => s + d[campo], 0);
}

function CartaoResumo({ titulo, bloco, rotulos, onGrafico }: { titulo: string; bloco: Record<string, DiaBloco>; rotulos: Record<string, string>; onGrafico: () => void }) {
  const cats = somarCategorias(bloco);
  const variacao = somar(bloco, 'variacao');
  const ordem = Object.keys(rotulos).filter((k) => cats[k]);
  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      <h3 className="text-xs font-semibold text-black uppercase tracking-wide mb-2">{titulo}</h3>
      <div className="grid grid-cols-3 gap-2 text-xs mb-2">
        <div><div className="text-black">Cenário</div><div className="text-sm font-bold text-black tabular-nums">{fmt(somar(bloco, 'cenario'))}</div></div>
        <div><div className="text-black">Agora{somar(bloco, 'pago') > 0 ? ' (aberto + pago)' : ''}</div><div className="text-sm font-bold text-black tabular-nums">{fmt(somar(bloco, 'atual'))}</div></div>
        <div>
          <div className="text-black">Variação</div>
          <button
            onClick={onGrafico}
            title="Ver gráfico da variação por mês e por semana"
            className={`text-sm font-bold tabular-nums underline decoration-dotted underline-offset-2 hover:opacity-70 inline-flex items-center gap-1 ${variacao > 0.005 ? 'text-red-700' : variacao < -0.005 ? 'text-green-700' : 'text-black'}`}
          >
            {fmtSinal(variacao)} <BarChart3 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {ordem.length === 0 ? (
        <p className="text-xs text-black">Nada mudou desde a foto.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {ordem.map((k) => {
              const info = CATEGORIAS_INFORMATIVAS.has(k);
              return (
                <tr key={k} className="border-t border-gray-100">
                  <td className="py-1 text-black">{rotulos[k]} <span className="text-black">({cats[k].qtd})</span></td>
                  <td className={`py-1 text-right tabular-nums font-semibold ${info ? 'text-gray-500' : cats[k].valor > 0 ? 'text-red-700' : 'text-green-700'}`}>
                    {info ? fmt(cats[k].valor) : fmtSinal(cats[k].valor)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Grafico da variacao por mes / semana (abre clicando na Variacao do resumo) ──
function segundaDaSemana(dia: string): string {
  const d = new Date(`${dia}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface PontoGrafico { chave: string; rotulo: string; cenario: number; atual: number; pago: number; variacao: number }

function agregarVariacao(bloco: Record<string, DiaBloco>, modo: 'mensal' | 'semanal'): PontoGrafico[] {
  const acc: Record<string, PontoGrafico> = {};
  Object.entries(bloco).forEach(([dia, v]) => {
    const chave = modo === 'mensal' ? dia.slice(0, 7) : segundaDaSemana(dia);
    const rotulo = modo === 'mensal'
      ? `${chave.slice(5)}/${chave.slice(2, 4)}`
      : `${chave.slice(8)}/${chave.slice(5, 7)}`;
    const a = acc[chave] ?? { chave, rotulo, cenario: 0, atual: 0, pago: 0, variacao: 0 };
    a.cenario += v.cenario;
    a.atual += v.atual;
    a.pago += v.pago;
    a.variacao += v.variacao;
    acc[chave] = a;
  });
  return Object.values(acc).sort((x, y) => x.chave.localeCompare(y.chave));
}

function ModalGraficoVariacao({ titulo, bloco, onFechar }: { titulo: string; bloco: Record<string, DiaBloco>; onFechar: () => void }) {
  const [modo, setModo] = useState<'mensal' | 'semanal'>('mensal');
  const dados = agregarVariacao(bloco, modo);
  const total = dados.reduce((s, d) => s + d.variacao, 0);
  const compacto = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v) >= 1_000_000 ? `${(Math.abs(v) / 1_000_000).toFixed(1)} mi` : Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 1000)} mil` : Math.abs(v).toFixed(0)}`;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onFechar}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-black">Variação desde a foto — {titulo}</h2>
            <p className="text-xs text-black">
              Total no período: <strong className={total > 0.005 ? 'text-red-700' : total < -0.005 ? 'text-green-700' : 'text-black'}>{fmtSinal(total)}</strong>
              {' '}· <span className="text-red-700">vermelho</span> = saídas aumentaram, <span className="text-green-700">verde</span> = diminuíram. Informativo.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs">
              {(['mensal', 'semanal'] as const).map((m) => (
                <button key={m} onClick={() => setModo(m)} className={`px-3 py-1 ${modo === m ? 'bg-sky-600 text-white' : 'bg-white text-black hover:bg-gray-100'}`}>
                  {m === 'mensal' ? 'Por mês' : 'Por semana'}
                </button>
              ))}
            </div>
            <button onClick={onFechar} className="text-black"><X className="w-5 h-5" /></button>
          </div>
        </div>
        <div className="p-4 flex-1 min-h-0 overflow-y-auto">
          {dados.length === 0 ? (
            <p className="text-sm text-black py-12 text-center">Sem variação no período.</p>
          ) : (
            <>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dados} margin={{ top: 16, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="rotulo" tick={{ fontSize: 11, fill: '#000' }} interval={0} angle={modo === 'semanal' && dados.length > 14 ? -45 : 0} textAnchor={modo === 'semanal' && dados.length > 14 ? 'end' : 'middle'} height={modo === 'semanal' && dados.length > 14 ? 50 : 30} />
                    <YAxis tickFormatter={compacto} tick={{ fontSize: 11, fill: '#000' }} width={64} />
                    <ReferenceLine y={0} stroke="#6b7280" />
                    <Tooltip
                      cursor={{ fill: '#f3f4f6' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as PontoGrafico;
                        return (
                          <div className="bg-white border border-gray-200 rounded-md shadow-md px-3 py-2 text-xs text-black">
                            <div className="font-semibold mb-1">{modo === 'mensal' ? `Mês ${p.rotulo}` : `Semana de ${p.rotulo} (seg)`}</div>
                            <div>Cenário: {fmt(p.cenario)}</div>
                            <div>Agora: {fmt(p.atual)}{p.pago > 0 ? ` (pago ${fmt(p.pago)})` : ''}</div>
                            <div className={`font-bold ${p.variacao > 0.005 ? 'text-red-700' : p.variacao < -0.005 ? 'text-green-700' : ''}`}>Variação: {fmtSinal(p.variacao)}</div>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="variacao" radius={[3, 3, 0, 0]}>
                      {dados.map((d) => <Cell key={d.chave} fill={d.variacao > 0.005 ? '#dc2626' : d.variacao < -0.005 ? '#16a34a' : '#9ca3af'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="w-full text-xs mt-3">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium text-black">{modo === 'mensal' ? 'Mês' : 'Semana (início segunda)'}</th>
                    <th className="text-right px-3 py-1.5 font-medium text-black">Cenário</th>
                    <th className="text-right px-3 py-1.5 font-medium text-black">Agora</th>
                    <th className="text-right px-3 py-1.5 font-medium text-black">Variação</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.map((d, i) => (
                    <tr key={d.chave} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-3 py-1 text-black tabular-nums">{d.rotulo}</td>
                      <td className="px-3 py-1 text-right text-black tabular-nums">{fmt(d.cenario)}</td>
                      <td className="px-3 py-1 text-right text-black tabular-nums">{fmt(d.atual)}</td>
                      <td className={`px-3 py-1 text-right tabular-nums font-semibold ${d.variacao > 0.005 ? 'text-red-700' : d.variacao < -0.005 ? 'text-green-700' : 'text-black'}`}>{fmtSinal(d.variacao)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Painel de resumo (so aparece com um cenario escolhido) ──
export function PainelComparacao({ c }: { c: CenariosState }) {
  // Lista de dias sempre compacta - so abre se a pessoa quiser.
  const [diasAberto, setDiasAberto] = useState(false);
  const [graficoBloco, setGraficoBloco] = useState<'duplicatas' | 'pedidos' | null>(null);
  if (c.selecionadoId === null) return null;
  const comp = c.comparacao;
  const dias = comp
    ? Array.from(new Set([...Object.keys(comp.duplicatas), ...Object.keys(comp.pedidos)]))
        .filter((d) => marcadorDia(comp, d) !== null)
        .sort()
    : [];
  return (
    <div className="px-4 py-3 border-b border-gray-200 bg-sky-50/40 space-y-3">
      {c.comparando && !comp && (
        <div className="flex items-center text-sm text-black"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Comparando com o cenário…</div>
      )}
      {c.erro && <p className="text-xs text-red-700">{c.erro}</p>}
      {comp && (
        <>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-xs text-black">
              <strong>Comparando com “{comp.cenario.nome}”</strong> — foto de {comp.cenario.criadoEm}
              {comp.cenario.criadoPor ? ` por ${comp.cenario.criadoPor}` : ''}, período {dataBR(comp.cenario.dtInicio)} a {dataBR(comp.cenario.dtFim)}.
              Calculado em {comp.geradoEm}. <em>Só informativo: não entra no saldo do dia nem no acumulado.</em>
            </p>
            <button onClick={() => c.selecionar(null)} className="text-xs font-medium text-black border border-gray-300 rounded px-2 py-1 hover:bg-white flex items-center gap-1">
              <X className="w-3.5 h-3.5" /> Fechar comparação
            </button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <CartaoResumo titulo="Contas a pagar (duplicatas)" bloco={comp.duplicatas} rotulos={ROTULO_DUP} onGrafico={() => setGraficoBloco('duplicatas')} />
            <CartaoResumo titulo="Pedidos de compra" bloco={comp.pedidos} rotulos={ROTULO_PED} onGrafico={() => setGraficoBloco('pedidos')} />
          </div>
          {graficoBloco && (
            <ModalGraficoVariacao
              titulo={graficoBloco === 'duplicatas' ? 'Contas a pagar' : 'Pedidos de compra'}
              bloco={graficoBloco === 'duplicatas' ? comp.duplicatas : comp.pedidos}
              onFechar={() => setGraficoBloco(null)}
            />
          )}
          {dias.length > 0 && (
            <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
              <button
                onClick={() => setDiasAberto((v) => !v)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-black hover:bg-gray-50 text-left"
              >
                {diasAberto ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                Dias que mudaram ({dias.length}) {diasAberto ? '' : '— clique para ver'}
              </button>
              {diasAberto && (
              <div className="max-h-56 overflow-y-auto border-t border-gray-200">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-3 py-1.5 font-medium text-black">Dia que mudou</th>
                      <th className="text-right px-3 py-1.5 font-medium text-black">Contas: cenário</th>
                      <th className="text-right px-3 py-1.5 font-medium text-black">Contas: agora</th>
                      <th className="text-right px-3 py-1.5 font-medium text-black">Variação</th>
                      <th className="text-right px-3 py-1.5 font-medium text-black">Pedidos: variação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dias.map((d, i) => {
                      const a = comp.duplicatas[d];
                      const p = comp.pedidos[d];
                      return (
                        <tr key={d} onClick={() => c.setDiaDetalhe(d)} className={`cursor-pointer hover:bg-rose-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                          <td className="px-3 py-1.5 text-black tabular-nums">{dataBR(d)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-black">{fmt(a?.cenario ?? 0)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-black">{fmt(a?.atual ?? 0)}{a && a.pago > 0 ? <span className="text-gray-500"> (pago {fmt(a.pago)})</span> : null}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${(a?.variacao ?? 0) > 0.005 ? 'text-red-700' : (a?.variacao ?? 0) < -0.005 ? 'text-green-700' : 'text-black'}`}>{fmtSinal(a?.variacao ?? 0)}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${(p?.variacao ?? 0) > 0.005 ? 'text-red-700' : (p?.variacao ?? 0) < -0.005 ? 'text-green-700' : 'text-black'}`}>{p ? fmtSinal(p.variacao) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Modal: o que mudou num dia ──
export function ModalDiaCenario({ c }: { c: CenariosState }) {
  const dia = c.diaDetalhe;
  const comp = c.comparacao;
  if (!dia || !comp) return null;
  const itens = comp.itens
    .filter((i) => i.diaCenario === dia || i.diaAtual === dia)
    .sort((a, b) => Math.abs(b.valorAtual - b.valorCenario) - Math.abs(a.valorAtual - a.valorCenario));
  const dup = comp.duplicatas[dia];
  const ped = comp.pedidos[dia];
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => c.setDiaDetalhe(null)}>
      <div className="bg-white rounded-lg shadow-xl max-w-[1400px] w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-black">O que mudou em {dataBR(dia)} — cenário “{comp.cenario.nome}”</h2>
            <p className="text-xs text-black">
              Contas a pagar: {fmt(dup?.cenario ?? 0)} → {fmt(dup?.atual ?? 0)} (aberto {fmt(dup?.aberto ?? 0)} + pago {fmt(dup?.pago ?? 0)}) ·
              Pedidos: {fmt(ped?.cenario ?? 0)} → {fmt(ped?.atual ?? 0)}. Informativo: não entra no saldo.
            </p>
          </div>
          <button onClick={() => c.setDiaDetalhe(null)} className="text-black"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto flex-1">
          {itens.length === 0 ? (
            <p className="text-sm text-black py-12 text-center">Nenhum item mudou nesse dia (o total do dia pode ter mudado só por itens inalterados).</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-black">O que aconteceu</th>
                  <th className="text-left px-3 py-2 font-medium text-black">Tipo</th>
                  <th className="text-left px-3 py-2 font-medium text-black">Documento</th>
                  <th className="text-left px-3 py-2 font-medium text-black">Fornecedor</th>
                  <th className="text-right px-3 py-2 font-medium text-black">Dia na foto</th>
                  <th className="text-right px-3 py-2 font-medium text-black">Dia agora</th>
                  <th className="text-right px-3 py-2 font-medium text-black">Na foto</th>
                  <th className="text-right px-3 py-2 font-medium text-black">Agora (total)</th>
                  <th className="text-right px-3 py-2 font-medium text-black">Em aberto</th>
                  <th className="text-right px-3 py-2 font-medium text-black">Pago</th>
                  <th className="text-left px-4 py-2 font-medium text-black">Situação atual</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((i, idx) => (
                  <tr key={`${i.tipo}-${i.documento}-${idx}`} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${COR_ITEM[i.categoria] ?? 'bg-gray-100 text-black'}`}>{ROTULO_ITEM[i.categoria] ?? i.categoria}</span>
                    </td>
                    <td className="px-3 py-1.5 text-black whitespace-nowrap">{i.tipo === 'duplicata' ? 'Conta a pagar' : 'Pedido'}</td>
                    <td className="px-3 py-1.5 text-black tabular-nums whitespace-nowrap">{i.documento}</td>
                    <td className="px-3 py-1.5 text-black">{i.fornecedor ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right text-black tabular-nums whitespace-nowrap">{dataBR(i.diaCenario)}</td>
                    <td className="px-3 py-1.5 text-right text-black tabular-nums whitespace-nowrap">{dataBR(i.diaAtual)}</td>
                    <td className="px-3 py-1.5 text-right text-black tabular-nums whitespace-nowrap">{fmt(i.valorCenario)}</td>
                    <td className="px-3 py-1.5 text-right text-black tabular-nums whitespace-nowrap">{fmt(i.valorAtual)}</td>
                    <td className="px-3 py-1.5 text-right text-sky-700 tabular-nums whitespace-nowrap">{i.aberto > 0 ? fmt(i.aberto) : '—'}</td>
                    <td className="px-3 py-1.5 text-right text-emerald-700 tabular-nums whitespace-nowrap">{i.pago > 0 ? fmt(i.pago) : '—'}</td>
                    <td className="px-4 py-1.5 text-black whitespace-nowrap">{i.situacao}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
