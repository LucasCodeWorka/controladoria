'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Factory,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  X,
  FileText,
  Building2,
  Store,
  BarChart3,
  Table,
  Filter,
  Eye,
  EyeOff,
} from 'lucide-react';

import { PLANO_CONTAS_DRE_FABRICA, type ContaDRE } from './planoContasDREFabrica';
import { formatarValor } from '../utils/formatters';

// Tipos
type TipoVisao = 'analitica' | 'sintetica' | 'por-empresa';

interface OpcaoFiltro {
  valor: string;
  label: string;
  tipo: string;
}

interface PeriodoDRE {
  key: string;
  label: string;
}

interface ContaDREValores {
  codigo: string;
  codigoExibicao?: string;
  nome: string;
  nivel: number;
  tipo: 'grupo' | 'conta' | 'resultado';
  valores: Record<string, number>;
  total: number;
  filhos?: ContaDREValores[];
  pendente?: boolean;
}

interface Duplicata {
  id: number;
  cdDespesaItem: number;
  descricao: string;
  dtEmissao: string;
  dtVencimento?: string;
  valor: number;
  cdCCusto: number;
  nomeCCusto: string;
}

interface ModalDuplicatasState {
  aberto: boolean;
  conta: string;
  nomeConta: string;
  periodo: string;
  labelPeriodo: string;
  duplicatas: Duplicata[];
  total: number;
  loading: boolean;
}

interface ResumoLoja {
  codigo: string;
  nome: string;
  tipo: string;
  receitaBruta: number;
  devolucoes: number;
  receitaLiquida: number;
  cmv: number;
  margemContribuicao: number;
  margemPct: number;
  despesasOperacionais: number;
  ebitda: number;
  ebitdaPct: number;
  despesasFinanceiras: number;
  despesasTributarias: number;
  lucroLiquido: number;
}

interface EmpresaInfo {
  cd_empresa: number;
  nome: string;
}

interface DadosPorEmpresa {
  empresas: EmpresaInfo[];
  valores: Record<string, Record<string, number>>;
  metadata: {
    totalEmpresas: number;
    dataInicio: string;
    dataFim: string;
  };
}

// Funções auxiliares
function clonarComValores(contas: ContaDRE[]): ContaDREValores[] {
  return contas.map((conta) => ({
    codigo: conta.codigo,
    codigoExibicao: conta.codigo,
    nome: conta.nome,
    nivel: conta.nivel,
    tipo: conta.tipo,
    valores: {},
    total: 0,
    filhos: conta.filhos ? clonarComValores(conta.filhos) : undefined,
    pendente: conta.pendente,
  }));
}

function criarResultado(codigo: string, nome: string, codigoExibicao?: string): ContaDREValores {
  return {
    codigo,
    codigoExibicao: codigoExibicao || codigo,
    nome,
    nivel: 1,
    tipo: 'resultado',
    valores: {},
    total: 0,
  };
}

function montarEstruturaDRE(): ContaDREValores[] {
  return clonarComValores(PLANO_CONTAS_DRE_FABRICA);
}

const ESTRUTURA_DRE: ContaDREValores[] = montarEstruturaDRE();

const CORES_NIVEL: Record<number, string> = {
  1: 'bg-blue-100 font-bold',
  2: 'bg-blue-50',
  3: 'bg-white',
  4: 'bg-white pl-8',
};

function indexarContas(contas: ContaDREValores[], mapa = new Map<string, ContaDREValores>()) {
  for (const conta of contas) {
    mapa.set(conta.codigo, conta);
    if (conta.filhos) indexarContas(conta.filhos, mapa);
  }
  return mapa;
}

function clonarConta(conta?: ContaDREValores | null): ContaDREValores | null {
  if (!conta) return null;
  return {
    ...conta,
    codigoExibicao: conta.codigoExibicao || conta.codigo,
    valores: { ...conta.valores },
    filhos: conta.filhos?.map((filho) => clonarConta(filho)!).filter(Boolean),
  };
}

function criarContaCalculada(
  codigo: string,
  nome: string,
  periodos: PeriodoDRE[],
  formula: (periodo: string) => number,
  total: () => number,
  codigoExibicao?: string
) {
  const conta = criarResultado(codigo, nome, codigoExibicao);
  for (const periodo of periodos) {
    conta.valores[periodo.key] = formula(periodo.key);
  }
  conta.total = total();
  return conta;
}

function somarFilhos(contas: ContaDREValores[], periodos: PeriodoDRE[]): void {
  for (const conta of contas) {
    if (!conta.filhos?.length) continue;
    somarFilhos(conta.filhos, periodos);
    conta.valores = {};
    for (const periodo of periodos) {
      conta.valores[periodo.key] = conta.filhos.reduce((sum, filho) => sum + (filho.valores[periodo.key] || 0), 0);
    }
    conta.total = conta.filhos.reduce((sum, filho) => sum + filho.total, 0);
  }
}

