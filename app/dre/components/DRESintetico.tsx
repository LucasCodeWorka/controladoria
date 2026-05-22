'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw, Calendar, TrendingUp, TrendingDown, Building2 } from 'lucide-react';

interface EmpresaResultado {
  cd_empresa: number;
  nome: string;
  receita_bruta: number;
  devolucoes: number;
  receita_liquida: number;
  cmv: number;
  lucro_bruto: number;
  despesas_operacionais: number;
  lucro_liquido: number;
  margem_percentual: number;
}

interface TotaisConsolidados {
  receita_bruta: number;
  devolucoes: number;
  receita_liquida: number;
  cmv: number;
  lucro_bruto: number;
  despesas_operacionais: number;
  lucro_liquido: number;
  margem_percentual: number;
}

interface DRESinteticoResponse {
  empresas: EmpresaResultado[];
  totais: TotaisConsolidados;
  metadata: {
    totalEmpresas: number;
    dataInicio: string;
    dataFim: string;
  };
  error?: string;
}

function formatarValor(valor: number): string {
  if (valor === 0) return '-';
  return valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatarPercentual(valor: number): string {
  return `${valor.toFixed(1)}%`;
}

export default function DRESintetico() {
  const [loading, setLoading] = useState(false);
  const [dataInicio, setDataInicio] = useState('2026-03-01');
  const [dataFim, setDataFim] = useState('2026-03-31');
  const [empresas, setEmpresas] = useState<EmpresaResultado[]>([]);
  const [totais, setTotais] = useState<TotaisConsolidados | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function buscarDados() {
    setLoading(true);
    setErro(null);
    try {
      const response = await fetch(`/api/dre/sintetico?dataInicio=${dataInicio}&dataFim=${dataFim}`);
      const data: DRESinteticoResponse = await response.json();

      if (data.error) {
        setErro(data.error);
        return;
      }

      setEmpresas(data.empresas || []);
      setTotais(data.totais || null);
    } catch (error) {
      console.error('Erro ao buscar DRE sintetico:', error);
      setErro('Erro ao conectar com o servidor');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    buscarDados();
  }, []);

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Filtros</h2>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
          <span className="text-gray-500">ate</span>
          <input
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
          <button
            onClick={buscarDados}
            disabled={loading}
            className="px-5 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Carregando...' : 'Consultar'}
          </button>
          <button
            onClick={buscarDados}
            disabled={loading}
            title="Atualizar dados"
            className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => {
              const hoje = new Date();
              setDataInicio(`${hoje.getFullYear()}-01-01`);
              setDataFim(`${hoje.getFullYear()}-12-31`);
            }}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Ano Atual
          </button>
        </div>
      </div>

      {erro && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {erro}
        </div>
      )}

      {/* Cards de Totais */}
      {totais && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              <Building2 className="w-4 h-4" />
              Receita Liquida Total
            </div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(totais.receita_liquida)}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-orange-500">
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              CMV Total
            </div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(totais.cmv)}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-purple-500">
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              Despesas Operacionais
            </div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(totais.despesas_operacionais)}</p>
          </div>
          <div className={`bg-white rounded-lg shadow p-4 border-l-4 ${totais.lucro_liquido >= 0 ? 'border-green-500' : 'border-red-500'}`}>
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              {totais.lucro_liquido >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              Lucro Liquido Total
            </div>
            <p className={`text-2xl font-bold mt-1 ${totais.lucro_liquido >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatarValor(totais.lucro_liquido)}
            </p>
            <p className="text-xs text-gray-500">Margem: {formatarPercentual(totais.margem_percentual)}</p>
          </div>
        </div>
      )}

      {/* Tabela Sintetica */}
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="p-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-800">Visao Sintetica por Empresa</h2>
          <p className="text-sm text-gray-600">
            Periodo: {new Date(dataInicio).toLocaleDateString('pt-BR')} a {new Date(dataFim).toLocaleDateString('pt-BR')}
            {empresas.length > 0 && ` | ${empresas.length} empresas`}
          </p>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2" />
            Carregando dados...
          </div>
        ) : empresas.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            Nenhum dado encontrado. Clique em Consultar para buscar os dados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 border-b border-gray-200">
                    Empresa
                  </th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200">
                    Receita Liquida
                  </th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200">
                    CMV
                  </th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200">
                    Lucro Bruto
                  </th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200">
                    Desp. Operacionais
                  </th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200">
                    Lucro Liquido
                  </th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200 bg-blue-50">
                    Margem %
                  </th>
                </tr>
              </thead>
              <tbody>
                {empresas.map((emp) => (
                  <tr key={emp.cd_empresa} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 border-b border-gray-200 font-medium">
                      {emp.nome}
                    </td>
                    <td className="px-3 py-3 border-b border-gray-200 text-right text-sm">
                      {formatarValor(emp.receita_liquida)}
                    </td>
                    <td className="px-3 py-3 border-b border-gray-200 text-right text-sm text-red-600">
                      {formatarValor(-emp.cmv)}
                    </td>
                    <td className="px-3 py-3 border-b border-gray-200 text-right text-sm">
                      {formatarValor(emp.lucro_bruto)}
                    </td>
                    <td className="px-3 py-3 border-b border-gray-200 text-right text-sm text-red-600">
                      {formatarValor(-emp.despesas_operacionais)}
                    </td>
                    <td className={`px-3 py-3 border-b border-gray-200 text-right text-sm font-semibold ${
                      emp.lucro_liquido >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {formatarValor(emp.lucro_liquido)}
                    </td>
                    <td className={`px-3 py-3 border-b border-gray-200 text-right text-sm font-bold bg-blue-50 ${
                      emp.margem_percentual >= 0 ? 'text-green-700' : 'text-red-700'
                    }`}>
                      {formatarPercentual(emp.margem_percentual)}
                    </td>
                  </tr>
                ))}
                {/* Linha de Totais */}
                {totais && (
                  <tr className="bg-gray-100 font-bold">
                    <td className="px-4 py-3 border-b border-gray-300">
                      TOTAL CONSOLIDADO
                    </td>
                    <td className="px-3 py-3 border-b border-gray-300 text-right text-sm">
                      {formatarValor(totais.receita_liquida)}
                    </td>
                    <td className="px-3 py-3 border-b border-gray-300 text-right text-sm text-red-600">
                      {formatarValor(-totais.cmv)}
                    </td>
                    <td className="px-3 py-3 border-b border-gray-300 text-right text-sm">
                      {formatarValor(totais.lucro_bruto)}
                    </td>
                    <td className="px-3 py-3 border-b border-gray-300 text-right text-sm text-red-600">
                      {formatarValor(-totais.despesas_operacionais)}
                    </td>
                    <td className={`px-3 py-3 border-b border-gray-300 text-right text-sm ${
                      totais.lucro_liquido >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {formatarValor(totais.lucro_liquido)}
                    </td>
                    <td className={`px-3 py-3 border-b border-gray-300 text-right text-sm bg-blue-100 ${
                      totais.margem_percentual >= 0 ? 'text-green-700' : 'text-red-700'
                    }`}>
                      {formatarPercentual(totais.margem_percentual)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Dica:</strong> Esta visao mostra um resumo consolidado das principais metricas de cada empresa.
          A margem % representa o lucro liquido dividido pela receita liquida.
        </p>
      </div>
    </div>
  );
}
