'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Factory,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  ArrowUp,
  ArrowDown,
  SearchCheck,
  HelpCircle,
  ChevronsDown,
  ChevronsUp,
  Unlink,
  Check,
  X,
  FileText,
  Building2,
  Store,
  BarChart3,
  Table,
  Filter,
  Eye,
  EyeOff,
  Sparkles,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';

import { PLANO_CONTAS_DRE_FABRICA, type ContaDRE } from './planoContasDREFabrica';
import { formatarValor } from '../utils/formatters';

// Tipos
type TipoVisao = 'analitica' | 'sintetica' | 'por-empresa' | 'por-ccusto';

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
  valoresApi?: boolean;
}

interface Duplicata {
  id: number;
  nrDuplicata?: string;
  cdDespesaItem: number;
  descricao: string;
  dtEmissao: string;
  dtVencimento?: string;
  valor: number;
  cdCCusto: number;
  nomeCCusto: string;
  cdFornecedor?: number | string;
  nmFornecedor?: string;
}

interface AuditoriaDespesaItem {
  cdDespesaItem: number;
  descricao: string;
  quantidade: number;
  percentual: number;
}

interface AuditoriaFornecedorDespesa {
  totalDuplicatas: number;
  amostraInsuficiente: boolean;
  distribuicao: AuditoriaDespesaItem[];
  dominante: AuditoriaDespesaItem | null;
  despesaAtual: AuditoriaDespesaItem | null;
  alerta: boolean;
  validado: boolean;
}

interface DespesaSemAssociacao {
  cdDespesaItem: number;
  descricao: string;
  cdCcusto: number;
  nomeCcusto: string;
  quantidade: number;
  valorTotal: number;
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
  resultadoNaoOperacional: number;
  despesasFinanceiras: number;
  despesasTributarias: number;
  lucroLiquido12m: number | null;
  lucroLiquido6m: number | null;
  lucroLiquido3m: number | null;
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

interface CentroCustoInfo {
  cd_ccusto: number;
  nome: string;
}

interface DadosPorCCusto {
  centros_custo: CentroCustoInfo[];
  valores: Record<string, Record<string, number>>;
  metadata: {
    totalCentrosCusto: number;
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

function valorNumerico(registro: unknown, campos: string[], fallback = 0): number {
  if (!registro || typeof registro !== 'object') return fallback;
  const valores = registro as Record<string, unknown>;
  for (const campo of campos) {
    const valor = valores[campo];
    if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
    if (typeof valor === 'string') {
      const normalizado = Number(valor.replace(/\./g, '').replace(',', '.'));
      if (Number.isFinite(normalizado)) return normalizado;
    }
  }
  return fallback;
}

function valorNumericoOuNulo(registro: unknown, campos: string[]): number | null {
  if (!registro || typeof registro !== 'object') return null;
  const valores = registro as Record<string, unknown>;
  for (const campo of campos) {
    const valor = valores[campo];
    if (valor === null) return null;
    if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
    if (typeof valor === 'string') {
      const normalizado = Number(valor.replace(/\./g, '').replace(',', '.'));
      if (Number.isFinite(normalizado)) return normalizado;
    }
  }
  return null;
}

function formatarValorOpcional(valor: number | null): string {
  return valor === null ? 'CMV incompleto' : formatarValor(valor);
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

// Deteccao de anomalias mes-a-mes: o gatilho da seta e sempre a variacao vs.
// o mes anterior. A media movel do historico ja carregado na grade entra so
// como informacao extra no tooltip, para dar mais contexto.
const ANOMALIA_LIMIAR_PCT = 15;
const ANOMALIA_JANELA_MEDIA = 6;
const ANOMALIA_MIN_HISTORICO_MEDIA = 2;

interface Anomalia {
  direcao: 'alta' | 'baixa';
  percentualAnterior: number;
  valorAnterior: number;
  media?: {
    valor: number;
    percentual: number;
    meses: number;
  };
}

function detectarAnomalia(
  valores: Record<string, number>,
  periodosRange: PeriodoDRE[],
  periodoIndex: number
): Anomalia | null {
  const valorAtual = valores[periodosRange[periodoIndex].key] || 0;
  if (valorAtual === 0) return null;

  const anteriores = periodosRange
    .slice(0, periodoIndex)
    .map((p) => valores[p.key] || 0)
    .filter((v) => v !== 0);

  if (anteriores.length === 0) return null;

  const valorAnterior = anteriores[anteriores.length - 1];
  const percentualAnterior = ((Math.abs(valorAtual) - Math.abs(valorAnterior)) / Math.abs(valorAnterior)) * 100;
  if (Math.abs(percentualAnterior) < ANOMALIA_LIMIAR_PCT) return null;

  let media: Anomalia['media'];
  if (anteriores.length >= ANOMALIA_MIN_HISTORICO_MEDIA) {
    const janela = anteriores.slice(-ANOMALIA_JANELA_MEDIA);
    const valorMedia = janela.reduce((a, b) => a + b, 0) / janela.length;
    if (valorMedia !== 0) {
      media = {
        valor: valorMedia,
        percentual: ((Math.abs(valorAtual) - Math.abs(valorMedia)) / Math.abs(valorMedia)) * 100,
        meses: janela.length,
      };
    }
  }

  return {
    direcao: percentualAnterior > 0 ? 'alta' : 'baixa',
    percentualAnterior,
    valorAnterior,
    media,
  };
}

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
    if (conta.valoresApi) continue;
    conta.valores = {};
    for (const periodo of periodos) {
      conta.valores[periodo.key] = conta.filhos.reduce((sum, filho) => sum + (filho.valores[periodo.key] || 0), 0);
    }
    conta.total = conta.filhos.reduce((sum, filho) => sum + filho.total, 0);
  }
}

function achatarContas(
  contas: ContaDREValores[],
  periodos: PeriodoDRE[]
): { codigo: string; nome: string; tipo: string; total: number; valores: Record<string, number> }[] {
  const linhas: { codigo: string; nome: string; tipo: string; total: number; valores: Record<string, number> }[] = [];
  for (const conta of contas) {
    const valores: Record<string, number> = {};
    for (const periodo of periodos) {
      valores[periodo.label] = conta.valores[periodo.key] || 0;
    }
    linhas.push({ codigo: conta.codigo, nome: conta.nome, tipo: conta.tipo, total: conta.total, valores });
    if (conta.filhos?.length) {
      linhas.push(...achatarContas(conta.filhos, periodos));
    }
  }
  return linhas;
}

function calcularLinhasOrdenadas(base: ContaDREValores[], periodos: PeriodoDRE[], contasTotalizadoras: Record<string, ContaDREValores> = {}) {
  const contasMap = indexarContas(base);

  const receitaBruta = contasMap.get('01');
  const deducoes = contasMap.get('02');
  const custosVariaveis = contasMap.get('04');
  const custosFixos = contasMap.get('06');
  const despesasOperacionais = contasMap.get('08');
  const resultadoNaoOp = contasMap.get('10');
  const despesasTributarias = contasMap.get('13');
  const investimentosImobilizados = contasMap.get('17');
  const amortizacaoDividas = contasMap.get('18');

  // Usa valores da API se existirem, senão calcula
  const receitaLiquidaApi = contasTotalizadoras['03'];
  const receitaLiquida = receitaLiquidaApi ? { ...receitaLiquidaApi, nome: 'RECEITA LIQUIDA' } : criarContaCalculada(
    '03',
    'RECEITA LIQUIDA',
    periodos,
    (periodo) => (receitaBruta?.valores[periodo] || 0) + (deducoes?.valores[periodo] || 0),
    () => (receitaBruta?.total || 0) + (deducoes?.total || 0)
  );

  const margemContribuicaoApi = contasTotalizadoras['05'];
  const margemContribuicao = margemContribuicaoApi ? { ...margemContribuicaoApi, nome: 'MARGEM CONTRIBUICAO' } : criarContaCalculada(
    '05',
    'MARGEM CONTRIBUICAO',
    periodos,
    (periodo) => (receitaLiquida.valores[periodo] || 0) + (custosVariaveis?.valores[periodo] || 0),
    () => receitaLiquida.total + (custosVariaveis?.total || 0)
  );

  const lucroOperacionalBrutoApi = contasTotalizadoras['07'];
  const lucroOperacionalBruto = lucroOperacionalBrutoApi ? { ...lucroOperacionalBrutoApi, nome: 'LUCRO OPERACIONAL BRUTO' } : criarContaCalculada(
    '07',
    'LUCRO OPERACIONAL BRUTO',
    periodos,
    (periodo) => (margemContribuicao.valores[periodo] || 0) + (custosFixos?.valores[periodo] || 0),
    () => margemContribuicao.total + (custosFixos?.total || 0)
  );

  const ebitdaApi = contasTotalizadoras['09'];
  const ebitda = ebitdaApi ? { ...ebitdaApi, nome: 'LUCRO OPERACIONAL LIQUIDO (EBITDA)' } : criarContaCalculada(
    '09',
    'LUCRO OPERACIONAL LIQUIDO (EBITDA)',
    periodos,
    (periodo) => (lucroOperacionalBruto.valores[periodo] || 0) + (despesasOperacionais?.valores[periodo] || 0),
    () => lucroOperacionalBruto.total + (despesasOperacionais?.total || 0)
  );

  const lucroBrutoApi = contasTotalizadoras['11'];
  const lucroBruto = lucroBrutoApi ? { ...lucroBrutoApi, nome: 'LUCRO BRUTO' } : criarContaCalculada(
    '11',
    'LUCRO BRUTO',
    periodos,
    (periodo) => (ebitda.valores[periodo] || 0) + (resultadoNaoOp?.valores[periodo] || 0),
    () => ebitda.total + (resultadoNaoOp?.total || 0)
  );

  const lucroLiquidoApi = contasTotalizadoras['14'];
  const lucroLiquido = lucroLiquidoApi ? { ...lucroLiquidoApi, nome: 'LUCRO LIQUIDO' } : criarContaCalculada(
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

  // Ponto de Equilíbrio Econômico = Receita necessária para Lucro Líquido = 0
  // Fórmula: (CMV + Custos Fixos + Despesas Op + Resultado Não Op + Desp Tributárias + Deduções) / (1 - CMV%)
  // Onde CMV% = CMV / Receita Bruta (proporção de custo variável)
  const pontoEquilibrioEconomicoCalc = criarContaCalculada(
    '16',
    'PONTO DE EQUILIBRIO ECONOMICO',
    periodos,
    (periodo) => {
      const receitaBrutaPeriodo = receitaBruta?.valores[periodo] || 0;
      if (receitaBrutaPeriodo === 0) return 0;

      // Custos variáveis (CMV) - proporcionais à receita
      const cmvPeriodo = Math.abs(custosVariaveis?.valores[periodo] || 0);
      const deducoesPeriodo = Math.abs(deducoes?.valores[periodo] || 0);

      // Custos fixos (não variam com receita)
      const custosFixosPeriodo = Math.abs(custosFixos?.valores[periodo] || 0);
      const despesasOpPeriodo = Math.abs(despesasOperacionais?.valores[periodo] || 0);
      const resultadoNaoOpPeriodo = Math.abs(resultadoNaoOp?.valores[periodo] || 0);
      const despesasTribPeriodo = Math.abs(despesasTributarias?.valores[periodo] || 0);

      // Percentual de custos variáveis sobre receita bruta
      const cmvPct = (cmvPeriodo + deducoesPeriodo) / Math.abs(receitaBrutaPeriodo);

      // Margem de contribuição % = 1 - CMV%
      const margemPct = 1 - cmvPct;
      if (margemPct <= 0) return 0;

      // Custos fixos totais
      const custosFixosTotais = custosFixosPeriodo + despesasOpPeriodo + resultadoNaoOpPeriodo + despesasTribPeriodo;

      // PE = Custos Fixos / Margem %
      return custosFixosTotais / margemPct;
    },
    () => {
      const receitaBrutaTotal = receitaBruta?.total || 0;
      if (receitaBrutaTotal === 0) return 0;

      const cmvTotal = Math.abs(custosVariaveis?.total || 0);
      const deducoesTotal = Math.abs(deducoes?.total || 0);
      const custosFixosTotal = Math.abs(custosFixos?.total || 0);
      const despesasOpTotal = Math.abs(despesasOperacionais?.total || 0);
      const resultadoNaoOpTotal = Math.abs(resultadoNaoOp?.total || 0);
      const despesasTribTotal = Math.abs(despesasTributarias?.total || 0);

      const cmvPct = (cmvTotal + deducoesTotal) / Math.abs(receitaBrutaTotal);
      const margemPct = 1 - cmvPct;
      if (margemPct <= 0) return 0;

      const custosFixosTotais = custosFixosTotal + despesasOpTotal + resultadoNaoOpTotal + despesasTribTotal;
      return custosFixosTotais / margemPct;
    }
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
    pontoEquilibrioEconomicoCalc,
    clonarConta(investimentosImobilizados),
    clonarConta(amortizacaoDividas),
    lucroLiquidoMenosInvestimentos,
  ].filter(Boolean) as ContaDREValores[];
}


export default function DREPage() {
  const [loading, setLoading] = useState(false);
  const [consultaExecutada, setConsultaExecutada] = useState(false);
  const [tipoVisao, setTipoVisao] = useState<TipoVisao>('analitica');
  const [filtro, setFiltro] = useState('consolidado');
  const [filtroAberto, setFiltroAberto] = useState(false);
  const [opcoesFiltro, setOpcoesFiltro] = useState<OpcaoFiltro[]>([]);
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
  const [periodos, setPeriodos] = useState<PeriodoDRE[]>([]);
  const [dadosDRE, setDadosDRE] = useState<ContaDREValores[]>([]);
  const [dadosSinteticos, setDadosSinteticos] = useState<ResumoLoja[]>([]);
  const [totaisSinteticos, setTotaisSinteticos] = useState<Record<string, number>>({});
  const [dadosSinteticosAno, setDadosSinteticosAno] = useState<ResumoLoja[]>([]);
  const [totaisSinteticosAno, setTotaisSinteticosAno] = useState<Record<string, number>>({});
  const [dadosPorEmpresa, setDadosPorEmpresa] = useState<DadosPorEmpresa | null>(null);
  const [dadosPorCCusto, setDadosPorCCusto] = useState<DadosPorCCusto | null>(null);
  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(
    new Set(['01', '02', '04', '06', '08', '10', '13', '16', '17', '18', '19'])
  );
  const [mostrarExtras, setMostrarExtras] = useState(false); // Controla visibilidade de 15, 16, 17, 18, 19
  const [despesaFiltroSelecionada, setDespesaFiltroSelecionada] = useState('');
  const [despesaBusca, setDespesaBusca] = useState('');
  const [despesaDropdownAberto, setDespesaDropdownAberto] = useState(false);
  const [mostrarApenasComAlerta, setMostrarApenasComAlerta] = useState(false);
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
  const [auditoriaModal, setAuditoriaModal] = useState<{ aberto: boolean; dup: Duplicata | null }>({
    aberto: false,
    dup: null,
  });
  const [auditoriaCache, setAuditoriaCache] = useState<
    Record<string, AuditoriaFornecedorDespesa | 'loading' | 'erro'>
  >({});
  const [celulasAlertadas, setCelulasAlertadas] = useState<Set<string>>(new Set());
  const [compararAnoAnterior, setCompararAnoAnterior] = useState(false);
  const [valoresAnoAnterior, setValoresAnoAnterior] = useState<Record<string, Record<string, number>>>({});
  const [carregandoAnoAnterior, setCarregandoAnoAnterior] = useState(false);
  const [nomesCustomizados, setNomesCustomizados] = useState<Record<string, string>>({});
  const [tiposCusto, setTiposCusto] = useState<Record<string, 'fixo' | 'variavel'>>({});
  const [modalSemAssociacao, setModalSemAssociacao] = useState<{
    aberto: boolean;
    loading: boolean;
    despesas: DespesaSemAssociacao[];
    totalItens: number;
    valorTotal: number;
  }>({ aberto: false, loading: false, despesas: [], totalItens: 0, valorTotal: 0 });
  const [modalAnaliseExecutiva, setModalAnaliseExecutiva] = useState<{
    aberto: boolean;
    loading: boolean;
    texto: string;
    erro: string | null;
  }>({ aberto: false, loading: false, texto: '', erro: null });
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState<string | null>(null);
  const [larguraColunaContas, setLarguraColunaContas] = useState(350);
  const [larguraColunaValor, setLarguraColunaValor] = useState(85);
  const [larguraColunaAV, setLarguraColunaAV] = useState(55);

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
    async function carregarNomesCustomizados() {
      try {
        const response = await fetch('/api/plano-contas-dre/nomes');
        const data = await response.json();
        setNomesCustomizados(data || {});
      } catch (error) {
        console.error('Erro ao carregar nomes customizados do plano de contas:', error);
      }
    }
    carregarNomesCustomizados();
  }, []);

