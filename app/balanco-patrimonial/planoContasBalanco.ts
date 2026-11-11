// Estrutura do Balanço Patrimonial (Ativos e Passivo), espelhando o modelo
// já usado pela empresa (ver anexo). Só a estrutura/nomes - os valores vêm
// zerados por enquanto, as consultas serão plugadas depois.

export interface ContaBalanco {
  codigo: string;
  nome: string;
  nivel: 1 | 2;
  filhos?: ContaBalanco[];
  // Abertura so de exibicao (ex: AC.2 em Boletos, Cartoes e Cheques): NAO entra na soma do
  // grupo - o valor da propria conta ja e o total das aberturas.
  detalhes?: { codigo: string; nome: string; sub?: boolean }[];
}

export const PLANO_ATIVOS: ContaBalanco[] = [
  {
    codigo: 'AC',
    nome: 'CIRCULANTE',
    nivel: 1,
    filhos: [
      { codigo: 'AC.1', nome: '1 - CAIXA E EQUIVALENTES DE CAIXA', nivel: 2 },
      {
        codigo: 'AC.2',
        nome: '2 - CONTAS A RECEBER',
        nivel: 2,
        detalhes: [
          { codigo: 'AC.2.1', nome: 'BOLETOS' },
          { codigo: 'AC.2.2', nome: 'CARTÕES' },
          { codigo: 'AC.2.3', nome: 'CHEQUES' },
        ],
      },
      {
        codigo: 'AC.3',
        nome: '3 - ESTOQUES',
        nivel: 2,
        detalhes: [
          { codigo: 'AC.3.1', nome: 'ESTOQUE PA (LOJAS)' },
          { codigo: 'AC.3.1.1', nome: 'EM LINHA', sub: true },
          { codigo: 'AC.3.1.2', nome: 'FORA DE LINHA', sub: true },
          { codigo: 'AC.3.2', nome: 'ESTOQUE PA (FÁBRICA)' },
          { codigo: 'AC.3.2.1', nome: 'EM LINHA', sub: true },
          { codigo: 'AC.3.2.2', nome: 'FORA DE LINHA', sub: true },
          { codigo: 'AC.3.3', nome: 'ESTOQUE MP (FÁBRICA)' },
          { codigo: 'AC.3.3.1', nome: 'EM LINHA', sub: true },
          { codigo: 'AC.3.3.2', nome: 'FORA DE LINHA', sub: true },
        ],
      },
    ],
  },
  {
    codigo: 'ANC',
    nome: 'NÃO CIRCULANTE',
    nivel: 1,
    filhos: [
      { codigo: 'ANC.4', nome: '4 - TRIBUTOS A RECUPERAR', nivel: 2 },
      { codigo: 'ANC.5', nome: '5 - INVESTIMENTOS', nivel: 2 },
      { codigo: 'ANC.6', nome: '6 - IMOBILIZADO', nivel: 2 },
    ],
  },
];

export const PLANO_PASSIVO: ContaBalanco[] = [
  {
    codigo: 'PC',
    nome: 'CIRCULANTE',
    nivel: 1,
    filhos: [
      {
        codigo: 'PC.1',
        nome: '1 - FORNECEDORES E ALUGUÉIS A PAGAR',
        nivel: 2,
        detalhes: [
          { codigo: 'PC.1.1', nome: 'FORNECEDORES E ALUGUÉIS A PAGAR' },
          { codigo: 'PC.1.2', nome: 'RESCISÃO DE ALUGUÉIS (SHOPPING)' },
        ],
      },
      { codigo: 'PC.2', nome: '2 - OBRIGAÇÕES DE COMPRA DE MP. E SERV.', nivel: 2 },
      {
        codigo: 'PC.3',
        nome: '3 - EMPRÉSTIMOS, FINANCIAMENTOS E DEBÊNTURES',
        nivel: 2,
        detalhes: [
          { codigo: 'PC.3.1', nome: 'PRINCIPAL' },
          { codigo: 'PC.3.2', nome: 'JUROS' },
        ],
      },
      { codigo: 'PC.ETR', nome: '4 - ENDIVIDAMENTO TRIBUTÁRIO', nivel: 2 },
      { codigo: 'PC.IMV', nome: '5 - OBRIGAÇÕES POR COMPRA DE IMÓVEIS', nivel: 2 },
      {
        codigo: 'PC.4',
        nome: '6 - SALÁRIOS E ENCARGOS A PAGAR',
        nivel: 2,
        detalhes: [
          { codigo: 'PC.4.1', nome: 'SALÁRIOS E ENCARGOS' },
          { codigo: 'PC.4.2', nome: 'RESCISÃO DE FUNCIONÁRIOS' },
        ],
      },
      { codigo: 'PC.5', nome: '7 - TRIBUTOS A RECOLHER', nivel: 2 },
      { codigo: 'PC.6', nome: '8 - IMPOSTO DE RENDA E CONTRIBUIÇÃO SOCIAL DIFERIDOS', nivel: 2 },
    ],
  },
  {
    codigo: 'PNC',
    nome: 'NÃO CIRCULANTE',
    nivel: 1,
    filhos: [
      {
        codigo: 'PNC.8',
        nome: '9 - EMPRÉSTIMOS, FINANCIAMENTOS E DEBÊNTURES',
        nivel: 2,
        detalhes: [
          { codigo: 'PNC.8.1', nome: 'PRINCIPAL' },
          { codigo: 'PNC.8.2', nome: 'JUROS' },
        ],
      },
      { codigo: 'PNC.ETR', nome: '10 - ENDIVIDAMENTO TRIBUTÁRIO', nivel: 2 },
      { codigo: 'PNC.IMV', nome: '11 - OBRIGAÇÕES POR COMPRA DE IMÓVEIS', nivel: 2 },
      { codigo: 'PNC.10', nome: '12 - IMPOSTO DE RENDA E CONTRIBUIÇÃO SOCIAL DIFERIDOS', nivel: 2 },
    ],
  },
];
