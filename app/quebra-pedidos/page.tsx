'use client';

import React, { useEffect, useRef, useState } from 'react';
import { carregarFiltro, salvarFiltro } from '../utils/persistirFiltro';
import { PackageX, Loader2, ChevronDown, RefreshCw, ArrowUp, ArrowDown } from 'lucide-react';
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

interface GrupoQuebra {
  nome: string;
  pedidos: number;
  itens: number;
  qtd: number;
  valor: number;
  valorQuebra: number;
  pctDoTotal: number | null;
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
  porLinha?: GrupoQuebra[];
  porGrupo?: GrupoQuebra[];
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

const MAX_BARRAS_DIMENSAO = 15;

// Grafico de barras horizontais (valor cancelado e parte de quebra, motivo 6) por linha ou grupo.
function GraficoDimensao({ titulo, itens }: { titulo: string; itens: GrupoQuebra[] }) {
  const top = itens.slice(0, MAX_BARRAS_DIMENSAO);
  const resto = itens.slice(MAX_BARRAS_DIMENSAO);
  const dadosGrafico = top.map((g) => ({ nome: g.nome, valor: g.valor, valorQuebra: g.valorQuebra, pct: g.pctDoTotal }));
  if (resto.length > 0) {
    dadosGrafico.push({
      nome: `Outros (${resto.length})`,
      valor: resto.reduce((a, g) => a + g.valor, 0),
      valorQuebra: resto.reduce((a, g) => a + g.valorQuebra, 0),
      pct: resto.reduce((a, g) => a + (g.pctDoTotal ?? 0), 0),
    });
  }
  function RotuloDimensao(props: any) {
    const { x, y, width, height, value, index } = props;
    if (!Number(value)) return null;
    const pct = dadosGrafico[index]?.pct;
    return (
      <text x={Number(x) + Number(width) + 6} y={Number(y) + Number(height) / 2 + 4} fontSize={11} fill="#000000">
        {rotuloValor(value)}{pct != null ? ` · ${fmtPct(pct)}` : ''}
      </text>
    );
  }
  return (
    <div className="bg-white rounded-lg shadow-md p-4">
      <h2 className="text-sm font-bold text-brand-dark">{titulo}</h2>
      <p className="text-xs text-black mb-3">Período e filtros da tela. Rótulo: valor · % do total cancelado. Marrom = quebra de pedidos (motivo 6).</p>
      {dadosGrafico.length === 0 ? (
        <p className="text-sm text-black">Nenhum cancelamento no período.</p>
      ) : (
        <div style={{ height: Math.max(180, dadosGrafico.length * 44 + 30) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dadosGrafico} layout="vertical" margin={{ top: 4, right: 90, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: '#000000' }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
              <YAxis type="category" dataKey="nome" width={130} tick={{ fontSize: 11, fill: '#000000' }} interval={0} />
              <Tooltip formatter={(v, nome) => [fmtMoeda(Number(v)), nome === 'valorQuebra' ? 'Quebra de pedidos' : 'Total cancelado']} />
              <Bar dataKey="valor" fill="#c5949d" name="valor" barSize={14}>
                <LabelList dataKey="valor" content={RotuloDimensao} />
              </Bar>
              <Bar dataKey="valorQuebra" fill="#8B6E5A" name="valorQuebra" barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function Cartao({ rotulo, valor, detalhe, destaque }: { rotulo: string; valor: string; detalhe?: string; destaque?: boolean }) {
  return (
    <div className={`rounded-lg shadow-md p-4 ${destaque ? 'bg-rose-50 border border-rose-200' : 'bg-white'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-black">{rotulo}</p>
      <p className="text-2xl font-bold text-brand-dark mt-1">{valor}</p>
      {detalhe && <p className="text-xs text-black mt-1">{detalhe}</p>}
    </div>
  );
}

type Ord = { col: string; asc: boolean } | null;

function ordenar<T>(lista: T[], ord: Ord): T[] {
  if (!ord) return lista;
  return [...lista].sort((a, b) => {
    const x = (a as any)[ord.col];
    const y = (b as any)[ord.col];
    const r = typeof x === 'string' || typeof y === 'string'
      ? String(x ?? '').localeCompare(String(y ?? ''), 'pt-BR')
      : (x ?? -Infinity) - (y ?? -Infinity);
    return ord.asc ? r : -r;
  });
}

function proximaOrd(atual: Ord, col: string): Ord {
  if (atual?.col === col) return { col, asc: !atual.asc };
  return { col, asc: col === 'motivo' || col === 'cliente' };
}

function Th({ rotulo, col, ord, setOrd, className }: { rotulo: string; col: string; ord: Ord; setOrd: (o: Ord) => void; className: string }) {
  const ativo = ord?.col === col;
  const direita = className.includes('text-right');
  return (
    <th className={`${className} cursor-pointer select-none hover:bg-gray-50`} onClick={() => setOrd(proximaOrd(ord, col))} title="Clique para ordenar">
      <span className={`inline-flex items-center gap-1 ${direita ? 'flex-row-reverse' : ''}`}>
        {rotulo}
        {ativo ? (ord!.asc ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null}
      </span>
    </th>
  );
}

// Cache das consultas (sobrevive a recarregar a pagina): "Consultar" usa o que ja foi
// buscado; o botao de atualizar ignora e busca de novo.
const CACHE_PREFIXO = 'quebra-pedidos:v2:';
function lerCache(chave: string): { dados: any; em: string } | null {
  try {
    const bruto = localStorage.getItem(CACHE_PREFIXO + chave);
    return bruto ? JSON.parse(bruto) : null;
  } catch {
    return null;
  }
}
function gravarCache(chave: string, dados: any, em: string) {
  try {
    localStorage.setItem(CACHE_PREFIXO + chave, JSON.stringify({ dados, em }));
  } catch {
    // sem espaco/bloqueado: segue sem cache
  }
}

const CHAVE_FILTROS = 'quebra_pedidos_filtros';

interface FiltrosSalvos {
  dataInicio: string;
  dataFim: string;
  motivos: number[] | null; // null = todos
  ate10: boolean;
  ordMotivo: Ord;
  ordCliente: Ord;
}

export default function QuebraPedidosPage() {
  const [dataInicio, setDataInicio] = useState(isoPrimeiroDiaMes());
  const [dataFim, setDataFim] = useState(isoHoje());
  const [motivosDisponiveis, setMotivosDisponiveis] = useState<OpcaoMotivo[]>([]);
  const [motivosSelecionados, setMotivosSelecionados] = useState<Set<number>>(new Set());
  const [filtroMotivoAberto, setFiltroMotivoAberto] = useState(false);
  const [ate10, setAte10] = useState(false);
  const [atualizadoEm, setAtualizadoEm] = useState<string | null>(null);
  const [ordMotivo, setOrdMotivo] = useState<Ord>(null);
  const [ordCliente, setOrdCliente] = useState<Ord>(null);
  const [dados, setDados] = useState<DadosQuebra | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const motivosSalvosRef = useRef<number[] | null>(null);
  const [filtrosRestaurados, setFiltrosRestaurados] = useState(false);

  async function consultar(ate10Forcado?: boolean, ignorarCache = false) {
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
      const chave = params.toString();
      if (!ignorarCache) {
        const emCache = lerCache(chave);
        if (emCache) {
          setDados(emCache.dados);
          setAtualizadoEm(emCache.em);
          return;
        }
      }
      const response = await fetch(`/api/quebra-pedidos?${chave}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) {
        setErro(`Erro do backend: ${data.detail || data.error || 'Erro desconhecido'}`);
        return;
      }
      const agora = new Date().toLocaleString('pt-BR');
      gravarCache(chave, data, agora);
      setDados(data);
      setAtualizadoEm(agora);
    } catch (e) {
      console.error('Erro ao buscar quebra de pedidos:', e);
      setErro('Erro ao buscar os dados. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  // So a lista de motivos (pro filtro) carrega ao abrir; os dados so vem ao clicar em Consultar.
  useEffect(() => {
    const salvo = carregarFiltro<FiltrosSalvos>(CHAVE_FILTROS);
    if (salvo) {
      if (salvo.dataInicio) setDataInicio(salvo.dataInicio);
      if (salvo.dataFim) setDataFim(salvo.dataFim);
      if (typeof salvo.ate10 === 'boolean') setAte10(salvo.ate10);
      if (salvo.ordMotivo) setOrdMotivo(salvo.ordMotivo);
      if (salvo.ordCliente) setOrdCliente(salvo.ordCliente);
      motivosSalvosRef.current = Array.isArray(salvo.motivos) ? salvo.motivos : null;
    }
    fetch('/api/quebra-pedidos/motivos', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        const lista: OpcaoMotivo[] = d.motivos || [];
        setMotivosDisponiveis(lista);
        const salvos = motivosSalvosRef.current;
        const validos = salvos ? lista.filter((m) => salvos.includes(m.cdMotivo)) : lista;
        setMotivosSelecionados(new Set((validos.length ? validos : lista).map((m) => m.cdMotivo)));
      })
      .catch((e) => console.error('Erro ao buscar motivos:', e))
      .finally(() => setFiltrosRestaurados(true));
  }, []);

  // Guarda os ultimos filtros usados (so depois de restaurar, pra nao sobrescrever com o padrao).
  useEffect(() => {
    if (!filtrosRestaurados) return;
    const todos = motivosSelecionados.size === motivosDisponiveis.length;
    salvarFiltro<FiltrosSalvos>(CHAVE_FILTROS, {
      dataInicio,
      dataFim,
      motivos: todos ? null : Array.from(motivosSelecionados),
      ate10,
      ordMotivo,
      ordCliente,
    });
  }, [filtrosRestaurados, dataInicio, dataFim, motivosSelecionados, motivosDisponiveis, ate10, ordMotivo, ordCliente]);

  function toggleMotivo(cd: number) {
    setMotivosSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(cd)) novo.delete(cd);
      else novo.add(cd);
      return novo;
    });
  }

  const c = dados?.consolidado;
  const grafico = (dados?.porMes ?? []).map((m) => ({ mes: rotuloMes(m.mes), valor: m.valor, valorQuebra: m.valorQuebra, pct: m.pctFaturamento, pctQuebra: m.faturamento ? (m.valorQuebra / m.faturamento) * 100 : null, faturamento: m.faturamento }));
  // Rotulo em duas linhas sobre a barra: % do faturamento da fabrica (em cima) e valor.
  const rotuloBarra = (cor: string, campoPct: 'pct' | 'pctQuebra') => function RotuloBarra(props: any) {
    const { x, y, width, value, index } = props;
    if (!Number(value)) return null;
    const pct = grafico[index]?.[campoPct];
    const cx = Number(x) + Number(width) / 2;
    return (
      <text x={cx} textAnchor="middle" fontSize={11} fill={cor}>
        <tspan x={cx} y={Number(y) - 16} fontWeight={600}>{pct != null ? fmtPct(pct) : ''}</tspan>
        <tspan x={cx} y={Number(y) - 4}>{rotuloValor(value)}</tspan>
      </text>
    );
  };
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
          <p className="text-sm text-black">
            Itens de pedido da fábrica cancelados, por motivo, por data e consolidados, com o percentual sobre o faturamento da fábrica.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-sm text-black">
            <span className="block text-xs font-medium mb-1">Data inicial</span>
            <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
          </label>
          <label className="text-sm text-black">
            <span className="block text-xs font-medium mb-1">Data final</span>
            <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm" />
          </label>
          <div className="relative">
            <span className="block text-xs font-medium mb-1 text-black">Motivo</span>
            <button
              type="button"
              onClick={() => setFiltroMotivoAberto((v) => !v)}
              className="min-w-[220px] flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50"
            >
              {motivosSelecionados.size === motivosDisponiveis.length ? 'Todos os motivos' : `Motivos (${motivosSelecionados.size}/${motivosDisponiveis.length})`}
              <ChevronDown className="w-4 h-4 text-black" />
            </button>
            {filtroMotivoAberto && (
              <div className="absolute z-30 mt-1 w-80 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-xl p-2">
                <div className="flex justify-between px-1 pb-1 mb-1 border-b border-gray-100">
                  <button type="button" className="text-xs font-medium text-purple-700 hover:text-purple-900" onClick={() => setMotivosSelecionados(new Set(motivosDisponiveis.map((m) => m.cdMotivo)))}>
                    Todos
                  </button>
                  <button type="button" className="text-xs font-medium text-black hover:text-black" onClick={() => setMotivosSelecionados(new Set(motivosDisponiveis.filter((m) => m.ehQuebra).map((m) => m.cdMotivo)))}>
                    Só quebra de pedidos
                  </button>
                  <button type="button" className="text-xs font-medium text-black hover:text-black" onClick={() => setMotivosSelecionados(new Set())}>
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
          <label className="flex items-center gap-2 text-sm text-black pb-2 cursor-pointer" title="Só conta como quebra o pedido que teve até 10% das peças canceladas (ex.: 10 de 100 entra; 11 de 100 não)">
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
          <button
            onClick={() => consultar(undefined, true)}
            disabled={loading}
            title="Atualizar dados (ignora o cache e busca de novo)"
            className="p-2 bg-gray-100 text-black rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {atualizadoEm && <span className="text-xs text-black pb-2">Atualizado em {atualizadoEm}</span>}
        </div>
        {erro && <p className="text-sm text-red-600 mt-3">{erro}</p>}
        <p className="text-xs text-black mt-3">
          Cancelamentos pela data em que foram registrados (último cancelamento de cada item), operações 52 e 1. Valor = valor unitário × quantidade cancelada.
          O percentual usa o faturamento da fábrica no mesmo período.
        </p>
      </div>

      {!dados && !loading && !erro && (
        <div className="bg-white rounded-lg shadow-md p-8 text-center text-sm text-black">
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
            <p className="text-xs text-black mb-3">Meses do ano atual até o último mês fechado (não depende das datas do filtro; respeita o filtro de motivo).</p>
            {grafico.length === 0 ? (
              <p className="text-sm text-black">Ainda não há mês fechado neste ano.</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={grafico} margin={{ top: 36, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="mes" tick={{ fontSize: 12, fill: '#000000' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#000000' }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                    <Tooltip
                      formatter={(v, nome) => [fmtMoeda(Number(v)), nome === 'valorQuebra' ? 'Quebra de pedidos' : 'Total cancelado']}
                      labelFormatter={(rotulo, itens) => {
                        const p = itens?.[0]?.payload as { pct: number | null; faturamento: number } | undefined;
                        return p ? `${rotulo} · ${fmtPct(p.pct)} do faturamento (${fmtMoeda(p.faturamento)})` : String(rotulo);
                      }}
                    />
                    <Bar dataKey="valor" fill="#c5949d" name="valor">
                      <LabelList dataKey="valor" content={rotuloBarra('#000000', 'pct')} />
                    </Bar>
                    <Bar dataKey="valorQuebra" fill="#8B6E5A" name="valorQuebra">
                      <LabelList dataKey="valorQuebra" content={rotuloBarra('#8B6E5A', 'pctQuebra')} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <GraficoDimensao titulo="Valor cancelado por linha" itens={dados.porLinha ?? []} />
            <GraficoDimensao titulo="Valor cancelado por grupo" itens={dados.porGrupo ?? []} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow-md p-4 overflow-x-auto">
              <h2 className="text-sm font-bold text-brand-dark mb-3">Por motivo</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-black border-b border-gray-200">
                    <Th rotulo="Motivo" col="motivo" ord={ordMotivo} setOrd={setOrdMotivo} className="py-2 pr-2" />
                    <Th rotulo="Pedidos" col="pedidos" ord={ordMotivo} setOrd={setOrdMotivo} className="py-2 px-2 text-right" />
                    <Th rotulo="Qtd. cancelada" col="qtd" ord={ordMotivo} setOrd={setOrdMotivo} className="py-2 px-2 text-right" />
                    <Th rotulo="Valor" col="valor" ord={ordMotivo} setOrd={setOrdMotivo} className="py-2 px-2 text-right" />
                    <Th rotulo="% do total" col="pctDoTotal" ord={ordMotivo} setOrd={setOrdMotivo} className="py-2 px-2 text-right" />
                    <Th rotulo="% do fat." col="pctFaturamento" ord={ordMotivo} setOrd={setOrdMotivo} className="py-2 pl-2 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {dados.porMotivo.length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-black">Nenhum cancelamento no período.</td></tr>
                  )}
                  {ordenar(dados.porMotivo, ordMotivo).map((m) => (
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
                  <tr className="text-left text-xs text-black border-b border-gray-200">
                    <Th rotulo="Cliente" col="cliente" ord={ordCliente} setOrd={setOrdCliente} className="py-2 pr-2" />
                    <Th rotulo="Pedidos" col="pedidos" ord={ordCliente} setOrd={setOrdCliente} className="py-2 px-2 text-right" />
                    <Th rotulo="Itens" col="itens" ord={ordCliente} setOrd={setOrdCliente} className="py-2 px-2 text-right" />
                    <Th rotulo="Qtd. cancelada" col="qtd" ord={ordCliente} setOrd={setOrdCliente} className="py-2 px-2 text-right" />
                    <Th rotulo="Valor" col="valor" ord={ordCliente} setOrd={setOrdCliente} className="py-2 px-2 text-right" />
                    <Th rotulo="% do total cancelado" col="pctDoTotal" ord={ordCliente} setOrd={setOrdCliente} className="py-2 pl-2 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {dados.porCliente.length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-black">Nenhum cancelamento no período.</td></tr>
                  )}
                  {ordenar(dados.porCliente, ordCliente).map((cl) => (
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
