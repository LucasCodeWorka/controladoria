'use client';

import React, { useEffect, useState } from 'react';
import { RotateCw, Loader2, ChevronDown } from 'lucide-react';
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

interface EmpresaOpcao {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
}

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

interface EmpresaFaltante {
  cdEmpresa: number;
  nome: string;
}

interface DadosGiro {
  itens: ItemGiro[];
  consolidadoFabrica: Consolidado | null;
  consolidadoLojas: Consolidado | null;
  consolidadoGeral: Consolidado | null;
  dtCalculado: string | null;
  mesIni: string | null;
  mesFim: string | null;
  mesReferencia: string;
  empresasFaltantes: EmpresaFaltante[];
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

function mesAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
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
  const [mesReferencia, setMesReferencia] = useState(mesAtual());
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaOpcao[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<Set<number>>(new Set());
  const [filtroLojasAberto, setFiltroLojasAberto] = useState(false);

  const [dados, setDados] = useState<DadosGiro | null>(null);
  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [recalculando, setRecalculando] = useState(false);
  const [progressoCalculo, setProgressoCalculo] = useState<{ atual: number; total: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/cmv-detalhado/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const lista: EmpresaOpcao[] = data.empresas || [];
        setEmpresasDisponiveis(lista);
        setEmpresasSelecionadas(new Set(lista.map((e) => e.cdEmpresa)));
      })
      .catch((e) => console.error('Erro ao buscar empresas do giro:', e));
  }, []);

  async function buscarSnapshot(mesRef: string, empresasParam: string) {
    try {
      const params = new URLSearchParams({ mesReferencia: mesRef, empresas: empresasParam });
      const response = await fetch(`/api/giro/dados?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (data.error) {
        setErro(`Erro do backend: ${data.error}`);
        return;
      }
      setDados(data);
    } catch (error) {
      console.error('Erro ao buscar giro:', error);
      setErro('Erro ao buscar os dados de giro.');
    }
  }

  // So le o snapshot ja calculado pro mes+empresas atuais (rapido, so
  // consulta o cache local) - nao dispara o calculo pesado sozinho, isso e
  // so no clique de "Calcular".
  useEffect(() => {
    if (empresasSelecionadas.size === 0) return;
    setCarregandoInicial(true);
    buscarSnapshot(mesReferencia, Array.from(empresasSelecionadas).join(',')).finally(() => setCarregandoInicial(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresasDisponiveis.length]);

  function consultar() {
    if (empresasSelecionadas.size === 0) {
      setErro('Selecione pelo menos uma loja/fábrica.');
      return;
    }
    setErro(null);
    setCarregandoInicial(true);
    buscarSnapshot(mesReferencia, Array.from(empresasSelecionadas).join(',')).finally(() => setCarregandoInicial(false));
  }

  async function calcularFaltantes() {
    if (!dados || dados.empresasFaltantes.length === 0) return;
    setRecalculando(true);
    setErro(null);
    const faltantes = dados.empresasFaltantes.map((e) => e.cdEmpresa);
    setProgressoCalculo({ atual: 0, total: faltantes.length });
    try {
      // Calcula uma empresa de cada vez, com progresso - cada uma leva uns
      // segundos a ~40s (fabrica e a mais pesada), dependendo do quanto a
      // parte de venda (view lenta) pesa pra ela.
      for (let i = 0; i < faltantes.length; i++) {
        const params = new URLSearchParams({ mesReferencia, empresas: String(faltantes[i]) });
        const response = await fetch(`/api/giro/recalcular?${params.toString()}`, { method: 'POST', cache: 'no-store' });
        const data = await response.json();
        if (data.error) {
          setErro(`Erro ao calcular: ${data.error}`);
          return;
        }
        setProgressoCalculo({ atual: i + 1, total: faltantes.length });
      }
      await buscarSnapshot(mesReferencia, Array.from(empresasSelecionadas).join(','));
    } catch (error) {
      console.error('Erro ao calcular giro:', error);
      setErro('Erro ao calcular o giro. Tente novamente.');
    } finally {
      setRecalculando(false);
      setProgressoCalculo(null);
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
            <p className="text-sm text-gray-500">Estoque no mês x venda média dos 3 meses cheios anteriores, por loja, fábrica e consolidado.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-gray-500">Mês de referência</label>
          <input
            type="month"
            value={mesReferencia}
            onChange={(e) => setMesReferencia(e.target.value)}
            max={mesAtual()}
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
            onClick={consultar}
            className="px-4 py-1.5 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700 transition-colors"
          >
            Consultar
          </button>
        </div>

        {dados?.dtCalculado && (
          <p className="text-xs text-gray-400 mt-3">
            Último cálculo em {new Date(dados.dtCalculado).toLocaleString('pt-BR')}
            {dados.mesIni && dados.mesFim && <> — venda média referente a {labelMes(dados.mesIni)} a {labelMes(dados.mesFim)}</>}
          </p>
        )}
      </div>

      {erro && <p className="text-sm text-red-600">{erro}</p>}

      {carregandoInicial && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {!carregandoInicial && dados && dados.empresasFaltantes.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <p className="text-xs text-amber-700">
            {recalculando && progressoCalculo
              ? `Calculando... empresa ${progressoCalculo.atual} de ${progressoCalculo.total}.`
              : `${dados.empresasFaltantes.length} empresa(s) sem giro calculado pra ${labelMes(mesReferencia)} (${dados.empresasFaltantes.map((e) => e.nome).join(', ')}) — cada uma leva alguns segundos a ~40s.`}
          </p>
          <button
            onClick={calcularFaltantes}
            disabled={recalculando}
            className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors disabled:opacity-60 flex items-center gap-1.5 shrink-0"
          >
            {recalculando && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Calcular faltantes
          </button>
        </div>
      )}

      {!carregandoInicial && !temDados && !recalculando && dados?.empresasFaltantes.length === 0 && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
          Nenhuma empresa selecionada.
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
              Giro = estoque no mês ÷ venda média mensal dos 3 meses cheios anteriores — meses de cobertura do estoque no ritmo de venda (quanto menor, mais rápido o giro).
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