  // Restaura o filtro (periodo + loja/fabrica) salvo da ultima visita, se houver
  useEffect(() => {
    try {
      const salvo = localStorage.getItem('dre_analitica_filtros');
      if (salvo) {
        const filtrosSalvos = JSON.parse(salvo);
        if (filtrosSalvos.dataInicio) setDataInicio(filtrosSalvos.dataInicio);
        if (filtrosSalvos.dataFim) setDataFim(filtrosSalvos.dataFim);
        if (filtrosSalvos.filtro) setFiltro(filtrosSalvos.filtro);
      }
    } catch (error) {
      console.error('Erro ao carregar filtros salvos:', error);
    }
  }, []);

  // Salva o filtro atual sempre que o usuario alterar data ou loja/fabrica,
  // pulando a primeira renderizacao pra nao sobrescrever o que acabou de ser
  // restaurado do localStorage (useEffect acima) com os valores padrao.
  const primeiraRenderizacaoFiltroRef = useRef(true);
  useEffect(() => {
    if (primeiraRenderizacaoFiltroRef.current) {
      primeiraRenderizacaoFiltroRef.current = false;
      return;
    }
    try {
      localStorage.setItem('dre_analitica_filtros', JSON.stringify({ dataInicio, dataFim, filtro }));
    } catch (error) {
      console.error('Erro ao salvar filtros:', error);
    }
  }, [dataInicio, dataFim, filtro]);

  useEffect(() => {
    async function carregarTiposCusto() {
      try {
        const response = await fetch('/api/plano-contas-dre/tipo-custo');
        const data = await response.json();
        setTiposCusto(data || {});
      } catch (error) {
        console.error('Erro ao carregar tipo de custo do plano de contas:', error);
      }
    }
    carregarTiposCusto();
  }, []);

  useEffect(() => {
    // Extrair ano/mes diretamente da string para evitar problemas de timezone
    const [anoInicio, mesInicio] = dataInicio.split('-').map(Number);
    const [anoFim, mesFim] = dataFim.split('-').map(Number);
    const novosPeriodos: PeriodoDRE[] = [];

    let anoAtual = anoInicio;
    let mesAtual = mesInicio;

    while (anoAtual < anoFim || (anoAtual === anoFim && mesAtual <= mesFim)) {
      const key = `${anoAtual}-${String(mesAtual).padStart(2, '0')}`;
      const dataTemp = new Date(anoAtual, mesAtual - 1, 1);
      const label = dataTemp.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).toUpperCase();
      novosPeriodos.push({ key, label });

      mesAtual++;
      if (mesAtual > 12) {
        mesAtual = 1;
        anoAtual++;
      }
    }

    setPeriodos(novosPeriodos);
  }, [dataInicio, dataFim]);

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

  // Agrupa os periodos em blocos consecutivos do mesmo ano, para o cabecalho
  // "EXERCICIO" dividir corretamente quando o intervalo selecionado cruza
  // dois anos (ex: filtro "Ultimos 12 Meses" indo de ago/2025 a jul/2026).
  const gruposPorAno = useMemo(() => {
    const grupos: { ano: string; qtd: number }[] = [];
    for (const periodo of periodos) {
      const ano = periodo.key.split('-')[0];
      const ultimo = grupos[grupos.length - 1];
      if (ultimo && ultimo.ano === ano) {
        ultimo.qtd += 1;
      } else {
        grupos.push({ ano, qtd: 1 });
      }
    }
    return grupos;
  }, [periodos]);

  // Filtrar contas extras (15, 16, 17, 18, 19) quando mostrarExtras for false
  const CONTAS_EXTRAS = ['16', '17', '18', '19'];
  const dadosDREFiltrados = useMemo(() => {
    if (mostrarExtras) return dadosDRE;
    return dadosDRE.filter((conta) => !CONTAS_EXTRAS.includes(conta.codigo));
  }, [dadosDRE, mostrarExtras]);

  // Filtros da visao Analitica: escolher uma despesa (conta-folha) especifica
  // mostra so ela; "somente com alerta" mantem apenas contas que tem alguma
  // celula sinalizada pela auditoria fornecedor x despesa no periodo.
  function contaTemAlertaNoPeriodo(conta: ContaDREValores): boolean {
    return periodos.some((periodo) => celulasAlertadas.has(`${conta.codigo}:${periodo.key}`));
  }

  // Lista de contas-folha de despesa disponiveis para o seletor de filtro,
  // extraida uma unica vez da estrutura estatica do plano de contas.
  const contasFolhaDespesa = useMemo(() => {
    const resultado: { codigo: string; nome: string }[] = [];
    function coletar(contas: ContaDREValores[]) {
      for (const conta of contas) {
        if (conta.filhos?.length) {
          coletar(conta.filhos);
        } else if (conta.tipo !== 'resultado') {
          resultado.push({ codigo: conta.codigo, nome: conta.nome });
        }
      }
    }
    coletar(ESTRUTURA_DRE);
    return resultado.sort((a, b) => a.codigo.localeCompare(b.codigo));
  }, []);

  const despesasFiltradasBusca = useMemo(() => {
    const termo = despesaBusca.trim().toLowerCase();
    if (!termo) return contasFolhaDespesa;
    return contasFolhaDespesa.filter(
      (c) => c.codigo.toLowerCase().includes(termo) || c.nome.toLowerCase().includes(termo)
    );
  }, [contasFolhaDespesa, despesaBusca]);

  function filtrarAnalitica(contas: ContaDREValores[]): ContaDREValores[] {
    const resultado: ContaDREValores[] = [];

    for (const conta of contas) {
      const temFilhos = !!conta.filhos?.length;

      if (temFilhos) {
        const filhosFiltrados = filtrarAnalitica(conta.filhos!);

        if (despesaFiltroSelecionada) {
          resultado.push(...filhosFiltrados);
          continue;
        }

        if (mostrarApenasComAlerta && filhosFiltrados.length === 0) {
          continue;
        }

        resultado.push({ ...conta, filhos: filhosFiltrados });
      } else {
        if (despesaFiltroSelecionada) {
          if (conta.codigo !== despesaFiltroSelecionada) continue;
        } else if (mostrarApenasComAlerta && !contaTemAlertaNoPeriodo(conta)) {
          continue;
        }
        resultado.push(conta);
      }
    }

    return resultado;
  }