function calcularLinhasOrdenadas(base: ContaDREValores[], periodos: PeriodoDRE[]) {
  const contasMap = indexarContas(base);

  const receitaBruta = contasMap.get('01');
  const deducoes = contasMap.get('02');
  const custosVariaveis = contasMap.get('04');
  const custosFixos = contasMap.get('06');
  const despesasOperacionais = contasMap.get('08');
  const resultadoNaoOp = contasMap.get('10');
  const despesasTributarias = contasMap.get('13');
  const pontoEquilibrioFinanceiro = contasMap.get('15');
  const pontoEquilibrioEconomico = contasMap.get('16');
  const investimentosImobilizados = contasMap.get('17');
  const amortizacaoDividas = contasMap.get('18');

  const receitaLiquida = criarContaCalculada(
    '03',
    'RECEITA LIQUIDA',
    periodos,
    (periodo) => (receitaBruta?.valores[periodo] || 0) + (deducoes?.valores[periodo] || 0),
    () => (receitaBruta?.total || 0) + (deducoes?.total || 0)
  );

  const margemContribuicao = criarContaCalculada(
    '05',
    'MARGEM CONTRIBUICAO',
    periodos,
    (periodo) => (receitaLiquida.valores[periodo] || 0) + (custosVariaveis?.valores[periodo] || 0),
    () => receitaLiquida.total + (custosVariaveis?.total || 0)
  );

  const lucroOperacionalBruto = criarContaCalculada(
    '07',
    'LUCRO OPERACIONAL BRUTO',
    periodos,
    (periodo) => (margemContribuicao.valores[periodo] || 0) + (custosFixos?.valores[periodo] || 0),
    () => margemContribuicao.total + (custosFixos?.total || 0)
  );

  const ebitda = criarContaCalculada(
    '09',
    'LUCRO OPERACIONAL LIQUIDO (EBITDA)',
    periodos,
    (periodo) => (lucroOperacionalBruto.valores[periodo] || 0) + (despesasOperacionais?.valores[periodo] || 0),
    () => lucroOperacionalBruto.total + (despesasOperacionais?.total || 0)
  );

  const lucroBruto = criarContaCalculada(
    '11',
    'LUCRO BRUTO',
    periodos,
    (periodo) => (ebitda.valores[periodo] || 0) + (resultadoNaoOp?.valores[periodo] || 0),
    () => ebitda.total + (resultadoNaoOp?.total || 0)
  );

  const lucroLiquido = criarContaCalculada(
    '14',
    'LUCRO LIQUIDO',
    periodos,
    (periodo) => (lucroBruto.valores[periodo] || 0) + (despesasTributarias?.valores[periodo] || 0),
    () => lucroBruto.total + (despesasTributarias?.total || 0)
  );

  // Lucro Liquido (-) Investimentos = Lucro Liquido - Investimentos - Amortizacoes
  const lucroLiquidoMenosInvestimentos = criarContaCalculada(
    '19',
    'LUCRO LIQUIDO (-) INVESTIMENTOS',
    periodos,
    (periodo) => (lucroLiquido.valores[periodo] || 0) + (investimentosImobilizados?.valores[periodo] || 0) + (amortizacaoDividas?.valores[periodo] || 0),
    () => lucroLiquido.total + (investimentosImobilizados?.total || 0) + (amortizacaoDividas?.total || 0)
  );

  return [
    clonarConta(receitaBruta),
    clonarConta(deducoes),
    receitaLiquida,
    clonarConta(custosVariaveis),
    margemContribuicao,
    clonarConta(custosFixos),
    lucroOperacionalBruto,
    clonarConta(despesasOperacionais),
    ebitda,
    clonarConta(resultadoNaoOp),
    lucroBruto,
    clonarConta(despesasTributarias),
    lucroLiquido,
    clonarConta(pontoEquilibrioFinanceiro),
    clonarConta(pontoEquilibrioEconomico),
    clonarConta(investimentosImobilizados),
    clonarConta(amortizacaoDividas),
    lucroLiquidoMenosInvestimentos,
  ].filter(Boolean) as ContaDREValores[];
}


