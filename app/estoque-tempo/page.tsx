'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Clock, Loader2, ChevronDown } from 'lucide-react';
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
import { carregarFiltro, salvarFiltro } from '../utils/persistirFiltro';

interface EmpresaOpcao {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
}

interface ItemEstoqueTempo {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
  skusTotal: number;
  qtdTotal: number;
  skusAcima3m: number;
  qtdAcima3m: number;
  skusAcima6m: number;
  qtdAcima6m: number;
}

interface Consolidado {
  skusTotal: number;
  qtdTotal: number;
  skusAcima3m: number;
  qtdAcima3m: number;
  skusAcima6m: number;
  qtdAcima6m: number;
}

interface ItemProduto {
  cdProduto: number;
  referencia: string;
  nome: string;
  qtdAtual: number;
  diasParado: number;
}

interface DadosEstoqueTempo {
  itens: ItemEstoqueTempo[];
  consolidadoFabrica: Consolidado | null;
  consolidadoLojas: Consolidado | null;
  consolidadoGeral: Consolidado | null;
  topPiores: ItemProduto[];
  topMelhores: ItemProduto[];
  dtReferencia: string;
}

const COR_3M = '#d97706';
const COR_6M = '#dc2626';

function formatarQtd(valor: number): string {
  return valor.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

function formatarPct(valor: number): string {
  return `${valor.toFixed(1)}%`;
}

function formatarDias(dias: number): string {
  if (dias < 30) return `${dias}d`;
  const meses = dias / 30.44;
  return `${meses.toFixed(1)} meses`;
}

function nomeCurto(nome: string): string {
  return nome.length > 14 ? `${nome.slice(0, 13)}…` : nome;
}

function pct(parte: number, total: number): number {
  return total > 0 ? (parte / total) * 100 : 0;
}

interface BarraDado {
  chave: string | number;
  label: string;
  pct3m: number;
  pct6m: number;
  tooltip3m: string;
  tooltip6m: string;
}

function TooltipBarra({ active, payload }: { active?: boolean; payload?: { dataKey: string; payload: BarraDado }[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const dado = payload[0].payload;
  return (
    <div className="bg-gray-900 text-white text-xs rounded px-2.5 py-1.5 shadow-lg max-w-xs space-y-1">
      <p>{dado.tooltip3m}</p>
      <p>{dado.tooltip6m}</p>
    </div>
  );
}

// Duas barras por loja (% SKUs parados 3m / 6m) - mesmo estilo dos graficos
// do CMV Detalhado e Giro (Recharts, grade, rotulo acima da barra).
function GraficoEstoqueParado({ dados }: { dados: BarraDado[] }) {
  if (dados.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem dado calculado ainda.</p>;
  }
  const muitasCategorias = dados.length > 8;

  return (
    <div role="img" aria-label="% de SKUs parados por loja">
      <ResponsiveContainer width="100%" height={muitasCategorias ? 340 : 280}>
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
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fontSize: 11, fill: '#898781' }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip content={<TooltipBarra />} cursor={{ fill: 'rgba(11,11,11,0.04)' }} />
          <Bar dataKey="pct3m" name="Acima de 3 meses" fill={COR_3M} radius={[4, 4, 0, 0]} maxBarSize={40}>
            <LabelList dataKey="pct3m" position="top" formatter={(v: React.ReactNode) => formatarPct(v as number)} style={{ fontSize: 10, fontWeight: 700, fill: '#0b0b0b' }} />
          </Bar>
          <Bar dataKey="pct6m" name="Acima de 6 meses" fill={COR_6M} radius={[4, 4, 0, 0]} maxBarSize={40}>
            <LabelList dataKey="pct6m" position="top" formatter={(v: React.ReactNode) => formatarPct(v as number)} style={{ fontSize: 10, fontWeight: 700, fill: '#0b0b0b' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-center gap-6 mt-2">
        <span className="flex items-center gap-1.5 text-xs text-gray-600">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: COR_3M }} /> % SKUs acima de 3 meses
        </span>
        <span className="flex items-center gap-1.5 text-xs text-gray-600">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: COR_6M }} /> % SKUs acima de 6 meses
        </span>
      </div>
    </div>
  );
}

