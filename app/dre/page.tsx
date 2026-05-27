'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Building2,
  Calendar,
  ChevronDown,
  ChevronRight,
  DollarSign,
  LayoutList,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

type VisaoDRE = 'vertical' | 'empresa' | 'sintetico';
import { PLANO_CONTAS_DRE } from '../configuracoes/plano-contas-dre/planoContasDRE';
import DetalhamentoDuplicatasDREModal from '../components/DetalhamentoDuplicatasDREModal';
import { generateCacheKey, useCache } from '../contexts/CacheContext';
import { formatarValor } from '../utils/formatters';
import { DRE_OFICIAL_MAR_2026, DRE_OFICIAL_MAR_2026_PERIODO } from './oficialMar2026';
import DREPorEmpresa from './components/DREPorEmpresa';
import DRESintetico, { type ContaDRE as ContaDREsintetico } from './components/DRESintetico';

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
}

interface PlanejadoValores {
  valores: Record<string, number>;
  total: number;
}

type ContaDREBase = {
  codigo: string;
  nome: string;
  nivel: number;
  tipo: 'grupo' | 'conta';
  filhos?: ContaDREBase[];
};

function clonarComValores(contas: ContaDREBase[]): ContaDREValores[] {
  return contas.map((conta) => ({
    codigo: conta.codigo,
    codigoExibicao: conta.codigo,
    nome: conta.nome,
    nivel: conta.nivel,
    tipo: conta.tipo,
    valores: {},
    total: 0,
    filhos: conta.filhos ? clonarComValores(conta.filhos) : undefined,
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
  return clonarComValores(PLANO_CONTAS_DRE as ContaDREBase[]);
}

const ESTRUTURA_DRE: ContaDREValores[] = montarEstruturaDRE();

const CORES_NIVEL: Record<number, string> = {
  1: 'bg-blue-50 font-bold',
  2: 'bg-gray-50',
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
  const depreciacao = contasMap.get('12');
  const despesasVendas = contasMap.get('08.10');
  const despesasOperacionais = contasMap.get('08');
  const receitasNaoOperacionais = contasMap.get('10.02');
  const receitasFinanceiras = contasMap.get('10.01');
  const despesasFinanceiras = contasMap.get('10.03');
  const despesasTributarias = contasMap.get('13');
  const investimentos = contasMap.get('17');
  const amortizacaoDividas = contasMap.get('18');

  const receitaLiquida = criarContaCalculada(
    '03',
    'RECEITA LIQUIDA',
    periodos,
    (periodo) => (receitaBruta?.valores[periodo] || 0) + (deducoes?.valores[periodo] || 0),
    () => (receitaBruta?.total || 0) + (deducoes?.total || 0)
  );

  const lucroBruto = criarContaCalculada(
    '07',
    'LUCRO BRUTO',
    periodos,
    (periodo) =>
      (receitaLiquida.valores[periodo] || 0) +
      (custosVariaveis?.valores[periodo] || 0) +
      (custosFixos?.valores[periodo] || 0) +
      (depreciacao?.valores[periodo] || 0),
    () =>
      receitaLiquida.total +
      (custosVariaveis?.total || 0) +
      (custosFixos?.total || 0) +
      (depreciacao?.total || 0)
  );

  const margemContribuicao = criarContaCalculada(
    '05',
    'MARGEM CONTRIBUICAO',
    periodos,
    (periodo) => (lucroBruto.valores[periodo] || 0) + (despesasVendas?.valores[periodo] || 0),
    () => lucroBruto.total + (despesasVendas?.total || 0)
  );

  const despesasOperacionaisSemVendas = clonarConta(despesasOperacionais);
  if (despesasOperacionaisSemVendas) {
    despesasOperacionaisSemVendas.filhos = despesasOperacionaisSemVendas.filhos?.filter((filho) => filho.codigo !== '08.10');
    despesasOperacionaisSemVendas.valores = {};
    for (const periodo of periodos) {
      despesasOperacionaisSemVendas.valores[periodo.key] =
        despesasOperacionaisSemVendas.filhos?.reduce((sum, filho) => sum + (filho.valores[periodo.key] || 0), 0) || 0;
    }
    despesasOperacionaisSemVendas.total =
      despesasOperacionaisSemVendas.filhos?.reduce((sum, filho) => sum + filho.total, 0) || 0;
  }

  const ebitda = criarContaCalculada(
    '09',
    'LUCRO OPERACIONAL (EBITDA)',
    periodos,
    (periodo) => (margemContribuicao.valores[periodo] || 0) + (despesasOperacionaisSemVendas?.valores[periodo] || 0),
    () => margemContribuicao.total + (despesasOperacionaisSemVendas?.total || 0)
  );

  const resultadoNaoOperacional = criarContaCalculada(
    '10A',
    'RESULTADO NAO OPERACIONAL',
    periodos,
    (periodo) => receitasNaoOperacionais?.valores[periodo] || 0,
    () => receitasNaoOperacionais?.total || 0,
    '10'
  );

  const resultadoFinanceiro = criarContaCalculada(
    '10B',
    'RESULTADO FINANCEIRO',
    periodos,
    (periodo) => (receitasFinanceiras?.valores[periodo] || 0) + (despesasFinanceiras?.valores[periodo] || 0),
    () => (receitasFinanceiras?.total || 0) + (despesasFinanceiras?.total || 0),
    '10'
  );

  const lucroAntesIr = criarContaCalculada(
    '11',
    'LUCRO ANTES DO IR/CSLL',
    periodos,
    (periodo) =>
      (ebitda.valores[periodo] || 0) +
      (resultadoNaoOperacional.valores[periodo] || 0) +
      (resultadoFinanceiro.valores[periodo] || 0),
    () => ebitda.total + resultadoNaoOperacional.total + resultadoFinanceiro.total
  );

  const lucroLiquido = criarContaCalculada(
    '14',
    'LUCRO LIQUIDO',
    periodos,
    (periodo) => (lucroAntesIr.valores[periodo] || 0) + (despesasTributarias?.valores[periodo] || 0),
    () => lucroAntesIr.total + (despesasTributarias?.total || 0)
  );

  const pontoEquilibrioFinanceiro = criarResultado('15', 'PONTO DE EQUILIBRIO FINANCEIRO');
  const pontoEquilibrioEconomico = criarResultado('16', 'PONTO DE EQUILIBRIO ECONOMICO');

  const lucroLiquidoMenosInvestimentos = criarContaCalculada(
    '19',
    'LUCRO LIQUIDO (-) INVESTIMENTOS',
    periodos,
    (periodo) =>
      (lucroLiquido.valores[periodo] || 0) +
      (investimentos?.valores[periodo] || 0) +
      (amortizacaoDividas?.valores[periodo] || 0),
    () => lucroLiquido.total + (investimentos?.total || 0) + (amortizacaoDividas?.total || 0)
  );

  return [
    clonarConta(receitaBruta),
    clonarConta(deducoes),
    receitaLiquida,
    clonarConta(custosVariaveis),
    clonarConta(custosFixos),
    clonarConta(depreciacao),
    lucroBruto,
    clonarConta(despesasVendas),
    margemContribuicao,
    despesasOperacionaisSemVendas,
    ebitda,
    resultadoNaoOperacional,
    resultadoFinanceiro,
    lucroAntesIr,
    clonarConta(despesasTributarias),
    lucroLiquido,
    pontoEquilibrioFinanceiro,
    pontoEquilibrioEconomico,
    clonarConta(investimentos),
    clonarConta(amortizacaoDividas),
    lucroLiquidoMenosInvestimentos,
  ].filter(Boolean) as ContaDREValores[];
}



export default function DREPage() {
  const [visaoAtiva, setVisaoAtiva] = useState<VisaoDRE>('vertical');
  const [loading, setLoading] = useState(true);
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
  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(
    new Set(['01', '02', '04', '06', '08', '08.10', '10', '13', '17', '18'])
  );
  const [modalAberto, setModalAberto] = useState(false);
  const [modalConta, setModalConta] = useState('');
  const [modalPeriodo, setModalPeriodo] = useState('');
  const [modalValor, setModalValor] = useState(0);
  const [planejadoLiquida, setPlanejadoLiquida] = useState<PlanejadoValores>({ valores: {}, total: 0 });
  const [grupoPlanejado, setGrupoPlanejado] = useState('Todos');
  const [fromCache, setFromCache] = useState(false);
  const [mostrarLinhasExtras, setMostrarLinhasExtras] = useState(false);
  const [compararOficialMar, setCompararOficialMar] = useState(false);
  const [statusCarregamento, setStatusCarregamento] = useState<string | null>(null);
  const [empresaSelecionada, setEmpresaSelecionada] = useState<string>('');
  const [listaEmpresas, setListaEmpresas] = useState<{ cd_empresa: number; nome: string }[]>([]);

  const { getDRECache, setDRECache } = useCache();

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
    buscarDados(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function carregarEmpresas() {
      try {
        const response = await fetch('/api/dre/por-empresa?dataInicio=2026-01-01&dataFim=2026-12-31');
        const data = await response.json();
        if (data.empresas) {
          setListaEmpresas(data.empresas);
        }
      } catch (error) {
        console.error('Erro ao carregar lista de empresas:', error);
      }
    }
    carregarEmpresas();
  }, []);

  function toggleExpansao(codigo: string) {
    setContasExpandidas((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  function renderizarLinhaConta(conta: ContaDREValores, nivel = 0): React.ReactNode[] {
    const linhas: React.ReactNode[] = [];
    const temFilhos = !!conta.filhos?.length;
    const expandida = contasExpandidas.has(conta.codigo);
    const isResultado = conta.tipo === 'resultado';
    const resultadoSecundario = ['10A', '10B', '15', '16'].includes(conta.codigo);
    const corLinha = isResultado
      ? resultadoSecundario
        ? 'bg-amber-50 font-bold text-amber-800'
        : 'bg-green-50 font-bold text-green-800'
      : CORES_NIVEL[conta.nivel] || 'bg-white';
    const isDespesa =
      !isResultado &&
      ['04', '06', '08', '10', '12', '13', '17', '18'].some((prefixo) => conta.codigo.startsWith(prefixo));
    const valorAtualMar = conta.valores[DRE_OFICIAL_MAR_2026_PERIODO];
    const valorOficialMar =
      DRE_OFICIAL_MAR_2026[conta.codigo] ??
      DRE_OFICIAL_MAR_2026[conta.codigoExibicao || ''] ??
      DRE_OFICIAL_MAR_2026[
        conta.codigo === '10B' ? '10' : conta.codigo
      ];
    const diferencaMar =
      valorAtualMar !== undefined && valorOficialMar !== undefined ? valorAtualMar - valorOficialMar : undefined;

    const abrirDetalhe = (periodo: string, valor: number) => {
      if (!isDespesa) return;
      setModalConta(conta.codigo);
      setModalPeriodo(periodo);
      setModalValor(valor);
      setModalAberto(true);
    };

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
          </div>
        </td>
        {periodos.map((periodo) => {
          const valorPeriodo = conta.valores[periodo.key] || 0;
          const clickable = isDespesa && periodo.key;
          return (
            <td
              key={periodo.key}
              onClick={() => clickable && abrirDetalhe(periodo.key, valorPeriodo)}
              className={`px-3 py-2 border-b border-gray-200 text-right text-sm ${
                valorPeriodo < 0 ? 'text-red-600' : ''
              } ${clickable ? 'cursor-pointer hover:bg-gray-50' : ''}`}
            >
              {formatarValor(valorPeriodo)}
            </td>
          );
        })}
        <td
          className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold ${
            conta.total < 0 ? 'text-red-600' : ''
          }`}
        >
          {formatarValor(conta.total)}
        </td>
        {compararOficialMar && (
          <td
            className={`px-3 py-2 border-b border-gray-200 text-right text-sm ${
              valorOficialMar !== undefined && valorOficialMar < 0 ? 'text-red-600' : ''
            }`}
          >
            {valorOficialMar !== undefined ? formatarValor(valorOficialMar) : '-'}
          </td>
        )}
        {compararOficialMar && (
          <td
            className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-semibold ${
              diferencaMar === undefined ? '' : diferencaMar === 0 ? 'text-green-700' : diferencaMar < 0 ? 'text-red-600' : 'text-amber-700'
            }`}
          >
            {diferencaMar !== undefined ? formatarValor(diferencaMar) : '-'}
          </td>
        )}
      </tr>
    );

    if (temFilhos && expandida) {
      for (const filho of conta.filhos || []) {
        linhas.push(...renderizarLinhaConta(filho, nivel + 1));
      }
    }

    return linhas;
  }

  async function buscarDados(forceRefresh = false) {
    const cacheKey = generateCacheKey({ dataInicio, dataFim, grupoPlanejado, empresaSelecionada, layout: 'dre-v2' });

    if (!forceRefresh) {
      const cachedData = getDRECache(cacheKey);
      if (cachedData) {
        setFromCache(true);
        setPeriodos(cachedData.periodos);
        setDadosDRE(cachedData.dadosDRE);
        setPlanejadoLiquida(cachedData.planejadoLiquida);
        return;
      }
    }

    setFromCache(false);
    setLoading(true);
    setStatusCarregamento(null);

    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      const empresaParam = empresaSelecionada ? `&empresas=${empresaSelecionada}` : '';
      const response = await fetch(`/api/dre?dataInicio=${dataInicio}&dataFim=${dataFim}${empresaParam}`, {
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      const data = await response.json();

      if (data.error) {
        setStatusCarregamento(`Erro do backend: ${data.error}`);
        setPeriodos([]);
        setDadosDRE([]);
        return;
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

      let planejadoResult = { valores: {} as Record<string, number>, total: 0 };
      try {
        const paramsPlanejado = new URLSearchParams({
          dataInicio,
          dataFim,
          conta: '03',
        });
        if (grupoPlanejado !== 'Todos') paramsPlanejado.set('grupo', grupoPlanejado);

        const planejadoResponse = await fetch(`/api/planejado?${paramsPlanejado.toString()}`);
        const planejadoData = await planejadoResponse.json();
        const planejadoConta = planejadoData?.valores?.['03'] || { total: 0 };
        const valoresPlanejados: Record<string, number> = {};

        for (const periodo of periodosAtuais) {
          valoresPlanejados[periodo.key] = planejadoConta[periodo.key] || 0;
        }

        planejadoResult = {
          valores: valoresPlanejados,
          total: planejadoConta.total || 0,
        };
        setPlanejadoLiquida(planejadoResult);
      } catch (planejadoError) {
        console.error('Erro ao buscar planejado:', planejadoError);
        setPlanejadoLiquida({ valores: {}, total: 0 });
      }

      setDRECache(cacheKey, {
        periodos: periodosAtuais,
        dadosDRE: dadosOrdenados,
        planejadoLiquida: planejadoResult,
      });
    } catch (error) {
      console.error('Erro ao buscar dados DRE:', error);
      setStatusCarregamento('Falha ao conectar com o backend. Verifique se o servidor está rodando.');
      setPeriodos([]);
      setDadosDRE([]);
    } finally {
      setLoading(false);
    }
  }

  const receitaLiquida = dadosDRE.find((conta) => conta.codigo === '03')?.total || 0;
  const margemContribuicao = dadosDRE.find((conta) => conta.codigo === '05')?.total || 0;
  const ebitda = dadosDRE.find((conta) => conta.codigo === '09')?.total || 0;
  const lucroLiquido = dadosDRE.find((conta) => conta.codigo === '14')?.total || 0;
  const planejadoLiquidaTotal = planejadoLiquida.total || 0;
  const atingimentoPlanejado = planejadoLiquidaTotal > 0 ? (receitaLiquida / planejadoLiquidaTotal) * 100 : 0;

  const dadosDREComPlanejado = useMemo(() => {
    if (!Object.keys(planejadoLiquida.valores).length) return dadosDRE;

    const planejadoConta: ContaDREValores = {
      codigo: '03P',
      codigoExibicao: '03',
      nome: 'RECEITA LIQUIDA (PLANEJADO)',
      nivel: 1,
      tipo: 'resultado',
      valores: planejadoLiquida.valores,
      total: planejadoLiquida.total || 0,
    };

    const resultado: ContaDREValores[] = [];
    for (const conta of dadosDRE) {
      resultado.push(conta);
      if (conta.codigo === '03') resultado.push(planejadoConta);
    }
    return resultado;
  }, [dadosDRE, planejadoLiquida]);

  const indiceLucroLiquido = dadosDREComPlanejado.findIndex((conta) => conta.codigo === '14');
  const linhasPrincipais =
    indiceLucroLiquido >= 0 ? dadosDREComPlanejado.slice(0, indiceLucroLiquido + 1) : dadosDREComPlanejado;
  const linhasExtras = indiceLucroLiquido >= 0 ? dadosDREComPlanejado.slice(indiceLucroLiquido + 1) : [];

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="mb-4">
        <h1 className="text-3xl font-bold text-brand-dark">DEMONSTRACAO DO RESULTADO DO EXERCICIO</h1>
        <p className="text-gray-600 mt-1">Analise de receitas, custos e despesas por periodo</p>
        {/* AVISO: Empresas excluidas do DRE */}
        <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
          <strong>Filtro ativo:</strong>{' '}
          {empresaSelecionada ? (
            <>Empresa: {listaEmpresas.find(e => e.cd_empresa.toString() === empresaSelecionada)?.nome || empresaSelecionada} | </>
          ) : null}
          Empresas excluidas: CORPO SEXY (50), CAIRO BENEVIDES (100), CB EMPREENDIMENTOS (110)
        </div>
      </div>

      {/* Botoes de navegacao entre visoes */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setVisaoAtiva('vertical')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            visaoAtiva === 'vertical'
              ? 'bg-brand-primary text-white shadow-md'
              : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
          }`}
        >
          <LayoutList className="w-4 h-4" />
          DRE Vertical
        </button>
        <button
          onClick={() => setVisaoAtiva('empresa')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            visaoAtiva === 'empresa'
              ? 'bg-brand-primary text-white shadow-md'
              : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
          }`}
        >
          <Building2 className="w-4 h-4" />
          Por Empresa
        </button>
        <button
          onClick={() => setVisaoAtiva('sintetico')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            visaoAtiva === 'sintetico'
              ? 'bg-brand-primary text-white shadow-md'
              : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          Visao Sintetica
        </button>
      </div>

      {/* Visao Vertical (atual) */}
      {visaoAtiva === 'vertical' && (
        <>
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
          <div className="flex items-center gap-2 text-gray-600 text-sm">
            <DollarSign className="w-4 h-4" />
            Receita Liquida
          </div>
          <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(receitaLiquida)}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-indigo-500">
          <div className="flex items-center gap-2 text-gray-600 text-sm">
            <DollarSign className="w-4 h-4" />
            Receita Liquida (Planejado)
          </div>
          <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(planejadoLiquidaTotal)}</p>
          {planejadoLiquidaTotal > 0 && (
            <p className="text-xs text-gray-500">{atingimentoPlanejado.toFixed(1)}% atingido</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
          <div className="flex items-center gap-2 text-gray-600 text-sm">
            <TrendingUp className="w-4 h-4" />
            Margem Contribuicao
          </div>
          <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(margemContribuicao)}</p>
          {receitaLiquida > 0 && (
            <p className="text-xs text-gray-500">{((margemContribuicao / receitaLiquida) * 100).toFixed(1)}% da Receita</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-yellow-500">
          <div className="flex items-center gap-2 text-gray-600 text-sm">
            <TrendingUp className="w-4 h-4" />
            EBITDA
          </div>
          <p className="text-2xl font-bold text-gray-800 mt-1">{formatarValor(ebitda)}</p>
          {receitaLiquida > 0 && (
            <p className="text-xs text-gray-500">{((ebitda / receitaLiquida) * 100).toFixed(1)}% da Receita</p>
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
            <p className="text-xs text-gray-500">{((lucroLiquido / receitaLiquida) * 100).toFixed(1)}% da Receita</p>
          )}
        </div>
      </div>

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
            onClick={() => buscarDados(false)}
            disabled={loading}
            className="px-5 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Carregando...' : 'Consultar'}
          </button>
          <button
            onClick={() => buscarDados(true)}
            disabled={loading}
            title="Atualizar dados (ignorar cache)"
            className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {fromCache && <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded">Cache</span>}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Empresa</span>
            <select
              value={empresaSelecionada}
              onChange={(e) => setEmpresaSelecionada(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary min-w-[180px]"
            >
              <option value="">Todas as Empresas</option>
              {listaEmpresas.map((emp) => (
                <option key={emp.cd_empresa} value={emp.cd_empresa.toString()}>
                  {emp.nome}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Planejado</span>
            <select
              value={grupoPlanejado}
              onChange={(e) => setGrupoPlanejado(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary"
            >
              <option value="Todos">Todos</option>
              <option value="Lojas">Lojas</option>
              <option value="Ecommerce">Ecommerce</option>
              <option value="Fabrica">Fabrica</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={compararOficialMar}
              onChange={(e) => setCompararOficialMar(e.target.checked)}
              className="rounded border-gray-300"
            />
            Comparar com oficial MAR/2026
          </label>
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
          <button
            onClick={() => {
              const hoje = new Date();
              setDataInicio(`${hoje.getFullYear() - 1}-01-01`);
              setDataFim(`${hoje.getFullYear() - 1}-12-31`);
            }}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
          >
            Ano Anterior
          </button>
        </div>
        {statusCarregamento && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {statusCarregamento}
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="p-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-800">DRE - Demonstracao do Resultado</h2>
          <p className="text-sm text-gray-600">
            Periodo: {new Date(dataInicio).toLocaleDateString('pt-BR')} a {new Date(dataFim).toLocaleDateString('pt-BR')}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 border-b border-gray-200 sticky left-0 bg-gray-100 z-20 min-w-[300px]">
                  Conta
                </th>
                {periodos.map((periodo) => (
                  <th
                    key={periodo.key}
                    className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200 min-w-[100px]"
                  >
                    {periodo.label}
                  </th>
                ))}
                <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200 min-w-[120px] bg-blue-50">
                  TOTAL
                </th>
                {compararOficialMar && (
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200 min-w-[120px] bg-amber-50">
                    OFICIAL MAR/26
                  </th>
                )}
                {compararOficialMar && (
                  <th className="px-3 py-3 text-right text-sm font-semibold text-gray-700 border-b border-gray-200 min-w-[120px] bg-amber-50">
                    DIF. MAR/26
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {linhasPrincipais.map((conta) => renderizarLinhaConta(conta))}
              {linhasExtras.length > 0 && (
                <tr className="bg-slate-50">
                  <td colSpan={periodos.length + 2 + (compararOficialMar ? 2 : 0)} className="px-4 py-3 border-b border-gray-200">
                    <button
                      onClick={() => setMostrarLinhasExtras((prev) => !prev)}
                      className="text-sm font-medium text-slate-700 hover:text-slate-900"
                    >
                      {mostrarLinhasExtras ? 'Ocultar linhas abaixo do Lucro Liquido' : 'Mostrar linhas abaixo do Lucro Liquido'}
                    </button>
                  </td>
                </tr>
              )}
              {mostrarLinhasExtras && linhasExtras.map((conta) => renderizarLinhaConta(conta))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Dica:</strong> Clique em &quot;Consultar&quot; para buscar dados reais do sistema. Para ajustar a
          classificacao das despesas, acesse{' '}
          <a href="/configuracoes/plano-contas-dre" className="text-blue-600 hover:underline font-medium">
            Config DRE
          </a>
          .
        </p>
      </div>
        </>
      )}

      {/* Visao por Empresa */}
      {visaoAtiva === 'empresa' && <DREPorEmpresa />}

      {/* Visao Sintetica */}
      {visaoAtiva === 'sintetico' && (
        <DRESintetico
          dreContas={dadosDRE as unknown as ContaDREsintetico[]}
          drePeriodos={periodos}
        />
      )}

      {modalAberto && (
        <DetalhamentoDuplicatasDREModal
          isOpen={modalAberto}
          onClose={() => setModalAberto(false)}
          conta={modalConta}
          periodo={modalPeriodo}
          valor={modalValor}
        />
      )}
    </div>
  );
}
