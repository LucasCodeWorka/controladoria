'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Calendar,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react';

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

interface TransacaoCmv {
  nrTransacao: number;
  dtTransacao: string | null;
  vlTransacao: number | null;
  valorCmc: number;
  cmvPercentual: number | null;
  qtdItens: number;
}

interface ItemTransacao {
  cdProduto: number;
  dsProduto: string;
  idconta: string;
  qtSolicitada: number | null;
  valorUnitario: number | null;
  valorCmc: number;
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

// Grafico de barras responsivo: viewBox fixo + width 100% faz o SVG escalar
// pra caber no container inteiro, sem nunca precisar de scroll horizontal -
// a largura de cada barra e calculada a partir da quantidade de itens, nunca
// de um pixel fixo. Rotula sempre acima da barra (%), com o nome/mes
// levemente rotacionado embaixo pra caber mais categorias sem se sobrepor.
function GraficoBarrasPercentual({
  dados,
  ariaLabel,
  onBarClick,
}: {
  dados: BarraDado[];
  ariaLabel: string;
  onBarClick?: (chave: string | number) => void;
}) {
  if (dados.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem dado no período pra calcular o %.</p>;
  }
  const gap = 16;
  const alturaMax = 110;
  const larguraViewBox = 1000;
  const larguraBarra = Math.max((larguraViewBox - gap * (dados.length + 1)) / dados.length, 8);
  const maxValor = Math.max(...dados.map((d) => d.valor), 1);
  const fonteRotulo = larguraBarra < 34 ? 9 : 12;
  const fonteLabel = larguraBarra < 34 ? 8 : 10;
  const alturaSvg = alturaMax + 90;
  const yEixoX = 28 + alturaMax + 14;
  const temAviso = dados.some((d) => d.aviso);

  return (
    <div>
      {/* height fixo (em px, nao so via viewBox) - sem isso o SVG cresce
          junto com a largura do container (aspect ratio do viewBox), o que
          deixava o grafico enorme em telas largas. width 100% continua
          fluido; height fica sempre o mesmo, so as barras encolhem/esticam
          na horizontal. */}
      <svg
        width="100%"
        height={alturaSvg}
        viewBox={`0 0 ${larguraViewBox} ${alturaSvg}`}
        preserveAspectRatio="none"
        className="font-sans"
        style={{ maxHeight: alturaSvg }}
        role="img"
        aria-label={ariaLabel}
      >
        {dados.map((d, i) => {
          const x = gap + i * (larguraBarra + gap);
          const h = Math.max((d.valor / maxValor) * alturaMax, 2);
          const y = 28 + (alturaMax - h);
          const xCentro = x + larguraBarra / 2;
          return (
            <g
              key={d.chave}
              onClick={onBarClick ? () => onBarClick(d.chave) : undefined}
              className={onBarClick ? 'cursor-pointer' : undefined}
            >
              {d.tooltip && <title>{d.tooltip}</title>}
              <text x={xCentro} y={y - 8} textAnchor="middle" fontSize={fonteRotulo} fontWeight={700} fill="#0b0b0b">
                {formatarPct(d.valor)}
              </text>
              <rect x={x} y={y} width={larguraBarra} height={h} rx={4} fill={COR_BARRA} />
              <text
                x={xCentro}
                y={yEixoX}
                textAnchor="end"
                fontSize={fonteLabel}
                fill="#52514e"
                transform={`rotate(-35 ${xCentro} ${yEixoX})`}
              >
                {d.label}
                {d.aviso ? ' *' : ''}
              </text>
            </g>
          );
        })}
      </svg>
      {temAviso && (
        <p className="text-[11px] text-amber-600 text-center -mt-2">* ainda faltam meses calcular no detalhe dessa loja</p>
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

  const [empresaDrill, setEmpresaDrill] = useState<TotalEmpresa | null>(null);
  const [transacoes, setTransacoes] = useState<TransacaoCmv[]>([]);
  const [carregandoTransacoes, setCarregandoTransacoes] = useState(false);

  const [transacaoExpandida, setTransacaoExpandida] = useState<number | null>(null);
  const [itensPorTransacao, setItensPorTransacao] = useState<Record<number, ItemTransacao[]>>({});
  const [carregandoItens, setCarregandoItens] = useState(false);

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

  async function buscarResumo() {
    if (empresasSelecionadas.size === 0) {
      setStatusCarregamento('Selecione pelo menos uma loja/fábrica.');
      return;
    }
    setLoading(true);
    setStatusCarregamento(null);
    setEmpresaDrill(null);
    setTransacaoExpandida(null);
    try {
      const params = new URLSearchParams({
        dataInicio,
        dataFim,
        empresas: Array.from(empresasSelecionadas).join(','),
      });
      const response = await fetch(`/api/cmv-detalhado/resumo?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (data.error) {
        setStatusCarregamento(`Erro do backend: ${data.error}`);
        return;
      }
      setTotais(data.totais || []);
      setConsolidado(data.consolidado || null);
      setPorMes(data.porMes || []);
      setConsultaExecutada(true);
    } catch (error) {
      console.error('Erro ao buscar resumo do CMV detalhado:', error);
      setStatusCarregamento('Erro ao buscar o resumo. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  function toggleEmpresaFiltro(cd: number) {
    setEmpresasSelecionadas((atual) => {
      const novo = new Set(atual);
      if (novo.has(cd)) novo.delete(cd);
      else novo.add(cd);
      return novo;
    });
  }

  async function abrirDrillEmpresa(empresa: TotalEmpresa) {
    setEmpresaDrill(empresa);
    setTransacaoExpandida(null);
    setCarregandoTransacoes(true);
    try {
      const params = new URLSearchParams({ cdEmpresa: String(empresa.cdEmpresa), dataInicio, dataFim });
      const response = await fetch(`/api/cmv-detalhado/transacoes-resumo?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      setTransacoes(data.transacoes || []);
    } catch (error) {
      console.error('Erro ao buscar transações do CMV detalhado:', error);
    } finally {
      setCarregandoTransacoes(false);
    }
  }

  async function toggleTransacao(nrTransacao: number) {
    if (transacaoExpandida === nrTransacao) {
      setTransacaoExpandida(null);
      return;
    }
    setTransacaoExpandida(nrTransacao);
    if (itensPorTransacao[nrTransacao] || !empresaDrill) return;
    setCarregandoItens(true);
    try {
      const params = new URLSearchParams({ cdEmpresa: String(empresaDrill.cdEmpresa), nrTransacao: String(nrTransacao) });
      const response = await fetch(`/api/cmv-detalhado/transacao-itens?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      setItensPorTransacao((atual) => ({ ...atual, [nrTransacao]: data.itens || [] }));
    } catch (error) {
      console.error('Erro ao buscar itens da transação:', error);
    } finally {
      setCarregandoItens(false);
    }
  }

  async function calcularMesesFaltando(empresa: TotalEmpresa) {
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
    await buscarResumo();
  }

  const totaisOrdenados = useMemo(() => [...totais].sort((a, b) => (b.cmvPercentual || 0) - (a.cmvPercentual || 0)), [totais]);

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-rose-100 rounded-lg">
            <Boxes className="w-6 h-6 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">CMV Detalhado</h1>
            <p className="text-sm text-gray-500">
              % de CMV por loja, consolidado do período, e detalhe venda a venda / item a item.
            </p>
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
            onClick={buscarResumo}
            className="px-4 py-1.5 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700 transition-colors"
          >
            Consultar
          </button>
          <button
            onClick={buscarResumo}
            className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors"
            title="Atualizar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
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
            <p className="text-xs text-gray-500 mb-3">Clique numa barra (ou numa linha da tabela) pra ver as transações dessa loja no período.</p>
            <GraficoBarrasPercentual
              ariaLabel="CMV percentual por loja"
              dados={totaisOrdenados.filter((d) => d.cmvPercentual !== null).map((d) => ({
                chave: d.cdEmpresa,
                label: nomeCurto(d.nome),
                valor: d.cmvPercentual as number,
                aviso: !d.detalhado,
                tooltip: `${d.nome}: ${formatarPct(d.cmvPercentual)} (CMV ${formatarValor(-Math.abs(d.valorTotal))} / Receita ${formatarValor(d.receita)})`,
              }))}
              onBarClick={(chave) => {
                const empresa = totaisOrdenados.find((t) => t.cdEmpresa === chave);
                if (empresa) abrirDrillEmpresa(empresa);
              }}
            />
          </div>

          {porMes.length > 0 && (
            <div className="bg-white rounded-lg shadow-lg p-5">
              <h2 className="text-base font-semibold text-gray-800 mb-1">% de CMV por mês</h2>
              <p className="text-xs text-gray-500 mb-3">Somando todas as lojas/fábrica selecionadas no filtro, mês a mês.</p>
              <GraficoBarrasPercentual
                ariaLabel="CMV percentual por mês"
                dados={porMes.filter((m) => m.cmvPercentual !== null).map((m) => ({
                  chave: m.anoMes,
                  label: labelMes(m.anoMes),
                  valor: m.cmvPercentual as number,
                  tooltip: `${labelMes(m.anoMes)}: ${formatarPct(m.cmvPercentual)} (CMV ${formatarValor(-Math.abs(m.valorTotal))} / Receita ${formatarValor(m.receita)})`,
                }))}
              />
            </div>
          )}

          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="p-4 border-b border-gray-200 bg-gray-50">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left font-semibold pb-2">Loja</th>
                    <th className="text-right font-semibold pb-2">Mercadoria Revenda</th>
                    <th className="text-right font-semibold pb-2">Produto Próprio</th>
                    <th className="text-right font-semibold pb-2">Total CMV</th>
                    <th className="text-right font-semibold pb-2">Receita</th>
                    <th className="text-right font-semibold pb-2">% CMV</th>
                    <th className="text-center font-semibold pb-2">Detalhe</th>
                  </tr>
                </thead>
                <tbody>
                  {totaisOrdenados.map((t) => (
                    <tr
                      key={t.cdEmpresa}
                      className={`border-t border-gray-100 hover:bg-white cursor-pointer ${empresaDrill?.cdEmpresa === t.cdEmpresa ? 'bg-rose-50' : ''}`}
                      onClick={() => abrirDrillEmpresa(t)}
                    >
                      <td className="py-2 font-medium">{t.nome}</td>
                      <td className="py-2 text-right text-red-600">{formatarValor(-Math.abs(t.mercadoriaRevenda))}</td>
                      <td className="py-2 text-right text-red-600">{formatarValor(-Math.abs(t.produtoProprio))}</td>
                      <td className="py-2 text-right font-semibold text-red-600">{formatarValor(-Math.abs(t.valorTotal))}</td>
                      <td className="py-2 text-right text-gray-600">{formatarValor(t.receita)}</td>
                      <td className="py-2 text-right font-semibold">{formatarPct(t.cmvPercentual)}</td>
                      <td className="py-2 text-center" onClick={(e) => e.stopPropagation()}>
                        {t.detalhado ? (
                          <span className="text-[11px] px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">Completo</span>
                        ) : calculandoMes && calculandoMes.startsWith(t.nome) ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                            <Loader2 className="w-3 h-3 animate-spin" /> {calculandoMes}
                          </span>
                        ) : (
                          <button
                            onClick={() => calcularMesesFaltando(t)}
                            className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 font-medium"
                            title={`Calcular: ${t.mesesFaltando.join(', ')}`}
                          >
                            Calcular {t.mesesFaltando.length} mês(es)
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {empresaDrill && (
            <div className="bg-white rounded-lg shadow-lg overflow-hidden">
              <div className="p-4 border-b border-gray-200 bg-rose-50">
                <h2 className="text-base font-semibold text-gray-800">
                  Transações — {empresaDrill.nome}
                </h2>
                <p className="text-xs text-gray-500">
                  Valor e CMV da venda inteira. Clique numa transação pra ver os itens que a compõem.
                </p>
              </div>
              {carregandoTransacoes ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                  <span className="ml-2 text-sm text-gray-500">Carregando transações...</span>
                </div>
              ) : (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-100">
                      <tr>
                        <th className="px-4 py-2 text-left font-semibold border-b">Transação</th>
                        <th className="px-3 py-2 text-left font-semibold border-b">Data</th>
                        <th className="px-3 py-2 text-right font-semibold border-b">Itens</th>
                        <th className="px-3 py-2 text-right font-semibold border-b">Valor da Venda</th>
                        <th className="px-3 py-2 text-right font-semibold border-b">CMV</th>
                        <th className="px-3 py-2 text-right font-semibold border-b">% CMV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transacoes.map((t) => {
                        const aberta = transacaoExpandida === t.nrTransacao;
                        return (
                          <React.Fragment key={t.nrTransacao}>
                            <tr
                              className={`border-t hover:bg-gray-50 cursor-pointer ${aberta ? 'bg-gray-50' : ''}`}
                              onClick={() => toggleTransacao(t.nrTransacao)}
                            >
                              <td className="px-4 py-1.5 font-mono text-gray-600">
                                <div className="flex items-center gap-1.5">
                                  {aberta ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                                  {t.nrTransacao}
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-gray-500">
                                {t.dtTransacao ? new Date(t.dtTransacao).toLocaleDateString('pt-BR') : '-'}
                              </td>
                              <td className="px-3 py-1.5 text-right text-gray-500">{t.qtdItens}</td>
                              <td className="px-3 py-1.5 text-right text-gray-700">
                                {t.vlTransacao !== null ? formatarValor(t.vlTransacao) : '-'}
                              </td>
                              <td className="px-3 py-1.5 text-right text-red-600 font-medium">
                                {formatarValor(-Math.abs(t.valorCmc))}
                              </td>
                              <td className="px-3 py-1.5 text-right font-semibold">{formatarPct(t.cmvPercentual)}</td>
                            </tr>
                            {aberta && (
                              <tr>
                                <td colSpan={6} className="p-0 bg-gray-50">
                                  {carregandoItens && !itensPorTransacao[t.nrTransacao] ? (
                                    <div className="flex items-center justify-center py-4">
                                      <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                      <span className="ml-2 text-xs text-gray-500">Carregando itens...</span>
                                    </div>
                                  ) : (
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="bg-gray-100 text-gray-500">
                                          <th className="px-10 py-1.5 text-left font-semibold">Produto</th>
                                          <th className="px-3 py-1.5 text-left font-semibold">Conta</th>
                                          <th className="px-3 py-1.5 text-right font-semibold">Qtd</th>
                                          <th className="px-3 py-1.5 text-right font-semibold">Custo Unit.</th>
                                          <th className="px-3 py-1.5 text-right font-semibold">CMV</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {(itensPorTransacao[t.nrTransacao] || []).map((item, idx) => (
                                          <tr key={`${item.cdProduto}-${idx}`} className="border-t border-gray-200">
                                            <td className="px-10 py-1">{item.dsProduto}</td>
                                            <td className="px-3 py-1 font-mono text-gray-500">{item.idconta}</td>
                                            <td className="px-3 py-1 text-right text-gray-500">{item.qtSolicitada ?? '-'}</td>
                                            <td className="px-3 py-1 text-right text-gray-500">
                                              {item.valorUnitario !== null ? formatarValor(item.valorUnitario) : '-'}
                                            </td>
                                            <td className="px-3 py-1 text-right text-red-600 font-medium">
                                              {formatarValor(-Math.abs(item.valorCmc))}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
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