export default function DREPage() {
  const [loading, setLoading] = useState(true);
  const [tipoVisao, setTipoVisao] = useState<TipoVisao>('analitica');
  const [filtro, setFiltro] = useState('consolidado');
  const [opcoesFiltro, setOpcoesFiltro] = useState<OpcaoFiltro[]>([]);
  const [dataInicio, setDataInicio] = useState(() => {
    const hoje = new Date();
    return `${hoje.getFullYear()}-01-01`;
  });
  const [dataFim, setDataFim] = useState(() => {
    const hoje = new Date();
    const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${ultimoDia}`;
  });
  const [periodos, setPeriodos] = useState<PeriodoDRE[]>([]);
  const [dadosDRE, setDadosDRE] = useState<ContaDREValores[]>([]);
  const [dadosSinteticos, setDadosSinteticos] = useState<ResumoLoja[]>([]);
  const [totaisSinteticos, setTotaisSinteticos] = useState<Record<string, number>>({});
  const [dadosPorEmpresa, setDadosPorEmpresa] = useState<DadosPorEmpresa | null>(null);
  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(
    new Set(['01', '02', '04', '06', '08', '10', '13', '15', '16', '17', '18', '19'])
  );
  const [mostrarExtras, setMostrarExtras] = useState(false); // Controla visibilidade de 15, 16, 17, 18, 19
  const [statusCarregamento, setStatusCarregamento] = useState<string | null>(null);
  const [filtroInfo, setFiltroInfo] = useState<string>('');
  const [modalDuplicatas, setModalDuplicatas] = useState<ModalDuplicatasState>({
    aberto: false,
    conta: '',
    nomeConta: '',
    periodo: '',
    labelPeriodo: '',
    duplicatas: [],
    total: 0,
    loading: false,
  });

  // Carregar opcoes de filtro
  useEffect(() => {
    async function carregarOpcoesFiltro() {
      try {
        const response = await fetch('/api/dre/centros-custo');
        const data = await response.json();
        if (data.opcoes) {
          setOpcoesFiltro(data.opcoes);
        }
      } catch (error) {
        console.error('Erro ao carregar opcoes de filtro:', error);
      }
    }
    carregarOpcoesFiltro();
  }, []);

  useEffect(() => {
    const inicio = new Date(dataInicio);
    const fim = new Date(dataFim);
    const novosPeriodos: PeriodoDRE[] = [];
    const atual = new Date(inicio.getFullYear(), inicio.getMonth(), 1);

    while (atual <= fim) {
      const key = `${atual.getFullYear()}-${String(atual.getMonth() + 1).padStart(2, '0')}`;
      const label = atual.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).toUpperCase();
      novosPeriodos.push({ key, label });
      atual.setMonth(atual.getMonth() + 1);
    }

    setPeriodos(novosPeriodos);
  }, [dataInicio, dataFim]);

  useEffect(() => {
    buscarDados();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleExpansao(codigo: string) {
    setContasExpandidas((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  const receitaLiquidaTotal = useMemo(() => {
    const conta = dadosDRE.find((c) => c.codigo === '03');
    return conta?.total || 0;
  }, [dadosDRE]);

  // Receita liquida por periodo para calcular A/V% por mes
  const receitaLiquidaPorPeriodo = useMemo(() => {
    const conta = dadosDRE.find((c) => c.codigo === '03');
    return conta?.valores || {};
  }, [dadosDRE]);

  // Filtrar contas extras (15, 16, 17, 18, 19) quando mostrarExtras for false
  const CONTAS_EXTRAS = ['15', '16', '17', '18', '19'];
  const dadosDREFiltrados = useMemo(() => {
    if (mostrarExtras) return dadosDRE;
    return dadosDRE.filter((conta) => !CONTAS_EXTRAS.includes(conta.codigo));
  }, [dadosDRE, mostrarExtras]);

  function calcularAV(valor: number): string {
    if (receitaLiquidaTotal === 0) return '-';
    // Calcular percentual mantendo o sinal correto baseado no valor
    const receitaAbs = Math.abs(receitaLiquidaTotal);
    const percentual = (valor / receitaAbs) * 100;
    // Se o valor original é negativo, garantir que o percentual também seja negativo
    const percentualFinal = valor < 0 ? -Math.abs(percentual) : Math.abs(percentual);
    return `${percentualFinal.toFixed(2)}%`;
  }

  function calcularAVPeriodo(valor: number, periodo: string): string {
    const receitaPeriodo = receitaLiquidaPorPeriodo[periodo] || 0;
    if (receitaPeriodo === 0) return '-';
    // Calcular percentual mantendo o sinal correto baseado no valor
    const receitaAbs = Math.abs(receitaPeriodo);
    const percentual = (valor / receitaAbs) * 100;
    // Se o valor original é negativo, garantir que o percentual também seja negativo
    const percentualFinal = valor < 0 ? -Math.abs(percentual) : Math.abs(percentual);
    return `${percentualFinal.toFixed(1)}%`;
  }

  async function abrirDuplicatas(conta: string, nomeConta: string, periodo: string, labelPeriodo: string) {
    setModalDuplicatas({
      aberto: true,
      conta,
      nomeConta,
      periodo,
      labelPeriodo,
      duplicatas: [],
      total: 0,
      loading: true,
    });

    try {
      const response = await fetch(`/api/dre/unificada/duplicatas?conta=${conta}&periodo=${periodo}&filtro=${filtro}`);
      const data = await response.json();

      setModalDuplicatas((prev) => ({
        ...prev,
        duplicatas: data.duplicatas || [],
        total: data.total || 0,
        loading: false,
      }));
    } catch (error) {
      console.error('Erro ao buscar duplicatas:', error);
      setModalDuplicatas((prev) => ({
        ...prev,
        loading: false,
      }));
    }
  }

  function fecharModal() {
    setModalDuplicatas((prev) => ({ ...prev, aberto: false }));
  }

  function formatarData(dataStr: string | null | undefined): string {
    if (!dataStr) return '-';
    const data = new Date(dataStr);
    return data.toLocaleDateString('pt-BR');
  }

  function renderizarLinhaConta(conta: ContaDREValores, nivel = 0): React.ReactNode[] {
    const linhas: React.ReactNode[] = [];
    const temFilhos = !!conta.filhos?.length;
    const expandida = contasExpandidas.has(conta.codigo);
    const isResultado = conta.tipo === 'resultado';
    const isPendente = conta.pendente;

    const corLinha = isPendente
      ? 'bg-amber-50'
      : isResultado
        ? 'bg-green-50 font-bold text-green-800'
        : CORES_NIVEL[conta.nivel] || 'bg-white';

    const isDespesa =
      !isResultado &&
      ['04', '06', '08', '10', '13'].some((prefixo) => conta.codigo.startsWith(prefixo));

    linhas.push(
      <tr key={conta.codigo} className={`${corLinha} hover:bg-gray-100 transition-colors`}>
        <td className="px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10">
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
            <span className="font-mono text-xs text-gray-500">{conta.codigoExibicao || conta.codigo}</span>
            <span className={`text-sm ${isResultado ? 'font-bold' : ''}`}>{conta.nome}</span>
            {isPendente && (
              <span className="ml-2 px-2 py-0.5 text-xs bg-amber-200 text-amber-800 rounded">PENDENTE</span>
            )}
          </div>
        </td>
        {periodos.map((periodo) => {
          const valorPeriodo = conta.valores[periodo.key] || 0;
          const podeClicar = !temFilhos && !isResultado && valorPeriodo !== 0 && isDespesa;
          return (
            <React.Fragment key={periodo.key}>
              <td
                className={`px-2 py-2 border-b border-gray-200 text-right text-sm ${
                  valorPeriodo < 0 ? 'text-red-600' : ''
                }`}
              >
                {podeClicar ? (
                  <button
                    onClick={() => abrirDuplicatas(conta.codigo, conta.nome, periodo.key, periodo.label)}
                    className="hover:underline hover:text-blue-600 cursor-pointer"
                    title="Clique para ver duplicatas"
                  >
                    {formatarValor(valorPeriodo)}
                  </button>
                ) : (
                  formatarValor(valorPeriodo)
                )}
              </td>
              <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-50 ${
                valorPeriodo < 0 ? 'text-red-500' : 'text-gray-500'
              }`}>
                {calcularAVPeriodo(valorPeriodo, periodo.key)}
              </td>
            </React.Fragment>
          );
        })}
        <td
          className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold ${
            conta.total < 0 ? 'text-red-600' : ''
          }`}
        >
          {formatarValor(conta.total)}
        </td>
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm ${
          conta.total < 0 ? 'text-red-500' : 'text-gray-600'
        }`}>
          {calcularAV(conta.total)}
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

  async function buscarDados() {
    setLoading(true);
    setStatusCarregamento(null);

    try {
      if (tipoVisao === 'analitica') {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 60000);
        const response = await fetch(`/api/dre/unificada?dataInicio=${dataInicio}&dataFim=${dataFim}&filtro=${filtro}`, {
          signal: controller.signal,
        });
        window.clearTimeout(timeout);
        const data = await response.json();

        if (data.error) {
          setStatusCarregamento(`Erro do backend: ${data.error}`);
          return;
        }

        if (data.metadata) {
          const m = data.metadata;
          setFiltroInfo(`${m.nomeFiltro} | Centros de Custo: ${m.centrosCusto?.length || 0}`);
        }

        const periodosAtuais: PeriodoDRE[] = data.periodos || periodos;
        if (data.periodos) setPeriodos(data.periodos);

        const dadosProcessados = JSON.parse(JSON.stringify(ESTRUTURA_DRE)) as ContaDREValores[];
        const valoresAPI = data.valores || {};

        const encontrarConta = (contas: ContaDREValores[], codigo: string): ContaDREValores | null => {
          for (const conta of contas) {
            if (conta.codigo === codigo) return conta;
            if (conta.filhos) {
              const encontrada = encontrarConta(conta.filhos, codigo);
              if (encontrada) return encontrada;
            }
          }
          return null;
        };

        for (const codigoConta of Object.keys(valoresAPI)) {
          const conta = encontrarConta(dadosProcessados, codigoConta);
          if (!conta) continue;
          const valoresConta = valoresAPI[codigoConta];
          conta.valores = {};
          for (const periodo of periodosAtuais) {
            conta.valores[periodo.key] = valoresConta[periodo.key] || 0;
          }
          conta.total = valoresConta.total || 0;
        }

        somarFilhos(dadosProcessados, periodosAtuais);
        const dadosOrdenados = calcularLinhasOrdenadas(dadosProcessados, periodosAtuais);
        setDadosDRE(dadosOrdenados);

      } else if (tipoVisao === 'sintetica') {
        const response = await fetch(`/api/dre/unificada/sintetico?dataInicio=${dataInicio}&dataFim=${dataFim}`);
        const data = await response.json();

        if (data.error) {
          setStatusCarregamento(`Erro do backend: ${data.error}`);
          return;
        }

        setDadosSinteticos(data.resumo || []);
        setTotaisSinteticos(data.totais || {});
      } else if (tipoVisao === 'por-empresa') {
        const response = await fetch(`/api/dre/por-empresa?dataInicio=${dataInicio}&dataFim=${dataFim}`);
        const data = await response.json();

        if (data.error) {
          setStatusCarregamento(`Erro do backend: ${data.error}`);
          return;
        }

        setDadosPorEmpresa(data);

        // Criar estrutura de contas ordenada para renderizacao
        const dadosEstrutura = JSON.parse(JSON.stringify(ESTRUTURA_DRE)) as ContaDREValores[];
        const dadosOrdenados = calcularLinhasOrdenadas(dadosEstrutura, []);
        setDadosDRE(dadosOrdenados);
      }

    } catch (error) {
      console.error('Erro ao buscar dados DRE:', error);
      if (dadosDRE.length === 0) {
        setStatusCarregamento('Falha ao conectar com o backend. Verifique se o servidor esta rodando.');
      }
    } finally {
      setLoading(false);
    }
  }

  // Buscar dados quando mudar filtro ou visao
  useEffect(() => {
    buscarDados();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro, tipoVisao]);

  const receitaLiquida = dadosDRE.find((conta) => conta.codigo === '03')?.total || 0;
  const margemContribuicao = dadosDRE.find((conta) => conta.codigo === '05')?.total || 0;
  const ebitda = dadosDRE.find((conta) => conta.codigo === '09')?.total || 0;
  const lucroLiquido = dadosDRE.find((conta) => conta.codigo === '14')?.total || 0;

  // Obter label do filtro selecionado
  const filtroLabel = opcoesFiltro.find(o => o.valor === filtro)?.label || filtro;
  const isFabrica = filtro === 'fabrica';
  const isLoja = !['consolidado', 'fabrica'].includes(filtro);

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            {isLoja ? (
              <Store className="w-8 h-8 text-purple-600" />
            ) : isFabrica ? (
              <Factory className="w-8 h-8 text-blue-600" />
            ) : (
              <BarChart3 className="w-8 h-8 text-green-600" />
            )}
            <div>
              <h1 className="text-3xl font-bold text-brand-dark">
                DRE - {filtroLabel}
              </h1>
              <p className="text-gray-600">Demonstracao do Resultado do Exercicio</p>
            </div>
          </div>

          {/* Dropdown de Filtro */}
          <div className="flex items-center gap-3">
            <Filter className="w-5 h-5 text-gray-500" />
            <select
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[250px]"
            >
              {opcoesFiltro.map((opcao) => (
                <option key={opcao.valor} value={opcao.valor}>
                  {opcao.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Abas de Visao */}
        <div className="flex gap-2 mt-4 bg-gray-100 p-1 rounded-lg w-fit">
          <button
            onClick={() => setTipoVisao('analitica')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all ${
              tipoVisao === 'analitica'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-gray-600 hover:bg-gray-200'
            }`}
          >
            <Table className="w-4 h-4" />
            Analitica
          </button>
          <button
            onClick={() => setTipoVisao('sintetica')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all ${
              tipoVisao === 'sintetica'
                ? 'bg-green-600 text-white shadow-md'
                : 'text-gray-600 hover:bg-gray-200'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            Sintetica
          </button>
          <button
            onClick={() => setTipoVisao('por-empresa')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all ${
              tipoVisao === 'por-empresa'
                ? 'bg-purple-600 text-white shadow-md'
                : 'text-gray-600 hover:bg-gray-200'
            }`}
          >
            <Building2 className="w-4 h-4" />
            Por Empresa
          </button>
          <div className="w-px h-6 bg-gray-300 mx-2" />
          <button
            onClick={() => setMostrarExtras(!mostrarExtras)}
            title={mostrarExtras ? 'Ocultar Investimentos e Amortizacoes' : 'Mostrar Investimentos e Amortizacoes'}
            className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
              mostrarExtras
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
            }`}
          >
            {mostrarExtras ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            Extras
          </button>
        </div>

        {filtroInfo && (
          <div className={`mt-2 px-3 py-2 border rounded-md text-sm ${
            isLoja
              ? 'bg-purple-50 border-purple-200 text-purple-800'
              : isFabrica
                ? 'bg-blue-50 border-blue-200 text-blue-800'
                : 'bg-green-50 border-green-200 text-green-800'
          }`}>
            <strong>Filtros ativos:</strong> {filtroInfo}
          </div>
        )}
      </div>

      {/* Cards de resumo - Apenas na visao analitica */}
      {tipoVisao === 'analitica' && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              <DollarSign className="w-4 h-4" />
              Receita Liquida
            </div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(receitaLiquida)}</p>
            <p className="text-xs text-gray-500">100% (base A/V)</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              <TrendingUp className="w-4 h-4" />
              Margem Contribuicao
            </div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(margemContribuicao)}</p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-gray-500">{((margemContribuicao / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
          </div>
          <div className="bg-white rounded-lg shadow p-4 border-l-4 border-yellow-500">
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              <TrendingUp className="w-4 h-4" />
              EBITDA
            </div>
            <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(ebitda)}</p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-gray-500">{((ebitda / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
          </div>
          <div className={`bg-white rounded-lg shadow p-4 border-l-4 ${lucroLiquido >= 0 ? 'border-green-500' : 'border-red-500'}`}>
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              {lucroLiquido >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              Lucro Liquido
            </div>
            <p className={`text-2xl font-bold mt-1 ${lucroLiquido >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatarValor(lucroLiquido)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-gray-500">{((lucroLiquido / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
          </div>
        </div>
      )}

      {/* Filtros de Data */}
      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Periodo</h2>
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
            onClick={() => buscarDados()}
            disabled={loading}
            className="px-5 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Carregando...' : 'Consultar'}
          </button>
          <button
            onClick={() => buscarDados()}
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
        {statusCarregamento && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {statusCarregamento}
          </div>
        )}
      </div>

      {/* Visao Analitica - Tabela DRE */}
      {tipoVisao === 'analitica' && (
        <div className="bg-white rounded-xl shadow-lg overflow-hidden border border-gray-200">
          <div className={`p-5 border-b-2 ${
            isLoja ? 'bg-gradient-to-r from-purple-50 to-purple-100 border-purple-200'
            : isFabrica ? 'bg-gradient-to-r from-blue-50 to-blue-100 border-blue-200'
            : 'bg-gradient-to-r from-green-50 to-green-100 border-green-200'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-800">
                  Demonstrativo de Resultado - {filtroLabel}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  Periodo: {new Date(dataInicio).toLocaleDateString('pt-BR')} a {new Date(dataFim).toLocaleDateString('pt-BR')}
                </p>
              </div>
              <div className={`px-4 py-2 rounded-lg text-sm font-semibold ${
                isLoja ? 'bg-purple-200 text-purple-800'
                : isFabrica ? 'bg-blue-200 text-blue-800'
                : 'bg-green-200 text-green-800'
              }`}>
                {periodos.length > 0 ? periodos[0].key.split('-')[0] : new Date().getFullYear()}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                {/* Linha do ano */}
                <tr className="bg-gradient-to-r from-blue-600 to-blue-700">
                  <th className="px-4 py-2 text-left text-sm font-bold text-white border-b border-blue-500 sticky left-0 bg-blue-600 z-20 min-w-[320px]">
                    CONTA
                  </th>
                  <th
                    colSpan={periodos.length * 2}
                    className="px-3 py-2 text-center text-sm font-bold text-white border-b border-blue-500"
                  >
                    {periodos.length > 0 ? `EXERCÍCIO ${periodos[0].key.split('-')[0]}` : 'EXERCÍCIO'}
                  </th>
                  <th colSpan={2} className="px-3 py-2 text-center text-sm font-bold text-white border-b border-blue-500 bg-blue-800">
                    ACUMULADO
                  </th>
                </tr>
                {/* Linha dos meses */}
                <tr className="bg-gray-100">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 border-b border-gray-300 sticky left-0 bg-gray-100 z-20">

                  </th>
                  {periodos.map((periodo) => {
                    const [ano, mes] = periodo.key.split('-');
                    const meses = ['', 'JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
                    const nomeMes = meses[parseInt(mes)] || mes;
                    return (
                      <th
                        key={periodo.key}
                        colSpan={2}
                        className="px-2 py-2 text-center text-xs font-bold text-gray-700 border-b border-gray-300 bg-gray-50"
                      >
                        {nomeMes}
                      </th>
                    );
                  })}
                  <th className="px-3 py-2 text-center text-xs font-bold text-blue-700 border-b border-gray-300 bg-blue-50">
                    TOTAL
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-bold text-green-700 border-b border-gray-300 bg-green-50">
                    A/V %
                  </th>
                </tr>
                {/* Linha de sub-cabeçalho (Valor / %) */}
                <tr className="bg-gray-50">
                  <th className="px-4 py-1 text-left text-[10px] text-gray-400 border-b border-gray-200 sticky left-0 bg-gray-50 z-20"></th>
                  {periodos.map((periodo) => (
                    <React.Fragment key={`sub-${periodo.key}`}>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200">R$</th>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-100">%</th>
                    </React.Fragment>
                  ))}
                  <th className="px-3 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-blue-50">R$</th>
                  <th className="px-3 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-green-50"></th>
                </tr>
              </thead>
              <tbody>
                {dadosDREFiltrados.map((conta) => renderizarLinhaConta(conta))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Visao Sintetica */}
      {tipoVisao === 'sintetica' && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-green-50">
            <h2 className="text-lg font-semibold text-gray-800">
              Visao Sintetica - Comparativo por Centro de Custo
            </h2>
            <p className="text-sm text-gray-600">
              Periodo: {new Date(dataInicio).toLocaleDateString('pt-BR')} a {new Date(dataFim).toLocaleDateString('pt-BR')}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-4 py-3 text-left font-semibold border-b sticky left-0 bg-gray-100 z-10">Centro de Custo</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">Rec. Liquida</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">CMV</th>
                  <th className="px-3 py-3 text-right font-semibold border-b text-gray-500">%</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">Margem</th>
                  <th className="px-3 py-3 text-right font-semibold border-b text-gray-500">%</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">EBITDA</th>
                  <th className="px-3 py-3 text-right font-semibold border-b text-gray-500">%</th>
                  <th className="px-3 py-3 text-right font-semibold border-b">Lucro Liq.</th>
                  <th className="px-3 py-3 text-right font-semibold border-b text-gray-500">%</th>
                </tr>
              </thead>
              <tbody>
                {dadosSinteticos.map((item) => {
                  const cmvPct = item.receitaLiquida !== 0 ? ((item.cmv / Math.abs(item.receitaLiquida)) * 100).toFixed(1) : '0.0';
                  const lucroLiqPct = item.receitaLiquida !== 0 ? ((item.lucroLiquido / Math.abs(item.receitaLiquida)) * 100).toFixed(1) : '0.0';
                  return (
                    <tr key={item.codigo} className="hover:bg-gray-50 border-b">
                      <td className="px-4 py-2 sticky left-0 bg-white">
                        <div className="flex items-center gap-2">
                          {item.tipo === 'fabrica' ? (
                            <Factory className="w-4 h-4 text-blue-500" />
                          ) : (
                            <Store className="w-4 h-4 text-purple-500" />
                          )}
                          <span className="font-medium">{item.nome}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">{formatarValor(item.receitaLiquida)}</td>
                      <td className="px-3 py-2 text-right text-red-600">{formatarValor(-item.cmv)}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{cmvPct}%</td>
                      <td className="px-3 py-2 text-right">{formatarValor(item.margemContribuicao)}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{item.margemPct}%</td>
                      <td className={`px-3 py-2 text-right ${item.ebitda >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatarValor(item.ebitda)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500">{item.ebitdaPct}%</td>
                      <td className={`px-3 py-2 text-right font-medium ${item.lucroLiquido >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatarValor(item.lucroLiquido)}
                      </td>
                      <td className={`px-3 py-2 text-right text-gray-500 ${parseFloat(lucroLiqPct) < 0 ? 'text-red-500' : ''}`}>
                        {lucroLiqPct}%
                      </td>
                    </tr>
                  );
                })}
                {/* Linha de Total */}
                {(() => {
                  const recLiq = totaisSinteticos.receitaLiquida || 0;
                  const totalCmvPct = recLiq !== 0
                    ? (((totaisSinteticos.cmv || 0) / Math.abs(recLiq)) * 100).toFixed(1)
                    : '0.0';
                  const totalLucroPct = recLiq !== 0
                    ? (((totaisSinteticos.lucroLiquido || 0) / Math.abs(recLiq)) * 100).toFixed(1)
                    : '0.0';
                  return (
                    <tr className="bg-gray-100 font-bold">
                      <td className="px-4 py-3 sticky left-0 bg-gray-100">TOTAL CONSOLIDADO</td>
                      <td className="px-3 py-3 text-right">{formatarValor(totaisSinteticos.receitaLiquida || 0)}</td>
                      <td className="px-3 py-3 text-right text-red-600">{formatarValor(-(totaisSinteticos.cmv || 0))}</td>
                      <td className="px-3 py-3 text-right text-gray-600">{totalCmvPct}%</td>
                      <td className="px-3 py-3 text-right">{formatarValor(totaisSinteticos.margemContribuicao || 0)}</td>
                      <td className="px-3 py-3 text-right text-gray-600">{totaisSinteticos.margemPct || 0}%</td>
                      <td className={`px-3 py-3 text-right ${(totaisSinteticos.ebitda || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatarValor(totaisSinteticos.ebitda || 0)}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-600">{totaisSinteticos.ebitdaPct || 0}%</td>
                      <td className={`px-3 py-3 text-right ${(totaisSinteticos.lucroLiquido || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatarValor(totaisSinteticos.lucroLiquido || 0)}
                      </td>
                      <td className={`px-3 py-3 text-right text-gray-600 ${parseFloat(totalLucroPct) < 0 ? 'text-red-600' : ''}`}>
                        {totalLucroPct}%
                      </td>
                    </tr>
                  );
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Visao Por Empresa */}
      {tipoVisao === 'por-empresa' && dadosPorEmpresa && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-purple-50">
            <h2 className="text-lg font-semibold text-gray-800">
              DRE Por Empresa - Comparativo
            </h2>
            <p className="text-sm text-gray-600">
              Periodo: {new Date(dataInicio).toLocaleDateString('pt-BR')} a {new Date(dataFim).toLocaleDateString('pt-BR')}
              {' | '}{dadosPorEmpresa.empresas.length} empresas
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-gradient-to-r from-purple-600 to-purple-700">
                  <th className="px-4 py-3 text-left font-bold text-white border-b border-purple-500 sticky left-0 bg-purple-600 z-20 min-w-[300px]">
                    CONTA
                  </th>
                  {dadosPorEmpresa.empresas.map((emp) => {
                    // Mapeamento de siglas por cd_empresa (unico)
                    // Lojas encerradas (9, 11, 12, 13, 16, 18) foram removidas
                    const SIGLAS_EMPRESA: Record<number, string> = {
                      1: 'FABRICA',
                      2: 'MARAP',
                      3: 'IGUAT',
                      4: 'TABOSA',
                      5: 'NORTH',
                      6: 'D.LUIS',
                      7: 'PARANG',
                      8: 'RIOMAR',
                      10: 'BARRA',
                      14: 'SALV',
                      15: 'MORUM',
                      17: 'RM.REC',
                      19: 'N.JOQUEI',
                      20: 'POA',
                      21: 'RM.KEN',
                      22: 'INTIM',
                      120: 'ECOMM',
                    };
                    const sigla = SIGLAS_EMPRESA[emp.cd_empresa] || emp.nome.substring(0, 6);
                    return (
                      <th
                        key={emp.cd_empresa}
                        className="px-2 py-2 text-center font-bold text-white border-b border-purple-500 min-w-[70px] text-[10px] cursor-help"
                        title={emp.nome}
                      >
                        {sigla}
                      </th>
                    );
                  })}
                  <th className="px-3 py-3 text-right font-bold text-white border-b border-purple-500 bg-purple-800 min-w-[110px]">
                    TOTAL
                  </th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Funcao para calcular valor de uma conta por empresa
                  const getValorEmpresa = (codigo: string, cdEmpresa: number): number => {
                    return dadosPorEmpresa.valores[codigo]?.[String(cdEmpresa)] || 0;
                  };

                  const getValorTotal = (codigo: string): number => {
                    return dadosPorEmpresa.valores[codigo]?.total || 0;
                  };

                  // Contas calculadas (resultados)
                  const contasCalculadas = ['03', '05', '07', '09', '11', '14', '19'];

                  // Funcao para calcular valor de conta calculada
                  const calcularValorEmpresa = (codigo: string, cdEmpresa: number): number => {
                    const v = (c: string) => getValorEmpresa(c, cdEmpresa);
                    switch (codigo) {
                      case '03': return v('01') + v('02'); // Receita Liquida
                      case '05': return v('01') + v('02') + v('04'); // Margem Contribuicao
                      case '07': return v('01') + v('02') + v('04') + v('06'); // Lucro Op Bruto
                      case '09': return v('01') + v('02') + v('04') + v('06') + v('08'); // EBITDA
                      case '11': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10'); // Lucro Bruto
                      case '14': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10') + v('13'); // Lucro Liquido
                      case '19': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10') + v('13') + v('17') + v('18'); // LL - Inv
                      default: return 0;
                    }
                  };

                  const calcularValorTotal = (codigo: string): number => {
                    const v = (c: string) => getValorTotal(c);
                    switch (codigo) {
                      case '03': return v('01') + v('02');
                      case '05': return v('01') + v('02') + v('04');
                      case '07': return v('01') + v('02') + v('04') + v('06');
                      case '09': return v('01') + v('02') + v('04') + v('06') + v('08');
                      case '11': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10');
                      case '14': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10') + v('13');
                      case '19': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10') + v('13') + v('17') + v('18');
                      default: return 0;
                    }
                  };

                  // Renderizar linha de conta
                  const renderizarLinhaEmpresa = (conta: ContaDREValores, nivel: number = 0): React.ReactNode[] => {
                    const linhas: React.ReactNode[] = [];
                    const temFilhos = conta.filhos && conta.filhos.length > 0;
                    const expandida = contasExpandidas.has(conta.codigo);
                    const isCalculada = contasCalculadas.includes(conta.codigo);
                    const isDespesa = conta.codigo.startsWith('02') || conta.codigo.startsWith('04') ||
                                     conta.codigo.startsWith('06') || conta.codigo.startsWith('08') ||
                                     conta.codigo.startsWith('10') || conta.codigo.startsWith('13') ||
                                     conta.codigo.startsWith('17') || conta.codigo.startsWith('18');

                    // Determinar estilo da linha
                    let bgClass = 'bg-white';
                    let fontClass = '';
                    let stickyBg = 'bg-white';

                    if (isCalculada) {
                      bgClass = 'bg-green-50';
                      fontClass = 'font-bold';
                      stickyBg = 'bg-green-50';
                    } else if (nivel === 0) {
                      bgClass = 'bg-purple-50';
                      fontClass = 'font-semibold';
                      stickyBg = 'bg-purple-50';
                    } else if (nivel === 1) {
                      bgClass = 'bg-gray-50';
                      stickyBg = 'bg-gray-50';
                    }

                    const paddingLeft = 16 + nivel * 16;

                    linhas.push(
                      <tr key={conta.codigo} className={`${bgClass} hover:bg-purple-100/30`}>
                        <td
                          className={`px-2 py-1.5 border-b border-gray-200 sticky left-0 z-10 ${stickyBg} ${fontClass}`}
                          style={{ paddingLeft: `${paddingLeft}px` }}
                        >
                          <div className="flex items-center gap-1">
                            {temFilhos && (
                              <button
                                onClick={() => toggleExpansao(conta.codigo)}
                                className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-gray-700"
                              >
                                {expandida ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              </button>
                            )}
                            {!temFilhos && <span className="w-4" />}
                            <span className="text-xs">{conta.codigo} {conta.nome}</span>
                          </div>
                        </td>
                        {dadosPorEmpresa.empresas.map((emp) => {
                          const valor = isCalculada
                            ? calcularValorEmpresa(conta.codigo, emp.cd_empresa)
                            : getValorEmpresa(conta.codigo, emp.cd_empresa);
                          return (
                            <td
                              key={emp.cd_empresa}
                              className={`px-2 py-1.5 text-right border-b border-gray-200 text-xs ${
                                valor < 0 ? 'text-red-600' : ''
                              } ${fontClass}`}
                            >
                              {valor !== 0 ? formatarValor(valor) : '-'}
                            </td>
                          );
                        })}
                        <td className={`px-2 py-1.5 text-right border-b border-gray-200 text-xs bg-purple-100/50 ${fontClass} ${
                          (isCalculada ? calcularValorTotal(conta.codigo) : getValorTotal(conta.codigo)) < 0 ? 'text-red-600' : ''
                        }`}>
                          {formatarValor(isCalculada ? calcularValorTotal(conta.codigo) : getValorTotal(conta.codigo))}
                        </td>
                      </tr>
                    );

                    if (temFilhos && expandida) {
                      for (const filho of conta.filhos || []) {
                        linhas.push(...renderizarLinhaEmpresa(filho, nivel + 1));
                      }
                    }

                    return linhas;
                  };

                  // Renderizar todas as contas do DRE
                  return dadosDREFiltrados.map((conta) => renderizarLinhaEmpresa(conta));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legenda */}
      {tipoVisao === 'analitica' && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Legenda</h3>
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-blue-100 border border-gray-300 rounded"></div>
              <span>Grupo nivel 1</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-blue-50 border border-gray-300 rounded"></div>
              <span>Grupo nivel 2</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-green-50 border border-gray-300 rounded"></div>
              <span>Resultado calculado</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-amber-50 border border-gray-300 rounded"></div>
              <span className="px-2 py-0.5 text-xs bg-amber-200 text-amber-800 rounded">PENDENTE</span>
              <span>- Conta sem query implementada</span>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Duplicatas */}
      {modalDuplicatas.aberto && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50 rounded-t-lg">
              <div>
                <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  Duplicatas - {modalDuplicatas.conta} {modalDuplicatas.nomeConta}
                </h3>
                <p className="text-sm text-gray-600">
                  Periodo: {modalDuplicatas.labelPeriodo} | Total: {formatarValor(modalDuplicatas.total)}
                </p>
              </div>
              <button
                onClick={fecharModal}
                className="p-2 hover:bg-gray-200 rounded-full transition-colors"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {modalDuplicatas.loading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
                  <span className="ml-3 text-gray-600">Carregando duplicatas...</span>
                </div>
              ) : modalDuplicatas.duplicatas.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  Nenhuma duplicata encontrada para este periodo.
                </div>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="px-3 py-2 text-left border-b font-semibold">Data Emissao</th>
                      <th className="px-3 py-2 text-center border-b font-semibold">CCusto</th>
                      <th className="px-3 py-2 text-left border-b font-semibold">Nome CCusto</th>
                      <th className="px-3 py-2 text-left border-b font-semibold">Descricao</th>
                      <th className="px-3 py-2 text-right border-b font-semibold">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modalDuplicatas.duplicatas.map((dup, idx) => (
                      <tr key={idx} className="hover:bg-gray-50 border-b border-gray-100">
                        <td className="px-3 py-2">{formatarData(dup.dtEmissao)}</td>
                        <td className="px-3 py-2 text-center font-mono text-xs text-gray-600">{dup.cdCCusto || '-'}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <Building2 className="w-3 h-3 text-gray-400" />
                            <span className="truncate max-w-[200px]" title={dup.nomeCCusto}>
                              {dup.nomeCCusto || '-'}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 truncate max-w-[250px]" title={dup.descricao}>
                          {dup.descricao || '-'}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-red-600">
                          {formatarValor(dup.valor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="p-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                onClick={fecharModal}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
