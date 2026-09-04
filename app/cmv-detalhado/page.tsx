'use client';

import React, { useEffect, useState } from 'react';
import {
  Boxes,
  Calendar,
  ChevronDown,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatarValor } from '../utils/formatters';

interface EmpresaOpcao {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
}

interface TotalEmpresa {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
  mercadoriaRevenda: number;
  produtoProprio: number;
  valorTotal: number;
  receita: number;
  cmvPercentual: number | null;
  mesesCalculados: string[];
  mesesFaltando: string[];
  detalhado: boolean;
}

interface Consolidado {
  valorTotal: number;
  receita: number;
  cmvPercentual: number | null;
}

interface TotalMes {
  anoMes: string;
  valorTotal: number;
  receita: number;
  cmvPercentual: number | null;
}

interface VendaDetalhada {
  cdEmpresa: number;
  nomeEmpresa: string;
  nrTransacao: number;
  dtTransacao: string | null;
  cdProduto: number;
  dsProduto: string;
  referencia: string | null;
  qtSolicitada: number | null;
  valorUnitarioVenda: number | null;
  valorUnitarioCmv: number | null;
  valorTotalVenda: number | null;
  valorTotalCmv: number;
  cmvPercentual: number | null;
}

// Cores em ordem categorica fixa (paleta validada) - aqui so a primeira
// (azul) e usada, ja que e uma metrica so (CMV%) comparada entre categorias.
const COR_BARRA = '#2a78d6';

function primeiroDiaMesAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
}

function ultimoDiaMesAtual(): string {
  const hoje = new Date();
  const ultimo = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  return `${ultimo.getFullYear()}-${String(ultimo.getMonth() + 1).padStart(2, '0')}-${String(ultimo.getDate()).padStart(2, '0')}`;
}

function labelMes(anoMes: string): string {
  const [ano, mes] = anoMes.split('-');
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${nomes[Number(mes) - 1]}/${ano.slice(2)}`;
}

function formatarPct(valor: number | null): string {
  if (valor === null) return '-';
  // 2 casas decimais, igual ao %AV da tela da DRE (calcularAV) - sem isso,
  // 29.97% (Iguatemi/ago) arredondava pra "30%" e parecia diferente do real.
  return `${valor.toFixed(2)}%`;
}

function nomeCurto(nome: string): string {
  return nome.length > 12 ? `${nome.slice(0, 11)}…` : nome;
}

interface BarraDado {
  chave: string | number;
  label: string;
  valor: number;
  aviso?: boolean;
  tooltip?: string;
}

interface PayloadTooltipBarra {
  active?: boolean;
  payload?: { payload: BarraDado }[];
}

function TooltipBarra({ active, payload }: PayloadTooltipBarra) {
  if (!active || !payload || payload.length === 0) return null;
  const dado = payload[0].payload;
  return (
    <div className="bg-gray-900 text-white text-xs rounded px-2.5 py-1.5 shadow-lg max-w-xs">
      {dado.tooltip || `${dado.label}: ${formatarPct(dado.valor)}`}
    </div>
  );
}

// Grafico de barras via Recharts (responsivo por padrao, ja com grade,
// eixos e proporcao de barra/espacamento bem resolvidas).
function GraficoBarrasPercentual({ dados, ariaLabel }: { dados: BarraDado[]; ariaLabel: string }) {
  if (dados.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem dado no período pra calcular o %.</p>;
  }
  const temAviso = dados.some((d) => d.aviso);
  const muitasCategorias = dados.length > 8;
  const dadosComLabel = dados.map((d) => ({ ...d, labelEixo: `${d.label}${d.aviso ? ' *' : ''}` }));

  return (
    <div role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height={muitasCategorias ? 300 : 240}>
        <BarChart data={dadosComLabel} margin={{ top: 24, right: 8, left: 0, bottom: muitasCategorias ? 56 : 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" vertical={false} />
          <XAxis
            dataKey="labelEixo"
            tick={{ fontSize: 11, fill: '#52514e' }}
            interval={0}
            angle={muitasCategorias ? -35 : 0}
            textAnchor={muitasCategorias ? 'end' : 'middle'}
            axisLine={{ stroke: '#c3c2b7' }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fontSize: 11, fill: '#898781' }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip content={<TooltipBarra />} cursor={{ fill: 'rgba(11,11,11,0.04)' }} />
          <Bar dataKey="valor" fill={COR_BARRA} radius={[4, 4, 0, 0]} maxBarSize={56}>
            <LabelList
              dataKey="valor"
              position="top"
              formatter={(v: React.ReactNode) => formatarPct(v as number)}
              style={{ fontSize: 12, fontWeight: 700, fill: '#0b0b0b' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {temAviso && (
        <p className="text-[11px] text-amber-600 text-center mt-1">* ainda faltam meses calcular no detalhe dessa loja</p>
      )}
    </div>
  );
}

function GraficoCmvConsolidado({ consolidado }: { consolidado: Consolidado }) {
  const pct = consolidado.cmvPercentual;
  const larguraTotal = 100;
  const preenchido = pct !== null ? Math.min(pct, 100) : 0;
  return (
    <div className="max-w-md mx-auto py-4">
      <p className="text-xs font-medium text-gray-500 text-center uppercase tracking-wide">% CMV Consolidado do Filtro</p>
      <p className="text-4xl font-bold text-center text-gray-900 mt-1">{formatarPct(pct)}</p>
      <div className="mt-4 h-6 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${(preenchido / larguraTotal) * 100}%`, backgroundColor: COR_BARRA }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-500 mt-2">
        <span>CMV: {formatarValor(-Math.abs(consolidado.valorTotal))}</span>
        <span>Receita: {formatarValor(consolidado.receita)}</span>
      </div>
    </div>
  );
}

