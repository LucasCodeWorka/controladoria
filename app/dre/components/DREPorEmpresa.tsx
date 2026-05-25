'use client';

import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Calendar } from 'lucide-react';
import { PLANO_CONTAS_DRE } from '../../configuracoes/plano-contas-dre/planoContasDRE';
import { formatarValor } from '../../utils/formatters';

interface EmpresaInfo {
  cd_empresa: number;
  nome: string;
}

interface ValoresPorConta {
  [conta: string]: {
    [empresaOuTotal: string]: number;
  };
}

interface DREPorEmpresaResponse {
  empresas: EmpresaInfo[];
  valores: ValoresPorConta;
  metadata: {
    totalEmpresas: number;
    dataInicio: string;
    dataFim: string;
  };
  error?: string;
}

interface ContaDRE {
  codigo: string;
  nome: string;
  nivel: number;
  tipo: 'grupo' | 'conta';
  filhos?: ContaDRE[];
}

const CORES_NIVEL: Record<number, string> = {
  1: 'bg-blue-50 font-bold',
  2: 'bg-gray-50',
  3: 'bg-white',
  4: 'bg-white pl-8',
};

export default function DREPorEmpresa() {
  const [loading, setLoading] = useState(false);
  const [dataInicio, setDataInicio] = useState('2026-03-01');
  const [dataFim, setDataFim] = useState('2026-03-31');
  const [empresas, setEmpresas] = useState<EmpresaInfo[]>([]);
  const [valores, setValores] = useState<ValoresPorConta>({});
  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(
    new Set(['01', '02', '04', '06', '08', '08.10', '10', '13'])
  );
  const [erro, setErro] = useState<string | null>(null);

  async function buscarDados() {
    setLoading(true);
    setErro(null);
    try {
      const response = await fetch(`/api/dre/por-empresa?dataInicio=${dataInicio}&dataFim=${dataFim}`);
      const data: DREPorEmpresaResponse = await response.json();

      if (data.error) {
        setErro(data.error as string);
        return;
      }

      setEmpresas(data.empresas || []);
      setValores(data.valores || {});
    } catch (error) {
      console.error('Erro ao buscar DRE por empresa:', error);
      setErro('Erro ao conectar com o servidor');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    buscarDados();
  }, []);

  function toggleExpansao(codigo: string) {
    setContasExpandidas((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  function getValorConta(codigo: string, empresaKey: string): number {
    return valores[codigo]?.[empresaKey] || 0;
  }

  function renderizarLinhaConta(conta: ContaDRE, nivel = 0): React.ReactNode[] {
    const linhas: React.ReactNode[] = [];
    const temFilhos = !!conta.filhos?.length;
    const expandida = contasExpandidas.has(conta.codigo);
    const corLinha = CORES_NIVEL[conta.nivel] || 'bg-white';

    linhas.push(
      <tr key={conta.codigo} className={`${corLinha} hover:bg-gray-100 transition-colors`}>
        <td className="px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10 min-w-[250px]">
          <div
            className="flex items-center gap-2 cursor-pointer"
            style={{ paddingLeft: `${nivel * 16}px` }}
            onClick={() => temFilhos && toggleExpansao(conta.codigo)}
          >
            {temFilhos ? (
              expandida ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            ) : (
              <div className="w-4" />
            )}
            <span className="font-mono text-xs text-gray-500">{conta.codigo}</span>
            <span className="text-sm">{conta.nome}</span>
          </div>
        </td>
        {empresas.map((emp) => {
          const valor = getValorConta(conta.codigo, String(emp.cd_empresa));
          return (
            <td
              key={emp.cd_empresa}
              className={`px-3 py-2 border-b border-gray-200 text-right text-sm min-w-[120px] ${
                valor < 0 ? 'text-red-600' : ''
              }`}
            >
              {formatarValor(valor)}
            </td>
          );
        })}
        <td
          className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold bg-blue-50 min-w-[130px] ${
            getValorConta(conta.codigo, 'total') < 0 ? 'text-red-600' : ''
          }`}
        >
          {formatarValor(getValorConta(conta.codigo, 'total'))}
        </td>
      </tr>
    );

    if (temFilhos && expandida) {
      for (const filho of conta.filhos || []) {
        linhas.push(...renderizarLinhaConta(filho, nivel + 1));
      }
    }

    return linhas;
  }

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

      {/* Tabela DRE por Empresa */}
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="p-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-800">DRE por Empresa / Centro de Custo</h2>
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
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 border-b border-gray-200 sticky left-0 bg-gray-100 z-20 min-w-[250px]">
                    Conta
                  </th>
                  {empresas.map((emp) => (
                    <th
                      key={emp.cd_empresa}
                      className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200 min-w-[120px]"
                      title={emp.nome}
                    >
                      {emp.nome.length > 15 ? emp.nome.substring(0, 15) + '...' : emp.nome}
                    </th>
                  ))}
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200 min-w-[130px] bg-blue-50">
                    TOTAL
                  </th>
                </tr>
              </thead>
              <tbody>
                {(PLANO_CONTAS_DRE as ContaDRE[]).map((conta) => renderizarLinhaConta(conta))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Dica:</strong> Esta visao mostra os valores da DRE separados por empresa/centro de custo.
          Cada coluna representa uma unidade de negocio diferente.
        </p>
      </div>
    </div>
  );
}
