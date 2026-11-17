'use client';

import React, { useEffect, useState } from 'react';
import { PackageX, Loader2, ChevronDown } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface MotivoQuebra {
  cdMotivo: number;
  motivo: string;
  ehQuebra: boolean;
  itens: number;
  pedidos: number;
  qtd: number;
  valor: number;
  pctDoTotal: number | null;
  pctFaturamento: number | null;
}

interface DiaQuebra {
  data: string;
  itens: number;
  qtd: number;
  valor: number;
  valorQuebra: number;
  faturamento: number;
  pctFaturamento: number | null;
}

interface ClienteQuebra {
  cdCliente: number | null;
  cliente: string;
  pedidos: number;
  itens: number;
  qtd: number;
  valor: number;
  pctDoTotal: number | null;
}

interface MesQuebra {
  mes: string;
  valor: number;
  qtd: number;
  valorQuebra: number;
  faturamento: number;
  pctFaturamento: number | null;
}

interface OpcaoMotivo {
  cdMotivo: number;
  motivo: string;
  ehQuebra: boolean;
}

interface DadosQuebra {
  dataInicio: string;
  dataFim: string;
  somenteQuebra: boolean;
  consolidado: {
    itens: number;
    pedidos: number;
    qtd: number;
    valor: number;
    faturamentoFabrica: number;
    pctFaturamento: number | null;
    valorQuebra: number;
    qtdQuebra: number;
    pctQuebraFaturamento: number | null;
  };
  porMotivo: MotivoQuebra[];
  porData: DiaQuebra[];
  porCliente: ClienteQuebra[];
  porMes: MesQuebra[];
}

const fmtMoeda = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtNum = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const fmtPct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const fmtData = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('pt-BR');
const rotuloValor = (v: unknown) => {
  const n = Number(v);
  if (!n) return '';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
};
const NOMES_MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (mes: string) => `${NOMES_MESES[Number(mes.slice(5, 7)) - 1]}/${mes.slice(2, 4)}`;
const isoHoje = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isoPrimeiroDiaMes = () => `${isoHoje().slice(0, 8)}01`;

