'use client';

import React, { useEffect, useState } from 'react';
import {
  Boxes,
  Calendar,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { formatarValor } from '../utils/formatters';

interface LinhaResumo {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
  anoMes: string;
  mercadoriaRevenda: number;
  produtoProprio: number;
  valorTotal: number;
  detalhado: boolean;
  valorDetalhado?: number | null;
}

interface ItemCmv {
  cdProduto: number;
  dsProduto: string;
  idconta: string;
  qtdTransacoes: number;
  valorCmc: number;
}

interface TransacaoCmv {
  nrTransacao: number;
  dtTransacao: string | null;
  cdProduto: number;
  idconta: string;
  vlTransacao: number | null;
  qtSolicitada: number | null;
  valorUnitario: number | null;
  valorCmc: number;
}

function mesAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

function mesAnterior(): string {
  const hoje = new Date();
  const anterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  return `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, '0')}`;
}

function labelMes(anoMes: string): string {
  const [ano, mes] = anoMes.split('-');
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${nomes[Number(mes) - 1]}/${ano}`;
}

export default function CmvDetalhadoPage() {
  const [anoMes, setAnoMes] = useState(mesAtual());
  const [loading, setLoading] = useState(false);
  const [statusCarregamento, setStatusCarregamento] = useState<string | null>(null);
  const [linhas, setLinhas] = useState<LinhaResumo[]>([]);
  const [consultaExecutada, setConsultaExecutada] = useState(false);

  const [linhaExpandida, setLinhaExpandida] = useState<number | null>(null);
  const [itensPorEmpresa, setItensPorEmpresa] = useState<Record<string, ItemCmv[]>>({});
  const [carregandoItens, setCarregandoItens] = useState(false);

  const [itemExpandido, setItemExpandido] = useState<number | null>(null);
  const [transacoesPorItem, setTransacoesPorItem] = useState<Record<string, TransacaoCmv[]>>({});
  const [carregandoTransacoes, setCarregandoTransacoes] = useState(false);

  const [calculando, setCalculando] = useState<Set<number>>(new Set());

  async function buscarResumo() {
    setLoading(true);
    setStatusCarregamento(null);
    setLinhaExpandida(null);
    setItemExpandido(null);
    try {
      const dataInicio = `${anoMes}-01`;
      const [ano, mes] = anoMes.split('-').map(Number);
      const ultimoDia = new Date(ano, mes, 0).getDate();
      const dataFim = `${anoMes}-${String(ultimoDia).padStart(2, '0')}`;
      const params = new URLSearchParams({ dataInicio, dataFim });
      const response = await fetch(`/api/cmv-detalhado/resumo?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (data.error) {
        setStatusCarregamento(`Erro do backend: ${data.error}`);
        return;
      }
      const linhasOrdenadas = [...(data.linhas || [])].sort((a, b) => b.valorTotal - a.valorTotal);
      setLinhas(linhasOrdenadas);
      setConsultaExecutada(true);
    } catch (error) {
      console.error('Erro ao buscar resumo do CMV detalhado:', error);
      setStatusCarregamento('Erro ao buscar o resumo. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    buscarResumo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anoMes]);

  async function toggleLinha(linha: LinhaResumo) {
    if (linhaExpandida === linha.cdEmpresa) {
      setLinhaExpandida(null);
      return;
    }
    setLinhaExpandida(linha.cdEmpresa);
    setItemExpandido(null);
    const chave = `${linha.cdEmpresa}-${anoMes}`;
    if (itensPorEmpresa[chave]) return;

    setCarregandoItens(true);
    try {
      const params = new URLSearchParams({ cdEmpresa: String(linha.cdEmpresa), anoMes });
      const response = await fetch(`/api/cmv-detalhado/itens?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      setItensPorEmpresa((atual) => ({ ...atual, [chave]: data.itens || [] }));
    } catch (error) {
      console.error('Erro ao buscar itens do CMV detalhado:', error);
    } finally {
      setCarregandoItens(false);
    }
  }

  async function toggleItem(linha: LinhaResumo, item: ItemCmv) {
    if (itemExpandido === item.cdProduto) {
      setItemExpandido(null);
      return;
    }
    setItemExpandido(item.cdProduto);
    const chave = `${linha.cdEmpresa}-${anoMes}-${item.cdProduto}`;
    if (transacoesPorItem[chave]) return;

    setCarregandoTransacoes(true);
    try {
      const params = new URLSearchParams({
        cdEmpresa: String(linha.cdEmpresa),
        anoMes,
        cdProduto: String(item.cdProduto),
      });
      const response = await fetch(`/api/cmv-detalhado/transacoes?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      setTransacoesPorItem((atual) => ({ ...atual, [chave]: data.transacoes || [] }));
    } catch (error) {
      console.error('Erro ao buscar transacoes do CMV detalhado:', error);
    } finally {
      setCarregandoTransacoes(false);
    }
  }

  async function calcularDetalhamento(linha: LinhaResumo) {
    setCalculando((atual) => new Set(atual).add(linha.cdEmpresa));
    try {
      const params = new URLSearchParams({ cdEmpresa: String(linha.cdEmpresa), anoMes });
      const response = await fetch(`/api/cmv-detalhado/calcular?${params.toString()}`, {
        method: 'POST',
        cache: 'no-store',
      });
      const data = await response.json();
      if (data.error) {
        setStatusCarregamento(`Erro ao calcular ${linha.nome}: ${data.error}`);
        return;
      }
      await buscarResumo();
    } catch (error) {
      console.error('Erro ao calcular CMV detalhado:', error);
      setStatusCarregamento(`Erro ao calcular ${linha.nome}. Tente novamente.`);
    } finally {
      setCalculando((atual) => {
        const novo = new Set(atual);
        novo.delete(linha.cdEmpresa);
        return novo;
      });
    }
  }

  const totalGeral = linhas.reduce((acc, l) => acc + l.valorTotal, 0);

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
              Custo de Mercadoria Vendida venda a venda, item a item — por loja e por mês.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Calendar className="w-4 h-4 text-gray-400" />
          <input
            type="month"
            value={anoMes}
            onChange={(e) => setAnoMes(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
          />
          <button
            onClick={() => setAnoMes(mesAtual())}
            className={`px-3 py-1.5 text-xs rounded-md border ${anoMes === mesAtual() ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
          >
            Mês Atual
          </button>
          <button
            onClick={() => setAnoMes(mesAnterior())}
            className={`px-3 py-1.5 text-xs rounded-md border ${anoMes === mesAnterior() ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
          >
            Mês Anterior
          </button>
          <button
            onClick={() => buscarResumo()}
            className="ml-auto p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors"
            title="Atualizar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {statusCarregamento && (
          <p className="text-sm text-red-600 mt-3">{statusCarregamento}</p>
        )}
      </div>

      {loading && !consultaExecutada && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {consultaExecutada && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-rose-50 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-800">Por loja — {labelMes(anoMes)}</h2>
              <p className="text-xs text-gray-500">
                Contas 04.02.01 (Mercadoria p/ Revenda) e 04.02.02 (Produto Próprio). Clique numa loja pra ver item a
                item; clique num item pra ver venda a venda.
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500">Total CMV do mês</p>
              <p className="text-lg font-bold text-red-600">{formatarValor(totalGeral)}</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-4 py-3 text-left font-semibold border-b">Loja</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">Mercadoria p/ Revenda</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">Produto Próprio</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">Total CMV</th>
                  <th className="px-3 py-3 text-center font-semibold border-b">Detalhe item/venda</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha) => {
                  const expandida = linhaExpandida === linha.cdEmpresa;
                  const chaveItens = `${linha.cdEmpresa}-${anoMes}`;
                  const estaCalculando = calculando.has(linha.cdEmpresa);
                  return (
                    <React.Fragment key={linha.cdEmpresa}>
                      <tr
                        className={`border-b hover:bg-gray-50 cursor-pointer ${expandida ? 'bg-rose-50' : ''}`}
                        onClick={() => toggleLinha(linha)}
                      >
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            {expandida ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                            <span className="font-medium">{linha.nome}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold ${linha.tipo === 'fabrica' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                              {linha.tipo}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right text-red-600">{formatarValor(-Math.abs(linha.mercadoriaRevenda))}</td>
                        <td className="px-3 py-2 text-right text-red-600">{formatarValor(-Math.abs(linha.produtoProprio))}</td>
                        <td className="px-3 py-2 text-right font-semibold text-red-600">{formatarValor(-Math.abs(linha.valorTotal))}</td>
                        <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                          {linha.detalhado ? (
                            <span className="text-[11px] px-2 py-1 rounded bg-green-100 text-green-700 font-medium">Disponível</span>
                          ) : estaCalculando ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                              <Loader2 className="w-3 h-3 animate-spin" /> Calculando (pode levar minutos)...
                            </span>
                          ) : (
                            <button
                              onClick={() => calcularDetalhamento(linha)}
                              className="text-[11px] px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 font-medium"
                              title="Calcula o item a item dessa loja/mês a partir da fonte original (pode levar alguns minutos)"
                            >
                              Calcular detalhe
                            </button>
                          )}
                        </td>
                      </tr>
                      {expandida && (
                        <tr>
                          <td colSpan={5} className="p-0 border-b bg-gray-50">
                            {carregandoItens && !itensPorEmpresa[chaveItens] ? (
                              <div className="flex items-center justify-center py-6">
                                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                <span className="ml-2 text-xs text-gray-500">Carregando itens...</span>
                              </div>
                            ) : !linha.detalhado && linha.tipo === 'loja' ? (
                              <p className="text-xs text-gray-500 px-8 py-4">
                                Detalhe item a item ainda não calculado pra essa loja/mês. Clique em &quot;Calcular
                                detalhe&quot; na linha acima.
                              </p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-gray-100 text-gray-500">
                                    <th className="px-8 py-2 text-left font-semibold">Produto</th>
                                    <th className="px-3 py-2 text-left font-semibold">Conta</th>
                                    <th className="px-3 py-2 text-right font-semibold">Transações</th>
                                    <th className="px-3 py-2 text-right font-semibold">CMV</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(itensPorEmpresa[chaveItens] || []).map((item) => {
                                    const itemAberto = itemExpandido === item.cdProduto;
                                    const chaveTransacoes = `${linha.cdEmpresa}-${anoMes}-${item.cdProduto}`;
                                    return (
                                      <React.Fragment key={`${item.cdProduto}-${item.idconta}`}>
                                        <tr
                                          className={`border-t hover:bg-white cursor-pointer ${itemAberto ? 'bg-white' : ''}`}
                                          onClick={() => toggleItem(linha, item)}
                                        >
                                          <td className="px-8 py-1.5">
                                            <div className="flex items-center gap-1.5">
                                              {itemAberto ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
                                              {item.dsProduto}
                                            </div>
                                          </td>
                                          <td className="px-3 py-1.5 font-mono text-gray-500">{item.idconta}</td>
                                          <td className="px-3 py-1.5 text-right text-gray-500">{item.qtdTransacoes}</td>
                                          <td className="px-3 py-1.5 text-right text-red-600 font-medium">{formatarValor(-Math.abs(item.valorCmc))}</td>
                                        </tr>
                                        {itemAberto && (
                                          <tr>
                                            <td colSpan={4} className="p-0 bg-white">
                                              {carregandoTransacoes && !transacoesPorItem[chaveTransacoes] ? (
                                                <div className="flex items-center justify-center py-4">
                                                  <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
                                                  <span className="ml-2 text-xs text-gray-500">Carregando vendas...</span>
                                                </div>
                                              ) : (
                                                <table className="w-full text-xs">
                                                  <thead>
                                                    <tr className="bg-gray-50 text-gray-400">
                                                      <th className="px-14 py-1.5 text-left font-semibold">Transação</th>
                                                      <th className="px-3 py-1.5 text-left font-semibold">Data</th>
                                                      <th className="px-3 py-1.5 text-right font-semibold">Qtd</th>
                                                      <th className="px-3 py-1.5 text-right font-semibold">Vl. Venda</th>
                                                      <th className="px-3 py-1.5 text-right font-semibold">Custo Unit.</th>
                                                      <th className="px-3 py-1.5 text-right font-semibold">CMV</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {(transacoesPorItem[chaveTransacoes] || []).map((t, idx) => (
                                                      <tr key={`${t.nrTransacao}-${idx}`} className="border-t border-gray-100">
                                                        <td className="px-14 py-1 font-mono text-gray-500">{t.nrTransacao}</td>
                                                        <td className="px-3 py-1 text-gray-500">
                                                          {t.dtTransacao ? new Date(t.dtTransacao).toLocaleDateString('pt-BR') : '-'}
                                                        </td>
                                                        <td className="px-3 py-1 text-right text-gray-500">{t.qtSolicitada ?? '-'}</td>
                                                        <td className="px-3 py-1 text-right text-gray-500">
                                                          {t.vlTransacao !== null ? formatarValor(t.vlTransacao) : '-'}
                                                        </td>
                                                        <td className="px-3 py-1 text-right text-gray-500">
                                                          {t.valorUnitario !== null ? formatarValor(t.valorUnitario) : '-'}
                                                        </td>
                                                        <td className="px-3 py-1 text-right text-red-600 font-medium">
                                                          {formatarValor(-Math.abs(t.valorCmc))}
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
        </div>
      )}
    </div>
  );
}
