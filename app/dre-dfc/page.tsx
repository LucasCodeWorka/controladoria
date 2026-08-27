'use client';

import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  GitCompare,
  RefreshCw,
} from 'lucide-react';

import { formatarValor } from '../utils/formatters';

interface OpcaoFiltro {
  valor: string;
  label: string;
  tipo: string;
}

interface PeriodoItem {
  key: string;
  label: string;
}

type ValoresPeriodo = Record<string, number> & { total: number };

interface ComparativoConta {
  competencia: ValoresPeriodo;
  caixa: ValoresPeriodo;
}

interface RespostaComparativo {
  periodos: PeriodoItem[];
  despesas: Record<string, ComparativoConta>;
  receita: ComparativoConta;
  grupoOP: ComparativoConta;
  resumo: {
    resultadoCompetencia: ValoresPeriodo;
    resultadoCaixa: ValoresPeriodo;
    ajusteDespesa: ValoresPeriodo;
    ajusteReceita: ValoresPeriodo;
  };
  metadata: {
    nomeFiltro: string;
    dataInicio: string;
    dataFim: string;
  };
}

export default function DreXDfcPage() {
  const [loading, setLoading] = useState(false);
  const [consultaExecutada, setConsultaExecutada] = useState(false);
  const [statusCarregamento, setStatusCarregamento] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('consolidado');
  const [filtroAberto, setFiltroAberto] = useState(false);
  const [opcoesFiltro, setOpcoesFiltro] = useState<OpcaoFiltro[]>([]);
  const [nomesSubgrupos, setNomesSubgrupos] = useState<Record<string, string>>({});
  const [dataInicio, setDataInicio] = useState(() => {
    const hoje = new Date();
    const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    return `${inicioMesAnterior.getFullYear()}-${String(inicioMesAnterior.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [dataFim, setDataFim] = useState(() => {
    const hoje = new Date();
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    return `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`;
  });
  const [dados, setDados] = useState<RespostaComparativo | null>(null);

  useEffect(() => {
    async function carregarFiltros() {
      try {
        const response = await fetch('/api/dre/centros-custo', { cache: 'no-store' });
        const data = await response.json();
        setOpcoesFiltro(data.opcoes || []);
      } catch (error) {
        console.error('Erro ao buscar centros de custo:', error);
      }
    }
    carregarFiltros();
  }, []);

  useEffect(() => {
    async function carregarNomesSubgrupos() {
      try {
        const response = await fetch('/api/dfc/plano-contas', { cache: 'no-store' });
        const data = await response.json();
        const nomes: Record<string, string> = {};
        for (const grupo of data.grupos || []) {
          for (const sub of grupo.subgrupos || []) {
            nomes[sub.codigo] = sub.nome;
          }
        }
        setNomesSubgrupos(nomes);
      } catch (error) {
        console.error('Erro ao buscar plano de contas DFC:', error);
      }
    }
    carregarNomesSubgrupos();
  }, []);

  async function buscarDados() {
    setLoading(true);
    setStatusCarregamento(null);
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 300000);
      const params = new URLSearchParams({ dataInicio, dataFim, filtro });
      const response = await fetch(`/api/dre-dfc/comparativo-operacional?${params.toString()}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      window.clearTimeout(timeout);
      const data = await response.json();

      if (data.error) {
        setStatusCarregamento(`Erro do backend: ${data.error}`);
        return;
      }

      setDados(data);
      setConsultaExecutada(true);
    } catch (error) {
      console.error('Erro ao buscar comparativo DRE x DFC:', error);
      setStatusCarregamento('Erro ao buscar o comparativo. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  function definirMesAtual() {
    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
    setDataInicio(`${inicioMes.getFullYear()}-${String(inicioMes.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(`${fimMes.getFullYear()}-${String(fimMes.getMonth() + 1).padStart(2, '0')}-${String(fimMes.getDate()).padStart(2, '0')}`);
  }

  function definirMesAnterior() {
    const hoje = new Date();
    const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    setDataInicio(`${inicioMesAnterior.getFullYear()}-${String(inicioMesAnterior.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(`${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`);
  }

  function definirUltimosMeses(qtdMeses: number) {
    const hoje = new Date();
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    const inicioIntervalo = new Date(hoje.getFullYear(), hoje.getMonth() - qtdMeses, 1);
    setDataInicio(`${inicioIntervalo.getFullYear()}-${String(inicioIntervalo.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(`${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`);
  }

  const opcoesLojas = opcoesFiltro.filter((o) => o.tipo === 'loja');
  const filtroLabel =
    filtro === 'consolidado'
      ? 'CONSOLIDADO (TODAS)'
      : filtro === 'fabrica'
        ? 'FABRICA'
        : opcoesLojas.find((o) => o.valor === filtro)?.label || filtro;

  const periodos = dados?.periodos || [];
  const larguraTabela = 260 + periodos.length * 300 + 140;

  function celula(valores: ValoresPeriodo | undefined, periodoKey?: string): number {
    if (!valores) return 0;
    return (periodoKey ? valores[periodoKey] : valores.total) || 0;
  }

  function renderizarLinha(
    nome: string,
    competencia: ValoresPeriodo | undefined,
    caixa: ValoresPeriodo | undefined,
    opcoes: { bold?: boolean; corFundo?: string } = {}
  ) {
    const totalComp = celula(competencia);
    const totalCaixa = celula(caixa);
    const totalDif = totalCaixa - totalComp;
    return (
      <tr key={nome} className={`${opcoes.corFundo || 'bg-white'} hover:bg-gray-50 transition-colors`}>
        <td className={`px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10 text-sm ${opcoes.bold ? 'font-bold' : ''}`}>
          {nome}
        </td>
        {periodos.map((periodo) => {
          const comp = celula(competencia, periodo.key);
          const cai = celula(caixa, periodo.key);
          const dif = cai - comp;
          return (
            <React.Fragment key={periodo.key}>
              <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm whitespace-nowrap ${comp < 0 ? 'text-red-600' : ''}`}>
                {formatarValor(comp)}
              </td>
              <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm whitespace-nowrap bg-purple-50 ${cai < 0 ? 'text-red-600' : ''}`}>
                {formatarValor(cai)}
              </td>
              <td className={`px-3 py-2 border-b border-gray-200 text-right text-xs whitespace-nowrap ${dif < 0 ? 'text-red-500' : 'text-green-600'}`}>
                {dif >= 0 ? '+' : ''}
                {formatarValor(dif)}
              </td>
            </React.Fragment>
          );
        })}
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold whitespace-nowrap ${totalComp < 0 ? 'text-red-600' : ''}`}>
          {formatarValor(totalComp)}
        </td>
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold whitespace-nowrap bg-purple-50 ${totalCaixa < 0 ? 'text-red-600' : ''}`}>
          {formatarValor(totalCaixa)}
        </td>
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-xs font-bold whitespace-nowrap ${totalDif < 0 ? 'text-red-500' : 'text-green-600'}`}>
          {totalDif >= 0 ? '+' : ''}
          {formatarValor(totalDif)}
        </td>
      </tr>
    );
  }

  const resumo = dados?.resumo;
  const resultadoCompetenciaTotal = resumo ? celula(resumo.resultadoCompetencia) : 0;
  const resultadoCaixaTotal = resumo ? celula(resumo.resultadoCaixa) : 0;
  const ajusteReceitaTotal = resumo ? celula(resumo.ajusteReceita) : 0;
  const ajusteDespesaTotal = resumo ? celula(resumo.ajusteDespesa) : 0;

  const linhasDespesas = dados
    ? Object.entries(dados.despesas).sort(
        (a, b) => Math.abs(celula(b[1].competencia)) - Math.abs(celula(a[1].competencia))
      )
    : [];

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="mb-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-purple-100 rounded-lg">
            <GitCompare className="w-6 h-6 text-purple-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">DRE x DFC — Competência x Caixa</h1>
            <p className="text-sm text-gray-500">
              Compara o resultado operacional pelo regime de competência (DRE, data de emissão) com o fluxo de caixa
              operacional (DFC, data de liquidação/recebimento) — só o grupo Operacional, sem Investimentos/Financiamento.
            </p>
          </div>
        </div>
      </div>

      {consultaExecutada && resumo && (
        <div className="bg-white rounded-lg shadow-lg p-5">
          <h2 className="text-base font-semibold text-brand-dark mb-4">Resumo executivo — a ponte entre resultado e caixa</h2>
          <div className="flex flex-wrap items-stretch gap-3">
            <div className="flex-1 min-w-[180px] bg-blue-50 rounded-lg p-4 border-l-4 border-blue-500">
              <p className="text-xs font-medium text-blue-800">Resultado Operacional (DRE)</p>
              <p className={`text-xl font-bold mt-1 ${resultadoCompetenciaTotal < 0 ? 'text-red-600' : 'text-blue-900'}`}>
                {formatarValor(resultadoCompetenciaTotal)}
              </p>
            </div>
            <div className="flex items-center justify-center px-1 text-gray-400">
              <ArrowRight className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-[180px] bg-gray-50 rounded-lg p-4 border-l-4 border-gray-400">
              <p className="text-xs font-medium text-gray-600">Ajuste de prazo — Receita</p>
              <p className={`text-xl font-bold mt-1 ${ajusteReceitaTotal < 0 ? 'text-red-600' : 'text-green-600'}`}>
                {ajusteReceitaTotal >= 0 ? '+' : ''}
                {formatarValor(ajusteReceitaTotal)}
              </p>
              <p className="text-[11px] text-gray-400 mt-1">recebido − vendido no período</p>
            </div>
            <div className="flex items-center justify-center px-1 text-gray-400">
              <ArrowRight className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-[180px] bg-gray-50 rounded-lg p-4 border-l-4 border-gray-400">
              <p className="text-xs font-medium text-gray-600">Ajuste de prazo — Despesa</p>
              <p className={`text-xl font-bold mt-1 ${-ajusteDespesaTotal < 0 ? 'text-red-600' : 'text-green-600'}`}>
                {-ajusteDespesaTotal >= 0 ? '+' : ''}
                {formatarValor(-ajusteDespesaTotal)}
              </p>
              <p className="text-[11px] text-gray-400 mt-1">pago − incorrido no período</p>
            </div>
            <div className="flex items-center justify-center px-1 text-gray-400">
              <ArrowRight className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-[180px] bg-teal-50 rounded-lg p-4 border-l-4 border-teal-500">
              <p className="text-xs font-medium text-teal-800">Fluxo de Caixa Operacional (DFC)</p>
              <p className={`text-xl font-bold mt-1 ${resultadoCaixaTotal < 0 ? 'text-red-600' : 'text-teal-900'}`}>
                {formatarValor(resultadoCaixaTotal)}
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Resultado (DRE) + ajuste de receita − ajuste de despesa = Caixa (DFC). Ajustes positivos = caixa favorecido
            (recebeu/pagou menos do que competiu no período); negativos = caixa desfavorecido.
          </p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Período</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <span className="text-gray-500 text-sm">até</span>
          <input
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          />

          <div className="relative">
            <button
              onClick={() => setFiltroAberto(!filtroAberto)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50 min-w-[160px] text-left"
            >
              {filtroLabel}
            </button>
            {filtroAberto && (
              <div className="absolute z-50 mt-1 w-64 max-h-80 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                <button
                  onClick={() => {
                    setFiltro('consolidado');
                    setFiltroAberto(false);
                  }}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${filtro === 'consolidado' ? 'bg-blue-50 font-semibold' : ''}`}
                >
                  CONSOLIDADO (TODAS)
                </button>
                <button
                  onClick={() => {
                    setFiltro('fabrica');
                    setFiltroAberto(false);
                  }}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${filtro === 'fabrica' ? 'bg-blue-50 font-semibold' : ''}`}
                >
                  FABRICA
                </button>
                <div className="border-t border-gray-100 my-1" />
                {opcoesLojas.map((opcao) => (
                  <button
                    key={opcao.valor}
                    onClick={() => {
                      setFiltro(opcao.valor);
                      setFiltroAberto(false);
                    }}
                    className={`block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${filtro === opcao.valor ? 'bg-blue-50 font-semibold' : ''}`}
                  >
                    {opcao.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => buscarDados()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
            Consultar
          </button>
          <button onClick={definirMesAnterior} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Mês Anterior
          </button>
          <button onClick={definirMesAtual} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Mês Atual
          </button>
          <button onClick={() => definirUltimosMeses(3)} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Últimos 3 Meses
          </button>
          <button onClick={() => definirUltimosMeses(6)} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Últimos 6 Meses
          </button>
        </div>

        {statusCarregamento && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {statusCarregamento}
          </div>
        )}
      </div>

      {loading && (
        <div className="bg-white rounded-lg shadow-lg border border-purple-100 p-8">
          <div className="flex flex-col items-center justify-center gap-3 text-gray-600">
            <RefreshCw className="w-8 h-8 animate-spin text-purple-600" />
            <p className="font-semibold text-gray-800">Carregando comparativo...</p>
          </div>
        </div>
      )}

      {!loading && !consultaExecutada && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
          Escolha o período e clique em Consultar para carregar o comparativo.
        </div>
      )}

      {!loading && consultaExecutada && dados && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: `${larguraTabela}px` }}>
              <thead>
                <tr className="bg-gradient-to-r from-purple-600 to-purple-700">
                  <th className="px-4 py-2 text-left text-sm font-bold text-white border-b border-purple-500 sticky left-0 bg-purple-600 z-20 min-w-[260px]">
                    CONTA
                  </th>
                  {periodos.map((periodo) => (
                    <th
                      key={periodo.key}
                      colSpan={3}
                      className="px-3 py-2 text-center text-sm font-bold text-white border-b border-purple-500 border-r border-purple-400"
                    >
                      {periodo.label}
                    </th>
                  ))}
                  <th colSpan={3} className="px-3 py-2 text-center text-sm font-bold text-white border-b border-purple-500 bg-purple-800">
                    TOTAL
                  </th>
                </tr>
                <tr className="bg-gray-100">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 border-b border-gray-300 sticky left-0 bg-gray-100 z-20" />
                  {periodos.map((periodo) => (
                    <React.Fragment key={periodo.key}>
                      <th className="px-3 py-1.5 text-center text-xs font-bold text-blue-700 border-b border-gray-300">Competência</th>
                      <th className="px-3 py-1.5 text-center text-xs font-bold text-purple-700 border-b border-gray-300 bg-purple-50">Caixa</th>
                      <th className="px-3 py-1.5 text-center text-xs font-bold text-gray-500 border-b border-gray-300">Dif.</th>
                    </React.Fragment>
                  ))}
                  <th className="px-3 py-1.5 text-center text-xs font-bold text-blue-700 border-b border-gray-300">Competência</th>
                  <th className="px-3 py-1.5 text-center text-xs font-bold text-purple-700 border-b border-gray-300 bg-purple-50">Caixa</th>
                  <th className="px-3 py-1.5 text-center text-xs font-bold text-gray-500 border-b border-gray-300">Dif.</th>
                </tr>
              </thead>
              <tbody>
                {renderizarLinha('RECEITA OPERACIONAL LÍQUIDA', dados.receita.competencia, dados.receita.caixa, {
                  bold: true,
                  corFundo: 'bg-green-50',
                })}
                {linhasDespesas.map(([codigo, valores]) =>
                  renderizarLinha(`${codigo} ${nomesSubgrupos[codigo] || ''}`, valores.competencia, valores.caixa)
                )}
                {renderizarLinha('TOTAL DESPESAS OPERACIONAIS', dados.grupoOP.competencia, dados.grupoOP.caixa, {
                  bold: true,
                  corFundo: 'bg-orange-50',
                })}
                {renderizarLinha('RESULTADO OPERACIONAL', resumo?.resultadoCompetencia, resumo?.resultadoCaixa, {
                  bold: true,
                  corFundo: 'bg-blue-50',
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
