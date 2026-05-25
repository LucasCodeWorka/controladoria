'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw, Calendar, TrendingUp, TrendingDown, Building2, X, ChevronRight, ChevronDown } from 'lucide-react';
import { formatarValor } from '../../utils/formatters';

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
  metadata: { totalEmpresas: number; dataInicio: string; dataFim: string };
  error?: string;
}

export interface ContaDRE {
  codigo: string;
  nome: string;
  nivel: number;
  tipo: string;
  valores: Record<string, number>;
  total: number;
  filhos?: ContaDRE[];
}

// Quais prefixos de conta compõem cada métrica
const GRUPOS_METRICA: Record<string, string[]> = {
  receita_liquida: ['01', '02', '03'],
  cmv:             ['04', '06'],
  lucro_bruto:     ['01', '02', '03', '04', '06'],
  despesas_operacionais: ['08'],
  lucro_liquido:   ['01', '02', '03', '04', '06', '08', '10', '12', '13'],
};

const LABEL_METRICA: Record<string, string> = {
  receita_liquida: 'Receita Líquida',
  cmv: 'CMV',
  lucro_bruto: 'Lucro Bruto',
  despesas_operacionais: 'Despesas Operacionais',
  lucro_liquido: 'Lucro Líquido',
};

function formatarPercentual(valor: number): string {
  return `${valor.toFixed(1)}%`;
}

// ─── Modal de detalhe ─────────────────────────────────────────────────────────

interface ModalState {
  aberto: boolean;
  metrica: string;
  empresa: EmpresaResultado | null;
  valor: number;
}

// Achata a árvore de contas em lista ordenada (depth-first)
function acharConta(contas: ContaDRE[], resultado: ContaDRE[] = []): ContaDRE[] {
  for (const c of contas) {
    resultado.push(c);
    if (c.filhos?.length) acharConta(c.filhos, resultado);
  }
  return resultado;
}

