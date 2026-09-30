// Estrutura do Balanço Patrimonial (Ativos e Passivo), espelhando o modelo
// já usado pela empresa (ver anexo). Só a estrutura/nomes - os valores vêm
// zerados por enquanto, as consultas serão plugadas depois.

export interface ContaBalanco {
  codigo: string;
  nome: string;
  nivel: 1 | 2;
  filhos?: ContaBalanco[];
}

export const PLANO_ATIVOS: ContaBalanco[] = [
  {
    codigo: 'AC',
    nome: 'CIRCULANTE - ( ATE 12 MESES )',
    nivel: 1,
    filhos: [
      { codigo: 'AC.1', nome: '1 - CAIXA E EQUIVALENTES DE CAIXA', nivel: 2 },
      { codigo: 'AC.2', nome: '2 - CONTAS A RECEBER', nivel: 2 },
      { codigo: 'AC.3', nome: '3 - ESTOQUES', nivel: 2 },
    ],
  },
  {
    codigo: 'ANC',
    nome: 'NÃO CIRCULANTE - ( APÓS 12 MESES )',
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
    nome: 'CIRCULANTE - ( ATÉ 12 MESES )',
    nivel: 1,
    filhos: [
      { codigo: 'PC.1', nome: '1 - FORNECEDORES E ALUGUÉIS A PAGAR', nivel: 2 },
      { codigo: 'PC.2', nome: '2 - OBRIGAÇÕES DE COMPRA DE MP. E SERV.', nivel: 2 },
      { codigo: 'PC.3', nome: '3 - EMPRÉSTIMOS, FINANCIAMENTOS E DEBÊNTURES', nivel: 2 },
      { codigo: 'PC.4', nome: '4 - SALÁRIOS E ENCARGOS A PAGAR', nivel: 2 },
      { codigo: 'PC.5', nome: '5 - TRIBUTOS A RECOLHER', nivel: 2 },
      { codigo: 'PC.6', nome: '6 - IMPOSTO DE RENDA E CONTRIBUIÇÃO SOCIAL DIFERIDOS', nivel: 2 },
    ],
  },
  {
    codigo: 'PNC',
    nome: 'NÃO CIRCULANTE - ( APÓS 12 MESES )',
    nivel: 1,
    filhos: [
      { codigo: 'PNC.7', nome: '7 - FORNECEDORES E ALUGUÉIS A PAGAR', nivel: 2 },
      { codigo: 'PNC.8', nome: '8 - OBRIGAÇÕES DE COMPRA DE MP. E SERV.', nivel: 2 },
      { codigo: 'PNC.9', nome: '9 - EMPRÉSTIMOS, FINANCIAMENTOS E DEBÊNTURES', nivel: 2 },
      { codigo: 'PNC.10', nome: '10 - SALÁRIOS E ENCARGOS A PAGAR', nivel: 2 },
      { codigo: 'PNC.11', nome: '11 - TRIBUTOS A RECOLHER', nivel: 2 },
      { codigo: 'PNC.12', nome: '12 - IMPOSTO DE RENDA E CONTRIBUIÇÃO SOCIAL DIFERIDOS', nivel: 2 },
    ],
  },
];
