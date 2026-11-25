// Indicadores de empresas listadas do varejo de moda, transcritos dos prints
// do Status Invest (seção "Indicadores da <ticker>", aba HOJE) enviados em
// 25/11/2026. Os prints originais ficam em public/comparativo-mercado/.
// null = o print mostra "-%" (sem dado). Percentuais em %, o resto em número.

export type Ticker = 'LREN3' | 'RIAA3' | 'AZZA3' | 'TFCO4' | 'CEAB3';

export const EMPRESAS_MERCADO: { ticker: Ticker; nome: string; print: string }[] = [
  { ticker: 'LREN3', nome: 'Lojas Renner', print: '/comparativo-mercado/lren3.png' },
  { ticker: 'RIAA3', nome: 'Riachuelo (Guararapes)', print: '/comparativo-mercado/riaa3.png' },
  { ticker: 'AZZA3', nome: 'Azzas 2154', print: '/comparativo-mercado/azza3.png' },
  { ticker: 'TFCO4', nome: 'Track & Field', print: '/comparativo-mercado/tfco4.png' },
  { ticker: 'CEAB3', nome: 'C&A', print: '/comparativo-mercado/ceab3.png' },
];

export type IdIndicador =
  | 'dy' | 'pl' | 'peg' | 'pvp' | 'ev_ebitda' | 'ev_ebit' | 'p_ebitda' | 'p_ebit' | 'vpa' | 'p_ativo' | 'lpa' | 'psr' | 'p_cap_giro' | 'p_ativo_circ_liq'
  | 'div_liq_pl' | 'div_liq_ebitda' | 'div_liq_ebit' | 'pl_ativos' | 'passivos_ativos' | 'liq_corrente'
  | 'm_bruta' | 'm_ebitda' | 'm_ebit' | 'm_liquida'
  | 'roe' | 'roa' | 'roic' | 'giro_ativos'
  | 'cagr_receitas' | 'cagr_lucros';