function CardConsolidado({ titulo, dado }: { titulo: string; dado: Consolidado | null }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{titulo}</p>
      {dado ? (
        <>
          <div className="flex items-baseline gap-4 mt-1">
            <div>
              <p className="text-2xl font-bold text-amber-700">{formatarPct(pct(dado.skusAcima3m, dado.skusTotal))}</p>
              <p className="text-xs text-gray-400">SKUs &gt; 3 meses</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-700">{formatarPct(pct(dado.skusAcima6m, dado.skusTotal))}</p>
              <p className="text-xs text-gray-400">SKUs &gt; 6 meses</p>
            </div>
          </div>
          <div className="text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100 space-y-1">
            <div className="flex justify-between">
              <span>SKUs parados (3m / 6m)</span>
              <span className="font-medium text-gray-700">{formatarQtd(dado.skusAcima3m)} / {formatarQtd(dado.skusAcima6m)} de {formatarQtd(dado.skusTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Unidades paradas (3m / 6m)</span>
              <span className="font-medium text-gray-700">{formatarQtd(dado.qtdAcima3m)} / {formatarQtd(dado.qtdAcima6m)} de {formatarQtd(dado.qtdTotal)}</span>
            </div>
          </div>
        </>
      ) : (
        <p className="text-2xl font-bold text-gray-300 mt-1">-</p>
      )}
    </div>
  );
}

function TabelaTopProdutos({ titulo, subtitulo, itens, corDestaque }: {
  titulo: string;
  subtitulo: string;
  itens: ItemProduto[];
  corDestaque: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      <div className="p-4 pb-2">
        <h2 className="text-base font-semibold text-gray-800">{titulo}</h2>
        <p className="text-xs text-gray-500">{subtitulo}</p>
      </div>
      {itens.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">Sem produtos suficientes pra calcular.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Referência</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Produto</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Estoque</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Parado há</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {itens.map((item) => (
                <tr key={item.cdProduto} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-500">{item.referencia}</td>
                  <td className="px-4 py-2 text-gray-800">{item.nome}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.qtdAtual)}</td>
                  <td className={`px-4 py-2 text-right font-medium ${corDestaque}`}>{formatarDias(item.diasParado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function EstoqueTempoPage() {
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaOpcao[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<Set<number>>(new Set());
  const [filtroLojasAberto, setFiltroLojasAberto] = useState(false);

  const [dados, setDados] = useState<DadosEstoqueTempo | null>(null);
  const [loading, setLoading] = useState(false);
  const [consultaExecutada, setConsultaExecutada] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/cmv-detalhado/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const lista: EmpresaOpcao[] = data.empresas || [];
        setEmpresasDisponiveis(lista);
        const salvo = carregarFiltro<{ empresas: number[] }>('estoque_tempo_filtros');
        // So aceita empresas que ainda existem na lista atual - uma selecao
        // salva antes (ex: um codigo que deixou de ser listado) nao pode
        // virar um pedido invalido pro backend.
        const validas = new Set(lista.map((e) => e.cdEmpresa));
        const empresasValidas = (salvo?.empresas || []).filter((cd) => validas.has(cd));
        setEmpresasSelecionadas(new Set(empresasValidas.length > 0 ? empresasValidas : lista.map((e) => e.cdEmpresa)));
      })
      .catch((e) => console.error('Erro ao buscar empresas do estoque por tempo:', e));
  }, []);

  const primeiraRenderizacaoFiltroRef = useRef(true);
  useEffect(() => {
    if (primeiraRenderizacaoFiltroRef.current) {
      primeiraRenderizacaoFiltroRef.current = false;
      return;
    }
    salvarFiltro('estoque_tempo_filtros', { empresas: Array.from(empresasSelecionadas) });
  }, [empresasSelecionadas]);

  async function consultar() {
    if (empresasSelecionadas.size === 0) {
      setErro('Selecione pelo menos uma loja/fábrica.');
      return;
    }
    setLoading(true);
    setErro(null);
    try {
      const params = new URLSearchParams({ empresas: Array.from(empresasSelecionadas).join(',') });
      const response = await fetch(`/api/estoque-tempo/dados?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) {
        setErro(`Erro do backend: ${data.detail || data.error || 'Erro desconhecido'}`);
        return;
      }
      setDados(data);
      setConsultaExecutada(true);
    } catch (error) {
      console.error('Erro ao buscar estoque por tempo:', error);
      setErro('Erro ao buscar os dados. Tente novamente.');
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

  const itensOrdenados = dados
    ? [...dados.itens].sort((a, b) => pct(b.skusAcima3m, b.skusTotal) - pct(a.skusAcima3m, a.skusTotal))
    : [];

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-rose-100 rounded-lg">
            <Clock className="w-6 h-6 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">Estoque por Tempo</h1>
            <p className="text-sm text-gray-500">
              Quanto do estoque (em quantidade e em SKUs) está parado — sem nenhuma movimentação — há mais de 3 e mais de 6 meses.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <button
              onClick={() => setFiltroLojasAberto((v) => !v)}
              className="min-w-[160px] flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50"
            >
              Lojas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
              <ChevronDown className="w-4 h-4 text-gray-500" />
            </button>
            {filtroLojasAberto && (
              <div className="absolute z-30 mt-1 w-64 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-xl p-2">
                <div className="flex justify-between px-1 pb-1 mb-1 border-b border-gray-100">
                  <button
                    className="text-xs font-medium text-purple-700 hover:text-purple-900"
                    onClick={() => setEmpresasSelecionadas(new Set(empresasDisponiveis.map((e) => e.cdEmpresa)))}
                  >
                    Todas
                  </button>
                  <button className="text-xs font-medium text-gray-600 hover:text-gray-900" onClick={() => setEmpresasSelecionadas(new Set())}>
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
            onClick={consultar}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Consultar
          </button>
        </div>

        {dados?.dtReferencia && (
          <p className="text-xs text-gray-400 mt-3">
            Posição de estoque em {new Date(`${dados.dtReferencia}T00:00:00`).toLocaleDateString('pt-BR')} — &quot;parado&quot; = sem nenhuma movimentação (entrada ou saída) desde então.
          </p>
        )}
        {erro && <p className="text-sm text-red-600 mt-3">{erro}</p>}
      </div>

      {loading && !consultaExecutada && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {!loading && !consultaExecutada && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
          Escolha as lojas e clique em Consultar.
        </div>
      )}

      {dados && consultaExecutada && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CardConsolidado titulo="Fábrica" dado={dados.consolidadoFabrica} />
            <CardConsolidado titulo="Lojas (consolidado)" dado={dados.consolidadoLojas} />
            <CardConsolidado titulo="Geral" dado={dados.consolidadoGeral} />
          </div>

          <div className="bg-white rounded-lg shadow-lg p-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">% de SKUs parados por loja e fábrica</h2>
            <p className="text-xs text-gray-500 mb-3">Fatia da quantidade de SKUs em estoque que não tem nenhuma movimentação há mais de 3 / 6 meses.</p>
            <GraficoEstoqueParado
              dados={itensOrdenados.map((i) => ({
                chave: i.cdEmpresa,
                label: nomeCurto(i.nome),
                pct3m: pct(i.skusAcima3m, i.skusTotal),
                pct6m: pct(i.skusAcima6m, i.skusTotal),
                tooltip3m: `${i.nome} — acima de 3m: ${formatarPct(pct(i.skusAcima3m, i.skusTotal))} (${formatarQtd(i.skusAcima3m)} de ${formatarQtd(i.skusTotal)} SKUs, ${formatarQtd(i.qtdAcima3m)} unidades)`,
                tooltip6m: `${i.nome} — acima de 6m: ${formatarPct(pct(i.skusAcima6m, i.skusTotal))} (${formatarQtd(i.skusAcima6m)} de ${formatarQtd(i.skusTotal)} SKUs, ${formatarQtd(i.qtdAcima6m)} unidades)`,
              }))}
            />
          </div>

          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Empresa</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">SKUs Total</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">SKUs &gt; 3m</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">% SKUs &gt; 3m</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">SKUs &gt; 6m</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">% SKUs &gt; 6m</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Unid. &gt; 3m</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Unid. &gt; 6m</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {itensOrdenados.map((item) => (
                    <tr key={item.cdEmpresa} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-800">{item.nome}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.skusTotal)}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.skusAcima3m)}</td>
                      <td className="px-4 py-2 text-right font-medium text-amber-700">{formatarPct(pct(item.skusAcima3m, item.skusTotal))}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.skusAcima6m)}</td>
                      <td className="px-4 py-2 text-right font-medium text-red-700">{formatarPct(pct(item.skusAcima6m, item.skusTotal))}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.qtdAcima3m)}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.qtdAcima6m)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TabelaTopProdutos
              titulo="Top 10 mais parados"
              subtitulo="Produtos sem nenhuma movimentação há mais tempo — candidatos a liquidação/transferência."
              itens={dados.topPiores}
              corDestaque="text-red-700"
            />
            <TabelaTopProdutos
              titulo="Top 10 mais recentes"
              subtitulo="Produtos com movimentação mais recente."
              itens={dados.topMelhores}
              corDestaque="text-green-700"
            />
          </div>
        </>
      )}
    </div>
  );
}
