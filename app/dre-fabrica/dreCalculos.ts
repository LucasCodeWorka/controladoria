import type { ContaDRE } from './planoContasDREFabrica';

// Tipos e funções de cálculo compartilhados entre a DRE Analítica e a DFC —
// ambas usam o mesmo plano de contas e a mesma lógica de hierarquia/totalizadores,
// só mudam a fonte de dados (endpoint) e a base de data (emissão vs. baixa).

export interface PeriodoDRE {
  key: string;
  label: string;
}

export interface ContaDREValores {
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

export const CORES_NIVEL: Record<number, string> = {
  1: 'bg-blue-100 font-bold',
  2: 'bg-blue-50',
  3: 'bg-white',
  4: 'bg-white pl-8',
};

export function clonarComValores(contas: ContaDRE[]): ContaDREValores[] {
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

export function criarResultado(codigo: string, nome: string, codigoExibicao?: string): ContaDREValores {
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

export function indexarContas(contas: ContaDREValores[], mapa = new Map<string, ContaDREValores>()) {
  for (const conta of contas) {
    mapa.set(conta.codigo, conta);
    if (conta.filhos) indexarContas(conta.filhos, mapa);
  }
  return mapa;
}

export function clonarConta(conta?: ContaDREValores | null): ContaDREValores | null {
  if (!conta) return null;
  return {
    ...conta,
    codigoExibicao: conta.codigoExibicao || conta.codigo,
    valores: { ...conta.valores },
    filhos: conta.filhos?.map((filho) => clonarConta(filho)!).filter(Boolean),
  };
}

export function criarContaCalculada(
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

export function somarFilhos(contas: ContaDREValores[], periodos: PeriodoDRE[]): void {
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

export function achatarContas(
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

export function calcularLinhasOrdenadas(
  base: ContaDREValores[],
  periodos: PeriodoDRE[],
  contasTotalizadoras: Record<string, ContaDREValores> = {}
) {
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

      const cmvPeriodo = Math.abs(custosVariaveis?.valores[periodo] || 0);
      const deducoesPeriodo = Math.abs(deducoes?.valores[periodo] || 0);

      const custosFixosPeriodo = Math.abs(custosFixos?.valores[periodo] || 0);
      const despesasOpPeriodo = Math.abs(despesasOperacionais?.valores[periodo] || 0);
      const resultadoNaoOpPeriodo = Math.abs(resultadoNaoOp?.valores[periodo] || 0);
      const despesasTribPeriodo = Math.abs(despesasTributarias?.valores[periodo] || 0);

      const cmvPct = (cmvPeriodo + deducoesPeriodo) / Math.abs(receitaBrutaPeriodo);

      const margemPct = 1 - cmvPct;
      if (margemPct <= 0) return 0;

      const custosFixosTotais = custosFixosPeriodo + despesasOpPeriodo + resultadoNaoOpPeriodo + despesasTribPeriodo;

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
