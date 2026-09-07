'use client';

import React, { useEffect, useState } from 'react';
import { RotateCw, Loader2 } from 'lucide-react';
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

interface ItemGiro {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
  estoqueAtual: number;
  vendaMedia3m: number;
  giro: number | null;
}

interface Consolidado {
  estoqueAtual: number;
  vendaMedia3m: number;
  giro: number | null;
}

interface DadosGiro {
  itens: ItemGiro[];
  consolidadoFabrica: Consolidado | null;
  consolidadoLojas: Consolidado | null;
  consolidadoGeral: Consolidado | null;
  dtCalculado: string | null;
  mesIni: string | null;
  mesFim: string | null;
}

const COR_BARRA = '#2a78d6';

function formatarQtd(valor: number): string {
  return valor.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

function formatarGiro(valor: number | null): string {
  if (valor === null) return '-';
  return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function labelMes(anoMes: string): string {
  const [ano, mes] = anoMes.split('-');
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${nomes[Number(mes) - 1]}/${ano.slice(2)}`;
}

function nomeCurto(nome: string): string {
  return nome.length > 14 ? `${nome.slice(0, 13)}…` : nome;
}

interface BarraDado {
  chave: string | number;
  label: string;
  valor: number;
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
      {dado.tooltip || `${dado.label}: ${formatarGiro(dado.valor)}`}
    </div>
  );
}

// Barras do giro (razao estoque/venda media, "meses de cobertura") - mesmo
// estilo dos graficos de % do CMV Detalhado, so que o eixo/rotulo mostra um
// numero com 2 casas em vez de %.
function GraficoGiro({ dados }: { dados: BarraDado[] }) {
  if (dados.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem giro calculado ainda.</p>;
  }
  const muitasCategorias = dados.length > 8;

  return (
    <div role="img" aria-label="Giro por loja e fábrica">
      <ResponsiveContainer width="100%" height={muitasCategorias ? 320 : 260}>
        <BarChart data={dados} margin={{ top: 24, right: 8, left: 0, bottom: muitasCategorias ? 64 : 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#52514e' }}
            interval={0}
            angle={muitasCategorias ? -35 : 0}
            textAnchor={muitasCategorias ? 'end' : 'middle'}
            axisLine={{ stroke: '#c3c2b7' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#898781' }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip content={<TooltipBarra />} cursor={{ fill: 'rgba(11,11,11,0.04)' }} />
          <Bar dataKey="valor" fill={COR_BARRA} radius={[4, 4, 0, 0]} maxBarSize={56}>
            <LabelList
              dataKey="valor"
              position="top"
              formatter={(v: React.ReactNode) => formatarGiro(v as number)}
              style={{ fontSize: 11, fontWeight: 700, fill: '#0b0b0b' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CardConsolidado({ titulo, dado }: { titulo: string; dado: Consolidado | null }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{titulo}</p>
      <p className="text-3xl font-bold text-gray-900 mt-1">{dado ? formatarGiro(dado.giro) : '-'}</p>
      <p className="text-xs text-gray-400 mt-0.5">meses de cobertura</p>
      {dado && (
        <div className="flex justify-between text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100">
          <span>Estoque: {formatarQtd(dado.estoqueAtual)} un.</span>
          <span>Venda média/mês: {formatarQtd(dado.vendaMedia3m)} un.</span>
        </div>
      )}
    </div>
  );
}

export default function GiroPage() {
  const [dados, setDados] = useState<DadosGiro | null>(null);
  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [recalculando, setRecalculando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function buscarUltimoSnapshot() {
    try {
      const response = await fetch('/api/giro/dados', { cache: 'no-store' });
      const data = await response.json();
      if (data.error) {
        setErro(`Erro do backend: ${data.error}`);
        return;
      }
      setDados(data);
    } catch (error) {
      console.error('Erro ao buscar giro:', error);
      setErro('Erro ao buscar os dados de giro.');
    } finally {
      setCarregandoInicial(false);
    }
  }

  // So le o ultimo snapshot ja calculado (rapido, so consulta o cache local)
  // - nao dispara o calculo pesado sozinho, isso e so no clique de
  // "Recalcular".
  useEffect(() => {
    buscarUltimoSnapshot();
  }, []);

  async function recalcular() {
    setRecalculando(true);
    setErro(null);
    try {
      const response = await fetch('/api/giro/recalcular', { method: 'POST', cache: 'no-store' });
      const data = await response.json();
      if (data.error) {
        setErro(`Erro do backend: ${data.error}`);
        return;
      }
      setDados(data);
    } catch (error) {
      console.error('Erro ao recalcular giro:', error);
      setErro('Erro ao recalcular o giro. Tente novamente.');
    } finally {
      setRecalculando(false);
    }
  }

  const temDados = !!dados && dados.itens.length > 0;
  const itensOrdenados = dados
    ? [...dados.itens].sort((a, b) => (b.giro ?? -1) - (a.giro ?? -1))
    : [];

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-rose-100 rounded-lg">
            <RotateCw className="w-6 h-6 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">Giro</h1>
            <p className="text-sm text-gray-500">Estoque atual x venda média dos últimos 3 meses completos, por loja, fábrica e consolidado.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="text-sm text-gray-600">
          {dados?.dtCalculado ? (
            <>
              Calculado em {new Date(dados.dtCalculado).toLocaleString('pt-BR')}
              {dados.mesIni && dados.mesFim && (
                <> — venda média referente a {labelMes(dados.mesIni)} a {labelMes(dados.mesFim)}</>
              )}
            </>
          ) : (
            'Giro ainda não foi calculado.'
          )}
        </div>
        <button
          onClick={recalcular}
          disabled={recalculando}
          className="px-4 py-1.5 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700 transition-colors disabled:opacity-60 flex items-center gap-2"
        >
          {recalculando && <Loader2 className="w-4 h-4 animate-spin" />}
          {recalculando ? 'Calculando... (~1 min)' : 'Recalcular giro'}
        </button>
      </div>

      {erro && <p className="text-sm text-red-600">{erro}</p>}

      {carregandoInicial && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {!carregandoInicial && !temDados && !recalculando && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
          Nenhum giro calculado ainda. Clique em &quot;Recalcular giro&quot; (leva cerca de 1 minuto).
        </div>
      )}

      {temDados && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CardConsolidado titulo="Giro Fábrica" dado={dados!.consolidadoFabrica} />
            <CardConsolidado titulo="Giro Lojas (consolidado)" dado={dados!.consolidadoLojas} />
            <CardConsolidado titulo="Giro Geral" dado={dados!.consolidadoGeral} />
          </div>

          <div className="bg-white rounded-lg shadow-lg p-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Giro por loja e fábrica</h2>
            <p className="text-xs text-gray-500 mb-3">
              Giro = estoque atual ÷ venda média mensal dos últimos 3 meses completos — meses de cobertura do estoque no ritmo atual de venda (quanto menor, mais rápido o giro).
            </p>
            <GraficoGiro
              dados={itensOrdenados
                .filter((i) => i.giro !== null)
                .map((i) => ({
                  chave: i.cdEmpresa,
                  label: nomeCurto(i.nome),
                  valor: i.giro as number,
                  tooltip: `${i.nome}: ${formatarGiro(i.giro)} meses de cobertura (estoque ${formatarQtd(i.estoqueAtual)} un. / venda média ${formatarQtd(i.vendaMedia3m)} un./mês)`,
                }))}
            />
          </div>

          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Empresa</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Tipo</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Estoque Atual</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Venda Média 3m</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Giro</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {itensOrdenados.map((item) => (
                    <tr key={item.cdEmpresa} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-800">{item.nome}</td>
                      <td className="px-4 py-2 text-gray-500 capitalize">{item.tipo}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.estoqueAtual)}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.vendaMedia3m)}</td>
                      <td className="px-4 py-2 text-right font-medium text-gray-900">{formatarGiro(item.giro)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
