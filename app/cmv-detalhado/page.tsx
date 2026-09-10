'use client';

import React, { useEffect, useRef, useState } from 'react';
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
import AtalhosPeriodo from '../components/filtros/AtalhosPeriodo';
import { carregarFiltro, salvarFiltro } from '../utils/persistirFiltro';

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

type Dimensao = 'grupo' | 'linha' | 'familia' | 'colecao' | 'status' | 'continuidade';

const DIMENSOES: { chave: Dimensao; label: string }[] = [
  { chave: 'grupo', label: 'Grupo' },
  { chave: 'linha', label: 'Linha' },
  { chave: 'familia', label: 'Família' },
  { chave: 'colecao', label: 'Coleção' },
  { chave: 'status', label: 'Status' },
  { chave: 'continuidade', label: 'Continuidade' },
];

interface ItemDimensao {
  chave: string;
  valor: number;
  receita: number;
  percentual: number | null;
}

interface RespostaDimensao {
  dimensao: Dimensao;
  itens: ItemDimensao[];
  mesesFaltantes: string[];
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

// Corte maior que nomeCurto, pra categorias de dimensao (status/familia/...)
// - com 12 caracteres, valores como "OPORTUNIDADE ATE 1 ANO" e "OPORTUNIDADE
// ACIMA DE 2 ANOS" ficavam identicos ("OPORTUNIDAD…"), parecendo repetidos.
// 22 mantem o suficiente pra distinguir sem estourar o espaco do eixo.
function nomeCurtoDimensao(nome: string): string {
  return nome.length > 22 ? `${nome.slice(0, 21)}…` : nome;
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
  const muitasCategorias = dados.length > 8;
  // Acima de ~14 categorias, "espremer" tudo em 100% da largura deixa as
  // barras finas e os rotulos ilegiveis - passa a largura fixa por
  // categoria e deixa rolar na horizontal pra mostrar todas.
  const rolagemHorizontal = dados.length > 14;
  const larguraMinima = rolagemHorizontal ? dados.length * 64 : undefined;

  return (
    <div role="img" aria-label={ariaLabel} className={rolagemHorizontal ? 'overflow-x-auto' : undefined}>
      <div style={larguraMinima ? { minWidth: larguraMinima } : undefined}>
      <ResponsiveContainer width="100%" height={muitasCategorias ? 300 : 240}>
        <BarChart data={dados} margin={{ top: 24, right: 8, left: 0, bottom: muitasCategorias ? 56 : 4 }}>
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
      </div>
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

  const [dimensaoSelecionada, setDimensaoSelecionada] = useState<Dimensao>('linha');
  const [dadosPorDimensao, setDadosPorDimensao] = useState<Record<Dimensao, RespostaDimensao | null>>({
    grupo: null,
    linha: null,
    familia: null,
    colecao: null,
    status: null,
    continuidade: null,
  });
  const [mesesFaltantes, setMesesFaltantes] = useState<string[]>([]);
  const [calculandoMeses, setCalculandoMeses] = useState(false);
  const [progressoCalculo, setProgressoCalculo] = useState<{ atual: number; total: number } | null>(null);

  useEffect(() => {
    fetch('/api/cmv-detalhado/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const lista: EmpresaOpcao[] = data.empresas || [];
        setEmpresasDisponiveis(lista);
        // Restaura o filtro salvo da ultima visita, se houver - senao,
        // seleciona todas por padrao (mesmo padrao do DRE/DFC).
        const salvo = carregarFiltro<{ dataInicio: string; dataFim: string; empresas: number[] }>('cmv_detalhado_filtros');
        const validas = new Set(lista.map((e) => e.cdEmpresa));
        if (salvo) {
          if (salvo.dataInicio) setDataInicio(salvo.dataInicio);
          if (salvo.dataFim) setDataFim(salvo.dataFim);
          // So aceita empresas que ainda existem na lista atual - uma
          // selecao salva antes (ex: um codigo que deixou de ser listado)
          // nao pode virar um pedido invalido pro backend.
          const empresasValidas = (salvo.empresas || []).filter((cd) => validas.has(cd));
          setEmpresasSelecionadas(new Set(empresasValidas.length > 0 ? empresasValidas : lista.map((e) => e.cdEmpresa)));
        } else {
          setEmpresasSelecionadas(new Set(lista.map((e) => e.cdEmpresa)));
        }
      })
      .catch((e) => console.error('Erro ao buscar empresas do CMV detalhado:', e));
  }, []);

  // Salva o filtro atual sempre que o usuario alterar data ou lojas,
  // pulando a primeira renderizacao pra nao sobrescrever o que acabou de ser
  // restaurado acima com os valores padrao.
  const primeiraRenderizacaoFiltroRef = useRef(true);
  useEffect(() => {
    if (primeiraRenderizacaoFiltroRef.current) {
      primeiraRenderizacaoFiltroRef.current = false;
      return;
    }
    salvarFiltro('cmv_detalhado_filtros', { dataInicio, dataFim, empresas: Array.from(empresasSelecionadas) });
  }, [dataInicio, dataFim, empresasSelecionadas]);

  async function buscarDados() {
    if (empresasSelecionadas.size === 0) {
      setStatusCarregamento('Selecione pelo menos uma loja/fábrica.');
      return;
    }
    setLoading(true);
    setStatusCarregamento(null);
    try {
      const empresasParam = Array.from(empresasSelecionadas).join(',');
      const paramsResumo = new URLSearchParams({ dataInicio, dataFim, empresas: empresasParam });

      const [respostaResumo, ...respostasDimensao] = await Promise.all([
        fetch(`/api/cmv-detalhado/resumo?${paramsResumo.toString()}`, { cache: 'no-store' }),
        ...DIMENSOES.map((d) => {
          const params = new URLSearchParams({ dimensao: d.chave, dataInicio, dataFim, empresas: empresasParam });
          return fetch(`/api/cmv-detalhado/por-dimensao?${params.toString()}`, { cache: 'no-store' });
        }),
      ]);

      const dataResumo = await respostaResumo.json();
      // !ok cobre qualquer erro do backend, nao so o formato {error: ...} -
      // o FastAPI usa {detail: ...} - sem isso, um erro (ex: filtro
      // invalido) virava "dados" com formato errado e quebrava a tela.
      if (!respostaResumo.ok || dataResumo.error) {
        setStatusCarregamento(`Erro do backend: ${dataResumo.detail || dataResumo.error || 'Erro desconhecido'}`);
        return;
      }
      setTotais(dataResumo.totais || []);
      setConsolidado(dataResumo.consolidado || null);
      setPorMes(dataResumo.porMes || []);

      const novosDadosDimensao: Record<Dimensao, RespostaDimensao | null> = {
        grupo: null,
        linha: null,
        familia: null,
        colecao: null,
        status: null,
        continuidade: null,
      };
      let faltantes: string[] = [];
      for (let i = 0; i < DIMENSOES.length; i++) {
        const dataDim = await respostasDimensao[i].json();
        if (respostasDimensao[i].ok && !dataDim.error) {
          novosDadosDimensao[DIMENSOES[i].chave] = dataDim;
          faltantes = dataDim.mesesFaltantes || [];
        }
      }
      setDadosPorDimensao(novosDadosDimensao);
      setMesesFaltantes(faltantes);

      setConsultaExecutada(true);
    } catch (error) {
      console.error('Erro ao buscar resumo do CMV detalhado:', error);
      setStatusCarregamento('Erro ao buscar os dados. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  async function calcularMesesFaltantes() {
    if (mesesFaltantes.length === 0) return;
    setCalculandoMeses(true);
    setProgressoCalculo({ atual: 0, total: mesesFaltantes.length });
    try {
      for (let i = 0; i < mesesFaltantes.length; i++) {
        const anoMes = mesesFaltantes[i];
        const response = await fetch(`/api/cmv-detalhado/calcular-mes?anoMes=${anoMes}`, {
          method: 'POST',
          cache: 'no-store',
        });
        const data = await response.json();
        if (!response.ok || data.error) {
          setStatusCarregamento(`Erro ao calcular ${anoMes}: ${data.detail || data.error || 'Erro desconhecido'}`);
          return;
        }
        setProgressoCalculo({ atual: i + 1, total: mesesFaltantes.length });
      }
      // Meses calculados - refaz a consulta pra trazer os graficos atualizados.
      await buscarDados();
    } catch (error) {
      console.error('Erro ao calcular meses do CMV por dimensão:', error);
      setStatusCarregamento('Erro ao calcular os dados. Tente novamente.');
    } finally {
      setCalculandoMeses(false);
      setProgressoCalculo(null);
    }
  }

  // Atalhos de periodo (Mes Anterior/Atual/Ultimos N Meses/Ano Atual/2025)
  // agora vem do componente compartilhado AtalhosPeriodo.
  function aplicarPeriodo(periodo: { dataInicio: string; dataFim: string }) {
    setDataInicio(periodo.dataInicio);
    setDataFim(periodo.dataFim);
  }

  function toggleEmpresaFiltro(cd: number) {
    setEmpresasSelecionadas((atual) => {
      const novo = new Set(atual);
      if (novo.has(cd)) novo.delete(cd);
      else novo.add(cd);
      return novo;
    });
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
            <p className="text-sm text-gray-500">% de CMV sobre a receita, por loja/fábrica e por mês.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Período</h2>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
          <span className="text-gray-500 text-sm">até</span>
          <input
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />

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
            onClick={buscarDados}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors"
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
          <AtalhosPeriodo onSelecionar={aplicarPeriodo} />
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

          <div className="bg-white rounded-lg shadow-lg p-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
              <h2 className="text-base font-semibold text-gray-800">CMV por {DIMENSOES.find((d) => d.chave === dimensaoSelecionada)?.label.toLowerCase()}</h2>
              <div className="flex items-center gap-1.5 flex-wrap">
                {DIMENSOES.map((d) => (
                  <button
                    key={d.chave}
                    onClick={() => setDimensaoSelecionada(d.chave)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      dimensaoSelecionada === d.chave
                        ? 'bg-rose-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              % de CMV sobre a receita (custo/venda), por {DIMENSOES.find((d) => d.chave === dimensaoSelecionada)?.label.toLowerCase()} do produto — fábrica e lojas.
            </p>
            <GraficoBarrasPercentual
              ariaLabel={`CMV por ${dimensaoSelecionada}`}
              dados={(dadosPorDimensao[dimensaoSelecionada]?.itens || [])
                .filter((item) => item.percentual !== null)
                .map((item) => ({
                  chave: item.chave,
                  label: nomeCurtoDimensao(item.chave),
                  valor: item.percentual as number,
                  tooltip: `${item.chave}: ${formatarPct(item.percentual)} (CMV ${formatarValor(item.valor)} / Receita ${formatarValor(item.receita)})`,
                }))}
            />
            {mesesFaltantes.length > 0 && (
              <div className="mt-3 flex items-center justify-between gap-3 flex-wrap bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                <p className="text-xs text-amber-700">
                  {calculandoMeses && progressoCalculo
                    ? `Calculando... mês ${progressoCalculo.atual} de ${progressoCalculo.total}.`
                    : `${mesesFaltantes.length} mês(es) ainda sem cálculo nesse gráfico (${mesesFaltantes.join(', ')}) — o cálculo é pesado e roda mês a mês, por isso não é automático.`}
                </p>
                <button
                  onClick={calcularMesesFaltantes}
                  disabled={calculandoMeses}
                  className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors disabled:opacity-60 flex items-center gap-1.5 shrink-0"
                >
                  {calculandoMeses && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Calcular meses faltantes
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