export const DADOS_MERCADO: Record<Ticker, Record<IdIndicador, number | null>> = {
  LREN3: {
    dy: 9.96, pl: 6.37, peg: 1.29, pvp: 0.91, ev_ebitda: 1.85, ev_ebit: 4.66, p_ebitda: 2.11, p_ebit: 5.31, vpa: 10.14, p_ativo: 0.49, lpa: 1.45, psr: 0.58, p_cap_giro: 2.09, p_ativo_circ_liq: -1.18,
    div_liq_pl: -0.11, div_liq_ebitda: -0.27, div_liq_ebit: -0.67, pl_ativos: 0.54, passivos_ativos: 0.46, liq_corrente: 1.67,
    m_bruta: 62.05, m_ebitda: 27.72, m_ebit: 10.99, m_liquida: 9.17,
    roe: 14.31, roa: 7.71, roic: 12.16, giro_ativos: 0.84,
    cagr_receitas: 16.0, cagr_lucros: 5.91,
  },
  RIAA3: {
    dy: 43.88, pl: 1.85, peg: 0.01, pvp: 0.52, ev_ebitda: 1.45, ev_ebit: 1.76, p_ebitda: 0.98, p_ebit: 1.2, vpa: 10.83, p_ativo: 0.2, lpa: 3.07, psr: 0.27, p_cap_giro: 0.92, p_ativo_circ_liq: -0.53,
    div_liq_pl: 0.25, div_liq_ebitda: 0.46, div_liq_ebit: 0.57, pl_ativos: 0.38, passivos_ativos: 0.62, liq_corrente: 1.53,
    m_bruta: 62.48, m_ebitda: 27.07, m_ebit: 22.2, m_liquida: 14.39,
    roe: 28.33, roa: 10.76, roic: 27.13, giro_ativos: 0.75,
    cagr_receitas: 10.94, cagr_lucros: null,
  },
  AZZA3: {
    dy: 10.65, pl: 9.12, peg: -0.17, pvp: 0.37, ev_ebitda: 3.87, ev_ebit: 6.25, p_ebitda: 2.32, p_ebit: 3.74, vpa: 39.82, p_ativo: 0.2, lpa: 1.63, psr: 0.27, p_cap_giro: 0.82, p_ativo_circ_liq: -0.36,
    div_liq_pl: 0.25, div_liq_ebitda: 1.54, div_liq_ebit: 2.49, pl_ativos: 0.53, passivos_ativos: 0.47, liq_corrente: 2.23,
    m_bruta: 55.23, m_ebitda: 11.77, m_ebit: 7.3, m_liquida: 2.99,
    roe: 4.1, roa: 2.19, roic: 3.51, giro_ativos: 0.73,
    cagr_receitas: 49.34, cagr_lucros: 47.3,
  },
  TFCO4: {
    dy: 1.79, pl: 59.82, peg: 6.43, pvp: 14.34, ev_ebitda: 6.89, ev_ebit: 6.97, p_ebitda: 38.99, p_ebit: 39.45, vpa: 0.67, p_ativo: 8.64, lpa: 0.16, psr: 8.07, p_cap_giro: 18.96, p_ativo_circ_liq: -28.08,
    div_liq_pl: 0.21, div_liq_ebitda: 0.57, div_liq_ebit: 0.58, pl_ativos: 0.6, passivos_ativos: 0.4, liq_corrente: 2.92,
    m_bruta: 57.86, m_ebitda: 20.7, m_ebit: 20.46, m_liquida: 13.49,
    roe: 23.97, roa: 14.44, roic: 22.17, giro_ativos: 1.07,
    cagr_receitas: 31.38, cagr_lucros: 42.59,
  },
  CEAB3: {
    dy: 7.16, pl: 3.38, peg: 0.13, pvp: 0.57, ev_ebitda: 1.29, ev_ebit: 2.21, p_ebitda: 1.17, p_ebit: 2.01, vpa: 12.78, p_ativo: 0.26, lpa: 2.15, psr: 0.28, p_cap_giro: 1.77, p_ativo_circ_liq: -0.48,
    div_liq_pl: 0.05, div_liq_ebitda: 0.1, div_liq_ebit: 0.18, pl_ativos: 0.45, passivos_ativos: 0.55, liq_corrente: 1.44,
    m_bruta: 56.45, m_ebitda: 23.79, m_ebit: 13.89, m_liquida: 8.23,
    roe: 16.83, roa: 7.55, roic: 15.92, giro_ativos: 0.92,
    cagr_receitas: 14.34, cagr_lucros: null,
  },
};

export type Formato = 'pct' | 'x';
export interface DefIndicador {
  id: IdIndicador;
  titulo: string;
  formato: Formato;
  // 'maior' = quanto maior melhor; 'menor' = quanto menor melhor; null = sem juízo de valor
  melhor: 'maior' | 'menor' | null;
}
export interface GrupoIndicadores { titulo: string; indicadores: DefIndicador[] }