function DetalheModal({
  modal,
  dataInicio,
  dataFim,
  dreContas,
  drePeriodos,
  onClose,
}: {
  modal: ModalState;
  dataInicio: string;
  dataFim: string;
  dreContas: ContaDRE[];
  drePeriodos: { key: string; label: string }[];
  onClose: () => void;
}) {
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set<string>());

  const contasFiltradas = React.useMemo(() => {
    const prefixos = GRUPOS_METRICA[modal.metrica] ?? [];
    const plana = acharConta(dreContas);
    return plana.filter((c: ContaDRE) =>
      prefixos.some((p: string) => c.codigo === p || c.codigo.startsWith(p + '.'))
    );
  }, [dreContas, modal.metrica]);

  useEffect(() => {
    if (!modal.aberto) return;
    const nivel1 = new Set<string>(
      contasFiltradas.filter((c: ContaDRE) => c.nivel === 1).map((c: ContaDRE) => c.codigo)
    );
    setExpandidas(nivel1);
  }, [modal.aberto, modal.metrica, contasFiltradas]);

  function toggle(codigo: string) {
    setExpandidas((prev) => {
      const n = new Set(prev);
      n.has(codigo) ? n.delete(codigo) : n.add(codigo);
      return n;
    });
  }

  function visivel(conta: ContaDRE): boolean {
    if (conta.nivel === 1) return true;
    const partes = conta.codigo.split('.');
    for (let i = 1; i < partes.length; i++) {
      const pai = partes.slice(0, i).join('.');
      if (!expandidas.has(pai)) return false;
    }
    return true;
  }

  function temFilhos(conta: ContaDRE): boolean {
    return contasFiltradas.some(
      (c: ContaDRE) => c.codigo !== conta.codigo && c.codigo.startsWith(conta.codigo + '.')
    );
  }

  if (!modal.aberto) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-bold text-gray-900">
              {LABEL_METRICA[modal.metrica] ?? modal.metrica}
              {modal.empresa && (
                <span className="ml-2 text-sm font-normal text-gray-500">— {modal.empresa.nome}</span>
              )}
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {new Date(dataInicio + 'T12:00:00').toLocaleDateString('pt-BR')} a{' '}
              {new Date(dataFim + 'T12:00:00').toLocaleDateString('pt-BR')}
              &nbsp;·&nbsp;
              <span className="font-semibold text-gray-700">{formatarValor(Math.abs(modal.valor))}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-auto flex-1">
          {contasFiltradas.length === 0 ? (
            <div className="py-16 text-center text-gray-400">Nenhum dado encontrado. Consulte o DRE primeiro.</div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 border-b">Conta</th>
                  {drePeriodos.map((p: { key: string; label: string }) => (
                    <th key={p.key} className="px-3 py-3 text-right font-semibold text-gray-700 border-b whitespace-nowrap">
                      {p.label}
                    </th>
                  ))}
                  <th className="px-3 py-3 text-right font-semibold text-gray-700 border-b">Total</th>
                </tr>
              </thead>
              <tbody>
                {contasFiltradas.filter(visivel).map((conta: ContaDRE) => {
                  const indent = (conta.nivel - 1) * 20;
                  const comFilhos = temFilhos(conta);
                  const aberta = expandidas.has(conta.codigo);
                  const total = drePeriodos.reduce((s: number, p: { key: string; label: string }) => s + (conta.valores[p.key] ?? 0), 0);
                  const isNegativo = total < 0;
                  return (
                    <tr key={conta.codigo} className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${conta.nivel === 1 ? 'bg-gray-50 font-bold' : conta.nivel === 2 ? 'font-semibold' : ''}`}>
                      <td className="px-4 py-2" style={{ paddingLeft: `${16 + indent}px` }}>
                        <div className="flex items-center gap-1">
                          {comFilhos ? (
                            <button onClick={() => toggle(conta.codigo)} className="text-gray-400 hover:text-gray-700 flex-shrink-0">
                              {aberta ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </button>
                          ) : (
                            <span className="w-4 flex-shrink-0" />
                          )}
                          <span className="text-xs text-gray-400 mr-1 font-mono">{conta.codigo}</span>
                          <span className={conta.nivel === 1 ? 'text-gray-800' : 'text-gray-700'}>{conta.nome}</span>
                        </div>
                      </td>
                      {drePeriodos.map((p: { key: string; label: string }) => {
                        const v = conta.valores[p.key] ?? 0;
                        return (
                          <td key={p.key} className={`px-3 py-2 text-right whitespace-nowrap ${v < 0 ? 'text-red-600' : v > 0 ? 'text-gray-800' : 'text-gray-400'}`}>
                            {v === 0 ? '-' : formatarValor(v)}
                          </td>
                        );
                      })}
                      <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${isNegativo ? 'text-red-600' : total > 0 ? 'text-gray-800' : 'text-gray-400'}`}>
                        {total === 0 ? '-' : formatarValor(total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
          <p className="text-xs text-gray-400">* Valores consolidados de todas as empresas para o período selecionado.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function DRESintetico({
  dreContas = [],
  drePeriodos = [],
}: {
  dreContas?: ContaDRE[];
  drePeriodos?: { key: string; label: string }[];
}) {
  const [loading, setLoading] = useState(false);
  const [dataInicio, setDataInicio] = useState(() => {
    const h = new Date();
    return `${h.getFullYear()}-01-01`;
  });
  const [dataFim, setDataFim] = useState(() => {
    const h = new Date();
    const ultimo = new Date(h.getFullYear(), h.getMonth() + 1, 0).getDate();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${ultimo}`;
  });
  const [empresas, setEmpresas] = useState<EmpresaResultado[]>([]);
  const [totais, setTotais] = useState<TotaisConsolidados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ aberto: false, metrica: '', empresa: null, valor: 0 });

  async function buscarDados() {
    setLoading(true);
    setErro(null);
    try {
      const response = await fetch(`/api/dre/sintetico?dataInicio=${dataInicio}&dataFim=${dataFim}`);
      const data: DRESinteticoResponse = await response.json();
      if (data.error) { setErro(data.error); return; }
      setEmpresas(data.empresas || []);
      setTotais(data.totais || null);
    } catch {
      setErro('Erro ao conectar com o servidor');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { buscarDados(); }, []);

  function abrirModal(metrica: string, empresa: EmpresaResultado | null, valor: number) {
    setModal({ aberto: true, metrica, empresa, valor });
  }

  function CelulaClicavel({ valor, metrica, empresa, negativo = false, bold = false }: {
    valor: number; metrica: string; empresa: EmpresaResultado | null; negativo?: boolean; bold?: boolean;
  }) {
    return (
      <td
        onClick={() => abrirModal(metrica, empresa, valor)}
        className={`px-3 py-3 border-b border-gray-200 text-right text-sm cursor-pointer hover:bg-blue-50 hover:underline transition-colors ${
          negativo ? 'text-red-600' : ''
        } ${bold ? 'font-semibold' : ''}`}
        title="Clique para ver o detalhamento"
      >
        {formatarValor(negativo ? -valor : valor)}
      </td>
    );
  }

  return (
    <div className="space-y-6">
      <DetalheModal modal={modal} dataInicio={dataInicio} dataFim={dataFim} dreContas={dreContas} drePeriodos={drePeriodos} onClose={() => setModal((m) => ({ ...m, aberto: false }))} />

      {/* Filtros */}
      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Filtros</h2>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary" />
          <span className="text-gray-500">ate</span>
          <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary" />
          <button onClick={buscarDados} disabled={loading}
            className="px-5 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50">
            {loading ? 'Carregando...' : 'Consultar'}
          </button>
          <button onClick={buscarDados} disabled={loading} title="Atualizar"
            className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => { const h = new Date(); setDataInicio(`${h.getFullYear()}-01-01`); setDataFim(`${h.getFullYear()}-12-31`); }}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Ano Atual
          </button>
        </div>
      </div>

      {erro && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{erro}</div>
      )}

      {/* Cards de Totais */}
      {totais && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
            <div className="flex items-center gap-2 text-gray-600 text-sm"><Building2 className="w-4 h-4" />Receita Líquida Total</div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(totais.receita_liquida)}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-orange-500">
            <div className="text-gray-600 text-sm">CMV Total</div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(totais.cmv)}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-purple-500">
            <div className="text-gray-600 text-sm">Despesas Operacionais</div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(totais.despesas_operacionais)}</p>
          </div>
          <div className={`bg-white rounded-lg shadow p-4 border-l-4 ${totais.lucro_liquido >= 0 ? 'border-green-500' : 'border-red-500'}`}>
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              {totais.lucro_liquido >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              Lucro Líquido Total
            </div>
            <p className={`text-2xl font-bold mt-1 ${totais.lucro_liquido >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatarValor(totais.lucro_liquido)}
            </p>
            <p className="text-xs text-gray-500">Margem: {formatarPercentual(totais.margem_percentual)}</p>
          </div>
        </div>
      )}

      {/* Tabela Sintética */}
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="p-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-800">Visão Sintética por Empresa</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date(dataInicio + 'T12:00:00').toLocaleDateString('pt-BR')} a {new Date(dataFim + 'T12:00:00').toLocaleDateString('pt-BR')}
            {empresas.length > 0 && ` · ${empresas.length} empresas`}
            {' '}· <span className="text-blue-600">Clique em um valor para ver o detalhamento</span>
          </p>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2" />
            Carregando dados...
          </div>
        ) : empresas.length === 0 ? (
          <div className="p-8 text-center text-gray-500">Nenhum dado encontrado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 border-b">Empresa</th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b">Receita Líquida</th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b">CMV</th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b">Lucro Bruto</th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b">Desp. Operacionais</th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b">Lucro Líquido</th>
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b bg-blue-50">Margem %</th>
                </tr>
              </thead>
              <tbody>
                {empresas.map((emp) => (
                  <tr key={emp.cd_empresa} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 border-b border-gray-200 font-medium">{emp.nome}</td>
                    <CelulaClicavel valor={emp.receita_liquida}        metrica="receita_liquida"        empresa={emp} />
                    <CelulaClicavel valor={emp.cmv}                    metrica="cmv"                    empresa={emp} negativo />
                    <CelulaClicavel valor={emp.lucro_bruto}            metrica="lucro_bruto"            empresa={emp} />
                    <CelulaClicavel valor={emp.despesas_operacionais}  metrica="despesas_operacionais"  empresa={emp} negativo />
                    <CelulaClicavel valor={emp.lucro_liquido}          metrica="lucro_liquido"          empresa={emp} bold />
                    <td className={`px-3 py-3 border-b border-gray-200 text-right text-sm font-bold bg-blue-50 ${emp.margem_percentual >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {formatarPercentual(emp.margem_percentual)}
                    </td>
                  </tr>
                ))}
                {totais && (
                  <tr className="bg-gray-100 font-bold">
                    <td className="px-4 py-3 border-b border-gray-300">TOTAL CONSOLIDADO</td>
                    <CelulaClicavel valor={totais.receita_liquida}       metrica="receita_liquida"       empresa={null} />
                    <CelulaClicavel valor={totais.cmv}                   metrica="cmv"                   empresa={null} negativo />
                    <CelulaClicavel valor={totais.lucro_bruto}           metrica="lucro_bruto"           empresa={null} />
                    <CelulaClicavel valor={totais.despesas_operacionais} metrica="despesas_operacionais" empresa={null} negativo />
                    <CelulaClicavel valor={totais.lucro_liquido}         metrica="lucro_liquido"         empresa={null} bold />
                    <td className={`px-3 py-3 border-b border-gray-300 text-right text-sm bg-blue-100 ${totais.margem_percentual >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {formatarPercentual(totais.margem_percentual)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