function Cartao({ rotulo, valor, detalhe, destaque }: { rotulo: string; valor: string; detalhe?: string; destaque?: boolean }) {
  return (
    <div className={`rounded-lg shadow-md p-4 ${destaque ? 'bg-rose-50 border border-rose-200' : 'bg-white'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{rotulo}</p>
      <p className="text-2xl font-bold text-brand-dark mt-1">{valor}</p>
      {detalhe && <p className="text-xs text-gray-500 mt-1">{detalhe}</p>}
    </div>
  );
}

export default function QuebraPedidosPage() {
  const [dataInicio, setDataInicio] = useState(isoPrimeiroDiaMes());
  const [dataFim, setDataFim] = useState(isoHoje());
  const [motivosDisponiveis, setMotivosDisponiveis] = useState<OpcaoMotivo[]>([]);
  const [motivosSelecionados, setMotivosSelecionados] = useState<Set<number>>(new Set());
  const [filtroMotivoAberto, setFiltroMotivoAberto] = useState(false);
  const [ate10, setAte10] = useState(false);
  const [dados, setDados] = useState<DadosQuebra | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function consultar(ate10Forcado?: boolean) {
    const usarAte10 = ate10Forcado ?? ate10;
    if (!dataInicio || !dataFim) {
      setErro('Informe a data inicial e a final.');
      return;
    }
    if (dataFim < dataInicio) {
      setErro('A data final não pode ser anterior à inicial.');
      return;
    }
    setLoading(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ dataInicio, dataFim });
      if (usarAte10) params.set('ate10', 'true');
      // Todos marcados (ou nenhum) = sem filtro de motivo.
      if (motivosSelecionados.size > 0 && motivosSelecionados.size < motivosDisponiveis.length) {
        params.set('motivos', Array.from(motivosSelecionados).join(','));
      }
      const response = await fetch(`/api/quebra-pedidos?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) {
        setErro(`Erro do backend: ${data.detail || data.error || 'Erro desconhecido'}`);
        return;
      }
      setDados(data);
    } catch (e) {
      console.error('Erro ao buscar quebra de pedidos:', e);
      setErro('Erro ao buscar os dados. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  // So a lista de motivos (pro filtro) carrega ao abrir; os dados so vem ao clicar em Consultar.
  useEffect(() => {
    fetch('/api/quebra-pedidos/motivos', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        const lista: OpcaoMotivo[] = d.motivos || [];
        setMotivosDisponiveis(lista);
        setMotivosSelecionados(new Set(lista.map((m) => m.cdMotivo)));
      })
      .catch((e) => console.error('Erro ao buscar motivos:', e));
  }, []);

  function toggleMotivo(cd: number) {
    setMotivosSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(cd)) novo.delete(cd);
      else novo.add(cd);
      return novo;
    });
  }

  const c = dados?.consolidado;
  const grafico = (dados?.porMes ?? []).map((m) => ({ mes: rotuloMes(m.mes), valor: m.valor, valorQuebra: m.valorQuebra, pct: m.pctFaturamento, faturamento: m.faturamento }));
  const totalDatas = (dados?.porData ?? []).reduce(
    (acc, d) => ({ itens: acc.itens + d.itens, qtd: acc.qtd + d.qtd, valor: acc.valor + d.valor, faturamento: acc.faturamento + d.faturamento }),
    { itens: 0, qtd: 0, valor: 0, faturamento: 0 },
  );
  const totalMotivos = (dados?.porMotivo ?? []).reduce(
    (acc, m) => ({ itens: acc.itens + m.itens, qtd: acc.qtd + m.qtd, valor: acc.valor + m.valor }),
    { itens: 0, qtd: 0, valor: 0 },
  );

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 bg-rose-100 rounded-lg">
          <PackageX className="w-6 h-6 text-rose-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Quebra de Pedidos</h1>
          <p className="text-sm text-gray-500">
            Itens de pedido da fábrica cancelados, por motivo, por data e consolidados, com o percentual sobre o faturamento da fábrica.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-sm text-gray-600">
            <span className="block text-xs font-medium mb-1">Data inicial</span>
            <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
          </label>
          <label className="text-sm text-gray-600">
            <span className="block text-xs font-medium mb-1">Data final</span>
            <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
          </label>
          <div className="relative">
            <span className="block text-xs font-medium mb-1 text-gray-600">Motivo</span>
            <button
              type="button"
              onClick={() => setFiltroMotivoAberto((v) => !v)}
              className="min-w-[220px] flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50"
            >
              {motivosSelecionados.size === motivosDisponiveis.length ? 'Todos os motivos' : `Motivos (${motivosSelecionados.size}/${motivosDisponiveis.length})`}
              <ChevronDown className="w-4 h-4 text-gray-500" />
            </button>
            {filtroMotivoAberto && (
              <div className="absolute z-30 mt-1 w-80 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-xl p-2">
                <div className="flex justify-between px-1 pb-1 mb-1 border-b border-gray-100">
                  <button type="button" className="text-xs font-medium text-purple-700 hover:text-purple-900" onClick={() => setMotivosSelecionados(new Set(motivosDisponiveis.map((m) => m.cdMotivo)))}>
                    Todos
                  </button>
                  <button type="button" className="text-xs font-medium text-gray-600 hover:text-gray-900" onClick={() => setMotivosSelecionados(new Set(motivosDisponiveis.filter((m) => m.ehQuebra).map((m) => m.cdMotivo)))}>
                    Só quebra de pedidos
                  </button>
                  <button type="button" className="text-xs font-medium text-gray-600 hover:text-gray-900" onClick={() => setMotivosSelecionados(new Set())}>
                    Nenhum
                  </button>
                </div>
                {motivosDisponiveis.map((m) => (
                  <label key={m.cdMotivo} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-gray-50 rounded cursor-pointer">
                    <input type="checkbox" checked={motivosSelecionados.has(m.cdMotivo)} onChange={() => toggleMotivo(m.cdMotivo)} />
                    {m.cdMotivo} - {m.motivo}
                  </label>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 pb-2 cursor-pointer" title="Só conta como quebra o pedido que teve até 10% das peças canceladas (ex.: 10 de 100 entra; 11 de 100 não)">
            <input
              type="checkbox"
              checked={ate10}
              onChange={(e) => {
                setAte10(e.target.checked);
                if (dados) consultar(e.target.checked);
              }}
            />
            Só pedidos com até 10% cancelado
          </label>
          <button
            onClick={() => consultar()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Consultar
          </button>
        </div>
        {erro && <p className="text-sm text-red-600 mt-3">{erro}</p>}
        <p className="text-xs text-gray-400 mt-3">
          Cancelamentos pela data em que foram registrados (último cancelamento de cada item), operações 52 e 1. Valor = valor unitário × quantidade cancelada.
          O percentual usa o faturamento da fábrica no mesmo período.
        </p>
      </div>

      {!dados && !loading && !erro && (
        <div className="bg-white rounded-lg shadow-md p-8 text-center text-sm text-gray-500">
          Escolha o período e o motivo e clique em Consultar.
        </div>
      )}

      {loading && !dados && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
        </div>
      )}

      {dados && c && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Cartao rotulo="Valor cancelado" valor={fmtMoeda(c.valor)} detalhe={`${fmtPct(c.pctFaturamento)} do faturamento da fábrica`} destaque />
            <Cartao rotulo="Quantidade cancelada" valor={fmtNum(c.qtd)} detalhe={`${fmtNum(c.itens)} itens em ${fmtNum(c.pedidos)} pedidos`} />
            <Cartao rotulo="Faturamento da fábrica" valor={fmtMoeda(c.faturamentoFabrica)} detalhe={`${fmtData(dados.dataInicio)} a ${fmtData(dados.dataFim)}`} />
            <Cartao
              rotulo="Quebra de pedidos (motivo 6)"
              valor={fmtMoeda(c.valorQuebra)}
              detalhe={`${fmtPct(c.pctQuebraFaturamento)} do faturamento · ${fmtNum(c.qtdQuebra)} peças`}
            />
          </div>

          <div className="bg-white rounded-lg shadow-md p-4">
            <h2 className="text-sm font-bold text-brand-dark">Valor cancelado por mês</h2>
            <p className="text-xs text-gray-500 mb-3">Meses do ano atual até o último mês fechado (não depende das datas do filtro; respeita o filtro de motivo).</p>
            {grafico.length === 0 ? (
              <p className="text-sm text-gray-500">Ainda não há mês fechado neste ano.</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={grafico} margin={{ top: 24, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="mes" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                    <Tooltip
                      formatter={(v, nome) => [fmtMoeda(Number(v)), nome === 'valorQuebra' ? 'Quebra de pedidos' : 'Total cancelado']}
                      labelFormatter={(rotulo, itens) => {
                        const p = itens?.[0]?.payload as { pct: number | null; faturamento: number } | undefined;
                        return p ? `${rotulo} · ${fmtPct(p.pct)} do faturamento (${fmtMoeda(p.faturamento)})` : String(rotulo);
                      }}
                    />
                    <Bar dataKey="valor" fill="#c5949d" name="valor">
                      <LabelList dataKey="valor" position="top" formatter={rotuloValor} style={{ fontSize: 11, fill: '#4b5563' }} />
                    </Bar>
                    <Bar dataKey="valorQuebra" fill="#8B6E5A" name="valorQuebra">
                      <LabelList dataKey="valorQuebra" position="top" formatter={rotuloValor} style={{ fontSize: 11, fill: '#8B6E5A' }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow-md p-4 overflow-x-auto">
              <h2 className="text-sm font-bold text-brand-dark mb-3">Por motivo</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-2">Motivo</th>
                    <th className="py-2 px-2 text-right">Pedidos</th>
                    <th className="py-2 px-2 text-right">Qtd. cancelada</th>
                    <th className="py-2 px-2 text-right">Valor</th>
                    <th className="py-2 px-2 text-right">% do total</th>
                    <th className="py-2 pl-2 text-right">% do fat.</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.porMotivo.length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-gray-500">Nenhum cancelamento no período.</td></tr>
                  )}
                  {dados.porMotivo.map((m) => (
                    <tr key={m.cdMotivo} className={`border-b border-gray-100 ${m.ehQuebra ? 'bg-rose-50 font-semibold' : ''}`}>
                      <td className="py-2 pr-2">{m.cdMotivo} - {m.motivo}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(m.pedidos)}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(m.qtd)}</td>
                      <td className="py-2 px-2 text-right whitespace-nowrap">{fmtMoeda(m.valor)}</td>
                      <td className="py-2 px-2 text-right">{fmtPct(m.pctDoTotal)}</td>
                      <td className="py-2 pl-2 text-right">{fmtPct(m.pctFaturamento)}</td>
                    </tr>
                  ))}
                </tbody>
                {dados.porMotivo.length > 0 && (
                  <tfoot>
                    <tr className="font-bold border-t-2 border-gray-300">
                      <td className="py-2 pr-2">Consolidado</td>
                      <td className="py-2 px-2 text-right">{fmtNum(c.pedidos)}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(totalMotivos.qtd)}</td>
                      <td className="py-2 px-2 text-right whitespace-nowrap">{fmtMoeda(totalMotivos.valor)}</td>
                      <td className="py-2 px-2 text-right">{totalMotivos.valor ? '100,00%' : '-'}</td>
                      <td className="py-2 pl-2 text-right">{fmtPct(c.pctFaturamento)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="bg-white rounded-lg shadow-md p-4 overflow-x-auto">
              <h2 className="text-sm font-bold text-brand-dark mb-3">Por cliente</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-2">Cliente</th>
                    <th className="py-2 px-2 text-right">Pedidos</th>
                    <th className="py-2 px-2 text-right">Itens</th>
                    <th className="py-2 px-2 text-right">Qtd. cancelada</th>
                    <th className="py-2 px-2 text-right">Valor</th>
                    <th className="py-2 pl-2 text-right">% do total cancelado</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.porCliente.length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-gray-500">Nenhum cancelamento no período.</td></tr>
                  )}
                  {dados.porCliente.map((cl) => (
                    <tr key={cl.cdCliente ?? 'sem'} className="border-b border-gray-100">
                      <td className="py-2 pr-2">{cl.cdCliente} - {cl.cliente}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(cl.pedidos)}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(cl.itens)}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(cl.qtd)}</td>
                      <td className="py-2 px-2 text-right whitespace-nowrap">{fmtMoeda(cl.valor)}</td>
                      <td className="py-2 pl-2 text-right">{fmtPct(cl.pctDoTotal)}</td>
                    </tr>
                  ))}
                </tbody>
                {dados.porCliente.length > 0 && (
                  <tfoot>
                    <tr className="font-bold border-t-2 border-gray-300">
                      <td className="py-2 pr-2">Consolidado</td>
                      <td className="py-2 px-2 text-right">{fmtNum(c.pedidos)}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(c.itens)}</td>
                      <td className="py-2 px-2 text-right">{fmtNum(c.qtd)}</td>
                      <td className="py-2 px-2 text-right whitespace-nowrap">{fmtMoeda(c.valor)}</td>
                      <td className="py-2 pl-2 text-right">{fmtPct(100)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