export const GRUPOS: GrupoIndicadores[] = [
  {
    titulo: 'Valuation (dependem de cotação em bolsa)',
    indicadores: [
      { id: 'dy', titulo: 'D.Y', formato: 'pct', melhor: null },
      { id: 'pl', titulo: 'P/L', formato: 'x', melhor: null },
      { id: 'peg', titulo: 'PEG Ratio', formato: 'x', melhor: null },
      { id: 'pvp', titulo: 'P/VP', formato: 'x', melhor: null },
      { id: 'ev_ebitda', titulo: 'EV/EBITDA', formato: 'x', melhor: null },
      { id: 'ev_ebit', titulo: 'EV/EBIT', formato: 'x', melhor: null },
      { id: 'p_ebitda', titulo: 'P/EBITDA', formato: 'x', melhor: null },
      { id: 'p_ebit', titulo: 'P/EBIT', formato: 'x', melhor: null },
      { id: 'vpa', titulo: 'VPA (R$ por ação)', formato: 'x', melhor: null },
      { id: 'p_ativo', titulo: 'P/Ativo', formato: 'x', melhor: null },
      { id: 'lpa', titulo: 'LPA (R$ por ação)', formato: 'x', melhor: null },
      { id: 'psr', titulo: 'P/SR', formato: 'x', melhor: null },
      { id: 'p_cap_giro', titulo: 'P/Cap. Giro', formato: 'x', melhor: null },
      { id: 'p_ativo_circ_liq', titulo: 'P/Ativo Circ. Líq.', formato: 'x', melhor: null },
    ],
  },
  {
    titulo: 'Endividamento',
    indicadores: [
      { id: 'div_liq_pl', titulo: 'Dív. líquida / PL', formato: 'x', melhor: 'menor' },
      { id: 'div_liq_ebitda', titulo: 'Dív. líquida / EBITDA', formato: 'x', melhor: 'menor' },
      { id: 'div_liq_ebit', titulo: 'Dív. líquida / EBIT', formato: 'x', melhor: 'menor' },
      { id: 'pl_ativos', titulo: 'PL / Ativos', formato: 'x', melhor: 'maior' },
      { id: 'passivos_ativos', titulo: 'Passivos / Ativos', formato: 'x', melhor: 'menor' },
      { id: 'liq_corrente', titulo: 'Liquidez corrente', formato: 'x', melhor: 'maior' },
    ],
  },
  {
    titulo: 'Eficiência',
    indicadores: [
      { id: 'm_bruta', titulo: 'Margem bruta', formato: 'pct', melhor: 'maior' },
      { id: 'm_ebitda', titulo: 'Margem EBITDA', formato: 'pct', melhor: 'maior' },
      { id: 'm_ebit', titulo: 'Margem EBIT', formato: 'pct', melhor: 'maior' },
      { id: 'm_liquida', titulo: 'Margem líquida', formato: 'pct', melhor: 'maior' },
    ],
  },
  {
    titulo: 'Rentabilidade',
    indicadores: [
      { id: 'roe', titulo: 'ROE', formato: 'pct', melhor: 'maior' },
      { id: 'roa', titulo: 'ROA', formato: 'pct', melhor: 'maior' },
      { id: 'roic', titulo: 'ROIC', formato: 'pct', melhor: 'maior' },
      { id: 'giro_ativos', titulo: 'Giro dos ativos', formato: 'x', melhor: 'maior' },
    ],
  },
  {
    titulo: 'Crescimento',
    indicadores: [
      { id: 'cagr_receitas', titulo: 'CAGR receitas 5 anos', formato: 'pct', melhor: 'maior' },
      { id: 'cagr_lucros', titulo: 'CAGR lucros 5 anos', formato: 'pct', melhor: 'maior' },
    ],
  },
];