export default function CmvDetalhadoPage() {
  const [dataInicio, setDataInicio] = useState(primeiroDiaMesAtual());
  const [dataFim, setDataFim] = useState(ultimoDiaMesAtual());

  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaOpcao[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<Set<number>>(new Set());
  const [filtroLojasAberto, setFiltroLojasAberto] = useState(false);

  const [loading, setLoading] = useState(false);
  const [statusCarregamento, setStatusCarregamento] = useState<string | null>(null);
  const [consultaExecutada, setConsultaExecutada] = useState(false);

  const [totais, setTotais] = useState<TotalEmpresa[]>([]);
  const [consolidado, setConsolidado] = useState<Consolidado | null>(null);
  const [porMes, setPorMes] = useState<TotalMes[]>([]);

  const [vendasDetalhadas, setVendasDetalhadas] = useState<VendaDetalhada[]>([]);
  const [vendasLimitadas, setVendasLimitadas] = useState(false);
  const [pendentes, setPendentes] = useState<TotalEmpresa[]>([]);
  const [calculandoMes, setCalculandoMes] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/cmv-detalhado/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const lista: EmpresaOpcao[] = data.empresas || [];
        setEmpresasDisponiveis(lista);
        setEmpresasSelecionadas(new Set(lista.map((e) => e.cdEmpresa)));
      })
      .catch((e) => console.error('Erro ao buscar empresas do CMV detalhado:', e));
  }, []);

  async function buscarDados() {
    if (empresasSelecionadas.size === 0) {
      setStatusCarregamento('Selecione pelo menos uma loja/fábrica.');
      return;
    }
    setLoading(true);
    setStatusCarregamento(null);
    try {
      // 1) /resumo (rapido) so pra saber quais lojas selecionadas ja tem o
      // detalhe calculado - fabrica sempre tem, lojas dependem do cache.
      const paramsResumo = new URLSearchParams({
        dataInicio,
        dataFim,
        empresas: Array.from(empresasSelecionadas).join(','),
      });
      const respResumo = await fetch(`/api/cmv-detalhado/resumo?${paramsResumo.toString()}`, { cache: 'no-store' });
      const dataResumo = await respResumo.json();
      if (dataResumo.error) {
        setStatusCarregamento(`Erro do backend: ${dataResumo.error}`);
        return;
      }
      const totaisResumo: TotalEmpresa[] = dataResumo.totais || [];
      setTotais(totaisResumo);
      setConsolidado(dataResumo.consolidado || null);
      setPorMes(dataResumo.porMes || []);
      const prontas = totaisResumo.filter((t) => t.detalhado);
      const naoProntas = totaisResumo.filter((t) => !t.detalhado);
      setPendentes(naoProntas);

      // 2) Vendas detalhadas de cada empresa pronta, em paralelo, juntando
      // tudo numa unica tabela.
      const respostas = await Promise.all(
        prontas.map((empresa) => {
          const params = new URLSearchParams({ cdEmpresa: String(empresa.cdEmpresa), dataInicio, dataFim });
          return fetch(`/api/cmv-detalhado/vendas-detalhadas?${params.toString()}`, { cache: 'no-store' }).then((r) => r.json());
        })
      );
      const todasVendas: VendaDetalhada[] = [];
      let algumaLimitada = false;
      for (const resp of respostas) {
        if (resp.error) continue;
        todasVendas.push(...(resp.vendas || []));
        if (resp.limitado) algumaLimitada = true;
      }
      todasVendas.sort((a, b) => (b.dtTransacao || '').localeCompare(a.dtTransacao || ''));
      setVendasDetalhadas(todasVendas);
      setVendasLimitadas(algumaLimitada);
      setConsultaExecutada(true);
    } catch (error) {
      console.error('Erro ao buscar vendas detalhadas do CMV:', error);
      setStatusCarregamento('Erro ao buscar os dados. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  function definirMesAtual() {
    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
    setDataInicio(`${inicioMes.getFullYear()}-${String(inicioMes.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(
      `${fimMes.getFullYear()}-${String(fimMes.getMonth() + 1).padStart(2, '0')}-${String(fimMes.getDate()).padStart(2, '0')}`
    );
  }

  function definirMesAnterior() {
    const hoje = new Date();
    const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    setDataInicio(`${inicioMesAnterior.getFullYear()}-${String(inicioMesAnterior.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(
      `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`
    );
  }

  function definirUltimosMeses(qtdMeses: number) {
    const hoje = new Date();
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    const inicioIntervalo = new Date(hoje.getFullYear(), hoje.getMonth() - qtdMeses, 1);
    setDataInicio(`${inicioIntervalo.getFullYear()}-${String(inicioIntervalo.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(
      `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`
    );
  }

  function definirAnoAtual() {
    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    const fimMesAnterior = new Date(anoAtual, hoje.getMonth(), 0);
    // Em janeiro nao ha mes anterior dentro do ano atual; mostra o mes corrente
    const dataFimAnoAtual =
      fimMesAnterior.getFullYear() === anoAtual ? fimMesAnterior : new Date(anoAtual, hoje.getMonth() + 1, 0);
    setDataInicio(`${anoAtual}-01-01`);
    setDataFim(
      `${dataFimAnoAtual.getFullYear()}-${String(dataFimAnoAtual.getMonth() + 1).padStart(2, '0')}-${String(dataFimAnoAtual.getDate()).padStart(2, '0')}`
    );
  }

  function toggleEmpresaFiltro(cd: number) {
    setEmpresasSelecionadas((atual) => {
      const novo = new Set(atual);
      if (novo.has(cd)) novo.delete(cd);
      else novo.add(cd);
      return novo;
    });
  }

  async function calcularPendente(empresa: TotalEmpresa) {
    for (const mes of empresa.mesesFaltando) {
      setCalculandoMes(`${empresa.nome} — ${mes}`);
      try {
        const params = new URLSearchParams({ cdEmpresa: String(empresa.cdEmpresa), anoMes: mes });
        // eslint-disable-next-line no-await-in-loop
        await fetch(`/api/cmv-detalhado/calcular?${params.toString()}`, { method: 'POST', cache: 'no-store' });
      } catch (error) {
        console.error(`Erro ao calcular ${empresa.nome}/${mes}:`, error);
      }
    }
    setCalculandoMes(null);
    await buscarDados();
  }

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-rose-100 rounded-lg">
            <Boxes className="w-6 h-6 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">CMV Detalhado</h1>
            <p className="text-sm text-gray-500">Venda a venda, item a item — SKU, referência, quantidade, valor de venda e CMV.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Calendar className="w-4 h-4 text-gray-400" />
          <input
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
          />
          <span className="text-gray-400 text-sm">até</span>
          <input
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
          />

          <div className="relative">
            <button
              onClick={() => setFiltroLojasAberto((v) => !v)}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50 flex items-center gap-2"
            >
              Lojas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {filtroLojasAberto && (
              <div className="absolute z-30 mt-1 w-64 max-h-80 overflow-auto bg-white border border-gray-200 rounded-md shadow-lg p-2">
                <div className="flex justify-between px-1 pb-1 mb-1 border-b border-gray-100">
                  <button
                    className="text-xs text-rose-600 hover:underline"
                    onClick={() => setEmpresasSelecionadas(new Set(empresasDisponiveis.map((e) => e.cdEmpresa)))}
                  >
                    Todas
                  </button>
                  <button className="text-xs text-gray-500 hover:underline" onClick={() => setEmpresasSelecionadas(new Set())}>
                    Nenhuma
                  </button>
                </div>
                {empresasDisponiveis.map((e) => (
                  <label key={e.cdEmpresa} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-gray-50 rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={empresasSelecionadas.has(e.cdEmpresa)}
                      onChange={() => toggleEmpresaFiltro(e.cdEmpresa)}
                    />
                    {e.nome}
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={buscarDados}
            className="px-4 py-1.5 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700 transition-colors"
          >
            Consultar
          </button>
          <button
            onClick={buscarDados}
            className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors"
            title="Atualizar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap mt-3">
          <button
            onClick={definirMesAnterior}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Mês Anterior
          </button>
          <button
            onClick={definirMesAtual}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Mês Atual
          </button>
          <button
            onClick={() => definirUltimosMeses(3)}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Últimos 3 Meses
          </button>
          <button
            onClick={() => definirUltimosMeses(6)}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Últimos 6 Meses
          </button>
          <button
            onClick={() => definirUltimosMeses(12)}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Últimos 12 Meses
          </button>
          <button
            onClick={definirAnoAtual}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Ano Atual
          </button>
          <button
            onClick={() => {
              setDataInicio('2025-01-01');
              setDataFim('2025-12-31');
            }}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            2025
          </button>
        </div>

        {statusCarregamento && <p className="text-sm text-red-600 mt-3">{statusCarregamento}</p>}
      </div>

      {loading && !consultaExecutada && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {!loading && !consultaExecutada && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
          Escolha o período e as lojas e clique em Consultar.
        </div>
      )}

      {consultaExecutada && (
        <>
          {consolidado && (
            <div className="bg-white rounded-lg shadow-lg p-5">
              <GraficoCmvConsolidado consolidado={consolidado} />
            </div>
          )}

          <div className="bg-white rounded-lg shadow-lg p-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">% de CMV por loja</h2>
            <p className="text-xs text-gray-500 mb-3">Percentual de CMV sobre a receita, por loja/fábrica selecionada no período.</p>
            <GraficoBarrasPercentual
              ariaLabel="CMV percentual por loja"
              dados={[...totais]
                .sort((a, b) => (b.cmvPercentual || 0) - (a.cmvPercentual || 0))
                .filter((d) => d.cmvPercentual !== null)
                .map((d) => ({
                  chave: d.cdEmpresa,
                  label: nomeCurto(d.nome),
                  valor: d.cmvPercentual as number,
                  aviso: !d.detalhado,
                  tooltip: `${d.nome}: ${formatarPct(d.cmvPercentual)} (CMV ${formatarValor(-Math.abs(d.valorTotal))} / Receita ${formatarValor(d.receita)})`,
                }))}
            />
          </div>

          {porMes.length > 0 && (
            <div className="bg-white rounded-lg shadow-lg p-5">
              <h2 className="text-base font-semibold text-gray-800 mb-1">% de CMV por mês</h2>
              <p className="text-xs text-gray-500 mb-3">Somando todas as lojas/fábrica selecionadas no filtro, mês a mês.</p>
              <GraficoBarrasPercentual
                ariaLabel="CMV percentual por mês"
                dados={porMes
                  .filter((m) => m.cmvPercentual !== null)
                  .map((m) => ({
                    chave: m.anoMes,
                    label: labelMes(m.anoMes),
                    valor: m.cmvPercentual as number,
                    tooltip: `${labelMes(m.anoMes)}: ${formatarPct(m.cmvPercentual)} (CMV ${formatarValor(-Math.abs(m.valorTotal))} / Receita ${formatarValor(m.receita)})`,
                  }))}
              />
            </div>
          )}

          {pendentes.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-sm font-medium text-amber-800 mb-2">
                Ainda faltam calcular o detalhe dessas lojas no período (não entram na tabela abaixo até calcular):
              </p>
              <div className="flex flex-wrap gap-2">
                {pendentes.map((p) => (
                  <button
                    key={p.cdEmpresa}
                    onClick={() => calcularPendente(p)}
                    disabled={!!calculandoMes}
                    className="text-xs px-2.5 py-1.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 font-medium disabled:opacity-50"
                    title={`Calcular: ${p.mesesFaltando.join(', ')}`}
                  >
                    {calculandoMes && calculandoMes.startsWith(p.nome) ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> {calculandoMes}
                      </span>
                    ) : (
                      <>{p.nome} ({p.mesesFaltando.length} mês(es))</>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="p-4 border-b border-gray-200 bg-rose-50">
              <h2 className="text-base font-semibold text-gray-800">Vendas detalhadas</h2>
              <p className="text-xs text-gray-500">
                Uma linha por SKU vendido dentro de cada transação.
                {vendasLimitadas && <> Mostrando as vendas mais recentes do período (algumas empresas ultrapassaram o limite de linhas).</>}
              </p>
            </div>
            {vendasDetalhadas.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">Nenhuma venda encontrada no período/filtro selecionado.</p>
            ) : (
              <div className="overflow-x-auto max-h-[720px] overflow-y-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="sticky top-0 bg-gray-100">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold border-b">Empresa</th>
                      <th className="px-3 py-2 text-left font-semibold border-b">Transação</th>
                      <th className="px-3 py-2 text-left font-semibold border-b">Data</th>
                      <th className="px-3 py-2 text-left font-semibold border-b">SKU</th>
                      <th className="px-3 py-2 text-left font-semibold border-b">Referência</th>
                      <th className="px-3 py-2 text-left font-semibold border-b">Produto</th>
                      <th className="px-3 py-2 text-right font-semibold border-b">Qtde</th>
                      <th className="px-3 py-2 text-right font-semibold border-b">Vl. Unit. Venda</th>
                      <th className="px-3 py-2 text-right font-semibold border-b">CMV Unit.</th>
                      <th className="px-3 py-2 text-right font-semibold border-b">Vl. Total Venda</th>
                      <th className="px-3 py-2 text-right font-semibold border-b">Vl. Total CMV</th>
                      <th className="px-3 py-2 text-right font-semibold border-b">% CMV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendasDetalhadas.map((v, idx) => (
                      <tr key={`${v.cdEmpresa}-${v.nrTransacao}-${v.cdProduto}-${idx}`} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-1.5">{v.nomeEmpresa}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-600">{v.nrTransacao}</td>
                        <td className="px-3 py-1.5 text-gray-500">
                          {v.dtTransacao ? new Date(v.dtTransacao).toLocaleDateString('pt-BR') : '-'}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-gray-600">{v.cdProduto}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-600">{v.referencia ?? '-'}</td>
                        <td className="px-3 py-1.5 text-gray-700 whitespace-normal max-w-xs">{v.dsProduto}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{v.qtSolicitada ?? '-'}</td>
                        <td className="px-3 py-1.5 text-right text-gray-700">
                          {v.valorUnitarioVenda !== null ? formatarValor(v.valorUnitarioVenda) : '-'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-700">
                          {v.valorUnitarioCmv !== null ? formatarValor(v.valorUnitarioCmv) : '-'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-700">
                          {v.valorTotalVenda !== null ? formatarValor(v.valorTotalVenda) : '-'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-red-600 font-medium">
                          {formatarValor(-Math.abs(v.valorTotalCmv))}
                        </td>
                        <td className="px-3 py-1.5 text-right font-semibold">{formatarPct(v.cmvPercentual)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