  const dadosAnaliticaExibicao = useMemo(() => {
    if (!despesaFiltroSelecionada && !mostrarApenasComAlerta) return dadosDREFiltrados;
    return filtrarAnalitica(dadosDREFiltrados);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dadosDREFiltrados, despesaFiltroSelecionada, mostrarApenasComAlerta, celulasAlertadas, periodos]);

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
    return `${percentualFinal.toFixed(2)}%`;
  }

  function calcularAVAnoAnterior(valor: number, periodoAnoAnteriorKey: string): string {
    const receitaPeriodo = valoresAnoAnterior['03']?.[periodoAnoAnteriorKey] || 0;
    if (receitaPeriodo === 0) return '-';
    const receitaAbs = Math.abs(receitaPeriodo);
    const percentual = (valor / receitaAbs) * 100;
    const percentualFinal = valor < 0 ? -Math.abs(percentual) : Math.abs(percentual);
    return `${percentualFinal.toFixed(2)}%`;
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

  async function abrirDuplicatasPorEmpresa(conta: string, nomeConta: string, cdEmpresa: number, nomeEmpresa: string) {
    setModalDuplicatas({
      aberto: true,
      conta,
      nomeConta: `${nomeConta} - ${nomeEmpresa}${cdEmpresa ? ` (CC ${cdEmpresa})` : ''}`,
      periodo: 'total',
      labelPeriodo: `${formatarData(dataInicio)} a ${formatarData(dataFim)}`,
      duplicatas: [],
      total: 0,
      loading: true,
    });

    try {
      const params = new URLSearchParams({
        conta,
        dataInicio,
        dataFim,
        cdEmpresa: String(cdEmpresa),
        t: String(Date.now()),
      });
      const response = await fetch(`/api/dre/por-empresa/duplicatas?${params.toString()}`, {
        cache: 'no-store',
      });
      const data = await response.json();

      setModalDuplicatas((prev) => ({
        ...prev,
        duplicatas: data.duplicatas || [],
        total: data.total || 0,
        loading: false,
      }));
    } catch (error) {
      console.error('Erro ao buscar duplicatas por empresa:', error);
      setModalDuplicatas((prev) => ({
        ...prev,
        loading: false,
      }));
    }
  }

  function fecharModal() {
    setModalDuplicatas((prev) => ({ ...prev, aberto: false }));
    setAuditoriaModal({ aberto: false, dup: null });
  }

  async function verificarAuditoria(dup: Duplicata) {
    setAuditoriaModal({ aberto: true, dup });

    const chave = `${dup.cdFornecedor}_${dup.cdDespesaItem}`;
    if (auditoriaCache[chave]) return;

    setAuditoriaCache((prev) => ({ ...prev, [chave]: 'loading' }));
    try {
      const response = await fetch(
        `/api/dre/auditoria/fornecedor-despesa?cdFornecedor=${dup.cdFornecedor}&cdDespesaItemAtual=${dup.cdDespesaItem}`
      );
      const data: AuditoriaFornecedorDespesa = await response.json();
      setAuditoriaCache((prev) => ({ ...prev, [chave]: data }));
    } catch (error) {
      console.error('Erro ao verificar auditoria fornecedor-despesa:', error);
      setAuditoriaCache((prev) => ({ ...prev, [chave]: 'erro' }));
    }
  }

  async function validarAuditoria(dup: Duplicata) {
    const chave = `${dup.cdFornecedor}_${dup.cdDespesaItem}`;
    const atual = auditoriaCache[chave];
    if (!atual || atual === 'loading' || atual === 'erro') return;

    setAuditoriaCache((prev) => ({
      ...prev,
      [chave]: { ...atual, alerta: false, validado: true },
    }));

    try {
      await fetch('/api/dre/auditoria/validar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cdFornecedor: dup.cdFornecedor,
          cdDespesaItem: dup.cdDespesaItem,
          usuario: 'dre_analitica',
        }),
      });
      buscarAlertasAuditoria();
    } catch (error) {
      console.error('Erro ao validar auditoria fornecedor-despesa:', error);
    }
  }

  // Busca em lote quais celulas (conta:periodo) da grade tem duplicata fora do
  // padrao do fornecedor, pra sinalizar antes mesmo de abrir o modal. Roda em
  // paralelo com a carga principal e nao bloqueia a grade se falhar/demorar.
  async function buscarAlertasAuditoria() {
    try {
      const params = new URLSearchParams({ dataInicio, dataFim, filtro });
      const response = await fetch(`/api/dre/auditoria/alertas?${params.toString()}`, {
        cache: 'no-store',
      });
      const data = await response.json();
      const celulas: string[] = data.celulasAlertadas || [];

      const expandido = new Set<string>();
      for (const chave of celulas) {
        const [conta, periodo] = chave.split(':');
        expandido.add(chave);
        const partes = conta.split('.');
        for (let i = partes.length - 1; i > 0; i--) {
          expandido.add(`${partes.slice(0, i).join('.')}:${periodo}`);
        }
      }
      setCelulasAlertadas(expandido);
    } catch (error) {
      console.error('Erro ao buscar alertas de auditoria:', error);
    }
  }

  // Desloca um periodo "YYYY-MM" um ano para tras, pra achar o mes correspondente do ano anterior
  function anoAnteriorDe(periodoKey: string): string {
    const [ano, mes] = periodoKey.split('-');
    return `${parseInt(ano, 10) - 1}-${mes}`;
  }

  function deslocarDataUmAno(data: string): string {
    const [ano, mes, dia] = data.split('-');
    return `${parseInt(ano, 10) - 1}-${mes}-${dia}`;
  }

  async function buscarDadosAnoAnterior() {
    setCarregandoAnoAnterior(true);
    try {
      const params = new URLSearchParams({
        dataInicio: deslocarDataUmAno(dataInicio),
        dataFim: deslocarDataUmAno(dataFim),
        filtro,
      });
      const response = await fetch(`/api/dre/unificada?${params.toString()}`, {
        cache: 'no-store',
      });
      const data = await response.json();
      setValoresAnoAnterior(data.valores || {});
    } catch (error) {
      console.error('Erro ao buscar dados do ano anterior:', error);
    } finally {
      setCarregandoAnoAnterior(false);
    }
  }

  async function abrirDespesasSemAssociacao() {
    setModalSemAssociacao({ aberto: true, loading: true, despesas: [], totalItens: 0, valorTotal: 0 });
    try {
      const params = new URLSearchParams({ dataInicio, dataFim, filtro });
      const response = await fetch(`/api/dre/despesas-sem-associacao?${params.toString()}`, {
        cache: 'no-store',
      });
      const data = await response.json();
      setModalSemAssociacao({
        aberto: true,
        loading: false,
        despesas: data.despesas || [],
        totalItens: data.totalItens || 0,
        valorTotal: data.valorTotal || 0,
      });
    } catch (error) {
      console.error('Erro ao buscar despesas sem associacao:', error);
      setModalSemAssociacao((prev) => ({ ...prev, loading: false }));
    }
  }

  function fecharModalSemAssociacao() {
    setModalSemAssociacao((prev) => ({ ...prev, aberto: false }));
  }

  async function gerarAnaliseExecutiva() {
    setModalAnaliseExecutiva({ aberto: true, loading: true, texto: '', erro: null });
    try {
      const contasAchatadas = achatarContas(dadosDRE, periodos);
      const comparativoAnoAnterior = compararAnoAnterior
        ? {
            contas: contasAchatadas.map((c) => ({
              codigo: c.codigo,
              nome: c.nome,
              valores: Object.fromEntries(
                periodos.map((p) => [p.label, valoresAnoAnterior[c.codigo]?.[anoAnteriorDe(p.key)] || 0])
              ),
            })),
          }
        : null;

      const payload = {
        periodo: {
          dataInicio,
          dataFim,
          filtroLabel,
          periodos: periodos.map((p) => p.label),
        },
        contas: contasAchatadas,
        resumo: {
          receitaLiquida,
          margemContribuicao,
          ebitda,
          lucroLiquido,
          despesasFixas: despesasFixasTotal,
          despesasVariaveis: despesasVariaveisTotal,
          custosProdutosVendidos: custosProdutosVendidosTotal,
        },
        comparativoAnoAnterior,
        alertasAuditoriaFornecedorDespesa: Array.from(celulasAlertadas),
      };

      const response = await fetch('/api/dre/analise-executiva', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) {
        setModalAnaliseExecutiva({
          aberto: true,
          loading: false,
          texto: '',
          erro: data.detail || data.error || 'Erro ao gerar a análise executiva.',
        });
        return;
      }

      setModalAnaliseExecutiva({ aberto: true, loading: false, texto: data.analise || '', erro: null });
    } catch (error) {
      console.error('Erro ao gerar analise executiva:', error);
      setModalAnaliseExecutiva({
        aberto: true,
        loading: false,
        texto: '',
        erro: 'Erro ao gerar a análise executiva.',
      });
    }
  }

  function fecharModalAnaliseExecutiva() {
    setModalAnaliseExecutiva((prev) => ({ ...prev, aberto: false }));
  }

  // Funcoes para expandir/recolher niveis
  const CONTAS_NIVEL_1 = ['01', '02', '04', '06', '08', '10', '13', '17', '18'];
  const CONTAS_NIVEL_2 = ['02.01', '04.01', '04.02', '06.01', '08.01', '08.02', '08.03', '08.04', '08.05', '08.06', '08.07', '08.08', '08.09', '08.10', '08.11', '08.12', '10.01', '10.03', '13.01'];

  function expandirTodos() {
    const todasContas = new Set([...CONTAS_NIVEL_1, ...CONTAS_NIVEL_2]);
    setContasExpandidas(todasContas);
  }

  function recolherTodos() {
    setContasExpandidas(new Set());
  }

  function expandirNivel1() {
    setContasExpandidas(new Set(CONTAS_NIVEL_1));
  }

  function expandirNivel2() {
    setContasExpandidas(new Set([...CONTAS_NIVEL_1, ...CONTAS_NIVEL_2]));
  }

  // Funcao para criar Date local a partir de string YYYY-MM-DD (evita problema de timezone)
  function parseDataLocal(dataStr: string): Date {
    const [ano, mes, dia] = dataStr.split('T')[0].split('-').map(Number);
    return new Date(ano, mes - 1, dia);
  }

  // Funcao para formatar data sem conversao de timezone
  function formatarData(dataStr: string | null | undefined): string {
    if (!dataStr) return '-';
    const [ano, mes, dia] = dataStr.split('T')[0].split('-');
    return `${dia}/${mes}/${ano}`;
  }

  // Define o periodo como os N meses mais recentes ja fechados (nao inclui o
  // mes atual, que ainda esta em andamento), terminando no mes anterior.
  function definirMesAtual() {
    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
    setDataInicio(`${inicioMes.getFullYear()}-${String(inicioMes.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(
      `${fimMes.getFullYear()}-${String(fimMes.getMonth() + 1).padStart(2, '0')}-${String(fimMes.getDate()).padStart(2, '0')}`
    );
  }

  function definirMesAnterior() {
    const hoje = new Date();
    const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    setDataInicio(`${inicioMesAnterior.getFullYear()}-${String(inicioMesAnterior.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(
      `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`
    );
  }

  function definirUltimosMeses(qtdMeses: number) {
    const hoje = new Date();
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    const inicioIntervalo = new Date(hoje.getFullYear(), hoje.getMonth() - qtdMeses, 1);
    setDataInicio(`${inicioIntervalo.getFullYear()}-${String(inicioIntervalo.getMonth() + 1).padStart(2, '0')}-01`);
    setDataFim(
      `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`
    );
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
            <span className={`text-sm ${isResultado ? 'font-bold' : ''}`}>{nomesCustomizados[conta.codigo] ?? conta.nome}</span>
            {isPendente && (
              <span className="ml-2 px-2 py-0.5 text-xs bg-amber-200 text-amber-800 rounded">PENDENTE</span>
            )}
          </div>
        </td>
        {periodos.map((periodo, periodoIndex) => {
          const valorPeriodo = conta.valores[periodo.key] || 0;
          const podeClicar = !temFilhos && !isResultado && valorPeriodo !== 0 && isDespesa;
          const anomalia = !isResultado && isDespesa
            ? detectarAnomalia(conta.valores, periodos, periodoIndex)
            : null;
          const alertaAuditoria = !isResultado && isDespesa && celulasAlertadas.has(`${conta.codigo}:${periodo.key}`);
          const periodoAnoAnteriorKey = anoAnteriorDe(periodo.key);
          const valorAnoAnteriorPeriodo = valoresAnoAnterior[conta.codigo]?.[periodoAnoAnteriorKey] || 0;
          return (
            <React.Fragment key={periodo.key}>
              {compararAnoAnterior && (
                <>
                  <td className={`px-2 py-2 border-b border-gray-200 text-right text-sm bg-gray-100 ${
                    valorAnoAnteriorPeriodo < 0 ? 'text-red-500' : 'text-gray-600'
                  }`}>
                    {formatarValor(valorAnoAnteriorPeriodo)}
                  </td>
                  <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-100 ${
                    valorAnoAnteriorPeriodo < 0 ? 'text-red-400' : 'text-gray-400'
                  }`}>
                    {calcularAVAnoAnterior(valorAnoAnteriorPeriodo, periodoAnoAnteriorKey)}
                  </td>
                </>
              )}
              <td
                className={`px-2 py-2 border-b border-gray-200 text-right text-sm ${
                  valorPeriodo < 0 ? 'text-red-600' : ''
                }`}
              >
                <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                  {alertaAuditoria && (
                    <span className="group relative inline-flex text-blue-600">
                      <HelpCircle className="w-3.5 h-3.5" strokeWidth={2.5} />
                      <span className="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden w-max max-w-xs whitespace-normal rounded bg-gray-900 px-2 py-1.5 text-left text-xs font-normal leading-snug text-white shadow-lg group-hover:block">
                        Tem duplicata classificada fora do padrão do fornecedor neste mês. Abra os detalhes e use a
                        lupa de auditoria pra conferir.
                      </span>
                    </span>
                  )}
                  {anomalia && (
                    <span className="group relative inline-flex">
                      <span className={anomalia.direcao === 'alta' ? 'text-red-600' : 'text-green-600'}>
                        {anomalia.direcao === 'alta' ? (
                          <ArrowUp className="w-3 h-3" strokeWidth={3} />
                        ) : (
                          <ArrowDown className="w-3 h-3" strokeWidth={3} />
                        )}
                      </span>
                      <span className="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden w-max max-w-xs whitespace-normal rounded bg-gray-900 px-2 py-1.5 text-left text-xs font-normal leading-snug text-white shadow-lg group-hover:block">
                        <span className="block">
                          {anomalia.direcao === 'alta' ? 'Alta' : 'Queda'} de{' '}
                          {Math.abs(anomalia.percentualAnterior).toFixed(0)}% vs. mês anterior (
                          {formatarValor(anomalia.valorAnterior)})
                        </span>
                        {anomalia.media && (
                          <span className="mt-0.5 block text-gray-300">
                            {anomalia.media.percentual >= 0 ? 'Alta' : 'Queda'} de{' '}
                            {Math.abs(anomalia.media.percentual).toFixed(0)}% vs. média dos últimos{' '}
                            {anomalia.media.meses} meses ({formatarValor(anomalia.media.valor)})
                          </span>
                        )}
                      </span>
                    </span>
                  )}
                  {podeClicar ? (
                    <button
                      onClick={() => abrirDuplicatas(conta.codigo, nomesCustomizados[conta.codigo] ?? conta.nome, periodo.key, periodo.label)}
                      className="hover:underline hover:text-blue-600 cursor-pointer"
                      title="Clique para ver duplicatas"
                    >
                      {formatarValor(valorPeriodo)}
                    </button>
                  ) : (
                    formatarValor(valorPeriodo)
                  )}
                </span>
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
      if (conta.codigo === '08') {
        const filhos = conta.filhos || [];
        const filhosFixos = filhos.filter((f) => tiposCusto[f.codigo] === 'fixo');
        const filhosVariaveis = filhos.filter((f) => tiposCusto[f.codigo] === 'variavel');
        const filhosSemClassificacao = filhos.filter((f) => !tiposCusto[f.codigo]);

        const renderizarSubgrupo = (titulo: string, corTexto: string, itens: ContaDREValores[]) => {
          if (itens.length === 0) return;

          const totalGeral = itens.reduce((acc, item) => acc + (item.total || 0), 0);

          linhas.push(
            <tr key={`subgrupo-${conta.codigo}-${titulo}`} className="bg-gray-50">
              <td
                className="px-4 py-1.5 border-b border-gray-200 sticky left-0 bg-gray-50 z-10"
                style={{ paddingLeft: `${(nivel + 1) * 16}px` }}
              >
                <span className={`text-[11px] font-bold tracking-wide ${corTexto}`}>{titulo}</span>
              </td>
              {periodos.map((periodo) => {
                const totalPeriodo = itens.reduce((acc, item) => acc + (item.valores[periodo.key] || 0), 0);
                const periodoAnoAnteriorKey = anoAnteriorDe(periodo.key);
                const totalAnoAnteriorPeriodo = itens.reduce(
                  (acc, item) => acc + (valoresAnoAnterior[item.codigo]?.[periodoAnoAnteriorKey] || 0),
                  0
                );
                return (
                  <React.Fragment key={periodo.key}>
                    {compararAnoAnterior && (
                      <>
                        <td
                          className={`px-2 py-1.5 border-b border-gray-200 bg-gray-200 text-right text-xs font-bold ${
                            totalAnoAnteriorPeriodo < 0 ? 'text-red-600' : 'text-gray-600'
                          }`}
                        >
                          {formatarValor(totalAnoAnteriorPeriodo)}
                        </td>
                        <td
                          className={`px-2 py-1.5 border-b border-gray-200 bg-gray-200 text-right text-[11px] ${
                            totalAnoAnteriorPeriodo < 0 ? 'text-red-500' : 'text-gray-500'
                          }`}
                        >
                          {calcularAVAnoAnterior(totalAnoAnteriorPeriodo, periodoAnoAnteriorKey)}
                        </td>
                      </>
                    )}
                    <td
                      className={`px-2 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-xs font-bold ${
                        totalPeriodo < 0 ? 'text-red-600' : 'text-gray-700'
                      }`}
                    >
                      {formatarValor(totalPeriodo)}
                    </td>
                    <td
                      className={`px-2 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-[11px] ${
                        totalPeriodo < 0 ? 'text-red-500' : 'text-gray-500'
                      }`}
                    >
                      {calcularAVPeriodo(totalPeriodo, periodo.key)}
                    </td>
                  </React.Fragment>
                );
              })}
              <td
                className={`px-3 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-xs font-bold ${
                  totalGeral < 0 ? 'text-red-600' : 'text-gray-700'
                }`}
              >
                {formatarValor(totalGeral)}
              </td>
              <td
                className={`px-3 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-[11px] ${
                  totalGeral < 0 ? 'text-red-500' : 'text-gray-500'
                }`}
              >
                {calcularAV(totalGeral)}
              </td>
            </tr>
          );
          for (const filho of itens) {
            linhas.push(...renderizarLinhaConta(filho, nivel + 1));
          }
        };

        renderizarSubgrupo('DESPESAS FIXAS', 'text-blue-700', filhosFixos);
        renderizarSubgrupo('DESPESAS VARIÁVEIS', 'text-orange-700', filhosVariaveis);
        renderizarSubgrupo('NÃO CLASSIFICADO', 'text-gray-400', filhosSemClassificacao);
      } else {
        for (const filho of conta.filhos || []) {
          linhas.push(...renderizarLinhaConta(filho, nivel + 1));
        }
      }
    }

    return linhas;
  }

  async function buscarDados() {
    setLoading(true);
    setStatusCarregamento(null);

    try {
      if (tipoVisao === 'analitica') {
        buscarAlertasAuditoria();
        buscarDadosAnoAnterior();

        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 300000);
        const params = new URLSearchParams({ dataInicio, dataFim, filtro });
        const response = await fetch(`/api/dre/unificada?${params.toString()}`, {
          signal: controller.signal,
          cache: 'no-store',
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

        // Contas totalizadoras que vêm da API
        const contasTotalizadoras: Record<string, ContaDREValores> = {};

        for (const codigoConta of Object.keys(valoresAPI)) {
          const conta = encontrarConta(dadosProcessados, codigoConta);
          const valoresConta = valoresAPI[codigoConta];

          if (!conta) {
            // Contas totalizadoras (03, 05, 07, 09, 11, 14) não existem na estrutura
            if (['03', '05', '07', '09', '11', '14'].includes(codigoConta)) {
              contasTotalizadoras[codigoConta] = {
                codigo: codigoConta,
                nome: '',
                nivel: 1,
                tipo: 'resultado',
                valores: {},
                total: valoresConta.total || 0,
                valoresApi: true,
              };
              for (const periodo of periodosAtuais) {
                contasTotalizadoras[codigoConta].valores[periodo.key] = valoresConta[periodo.key] || 0;
              }
            }
            continue;
          }
          conta.valores = {};
          for (const periodo of periodosAtuais) {
            conta.valores[periodo.key] = valoresConta[periodo.key] || 0;
          }
          conta.total = valoresConta.total || 0;
          conta.valoresApi = true;
        }

        somarFilhos(dadosProcessados, periodosAtuais);
        const dadosOrdenados = calcularLinhasOrdenadas(dadosProcessados, periodosAtuais, contasTotalizadoras);
        setDadosDRE(dadosOrdenados);
        setUltimaAtualizacao(new Date().toLocaleString('pt-BR'));
        setConsultaExecutada(true);

      } else if (tipoVisao === 'sintetica') {
        setDadosSinteticos([]);
        setTotaisSinteticos({});
        setDadosSinteticosAno([]);
        setTotaisSinteticosAno({});

        const params = new URLSearchParams({
          dataInicio,
          dataFim,
          filtro,
          t: String(Date.now()),
        });
        const dataInicioComparativo = `${Number(dataInicio.split('-')[0]) - 1}-${dataInicio.split('-')[1]}-${dataInicio.split('-')[2]}`;
        const dataFimComparativo = `${Number(dataFim.split('-')[0]) - 1}-${dataFim.split('-')[1]}-${dataFim.split('-')[2]}`;
        const paramsAno = new URLSearchParams({
          dataInicio: dataInicioComparativo,
          dataFim: dataFimComparativo,
          filtro,
          t: String(Date.now()),
        });
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 300000);
        const [response, responseAno] = await Promise.all([
          fetch(`/api/dre/unificada/sintetico?${params.toString()}`, {
            signal: controller.signal,
            cache: 'no-store',
          }),
          fetch(`/api/dre/unificada/sintetico?${paramsAno.toString()}`, {
            signal: controller.signal,
            cache: 'no-store',
          }),
        ]);
        window.clearTimeout(timeout);
        const data = await response.json();
        const dataAno = await responseAno.json();

        if (data.error) {
          setStatusCarregamento(`Erro do backend: ${data.error}`);
          return;
        }
        if (dataAno.error) {
          setStatusCarregamento(`Erro do backend na tabela anual: ${dataAno.error}`);
          return;
        }

        setDadosSinteticos(data.resumo || []);
        setTotaisSinteticos(data.totais || {});
        setDadosSinteticosAno(dataAno.resumo || []);
        setTotaisSinteticosAno(dataAno.totais || {});
        setUltimaAtualizacao(new Date().toLocaleString('pt-BR'));
        setConsultaExecutada(true);
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
        setUltimaAtualizacao(new Date().toLocaleString('pt-BR'));
        setConsultaExecutada(true);
      } else if (tipoVisao === 'por-ccusto') {
        const response = await fetch(`/api/dre/fabrica/por-ccusto?dataInicio=${dataInicio}&dataFim=${dataFim}`);
        const data = await response.json();

        if (data.error) {
          setStatusCarregamento(`Erro do backend: ${data.error}`);
          return;
        }

        setDadosPorCCusto(data);

        // Criar estrutura de contas ordenada para renderizacao
        const dadosEstrutura = JSON.parse(JSON.stringify(ESTRUTURA_DRE)) as ContaDREValores[];
        const dadosOrdenados = calcularLinhasOrdenadas(dadosEstrutura, []);
        setDadosDRE(dadosOrdenados);
        setUltimaAtualizacao(new Date().toLocaleString('pt-BR'));
        setConsultaExecutada(true);
      }

    } catch (error) {
      console.error('Erro ao buscar dados DRE:', error);
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatusCarregamento('A consulta demorou mais de 5 minutos e foi cancelada. Tente um periodo menor ou consulte novamente.');
        return;
      }
      if (dadosDRE.length === 0) {
        setStatusCarregamento('Falha ao conectar com o backend. Verifique se o servidor esta rodando.');
      }
    } finally {
      setLoading(false);
    }
  }

  // Mudancas de filtro/periodo/visao apenas limpam a tela. A consulta pesada
  // roda somente quando o usuario clicar em Consultar.
  useEffect(() => {
    setConsultaExecutada(false);
    setStatusCarregamento(null);
    setFiltroInfo('');
    setDadosDRE([]);
    setDadosSinteticos([]);
    setTotaisSinteticos({});
    setDadosSinteticosAno([]);
    setTotaisSinteticosAno({});
    setDadosPorEmpresa(null);
    setDadosPorCCusto(null);
  }, [filtro, tipoVisao, dataInicio, dataFim]);

  const receitaLiquida = dadosDRE.find((conta) => conta.codigo === '03')?.total || 0;
  const margemContribuicao = dadosDRE.find((conta) => conta.codigo === '05')?.total || 0;
  const ebitda = dadosDRE.find((conta) => conta.codigo === '09')?.total || 0;
  const lucroLiquido = dadosDRE.find((conta) => conta.codigo === '14')?.total || 0;

  const despesasOperacionaisConta = dadosDRE.find((conta) => conta.codigo === '08');
  const despesasFixasTotal = (despesasOperacionaisConta?.filhos || [])
    .filter((filho) => tiposCusto[filho.codigo] === 'fixo')
    .reduce((acc, filho) => acc + (filho.total || 0), 0);
  const despesasVariaveisTotal = (despesasOperacionaisConta?.filhos || [])
    .filter((filho) => tiposCusto[filho.codigo] === 'variavel')
    .reduce((acc, filho) => acc + (filho.total || 0), 0);
  const custosProdutosVendidosTotal = dadosDRE
    .find((conta) => conta.codigo === '04')
    ?.filhos?.find((filho) => filho.codigo === '04.02')?.total || 0;
  const despesasOcupacaoTotal = (despesasOperacionaisConta?.filhos || [])
    .find((filho) => filho.codigo === '08.01')?.total || 0;
  const despesasPessoalTotal = (despesasOperacionaisConta?.filhos || [])
    .find((filho) => filho.codigo === '08.04')?.total || 0;
  const despesasVendasTotal = (despesasOperacionaisConta?.filhos || [])
    .find((filho) => filho.codigo === '08.10')?.total || 0;

  function totalAnoAnteriorConta(codigo: string): number {
    return periodos.reduce(
      (acc, p) => acc + (valoresAnoAnterior[codigo]?.[anoAnteriorDe(p.key)] || 0),
      0
    );
  }

  const receitaLiquidaAnoAnterior = totalAnoAnteriorConta('03');
  const margemContribuicaoAnoAnterior = totalAnoAnteriorConta('05');
  const ebitdaAnoAnterior = totalAnoAnteriorConta('09');
  const lucroLiquidoAnoAnterior = totalAnoAnteriorConta('14');
  const despesasFixasAnoAnterior = (despesasOperacionaisConta?.filhos || [])
    .filter((filho) => tiposCusto[filho.codigo] === 'fixo')
    .reduce((acc, filho) => acc + totalAnoAnteriorConta(filho.codigo), 0);
  const despesasVariaveisAnoAnterior = (despesasOperacionaisConta?.filhos || [])
    .filter((filho) => tiposCusto[filho.codigo] === 'variavel')
    .reduce((acc, filho) => acc + totalAnoAnteriorConta(filho.codigo), 0);
  const custosProdutosVendidosAnoAnterior = totalAnoAnteriorConta('04.02');
  const despesasOcupacaoAnoAnterior = totalAnoAnteriorConta('08.01');
  const despesasPessoalAnoAnterior = totalAnoAnteriorConta('08.04');
  const despesasVendasAnoAnterior = totalAnoAnteriorConta('08.10');

  function renderizarLinhaAnoAnterior(anterior: number) {
    return (
      <p className="text-xs text-black font-medium mt-0.5">
        {carregandoAnoAnterior ? 'Ano anterior: carregando...' : `Ano anterior: ${formatarValor(anterior)}`}
      </p>
    );
  }

  function renderizarLinhaMediaMensal(total: number) {
    if (periodos.length <= 1) return null;
    return (
      <p className="text-xs text-black font-medium mt-0.5">
        {`Média mensal: ${formatarValor(total / periodos.length)}`}
      </p>
    );
  }

  // Obter label do filtro selecionado
  const filtrosSelecionados = filtro.split(',').filter(Boolean);
  const opcoesLojas = opcoesFiltro.filter((opcao) => opcao.tipo === 'loja');
  const filtrosLojasSelecionados = filtrosSelecionados.filter((valor) =>
    opcoesLojas.some((opcao) => opcao.valor === valor)
  );
  const filtroLabel = filtro === 'consolidado'
    ? 'CONSOLIDADO (TODAS)'
    : filtro === 'fabrica'
      ? 'FABRICA'
      : filtrosLojasSelecionados.length === 1
        ? opcoesFiltro.find(o => o.valor === filtrosLojasSelecionados[0])?.label || filtro
        : `${filtrosLojasSelecionados.length} LOJAS`;
  const isFabrica = filtro === 'fabrica';
  const isLoja = filtro !== 'consolidado' && filtro !== 'fabrica';

  function selecionarFiltroUnico(valor: string) {
    setFiltro(valor);
    setFiltroAberto(false);
  }

  function toggleFiltroLoja(valor: string) {
    setFiltro((atual) => {
      const selecionadasAtuais = atual.split(',').filter((item) =>
        opcoesLojas.some((loja) => loja.valor === item)
      );
      const novas = selecionadasAtuais.includes(valor)
        ? selecionadasAtuais.filter((item) => item !== valor)
        : [...selecionadasAtuais, valor];

      return novas.length > 0 ? novas.join(',') : 'consolidado';
    });
  }
  const colunasSinteticas = [
    { key: 'receitaLiquida', label: 'RECEITA LÍQUIDA', tipo: 'valor' },
    { key: 'lucroLiquido', label: 'LUCRO LÍQUIDO', tipo: 'valor' },
    { key: 'lucroLiquidoPct', label: '%', tipo: 'av' },
    { key: 'lucroLiquido3mPct', label: '%3M', tipo: 'av' },
    { key: 'lucroLiquido6mPct', label: '%6M', tipo: 'av' },
    { key: 'lucroLiquido12mPct', label: '%12M', tipo: 'av' },
    { key: 'cmv', label: 'CMV', tipo: 'valor', negativo: true },
    { key: 'cmvPct', label: '%', tipo: 'av' },
    { key: 'lucroOperBruto', label: 'LUCRO OPER. BRUTO', tipo: 'valor' },
    { key: 'lucroOperBrutoPct', label: '%', tipo: 'av' },
    { key: 'despOcupacao', label: 'DESP. OCUPAÇÃO', tipo: 'valor', negativo: true },
    { key: 'despOcupacaoPct', label: '%', tipo: 'av' },
    { key: 'despAdministrativas', label: 'DESP. ADMINISTRATIVAS', tipo: 'valor', negativo: true },
    { key: 'despAdministrativasPct', label: '%', tipo: 'av' },
    { key: 'despManutencao', label: 'DESP. MANUTENÇÃO', tipo: 'valor', negativo: true },
    { key: 'despManutencaoPct', label: '%', tipo: 'av' },
    { key: 'despPessoal', label: 'DESP. PESSOAL', tipo: 'valor', negativo: true },
    { key: 'despPessoalPct', label: '%', tipo: 'av' },
    { key: 'despBancarias', label: 'DESP. BANCÁRIAS', tipo: 'valor', negativo: true },
    { key: 'despBancariasPct', label: '%', tipo: 'av' },
    { key: 'impostosDiretos', label: 'IMPOSTOS DIRETOS', tipo: 'valor', negativo: true },
    { key: 'impostosDiretosPct', label: '%', tipo: 'av' },
    { key: 'despMarketing', label: 'DESP. MARKETING', tipo: 'valor', negativo: true },
    { key: 'despMarketingPct', label: '%', tipo: 'av' },
    { key: 'despVendas', label: 'DESP. VENDAS', tipo: 'valor', negativo: true },
    { key: 'despVendasPct', label: '%', tipo: 'av' },
    { key: 'despCobranca', label: 'DESP. COBRANÇA', tipo: 'valor', negativo: true },
    { key: 'despCobrancaPct', label: '%', tipo: 'av' },
    { key: 'freteVendas', label: 'FRETE VENDAS', tipo: 'valor', negativo: true },
    { key: 'freteVendasPct', label: '%', tipo: 'av' },
    { key: 'comissaoRepresentante', label: 'COMISSÃO REPRESENTANTES', tipo: 'valor', negativo: true },
    { key: 'comissaoRepresentantePct', label: '%', tipo: 'av' },
    { key: 'premiacaoComercial', label: 'PREMIAÇÃO COMERCIAL', tipo: 'valor', negativo: true },
    { key: 'premiacaoComercialPct', label: '%', tipo: 'av' },
    { key: 'despesasFinanceiras', label: 'DESP. FINANCEIRAS', tipo: 'valor', negativo: true },
    { key: 'despesasFinanceirasPct', label: '%', tipo: 'av' },
  ] as const;
  const larguraTabelaSintetica = larguraColunaContas
    + colunasSinteticas.reduce((total, coluna) => total + (coluna.tipo === 'av' ? larguraColunaAV : larguraColunaValor), 0);

  function percentualSobreReceita(valor: number | null, receita: number | null): number | null {
    if (valor === null || receita === null || receita === 0) return null;
    return (valor / Math.abs(receita)) * 100;
  }

  function calcularColunaSintetica(registro: unknown, coluna: typeof colunasSinteticas[number]): number | null {
    const receitaLiquidaRegistro = valorNumericoOuNulo(registro, ['receitaLiquida']);
    const receitaLiquidaAbs = receitaLiquidaRegistro === null ? null : Math.abs(receitaLiquidaRegistro);
    const valorCampo = (campo: string) => valorNumerico(registro, [campo]);
    const pctCampo = (campo: string) => percentualSobreReceita(valorCampo(campo), receitaLiquidaAbs);

    switch (coluna.key) {
      case 'receitaLiquida':
        return receitaLiquidaRegistro;
      case 'lucroLiquido':
        return valorCampo('lucroLiquido');
      case 'lucroLiquidoPct':
        return pctCampo('lucroLiquido');
      case 'lucroLiquido3mPct':
        return percentualSobreReceita(valorNumericoOuNulo(registro, ['lucroLiquido3m']), valorNumericoOuNulo(registro, ['receitaLiquida3m']));
      case 'lucroLiquido6mPct':
        return percentualSobreReceita(valorNumericoOuNulo(registro, ['lucroLiquido6m']), valorNumericoOuNulo(registro, ['receitaLiquida6m']));
      case 'lucroLiquido12mPct':
        return percentualSobreReceita(valorNumericoOuNulo(registro, ['lucroLiquido12m']), valorNumericoOuNulo(registro, ['receitaLiquida12m']));
      case 'impostosDiretos':
        return valorCampo('despesasTributarias');
      case 'impostosDiretosPct':
        return pctCampo('despesasTributarias');
      case 'cmv':
        return valorCampo('cmv');
      case 'cmvPct':
        return pctCampo('cmv');
      case 'lucroOperBruto':
        return valorCampo('margemContribuicao');
      case 'lucroOperBrutoPct':
        return pctCampo('margemContribuicao');
      case 'despOcupacao':
      case 'despAdministrativas':
      case 'despManutencao':
      case 'despPessoal':
      case 'despBancarias':
      case 'despMarketing':
      case 'despVendas':
      case 'despCobranca':
      case 'freteVendas':
      case 'comissaoRepresentante':
      case 'premiacaoComercial':
      case 'despesasFinanceiras':
        return valorCampo(coluna.key);
      case 'despOcupacaoPct':
        return pctCampo('despOcupacao');
      case 'despAdministrativasPct':
        return pctCampo('despAdministrativas');
      case 'despManutencaoPct':
        return pctCampo('despManutencao');
      case 'despPessoalPct':
        return pctCampo('despPessoal');
      case 'despBancariasPct':
        return pctCampo('despBancarias');
      case 'despMarketingPct':
        return pctCampo('despMarketing');
      case 'despVendasPct':
        return pctCampo('despVendas');
      case 'despCobrancaPct':
        return pctCampo('despCobranca');
      case 'freteVendasPct':
        return pctCampo('freteVendas');
      case 'comissaoRepresentantePct':
        return pctCampo('comissaoRepresentante');
      case 'premiacaoComercialPct':
        return pctCampo('premiacaoComercial');
      case 'despesasFinanceirasPct':
        return pctCampo('despesasFinanceiras');
      default:
        return null;
    }
  }

  function formatarColunaSintetica(registro: unknown, coluna: typeof colunasSinteticas[number]): string {
    const valor = calcularColunaSintetica(registro, coluna);
    if (valor === null) return '-';
    if (coluna.tipo === 'av') return `${valor.toFixed(2)}%`;
    return formatarValor(('negativo' in coluna && coluna.negativo) ? -Math.abs(valor) : valor);
  }

  function isPercentualLucroLiquidoSintetico(coluna: typeof colunasSinteticas[number]): boolean {
    return ['lucroLiquidoPct', 'lucroLiquido3mPct', 'lucroLiquido6mPct', 'lucroLiquido12mPct'].includes(coluna.key);
  }

  function normalizarNomeLojaSintetica(nome: string): string {
    const normalizado = nome.trim().toUpperCase();
    const nomesCurtos: Record<string, string> = {
      'BARRA SHOPPING - RJ': 'BARRA',
      'ECOMMERCE ANGELICA': 'ECOMMERCE',
      'SALVADOR SHOPPING - BA': 'SALVADOR',
      'MORUMBI SHOPPING': 'MORUMBI',
    };
    return nomesCurtos[normalizado] || normalizado.replace(/\s+-\s+[A-Z]{2}$/, '');
  }

  function filtrarLinhasVisiveisSintetica(dados: ResumoLoja[]): ResumoLoja[] {
    return dados.filter((item) => item.codigo !== 'outros');
  }

  function renderTabelaSintetica(dados: ResumoLoja[], totais: Record<string, number>, prefixo: string) {
    const linhasVisiveis = filtrarLinhasVisiveisSintetica(dados);

    return (
      <div className="overflow-x-auto">
        <table className="border-collapse text-sm" style={{ minWidth: `${larguraTabelaSintetica}px` }}>
          <colgroup>
            <col style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }} />
            {colunasSinteticas.map((tipo, index) => (
              <col
                key={`${prefixo}-${tipo.key}-${index}`}
                style={{
                  width: `${tipo.tipo === 'av' ? larguraColunaAV : larguraColunaValor}px`,
                  minWidth: `${tipo.tipo === 'av' ? larguraColunaAV : larguraColunaValor}px`,
                }}
              />
            ))}
          </colgroup>
          <thead>
            <tr className="bg-gray-100">
              <th className="px-4 py-3 text-left font-semibold border-b sticky left-0 bg-gray-100 z-10" style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }}>LOJA</th>
              {colunasSinteticas.map((coluna, index) => (
                <th
                  key={`${prefixo}-${coluna.key}-${index}`}
                  className={`px-3 py-3 text-right font-semibold border-b ${coluna.tipo === 'av' ? 'text-gray-500' : ''}`}
                >
                  {coluna.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhasVisiveis.map((item) => (
              <tr key={`${prefixo}-${item.codigo}`} className="hover:bg-gray-50 border-b">
                <td className="px-4 py-2 sticky left-0 bg-white" style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }}>
                  <span className="font-medium whitespace-nowrap">{normalizarNomeLojaSintetica(item.nome)}</span>
                </td>
                {colunasSinteticas.map((coluna, index) => {
                  const valor = calcularColunaSintetica(item, coluna);
                  const negativo = coluna.tipo === 'valor' && valor !== null && (('negativo' in coluna && coluna.negativo) || valor < 0);
                  const percentualLucro = coluna.tipo === 'av' && isPercentualLucroLiquidoSintetico(coluna);
                  return (
                    <td
                      key={`${prefixo}-${item.codigo}-${coluna.key}-${index}`}
                      className={`px-3 py-2 text-right ${percentualLucro && valor !== null ? valor >= 0 ? 'text-green-600' : 'text-red-600' : coluna.tipo === 'av' ? 'text-gray-500' : negativo ? 'text-red-600' : valor && valor > 0 ? 'text-gray-800' : 'text-gray-400'}`}
                    >
                      {formatarColunaSintetica(item, coluna)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="bg-gray-100 font-bold">
              <td className="px-4 py-3 sticky left-0 bg-gray-100" style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }}>TOTAL CONSOLIDADO</td>
              {colunasSinteticas.map((coluna, index) => {
                const valor = calcularColunaSintetica(totais, coluna);
                const negativo = coluna.tipo === 'valor' && valor !== null && (('negativo' in coluna && coluna.negativo) || valor < 0);
                const percentualLucro = coluna.tipo === 'av' && isPercentualLucroLiquidoSintetico(coluna);
                return (
                  <td
                    key={`${prefixo}-total-${coluna.key}-${index}`}
                    className={`px-3 py-3 text-right ${percentualLucro && valor !== null ? valor >= 0 ? 'text-green-600' : 'text-red-600' : coluna.tipo === 'av' ? 'text-gray-600' : negativo ? 'text-red-600' : valor && valor > 0 ? 'text-gray-800' : 'text-gray-400'}`}
                  >
                    {formatarColunaSintetica(totais, coluna)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

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
              {ultimaAtualizacao && (
                <p className="text-xs text-gray-400 mt-1">Carregado em: {ultimaAtualizacao}</p>
              )}
            </div>
          </div>

          {/* Filtro */}
          <div className="flex items-center gap-3">
            <Filter className="w-5 h-5 text-gray-500" />
            <div className="relative">
              <button
                type="button"
                onClick={() => setFiltroAberto((aberto) => !aberto)}
                className="min-w-[280px] max-w-[360px] flex items-center justify-between gap-2 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white hover:bg-gray-50"
              >
                <span className="truncate text-left">{filtroLabel}</span>
                <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
              </button>

              {filtroAberto && (
                <div className="absolute right-0 z-40 mt-2 w-[320px] max-h-[420px] overflow-auto rounded-lg border border-gray-200 bg-white shadow-xl">
                  <div className="border-b border-gray-100 p-2 space-y-1">
                    <button
                      type="button"
                      onClick={() => selecionarFiltroUnico('consolidado')}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm ${
                        filtro === 'consolidado' ? 'bg-green-50 text-green-800 font-semibold' : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      CONSOLIDADO (TODAS)
                    </button>
                    <button
                      type="button"
                      onClick={() => selecionarFiltroUnico('fabrica')}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm ${
                        filtro === 'fabrica' ? 'bg-blue-50 text-blue-800 font-semibold' : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      FABRICA
                    </button>
                  </div>

                  <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-gray-100 bg-white px-3 py-2">
                    <span className="text-xs font-semibold text-gray-500 uppercase">Lojas</span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setFiltro(opcoesLojas.map((loja) => loja.valor).join(','))}
                        className="text-xs font-medium text-purple-700 hover:text-purple-900"
                      >
                        Todas
                      </button>
                      <button
                        type="button"
                        onClick={() => setFiltro('consolidado')}
                        className="text-xs font-medium text-gray-600 hover:text-gray-900"
                      >
                        Limpar
                      </button>
                    </div>
                  </div>

                  <div className="py-1">
                    {opcoesLojas.map((opcao) => (
                      <label key={opcao.valor} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={filtrosLojasSelecionados.includes(opcao.valor)}
                          onChange={() => toggleFiltroLoja(opcao.valor)}
                          className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                        <span className="truncate">{opcao.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
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
          <button
            onClick={() => setTipoVisao('por-ccusto')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all ${
              tipoVisao === 'por-ccusto'
                ? 'bg-orange-600 text-white shadow-md'
                : 'text-gray-600 hover:bg-gray-200'
            }`}
          >
            <Factory className="w-4 h-4" />
            Por Centro de Custo
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
          {tipoVisao === 'analitica' && (
            <>
              <div className="w-px h-6 bg-gray-300 mx-2" />
              <button
                onClick={expandirTodos}
                title="Expandir todas as contas"
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
              >
                <ChevronsDown className="w-4 h-4" />
                Expandir tudo
              </button>
              <button
                onClick={recolherTodos}
                title="Recolher todas as contas"
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
              >
                <ChevronsUp className="w-4 h-4" />
                Recolher tudo
              </button>
              <div className="w-px h-6 bg-gray-300 mx-2" />
              <button
                onClick={abrirDespesasSemAssociacao}
                title="Verificar despesas do período/filtro atual que não estão associadas a nenhuma conta do plano de contas"
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 transition-colors"
              >
                <Unlink className="w-4 h-4" />
                Despesas sem associação
              </button>
              <div className="w-px h-6 bg-gray-300 mx-2" />
              <div className="relative w-64">
                <input
                  type="text"
                  value={despesaBusca}
                  onChange={(e) => {
                    setDespesaBusca(e.target.value);
                    setDespesaDropdownAberto(true);
                    if (despesaFiltroSelecionada) setDespesaFiltroSelecionada('');
                  }}
                  onFocus={() => setDespesaDropdownAberto(true)}
                  onBlur={() => setTimeout(() => setDespesaDropdownAberto(false), 150)}
                  placeholder="Filtrar despesa..."
                  title="Digite o código ou nome de uma despesa para filtrar a grade"
                  className={`w-full pl-3 pr-8 py-2 rounded-md border text-sm ${
                    despesaFiltroSelecionada
                      ? 'bg-blue-600 text-white border-blue-600 placeholder-blue-200'
                      : 'bg-gray-200 text-gray-700 border-gray-200'
                  }`}
                />
                {despesaBusca && (
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setDespesaFiltroSelecionada('');
                      setDespesaBusca('');
                    }}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 ${
                      despesaFiltroSelecionada ? 'text-blue-200 hover:text-white' : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                {despesaDropdownAberto && despesasFiltradasBusca.length > 0 && (
                  <div className="absolute z-50 mt-1 w-full max-h-64 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                    {despesasFiltradasBusca.map((c) => (
                      <button
                        key={c.codigo}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setDespesaFiltroSelecionada(c.codigo);
                          setDespesaBusca(`${c.codigo} - ${c.nome}`);
                          setDespesaDropdownAberto(false);
                        }}
                        className="block w-full truncate px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-blue-50"
                        title={`${c.codigo} - ${c.nome}`}
                      >
                        {c.codigo} - {c.nome}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => setMostrarApenasComAlerta(!mostrarApenasComAlerta)}
                title="Mostrar apenas contas com duplicata fora do padrão do fornecedor"
                className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
                  mostrarApenasComAlerta
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                }`}
              >
                <HelpCircle className="w-4 h-4" />
                Só com problema
              </button>
              <div className="w-px h-6 bg-gray-300 mx-2" />
              <button
                onClick={gerarAnaliseExecutiva}
                disabled={!consultaExecutada || dadosDRE.length === 0}
                title="Gerar leitura executiva do período/filtro atual com IA"
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                Análise Executiva
              </button>
            </>
          )}
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
      {tipoVisao === 'analitica' && consultaExecutada && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-blue-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <DollarSign className="w-4 h-4" />
              Receita Liquida
            </div>
            <p className="text-lg font-bold text-black mt-1">{formatarValor(receitaLiquida)}</p>
            <p className="text-xs text-black font-medium">100% (base A/V)</p>
            {renderizarLinhaMediaMensal(receitaLiquida)}
            {renderizarLinhaAnoAnterior(receitaLiquidaAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-green-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingUp className="w-4 h-4" />
              Margem Contribuicao
            </div>
            <p className="text-lg font-bold text-black mt-1">{formatarValor(margemContribuicao)}</p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((margemContribuicao / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(margemContribuicao)}
            {renderizarLinhaAnoAnterior(margemContribuicaoAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-yellow-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingUp className="w-4 h-4" />
              EBITDA
            </div>
            <p className="text-lg font-bold text-black mt-1">{formatarValor(ebitda)}</p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((ebitda / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(ebitda)}
            {renderizarLinhaAnoAnterior(ebitdaAnoAnterior)}
          </div>
          <div className={`bg-white rounded-lg shadow p-3 border-l-4 ${lucroLiquido >= 0 ? 'border-green-500' : 'border-red-500'}`}>
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              {lucroLiquido >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              Lucro Liquido
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {formatarValor(lucroLiquido)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((lucroLiquido / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(lucroLiquido)}
            {renderizarLinhaAnoAnterior(lucroLiquidoAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-blue-600">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Despesas Fixas
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {formatarValor(despesasFixasTotal)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((despesasFixasTotal / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(despesasFixasTotal)}
            {renderizarLinhaAnoAnterior(despesasFixasAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-orange-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Despesas Variaveis
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {formatarValor(despesasVariaveisTotal)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((despesasVariaveisTotal / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(despesasVariaveisTotal)}
            {renderizarLinhaAnoAnterior(despesasVariaveisAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-red-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Custos Produtos Vendidos
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {formatarValor(custosProdutosVendidosTotal)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((custosProdutosVendidosTotal / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(custosProdutosVendidosTotal)}
            {renderizarLinhaAnoAnterior(custosProdutosVendidosAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-orange-600">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Despesas Ocupação
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {formatarValor(despesasOcupacaoTotal)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((despesasOcupacaoTotal / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(despesasOcupacaoTotal)}
            {renderizarLinhaAnoAnterior(despesasOcupacaoAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-purple-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Despesas Pessoal
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {formatarValor(despesasPessoalTotal)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((despesasPessoalTotal / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(despesasPessoalTotal)}
            {renderizarLinhaAnoAnterior(despesasPessoalAnoAnterior)}
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-pink-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Despesas Vendas
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {formatarValor(despesasVendasTotal)}
            </p>
            {receitaLiquida > 0 && (
              <p className="text-xs text-black font-medium">{((despesasVendasTotal / receitaLiquida) * 100).toFixed(2)}% da Receita</p>
            )}
            {renderizarLinhaMediaMensal(despesasVendasTotal)}
            {renderizarLinhaAnoAnterior(despesasVendasAnoAnterior)}
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
            onClick={definirMesAnterior}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Mês Anterior
          </button>
          <button
            onClick={definirMesAtual}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Mês Atual
          </button>
          <button
            onClick={() => definirUltimosMeses(3)}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Últimos 3 Meses
          </button>
          <button
            onClick={() => definirUltimosMeses(6)}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Últimos 6 Meses
          </button>
          <button
            onClick={() => definirUltimosMeses(12)}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Últimos 12 Meses
          </button>
          <button
            onClick={() => {
              const hoje = new Date();
              const anoAtual = hoje.getFullYear();
              const fimMesAnterior = new Date(anoAtual, hoje.getMonth(), 0);
              // Em janeiro nao ha mes anterior dentro do ano atual; mostra o mes corrente
              const dataFimAnoAtual =
                fimMesAnterior.getFullYear() === anoAtual ? fimMesAnterior : new Date(anoAtual, hoje.getMonth() + 1, 0);
              setDataInicio(`${anoAtual}-01-01`);
              setDataFim(
                `${dataFimAnoAtual.getFullYear()}-${String(dataFimAnoAtual.getMonth() + 1).padStart(2, '0')}-${String(dataFimAnoAtual.getDate()).padStart(2, '0')}`
              );
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

      {!loading && !consultaExecutada && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8">
          <div className="text-center text-gray-600">
            <Calendar className="w-8 h-8 mx-auto mb-3 text-green-600" />
            <p className="font-semibold text-gray-800">Selecione os filtros e clique em Consultar.</p>
            <p className="text-sm text-gray-500 mt-1">A DRE nao sera carregada automaticamente ao abrir ou alterar filtros.</p>
          </div>
        </div>
      )}

      {/* Visao Analitica - Tabela DRE */}
      {tipoVisao === 'analitica' && consultaExecutada && (
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
                  Periodo: {formatarData(dataInicio)} a {formatarData(dataFim)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-medium text-gray-600 cursor-pointer select-none">
                  {carregandoAnoAnterior && <RefreshCw className="w-3 h-3 animate-spin text-gray-400" />}
                  Comparar com ano anterior
                  <button
                    role="switch"
                    aria-checked={compararAnoAnterior}
                    onClick={() => {
                      const novoValor = !compararAnoAnterior;
                      setCompararAnoAnterior(novoValor);
                      if (novoValor && periodos.length > 0) buscarDadosAnoAnterior();
                    }}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      compararAnoAnterior ? 'bg-blue-600' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        compararAnoAnterior ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </label>
                <div className={`px-4 py-2 rounded-lg text-sm font-semibold ${
                  isLoja ? 'bg-purple-200 text-purple-800'
                  : isFabrica ? 'bg-blue-200 text-blue-800'
                  : 'bg-green-200 text-green-800'
                }`}>
                  {periodos.length > 0
                    ? (() => {
                        const anoInicio = periodos[0].key.split('-')[0];
                        const anoFim = periodos[periodos.length - 1].key.split('-')[0];
                        return anoInicio === anoFim ? anoInicio : `${anoInicio}-${anoFim}`;
                      })()
                    : new Date().getFullYear()}
                </div>
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
                  {gruposPorAno.length > 0 ? (
                    gruposPorAno.map((grupo) => (
                      <th
                        key={grupo.ano}
                        colSpan={grupo.qtd * (compararAnoAnterior ? 4 : 2)}
                        className="px-3 py-2 text-center text-sm font-bold text-white border-b border-blue-500 border-r border-blue-400 last:border-r-0"
                      >
                        EXERCÍCIO {grupo.ano}
                        {compararAnoAnterior ? ` vs ${parseInt(grupo.ano, 10) - 1}` : ''}
                      </th>
                    ))
                  ) : (
                    <th className="px-3 py-2 text-center text-sm font-bold text-white border-b border-blue-500">
                      EXERCÍCIO
                    </th>
                  )}
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
                    const anoCurto = ano.slice(2);
                    const anoAnteriorCurto = (parseInt(ano, 10) - 1).toString().slice(2);
                    return (
                      <React.Fragment key={periodo.key}>
                        {compararAnoAnterior && (
                          <th
                            colSpan={2}
                            className="px-2 py-2 text-center text-xs font-bold text-gray-500 border-b border-gray-300 bg-gray-200"
                          >
                            {nomeMes}/{anoAnteriorCurto}
                          </th>
                        )}
                        <th
                          colSpan={2}
                          className="px-2 py-2 text-center text-xs font-bold text-gray-700 border-b border-gray-300 bg-gray-50"
                        >
                          {compararAnoAnterior ? `${nomeMes}/${anoCurto}` : nomeMes}
                        </th>
                      </React.Fragment>
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
                      {compararAnoAnterior && (
                        <>
                          <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-200">R$</th>
                          <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-200">%</th>
                        </>
                      )}
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200">R$</th>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-100">%</th>
                    </React.Fragment>
                  ))}
                  <th className="px-3 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-blue-50">R$</th>
                  <th className="px-3 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-green-50"></th>
                </tr>
              </thead>
              <tbody>
                {dadosAnaliticaExibicao.map((conta) => renderizarLinhaConta(conta))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Visao Sintetica */}
      {tipoVisao === 'sintetica' && (loading || consultaExecutada) && (
        <>
        {loading && (
          <div className="bg-white rounded-lg shadow-lg border border-green-100 p-8">
            <div className="flex flex-col items-center justify-center gap-3 text-gray-600">
              <RefreshCw className="w-8 h-8 animate-spin text-green-600" />
              <div className="text-center">
                <p className="font-semibold text-gray-800">Carregando visao sintetica...</p>
                <p className="text-sm text-gray-500">Buscando periodo selecionado e comparativo do ano anterior.</p>
              </div>
            </div>
          </div>
        )}
        {!loading && consultaExecutada && (
        <>
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-green-50">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-800">
                  Visao Sintetica - Comparativo por Centro de Custo
                </h2>
                <p className="text-sm text-gray-600">
                  Periodo: {formatarData(dataInicio)} a {formatarData(dataFim)}
                </p>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">Contas:</label>
                  <input
                    type="range"
                    min="250"
                    max="500"
                    value={larguraColunaContas}
                    onChange={(e) => setLarguraColunaContas(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaContas}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">Valor:</label>
                  <input
                    type="range"
                    min="60"
                    max="150"
                    value={larguraColunaValor}
                    onChange={(e) => setLarguraColunaValor(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaValor}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">A/V%:</label>
                  <input
                    type="range"
                    min="40"
                    max="100"
                    value={larguraColunaAV}
                    onChange={(e) => setLarguraColunaAV(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaAV}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="border-collapse text-sm" style={{ minWidth: `${larguraTabelaSintetica}px` }}>
              <colgroup>
                <col style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }} />
                {colunasSinteticas.map((tipo, index) => (
                  <col
                    key={`${tipo.key}-${index}`}
                    style={{
                      width: `${tipo.tipo === 'av' ? larguraColunaAV : larguraColunaValor}px`,
                      minWidth: `${tipo.tipo === 'av' ? larguraColunaAV : larguraColunaValor}px`,
                    }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr className="bg-gray-100">
                  <th className="px-4 py-3 text-left font-semibold border-b sticky left-0 bg-gray-100 z-10" style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }}>LOJA</th>
                  {colunasSinteticas.map((coluna, index) => (
                    <th
                      key={`${coluna.key}-${index}`}
                      className={`px-3 py-3 text-right font-semibold border-b ${coluna.tipo === 'av' ? 'text-gray-500' : ''}`}
                    >
                      {coluna.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrarLinhasVisiveisSintetica(dadosSinteticos).map((item) => (
                  <tr key={item.codigo} className="hover:bg-gray-50 border-b">
                    <td className="px-4 py-2 sticky left-0 bg-white" style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }}>
                      <span className="font-medium whitespace-nowrap">{normalizarNomeLojaSintetica(item.nome)}</span>
                    </td>
                    {colunasSinteticas.map((coluna, index) => {
                      const valor = calcularColunaSintetica(item, coluna);
                      const negativo = coluna.tipo === 'valor' && valor !== null && (('negativo' in coluna && coluna.negativo) || valor < 0);
                      const percentualLucro = coluna.tipo === 'av' && isPercentualLucroLiquidoSintetico(coluna);
                      return (
                        <td
                          key={`${item.codigo}-${coluna.key}-${index}`}
                          className={`px-3 py-2 text-right ${percentualLucro && valor !== null ? valor >= 0 ? 'text-green-600' : 'text-red-600' : coluna.tipo === 'av' ? 'text-gray-500' : negativo ? 'text-red-600' : valor && valor > 0 ? 'text-gray-800' : 'text-gray-400'}`}
                        >
                          {formatarColunaSintetica(item, coluna)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="bg-gray-100 font-bold">
                  <td className="px-4 py-3 sticky left-0 bg-gray-100" style={{ width: `${larguraColunaContas}px`, minWidth: `${larguraColunaContas}px` }}>TOTAL CONSOLIDADO</td>
                  {colunasSinteticas.map((coluna, index) => {
                    const valor = calcularColunaSintetica(totaisSinteticos, coluna);
                    const negativo = coluna.tipo === 'valor' && valor !== null && (('negativo' in coluna && coluna.negativo) || valor < 0);
                    const percentualLucro = coluna.tipo === 'av' && isPercentualLucroLiquidoSintetico(coluna);
                    return (
                      <td
                        key={`total-${coluna.key}-${index}`}
                        className={`px-3 py-3 text-right ${percentualLucro && valor !== null ? valor >= 0 ? 'text-green-600' : 'text-red-600' : coluna.tipo === 'av' ? 'text-gray-600' : negativo ? 'text-red-600' : valor && valor > 0 ? 'text-gray-800' : 'text-gray-400'}`}
                      >
                        {formatarColunaSintetica(totaisSinteticos, coluna)}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-emerald-50">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-800">
                  Visao Sintetica - Comparativo por Centro de Custo
                </h2>
                <p className="text-sm text-gray-600">
                  Periodo: {formatarData(`${Number(dataInicio.split('-')[0]) - 1}-${dataInicio.split('-')[1]}-${dataInicio.split('-')[2]}`)} a {formatarData(`${Number(dataFim.split('-')[0]) - 1}-${dataFim.split('-')[1]}-${dataFim.split('-')[2]}`)}
                </p>
              </div>
              <div className="px-3 py-1.5 rounded-md bg-emerald-100 text-emerald-800 text-sm font-semibold">
                {filtroLabel}
              </div>
            </div>
          </div>
          {renderTabelaSintetica(dadosSinteticosAno, totaisSinteticosAno, 'ano')}
        </div>
        </>
        )}
        </>
      )}

      {/* Visao Por Empresa */}
      {tipoVisao === 'por-empresa' && consultaExecutada && dadosPorEmpresa && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-purple-50">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-800">
                  DRE Por Empresa - Comparativo
                </h2>
                <p className="text-sm text-gray-600">
                  Periodo: {formatarData(dataInicio)} a {formatarData(dataFim)}
                  {' | '}{dadosPorEmpresa.empresas.length} empresas
                </p>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">Contas:</label>
                  <input
                    type="range"
                    min="250"
                    max="500"
                    value={larguraColunaContas}
                    onChange={(e) => setLarguraColunaContas(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaContas}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">Valor:</label>
                  <input
                    type="range"
                    min="60"
                    max="150"
                    value={larguraColunaValor}
                    onChange={(e) => setLarguraColunaValor(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaValor}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">A/V%:</label>
                  <input
                    type="range"
                    min="40"
                    max="100"
                    value={larguraColunaAV}
                    onChange={(e) => setLarguraColunaAV(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaAV}</span>
                </div>
                <div className="flex items-center gap-1 border-l border-purple-200 pl-4">
                  <span className="text-xs text-gray-600 mr-1">Niveis:</span>
                  <button
                    onClick={recolherTodos}
                    className="px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 rounded transition-colors"
                    title="Recolher todos"
                  >
                    0
                  </button>
                  <button
                    onClick={expandirNivel1}
                    className="px-2 py-1 text-xs bg-purple-200 hover:bg-purple-300 text-purple-700 rounded transition-colors"
                    title="Expandir nivel 1"
                  >
                    1
                  </button>
                  <button
                    onClick={expandirNivel2}
                    className="px-2 py-1 text-xs bg-purple-300 hover:bg-purple-400 text-purple-800 rounded transition-colors"
                    title="Expandir nivel 2"
                  >
                    2
                  </button>
                  <button
                    onClick={expandirTodos}
                    className="px-2 py-1 text-xs bg-purple-500 hover:bg-purple-600 text-white rounded transition-colors"
                    title="Expandir todos"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-gradient-to-r from-purple-600 to-purple-700">
                  <th rowSpan={2} className="px-4 py-2 text-left font-bold text-white border-b border-purple-500 sticky left-0 bg-purple-600 z-20" style={{ minWidth: `${larguraColunaContas}px`, width: `${larguraColunaContas}px` }}>
                    CONTA
                  </th>
                  {dadosPorEmpresa.empresas.map((emp) => {
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
                        colSpan={2}
                        className="px-2 py-2 text-center font-bold text-white border-b border-purple-500 text-xs cursor-help"
                        style={{ minWidth: `${larguraColunaValor + larguraColunaAV}px` }}
                        title={emp.nome}
                      >
                        {sigla}
                      </th>
                    );
                  })}
                  <th colSpan={2} className="px-2 py-2 text-center font-bold text-white border-b border-purple-500 bg-purple-800 text-xs" style={{ minWidth: `${larguraColunaValor + larguraColunaAV}px` }}>
                    TOTAL
                  </th>
                </tr>
                <tr className="bg-purple-500">
                  {dadosPorEmpresa.empresas.map((emp) => (
                    <React.Fragment key={`hdr-${emp.cd_empresa}`}>
                      <th className="px-2 py-1 text-right text-xs font-medium text-purple-100 border-b border-purple-400" style={{ minWidth: `${larguraColunaValor}px`, width: `${larguraColunaValor}px` }}>
                        Valor
                      </th>
                      <th className="px-2 py-1 text-right text-xs font-medium text-purple-200 border-b border-purple-400 bg-purple-600/50" style={{ minWidth: `${larguraColunaAV}px`, width: `${larguraColunaAV}px` }}>
                        A/V%
                      </th>
                    </React.Fragment>
                  ))}
                  <th className="px-2 py-1 text-right text-xs font-medium text-purple-100 border-b border-purple-400 bg-purple-800" style={{ minWidth: `${larguraColunaValor}px`, width: `${larguraColunaValor}px` }}>
                    Valor
                  </th>
                  <th className="px-2 py-1 text-right text-xs font-medium text-purple-200 border-b border-purple-400 bg-purple-900" style={{ minWidth: `${larguraColunaAV}px`, width: `${larguraColunaAV}px` }}>
                    A/V%
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

                  // Funcao para calcular A/V% (em relacao a Receita Liquida = conta 03)
                  const calcularAVEmpresa = (codigo: string, cdEmpresa: number, isCalculada: boolean): number => {
                    const valor = isCalculada
                      ? calcularValorEmpresaLocal(codigo, cdEmpresa)
                      : getValorEmpresa(codigo, cdEmpresa);
                    const receitaLiquida = calcularValorEmpresaLocal('03', cdEmpresa);
                    if (receitaLiquida === 0) return 0;
                    return (valor / receitaLiquida) * 100;
                  };

                  const calcularAVTotal = (codigo: string, isCalculada: boolean): number => {
                    const valor = isCalculada
                      ? calcularValorTotalLocal(codigo)
                      : getValorTotal(codigo);
                    const receitaLiquida = calcularValorTotalLocal('03');
                    if (receitaLiquida === 0) return 0;
                    return (valor / receitaLiquida) * 100;
                  };

                  const formatarAV = (pct: number): string => {
                    if (pct === 0) return '-';
                    return `${pct.toFixed(1)}%`;
                  };

                  // Contas calculadas (resultados)
                  const contasCalculadas = ['03', '05', '07', '09', '11', '14', '16', '19'];

                  // Funcao para calcular valor de conta calculada
                  const calcularValorEmpresaLocal = (codigo: string, cdEmpresa: number): number => {
                    const v = (c: string) => getValorEmpresa(c, cdEmpresa);
                    switch (codigo) {
                      case '03': return v('01') + v('02'); // Receita Liquida
                      case '05': return v('01') + v('02') + v('04'); // Margem Contribuicao
                      case '07': return v('01') + v('02') + v('04') + v('06'); // Lucro Op Bruto
                      case '09': return v('01') + v('02') + v('04') + v('06') + v('08'); // EBITDA
                      case '11': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10'); // Lucro Bruto
                      case '14': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10') + v('13'); // Lucro Liquido
                      case '16': { // PE Economico = Receita para Lucro Liquido = 0
                        const receitaBruta = v('01');
                        if (receitaBruta === 0) return 0;
                        // Custos variáveis (proporcionais à receita)
                        const cmv = Math.abs(v('04'));
                        const deducoes = Math.abs(v('02'));
                        const cmvPct = (cmv + deducoes) / Math.abs(receitaBruta);
                        const margemPct = 1 - cmvPct;
                        if (margemPct <= 0) return 0;
                        // Custos fixos totais
                        const custosFixos = Math.abs(v('06')) + Math.abs(v('08')) + Math.abs(v('10')) + Math.abs(v('13'));
                        return custosFixos / margemPct;
                      }
                      case '19': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10') + v('13') + v('17') + v('18'); // LL - Inv
                      default: return 0;
                    }
                  };

                  const calcularValorTotalLocal = (codigo: string): number => {
                    const v = (c: string) => getValorTotal(c);
                    switch (codigo) {
                      case '03': return v('01') + v('02');
                      case '05': return v('01') + v('02') + v('04');
                      case '07': return v('01') + v('02') + v('04') + v('06');
                      case '09': return v('01') + v('02') + v('04') + v('06') + v('08');
                      case '11': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10');
                      case '14': return v('01') + v('02') + v('04') + v('06') + v('08') + v('10') + v('13');
                      case '16': { // PE Economico = Receita para Lucro Liquido = 0
                        const receitaBruta = v('01');
                        if (receitaBruta === 0) return 0;
                        const cmv = Math.abs(v('04'));
                        const deducoes = Math.abs(v('02'));
                        const cmvPct = (cmv + deducoes) / Math.abs(receitaBruta);
                        const margemPct = 1 - cmvPct;
                        if (margemPct <= 0) return 0;
                        const custosFixos = Math.abs(v('06')) + Math.abs(v('08')) + Math.abs(v('10')) + Math.abs(v('13'));
                        return custosFixos / margemPct;
                      }
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
                          style={{ paddingLeft: `${paddingLeft}px`, minWidth: `${larguraColunaContas}px`, width: `${larguraColunaContas}px` }}
                        >
                          <div className="flex items-center gap-1 whitespace-nowrap">
                            {temFilhos && (
                              <button
                                onClick={() => toggleExpansao(conta.codigo)}
                                className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-gray-700"
                              >
                                {expandida ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              </button>
                            )}
                            {!temFilhos && <span className="w-4" />}
                            <span className="text-sm">{conta.codigo} {nomesCustomizados[conta.codigo] ?? conta.nome}</span>
                          </div>
                        </td>
                        {dadosPorEmpresa.empresas.map((emp) => {
                          const valor = isCalculada
                            ? calcularValorEmpresaLocal(conta.codigo, emp.cd_empresa)
                            : getValorEmpresa(conta.codigo, emp.cd_empresa);
                          const avPct = calcularAVEmpresa(conta.codigo, emp.cd_empresa, isCalculada);
                          const podeClicar = !temFilhos && !isCalculada && valor !== 0 && isDespesa;
                          return (
                            <React.Fragment key={emp.cd_empresa}>
                              <td
                                className={`px-2 py-2 text-right border-b border-gray-200 text-sm ${
                                  valor < 0 ? 'text-red-600' : ''
                                } ${fontClass}`}
                                style={{ minWidth: `${larguraColunaValor}px`, width: `${larguraColunaValor}px` }}
                              >
                                {podeClicar ? (
                                  <button
                                    onClick={() => abrirDuplicatasPorEmpresa(conta.codigo, nomesCustomizados[conta.codigo] ?? conta.nome, emp.cd_empresa, emp.nome)}
                                    className="hover:underline hover:text-blue-600 cursor-pointer"
                                    title={`Clique para ver duplicatas - ${emp.nome}`}
                                  >
                                    {formatarValor(valor)}
                                  </button>
                                ) : (
                                  valor !== 0 ? formatarValor(valor) : '-'
                                )}
                              </td>
                              <td className={`px-2 py-2 text-right border-b border-gray-200 text-sm bg-gray-50/50 ${fontClass} ${
                                valor < 0 ? 'text-red-600' : 'text-gray-600'
                              }`} style={{ minWidth: `${larguraColunaAV}px`, width: `${larguraColunaAV}px` }}>
                                {formatarAV(avPct)}
                              </td>
                            </React.Fragment>
                          );
                        })}
                        <td className={`px-2 py-2 text-right border-b border-gray-200 text-sm bg-purple-100/50 ${fontClass} ${
                          (isCalculada ? calcularValorTotalLocal(conta.codigo) : getValorTotal(conta.codigo)) < 0 ? 'text-red-600' : ''
                        }`} style={{ minWidth: `${larguraColunaValor}px`, width: `${larguraColunaValor}px` }}>
                          {(() => {
                            const valorTotal = isCalculada ? calcularValorTotalLocal(conta.codigo) : getValorTotal(conta.codigo);
                            const podeClicarTotal = !temFilhos && !isCalculada && valorTotal !== 0 && isDespesa;
                            return podeClicarTotal ? (
                              <button
                                onClick={() => abrirDuplicatasPorEmpresa(conta.codigo, nomesCustomizados[conta.codigo] ?? conta.nome, 0, 'TOTAL')}
                                className="hover:underline hover:text-blue-600 cursor-pointer"
                                title="Clique para ver duplicatas - TOTAL"
                              >
                                {formatarValor(valorTotal)}
                              </button>
                            ) : (
                              formatarValor(valorTotal)
                            );
                          })()}
                        </td>
                        <td className={`px-2 py-2 text-right border-b border-gray-200 text-sm bg-purple-200/50 ${fontClass} ${
                          (isCalculada ? calcularValorTotalLocal(conta.codigo) : getValorTotal(conta.codigo)) < 0 ? 'text-red-600' : 'text-gray-600'
                        }`} style={{ minWidth: `${larguraColunaAV}px`, width: `${larguraColunaAV}px` }}>
                          {formatarAV(calcularAVTotal(conta.codigo, isCalculada))}
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

      {/* Visao Por Centro de Custo */}
      {tipoVisao === 'por-ccusto' && consultaExecutada && dadosPorCCusto && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-orange-50">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-800">
                  DRE Fabrica Por Centro de Custo
                </h2>
                <p className="text-sm text-gray-600">
                  Periodo: {formatarData(dataInicio)} a {formatarData(dataFim)}
                  {' | '}{dadosPorCCusto.centros_custo.length} centros de custo
                </p>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">Contas:</label>
                  <input
                    type="range"
                    min="250"
                    max="500"
                    value={larguraColunaContas}
                    onChange={(e) => setLarguraColunaContas(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaContas}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600">Valor:</label>
                  <input
                    type="range"
                    min="60"
                    max="150"
                    value={larguraColunaValor}
                    onChange={(e) => setLarguraColunaValor(Number(e.target.value))}
                    className="w-20 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 w-8">{larguraColunaValor}</span>
                </div>
                <div className="flex items-center gap-1 border-l border-orange-200 pl-4">
                  <span className="text-xs text-gray-600 mr-1">Niveis:</span>
                  <button
                    onClick={recolherTodos}
                    className="px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 rounded transition-colors"
                    title="Recolher todos"
                  >
                    0
                  </button>
                  <button
                    onClick={expandirNivel1}
                    className="px-2 py-1 text-xs bg-orange-200 hover:bg-orange-300 text-orange-700 rounded transition-colors"
                    title="Expandir nivel 1"
                  >
                    1
                  </button>
                  <button
                    onClick={expandirNivel2}
                    className="px-2 py-1 text-xs bg-orange-300 hover:bg-orange-400 text-orange-800 rounded transition-colors"
                    title="Expandir nivel 2"
                  >
                    2
                  </button>
                  <button
                    onClick={expandirTodos}
                    className="px-2 py-1 text-xs bg-orange-500 hover:bg-orange-600 text-white rounded transition-colors"
                    title="Expandir todos"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-gradient-to-r from-orange-600 to-orange-700">
                  <th className="px-4 py-2 text-left font-bold text-white border-b border-orange-500 sticky left-0 bg-orange-600 z-20" style={{ minWidth: `${larguraColunaContas}px`, width: `${larguraColunaContas}px` }}>
                    CONTA
                  </th>
                  {dadosPorCCusto.centros_custo.map((cc) => (
                    <th
                      key={cc.cd_ccusto}
                      className="px-2 py-2 text-center font-bold text-white border-b border-orange-500 text-xs cursor-help"
                      style={{ minWidth: `${larguraColunaValor}px` }}
                      title={cc.nome}
                    >
                      {cc.nome.length > 12 ? cc.nome.substring(0, 12) + '...' : cc.nome}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-center font-bold text-white border-b border-orange-500 bg-orange-800 text-xs" style={{ minWidth: `${larguraColunaValor}px` }}>
                    TOTAL
                  </th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Funções auxiliares para buscar valores por centro de custo
                  const getValorCCusto = (codigo: string, cdCCusto: number): number => {
                    const valoresConta = dadosPorCCusto?.valores[codigo];
                    if (!valoresConta) return 0;
                    return valoresConta[String(cdCCusto)] || 0;
                  };

                  const getValorTotalCC = (codigo: string): number => {
                    const valoresConta = dadosPorCCusto?.valores[codigo];
                    if (!valoresConta) return 0;
                    return valoresConta['total'] || 0;
                  };

                  // Lista de contas calculadas
                  const contasCalculadas = ['03', '05', '07', '09', '11', '12', '14', '15', '16', '19'];

                  // Filtrar contas baseado em mostrarExtras
                  const dadosDREFiltrados = mostrarExtras
                    ? dadosDRE
                    : dadosDRE.filter((conta) => !['15', '16', '17', '18', '19'].includes(conta.codigo));

                  const renderizarLinhaCCusto = (conta: ContaDREValores, nivel = 0): React.ReactNode[] => {
                    const linhas: React.ReactNode[] = [];
                    const expandida = contasExpandidas.has(conta.codigo);
                    const temFilhos = conta.filhos && conta.filhos.length > 0;
                    const isCalculada = contasCalculadas.includes(conta.codigo);

                    const bgClass = nivel === 0
                      ? (isCalculada ? 'bg-orange-100 font-semibold' : 'bg-orange-50')
                      : nivel === 1 ? 'bg-gray-50' : '';
                    const fontClass = isCalculada ? 'font-medium' : '';
                    const paddingLeft = 16 + nivel * 16;

                    linhas.push(
                      <tr key={conta.codigo} className={`${bgClass} hover:bg-orange-50 transition-colors`}>
                        <td
                          className="px-4 py-2 border-b border-gray-200 sticky left-0 z-10 bg-inherit"
                          style={{ paddingLeft: `${paddingLeft}px`, minWidth: `${larguraColunaContas}px`, width: `${larguraColunaContas}px` }}
                        >
                          <div className="flex items-center gap-1 whitespace-nowrap">
                            {temFilhos && (
                              <button
                                onClick={() => toggleExpansao(conta.codigo)}
                                className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-gray-700"
                              >
                                {expandida ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              </button>
                            )}
                            {!temFilhos && <span className="w-4" />}
                            <span className="text-sm">{conta.codigo} {nomesCustomizados[conta.codigo] ?? conta.nome}</span>
                          </div>
                        </td>
                        {dadosPorCCusto.centros_custo.map((cc) => {
                          const valor = getValorCCusto(conta.codigo, cc.cd_ccusto);
                          return (
                            <td
                              key={cc.cd_ccusto}
                              className={`px-2 py-2 text-right border-b border-gray-200 text-sm ${
                                valor < 0 ? 'text-red-600' : ''
                              } ${fontClass}`}
                              style={{ minWidth: `${larguraColunaValor}px`, width: `${larguraColunaValor}px` }}
                            >
                              {valor !== 0 ? formatarValor(valor) : '-'}
                            </td>
                          );
                        })}
                        <td className={`px-2 py-2 text-right border-b border-gray-200 text-sm bg-orange-100/50 ${fontClass} ${
                          getValorTotalCC(conta.codigo) < 0 ? 'text-red-600' : ''
                        }`} style={{ minWidth: `${larguraColunaValor}px`, width: `${larguraColunaValor}px` }}>
                          {formatarValor(getValorTotalCC(conta.codigo))}
                        </td>
                      </tr>
                    );

                    if (temFilhos && expandida) {
                      for (const filho of conta.filhos || []) {
                        linhas.push(...renderizarLinhaCCusto(filho, nivel + 1));
                      }
                    }

                    return linhas;
                  };

                  return dadosDREFiltrados.map((conta) => renderizarLinhaCCusto(conta));
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
          <div className="bg-white rounded-lg shadow-xl w-[95vw] max-w-6xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50 rounded-t-lg">
              <div>
                <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  Duplicatas - {modalDuplicatas.conta} {modalDuplicatas.nomeConta}
                </h3>
                <p className="text-sm text-gray-600">
                  Periodo: {modalDuplicatas.labelPeriodo} | Total: <span className="font-semibold text-red-600">{formatarValor(modalDuplicatas.total)}</span>
                </p>
              </div>
              <button
                onClick={fecharModal}
                className="p-2 hover:bg-gray-200 rounded-full transition-colors"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-hidden flex flex-col">
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
                <div className="flex-1 overflow-auto">
                  <table className="w-full table-fixed border-collapse text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-gray-100">
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-24">Nr Duplicata</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-24">Data Emissao</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-32">Centro de Custo</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-20">Cód. Fornecedor</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-1/5">Fornecedor</th>
                        <th
                          className="px-2 py-3 text-center border-b-2 border-gray-300 font-semibold text-gray-700 w-10"
                          title="Compara a despesa lançada com o padrão histórico do fornecedor"
                        >
                          Aud.
                        </th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-1/5">Descricao</th>
                        <th className="px-4 py-3 text-right border-b-2 border-gray-300 font-semibold text-gray-700 w-24">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalDuplicatas.duplicatas.map((dup, idx) => (
                        <tr key={idx} className="hover:bg-blue-50 border-b border-gray-100 transition-colors">
                          <td className="px-4 py-2.5 text-gray-600 font-mono text-xs">{dup.nrDuplicata || dup.id || '-'}</td>
                          <td className="px-4 py-2.5 text-gray-600">{formatarData(dup.dtEmissao)}</td>
                          <td className="px-4 py-2.5">
                            <span className="block truncate text-gray-700" title={dup.nomeCCusto}>
                              {dup.nomeCCusto || '-'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-gray-600 font-mono text-xs">
                            {dup.cdFornecedor ?? '-'}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="block truncate text-gray-700" title={dup.nmFornecedor}>
                              {dup.nmFornecedor || 'N/A'}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 text-center">
                            {dup.cdFornecedor && (() => {
                              const chave = `${dup.cdFornecedor}_${dup.cdDespesaItem}`;
                              const resultado = auditoriaCache[chave];
                              const alertaConhecido = resultado && resultado !== 'loading' && resultado !== 'erro' && resultado.alerta;
                              return (
                                <button
                                  onClick={() => verificarAuditoria(dup)}
                                  className={alertaConhecido ? 'text-red-600 hover:text-red-700 transition-colors' : 'text-gray-400 hover:text-blue-600 transition-colors'}
                                  title="Verificar padrão de classificação deste fornecedor"
                                >
                                  <SearchCheck className="w-4 h-4" />
                                </button>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="block truncate text-gray-600" title={dup.descricao}>
                              {dup.descricao || '-'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-medium text-red-600 whitespace-nowrap">
                            {formatarValor(dup.valor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Footer fixo com total */}
            {!modalDuplicatas.loading && modalDuplicatas.duplicatas.length > 0 && (
              <div className="border-t-2 border-gray-300 bg-gray-100 px-4 py-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-semibold text-gray-700">
                    TOTAL ({modalDuplicatas.duplicatas.length} {modalDuplicatas.duplicatas.length === 1 ? 'registro' : 'registros'})
                  </span>
                  <span className="text-base font-bold text-red-600">
                    {formatarValor(modalDuplicatas.duplicatas.reduce((acc, dup) => acc + (dup.valor || 0), 0))}
                  </span>
                </div>
              </div>
            )}

            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                onClick={fecharModal}
                className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors font-medium"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {auditoriaModal.aberto && auditoriaModal.dup && (() => {
        const dup = auditoriaModal.dup;
        const chave = `${dup.cdFornecedor}_${dup.cdDespesaItem}`;
        const resultado = auditoriaCache[chave];
        return (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-[60] flex items-center justify-center p-4"
            onClick={() => setAuditoriaModal({ aberto: false, dup: null })}
          >
            <div
              className="bg-white rounded-lg shadow-2xl w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                <div className="flex items-center gap-2">
                  <SearchCheck className="w-5 h-5 text-blue-600" />
                  <h3 className="text-base font-bold text-gray-800">Auditoria de Classificação</h3>
                </div>
                <button
                  onClick={() => setAuditoriaModal({ aberto: false, dup: null })}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="px-6 py-5">
                <div className="mb-4 text-sm text-gray-600">
                  <div className="font-semibold text-gray-800">{dup.nmFornecedor || 'N/A'}</div>
                  <div>
                    Duplicata {dup.nrDuplicata || dup.id} · lançada em{' '}
                    <span className="font-medium">{dup.descricao}</span>
                  </div>
                </div>

                {!resultado || resultado === 'loading' ? (
                  <div className="flex items-center gap-2 text-gray-500 py-6 justify-center">
                    <RefreshCw className="w-5 h-5 animate-spin" /> Verificando histórico do fornecedor...
                  </div>
                ) : resultado === 'erro' ? (
                  <div className="text-red-600 py-4">Erro ao verificar auditoria. Tente novamente.</div>
                ) : resultado.amostraInsuficiente ? (
                  <div className="text-gray-600 bg-gray-50 rounded-lg p-4 text-sm">
                    Histórico insuficiente ({resultado.totalDuplicatas}{' '}
                    {resultado.totalDuplicatas === 1 ? 'duplicata' : 'duplicatas'}) para avaliar o padrão deste
                    fornecedor. É preciso um mínimo de histórico pra essa comparação fazer sentido.
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-sm text-gray-600">
                      <span className="font-semibold text-gray-800">{resultado.totalDuplicatas}</span> duplicatas no
                      histórico deste fornecedor
                    </div>

                    <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
                      {resultado.distribuicao.map((item) => (
                        <div
                          key={item.cdDespesaItem}
                          className={`flex items-center justify-between px-3 py-2 text-sm ${
                            item.cdDespesaItem === dup.cdDespesaItem ? 'bg-blue-50' : ''
                          }`}
                        >
                          <span className="text-gray-700">
                            {item.descricao}
                            {item.cdDespesaItem === dup.cdDespesaItem && (
                              <span className="ml-2 text-xs text-blue-600 font-medium">(esta duplicata)</span>
                            )}
                          </span>
                          <span className="font-mono text-xs text-gray-500 whitespace-nowrap">
                            {item.quantidade}x · {item.percentual}%
                          </span>
                        </div>
                      ))}
                    </div>

                    {resultado.alerta ? (
                      <div className="space-y-2">
                        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                          <span className="font-semibold">⚠ Fora do padrão. </span>
                          Este fornecedor lança {resultado.dominante?.percentual}% das duplicatas em &quot;
                          {resultado.dominante?.descricao}&quot;, mas esta está em &quot;
                          {resultado.despesaAtual?.descricao || dup.descricao}&quot;. Vale conferir se a
                          classificação está correta.
                        </div>
                        <button
                          onClick={() => validarAuditoria(dup)}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors"
                        >
                          <Check className="w-4 h-4" />
                          Validar como correto
                        </button>
                      </div>
                    ) : resultado.validado ? (
                      <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-700">
                        <span className="font-semibold">✓ Validado manualmente. </span>
                        Confirmado como correto, mesmo fora do padrão estatístico do fornecedor. Não será mais
                        sinalizado.
                      </div>
                    ) : (
                      <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
                        <span className="font-semibold">✓ Dentro do padrão. </span>
                        Consistente com o histórico deste fornecedor.
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
                <button
                  onClick={() => setAuditoriaModal({ aberto: false, dup: null })}
                  className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors font-medium"
                >
                  Fechar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {modalSemAssociacao.aberto && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
          onClick={fecharModalSemAssociacao}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <div className="flex items-center gap-2">
                  <Unlink className="w-5 h-5 text-red-600" />
                  <h3 className="text-base font-bold text-gray-800">Despesas sem Associação</h3>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Período: {formatarData(dataInicio)} a {formatarData(dataFim)} · Filtro: {filtroInfo || filtro}
                </p>
              </div>
              <button onClick={fecharModalSemAssociacao} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              {modalSemAssociacao.loading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
                  <span className="ml-3 text-gray-600">Verificando despesas...</span>
                </div>
              ) : modalSemAssociacao.despesas.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <div className="text-green-600 font-medium mb-1">✓ Nenhuma despesa sem associação</div>
                  Todas as despesas lançadas neste período/filtro estão classificadas no plano de contas.
                </div>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-100">
                    <tr>
                      <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-20">Código</th>
                      <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700">Descrição</th>
                      <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-44">Centro de Custo</th>
                      <th className="px-4 py-3 text-right border-b-2 border-gray-300 font-semibold text-gray-700 w-20">Qtd</th>
                      <th className="px-4 py-3 text-right border-b-2 border-gray-300 font-semibold text-gray-700 w-32">Valor Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modalSemAssociacao.despesas.map((d, idx) => (
                      <tr key={`${d.cdDespesaItem}-${d.cdCcusto}-${idx}`} className="hover:bg-red-50 border-b border-gray-100">
                        <td className="px-4 py-2.5 text-gray-600 font-mono text-xs">{d.cdDespesaItem}</td>
                        <td className="px-4 py-2.5 text-gray-700">{d.descricao}</td>
                        <td className="px-4 py-2.5 text-gray-600">{d.nomeCcusto}</td>
                        <td className="px-4 py-2.5 text-right text-gray-600">{d.quantidade}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-red-600 whitespace-nowrap">
                          {formatarValor(d.valorTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {!modalSemAssociacao.loading && modalSemAssociacao.despesas.length > 0 && (
              <div className="border-t-2 border-gray-300 bg-gray-100 px-4 py-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-semibold text-gray-700">
                    TOTAL ({modalSemAssociacao.totalItens} {modalSemAssociacao.totalItens === 1 ? 'despesa' : 'despesas'})
                  </span>
                  <span className="text-base font-bold text-red-600">
                    {formatarValor(modalSemAssociacao.valorTotal)}
                  </span>
                </div>
              </div>
            )}

            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                onClick={fecharModalSemAssociacao}
                className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors font-medium"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {modalAnaliseExecutiva.aberto && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
          onClick={fecharModalAnaliseExecutiva}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-indigo-600" />
                  <h3 className="text-base font-bold text-gray-800">Análise Executiva</h3>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Período: {formatarData(dataInicio)} a {formatarData(dataFim)} · Filtro: {filtroInfo || filtro}
                </p>
              </div>
              <button onClick={fecharModalAnaliseExecutiva} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-6 py-4">
              {modalAnaliseExecutiva.loading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-8 h-8 animate-spin text-indigo-600" />
                  <span className="ml-3 text-gray-600">Gerando análise...</span>
                </div>
              ) : modalAnaliseExecutiva.erro ? (
                <div className="text-center py-12 text-red-600">{modalAnaliseExecutiva.erro}</div>
              ) : (
                <div className="prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-900">
                  <ReactMarkdown>{modalAnaliseExecutiva.texto}</ReactMarkdown>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                onClick={fecharModalAnaliseExecutiva}
                className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors font-medium"
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