export function mediaMercado(id: IdIndicador): number | null {
  const v = (Object.keys(DADOS_MERCADO) as Ticker[]).map((t) => DADOS_MERCADO[t][id]).filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Explicacao curta + formula de cada indicador (popup da tela de comparativo).
export const EXPLICACOES: Record<IdIndicador, { o_que: string; formula: string }> = {
  dy: { o_que: 'Dividend Yield: quanto a empresa pagou de dividendos nos últimos 12 meses em relação ao preço da ação.', formula: 'Dividendos por ação ÷ preço da ação' },
  pl: { o_que: 'Preço sobre Lucro: quantos anos de lucro atual o mercado paga pela ação.', formula: 'Preço da ação ÷ lucro por ação (LPA)' },
  peg: { o_que: 'P/L ajustado pelo crescimento dos lucros: compara o preço pago com o ritmo de crescimento.', formula: 'P/L ÷ crescimento anual do lucro (CAGR)' },
  pvp: { o_que: 'Preço sobre Valor Patrimonial: quanto o mercado paga pelo patrimônio líquido contábil da empresa.', formula: 'Preço da ação ÷ valor patrimonial por ação (VPA)' },
  ev_ebitda: { o_que: 'Valor da firma sobre EBITDA: quantos anos de geração de caixa operacional o mercado paga pela empresa inteira (ações + dívida líquida).', formula: '(Valor de mercado + dívida líquida) ÷ EBITDA 12m' },
  ev_ebit: { o_que: 'Igual ao EV/EBITDA, mas usando o EBIT (já descontando depreciação).', formula: '(Valor de mercado + dívida líquida) ÷ EBIT 12m' },
  p_ebitda: { o_que: 'Valor de mercado sobre EBITDA, sem considerar a dívida.', formula: 'Valor de mercado ÷ EBITDA 12m' },
  p_ebit: { o_que: 'Valor de mercado sobre EBIT, sem considerar a dívida.', formula: 'Valor de mercado ÷ EBIT 12m' },
  vpa: { o_que: 'Valor Patrimonial por Ação: patrimônio líquido dividido pelo número de ações.', formula: 'Patrimônio líquido ÷ nº de ações' },
  p_ativo: { o_que: 'Quanto o mercado paga por cada real de ativo da empresa.', formula: 'Valor de mercado ÷ ativos totais' },
  lpa: { o_que: 'Lucro por Ação: lucro líquido dos últimos 12 meses dividido pelo número de ações.', formula: 'Lucro líquido 12m ÷ nº de ações' },
  psr: { o_que: 'Price to Sales Ratio: valor de mercado sobre a receita líquida.', formula: 'Valor de mercado ÷ receita líquida 12m' },
  p_cap_giro: { o_que: 'Valor de mercado sobre o capital de giro da empresa.', formula: 'Valor de mercado ÷ capital de giro' },
  p_ativo_circ_liq: { o_que: 'Valor de mercado sobre o ativo circulante líquido (ativo circulante − passivos de curto e longo prazo).', formula: 'Valor de mercado ÷ ativo circulante líquido' },
  div_liq_pl: { o_que: 'Quanto a dívida líquida representa do patrimônio líquido. Negativo = a empresa tem mais caixa que dívida.', formula: 'Dívida líquida ÷ patrimônio líquido' },
  div_liq_ebitda: { o_que: 'Em quantos anos de EBITDA a empresa quitaria a dívida líquida. Quanto menor, menos alavancada.', formula: 'Dívida líquida ÷ EBITDA 12m' },
  div_liq_ebit: { o_que: 'Igual à dívida líquida/EBITDA, mas sobre o EBIT.', formula: 'Dívida líquida ÷ EBIT 12m' },
  pl_ativos: { o_que: 'Parte dos ativos financiada com capital próprio.', formula: 'Patrimônio líquido ÷ ativos totais' },
  passivos_ativos: { o_que: 'Parte dos ativos financiada com capital de terceiros (todas as obrigações).', formula: 'Passivo total ÷ ativos totais' },
  liq_corrente: { o_que: 'Capacidade de pagar as obrigações de curto prazo com os ativos de curto prazo. Acima de 1 é saudável.', formula: 'Ativo circulante ÷ passivo circulante' },
  m_bruta: { o_que: 'Percentual da receita que sobra depois do custo da mercadoria vendida (CMV).', formula: '(Receita líquida − CMV) ÷ receita líquida' },
  m_ebitda: { o_que: 'Percentual da receita que vira geração de caixa operacional (antes de depreciação, juros e impostos).', formula: 'EBITDA ÷ receita líquida' },
  m_ebit: { o_que: 'Percentual da receita que sobra como resultado operacional, já descontando a depreciação.', formula: 'EBIT ÷ receita líquida' },
  m_liquida: { o_que: 'Percentual da receita que sobra como lucro depois de tudo.', formula: 'Lucro líquido ÷ receita líquida' },
  roe: { o_que: 'Retorno sobre o Patrimônio Líquido: quanto a empresa gera de lucro para cada real de capital próprio.', formula: 'Lucro líquido 12m ÷ patrimônio líquido' },
  roa: { o_que: 'Retorno sobre os Ativos: quanto de lucro cada real de ativo gera.', formula: 'Lucro líquido 12m ÷ ativos totais' },
  roic: { o_que: 'Retorno sobre o Capital Investido: lucro operacional após impostos sobre o capital (próprio + dívida) usado no negócio.', formula: 'EBIT × (1 − 34%) ÷ (patrimônio líquido + dívida líquida)' },
  giro_ativos: { o_que: 'Quantas vezes por ano a empresa vende o equivalente aos seus ativos. Mede a eficiência no uso dos ativos.', formula: 'Receita líquida 12m ÷ ativos totais' },
  cagr_receitas: { o_que: 'Crescimento médio anual composto da receita nos últimos 5 anos.', formula: '(Receita atual ÷ receita de 5 anos atrás)^(1/5) − 1' },
  cagr_lucros: { o_que: 'Crescimento médio anual composto do lucro nos últimos 5 anos.', formula: '(Lucro atual ÷ lucro de 5 anos atrás)^(1/5) − 1' },
};
