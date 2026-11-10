import { formatarValor } from '../utils/formatters';
import { PLANO_ATIVOS, PLANO_PASSIVO, type ContaBalanco } from './planoContasBalanco';

// Indicadores financeiros do Balanço Patrimonial (liquidez, ROE, dívida
// líquida/EBITDA e alavancagem ajustada) como função pura - mesma conta da
// tela do balanço (app/balanco-patrimonial/page.tsx), pra a tela de
// indicadores mostrar exatamente os mesmos números.

export type StatusIndicador = 'ok' | 'atencao' | 'ruim' | 'neutro';
export type LinhaMemoria = { t: string; v: string; forte?: boolean };

export interface IndicadorBalanco {
  id: string;
  titulo: string;
  valor: string;
  meta: string;
  detalhe: string;
  memoria: LinhaMemoria[];
  status: StatusIndicador;
}

export interface EntradaIndicadoresBalanco {
  valores: Record<string, number>; // dict unico devolvido pela API (ativos + passivo)
  caixaDisponivel?: number | null;
  chequeEspecial?: number | null;
  dre: { lucroLiquido12m: number; ebitda12m: number; inicio: string; fim: string } | null;
}

export const fmtIndice = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const mesAno = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(2, 4)}`;

function totalGrupo(grupo: ContaBalanco, valores: Record<string, number>): number {
  if (!grupo.filhos || grupo.filhos.length === 0) return valores[grupo.codigo] ?? 0;
  return grupo.filhos.reduce((acc, filho) => acc + (valores[filho.codigo] ?? 0), 0);
}
const totalGeral = (plano: ContaBalanco[], valores: Record<string, number>) =>
  plano.reduce((acc, g) => acc + totalGrupo(g, valores), 0);

export function calcularIndicadoresBalanco(e: EntradaIndicadoresBalanco): IndicadorBalanco[] {
  const { valores, dre } = e;
  const ativoCirculante = totalGrupo(PLANO_ATIVOS[0], valores);
  const passivoCirculante = Math.abs(totalGrupo(PLANO_PASSIVO[0], valores));
  const caixa = valores['AC.1'] ?? 0;
  const estoques = valores['AC.3'] ?? 0;
  const totalAtivos = totalGeral(PLANO_ATIVOS, valores);
  const totalPassivo = totalGeral(PLANO_PASSIVO, valores);
  const patrimonioLiquido = totalAtivos - Math.abs(totalPassivo);

  const somaPassivo = (codigos: string[]) => Math.abs(codigos.reduce((s, c) => s + (valores[c] ?? 0), 0));
  const emprestimosCP = somaPassivo(['PC.3']);
  const emprestimosLP = somaPassivo(['PNC.8']);
  const imoveisCP = somaPassivo(['PC.IMV']);
  const imoveisLP = somaPassivo(['PNC.IMV']);
  const chequeEspecial = e.chequeEspecial ?? 0;
  const caixaDisponivel = e.caixaDisponivel ?? caixa;
  const dividaBruta = emprestimosCP + emprestimosLP + chequeEspecial;
  const dividaLiquida = dividaBruta - caixaDisponivel;
  const dividaAjustadaBruta = dividaBruta + imoveisCP + imoveisLP;
  const dividaAjustadaLiquida = dividaAjustadaBruta - caixaDisponivel;

  const liqImediata = passivoCirculante > 0 ? caixa / passivoCirculante : null;
  const liqSeca = passivoCirculante > 0 ? (ativoCirculante - estoques) / passivoCirculante : null;
  const liqCorrente = passivoCirculante > 0 ? ativoCirculante / passivoCirculante : null;
  const roe = dre && patrimonioLiquido > 0 ? (dre.lucroLiquido12m / patrimonioLiquido) * 100 : null;
  const ebitdaValido = !!dre && dre.ebitda12m > 0;
  const dividaEbitda = ebitdaValido ? dividaLiquida / dre!.ebitda12m : null;
  const alavancagemAjustada = ebitdaValido ? dividaAjustadaLiquida / dre!.ebitda12m : null;

  const statusProximoDe1 = (v: number | null): StatusIndicador => (v === null ? 'neutro' : v >= 0.8 ? 'ok' : v >= 0.5 ? 'atencao' : 'ruim');
  const statusAlavancagem = (x: number): StatusIndicador => (x <= 2.5 ? 'ok' : x <= 3 ? 'atencao' : 'ruim');

  const memoriaDivida = (ajustada: boolean): LinhaMemoria[] => {
    const indice = ajustada ? alavancagemAjustada : dividaEbitda;
    return [
      { t: 'Empréstimos curto prazo (PC.3)', v: formatarValor(emprestimosCP) },
      { t: 'Empréstimos longo prazo (PNC.8)', v: formatarValor(emprestimosLP) },
      { t: 'Cheque especial utilizado', v: formatarValor(chequeEspecial) },
      { t: 'Dívida financeira bruta', v: formatarValor(dividaBruta), forte: true },
      ...(ajustada ? [
        { t: '(+) Compra de imóveis curto prazo', v: formatarValor(imoveisCP) },
        { t: '(+) Compra de imóveis longo prazo', v: formatarValor(imoveisLP) },
        { t: 'Dívida ajustada bruta', v: formatarValor(dividaAjustadaBruta), forte: true },
      ] : []),
      { t: '(−) Caixa disponível (saldos positivos)', v: formatarValor(caixaDisponivel) },
      { t: ajustada ? 'Dívida ajustada líquida' : 'Dívida financeira líquida', v: formatarValor(ajustada ? dividaAjustadaLiquida : dividaLiquida), forte: true },
      { t: 'EBITDA 12m', v: dre ? formatarValor(dre.ebitda12m) : '...' },
      { t: ajustada ? 'Líquida ajustada ÷ EBITDA' : 'Líquida ÷ EBITDA', v: indice === null ? 'exige análise' : `${fmtIndice(indice)}x`, forte: true },
    ];
  };

  const txt = (n: number | null) => (n === null ? '-' : fmtIndice(n));

  return [
    {
      id: 'liq_imediata', titulo: 'Liquidez imediata', valor: txt(liqImediata),
      meta: 'Quanto mais perto de 1, melhor', detalhe: 'Caixa ÷ Passivo Circulante',
      memoria: [
        { t: 'Caixa (saldos bancários)', v: formatarValor(caixa) },
        { t: 'Passivo circulante', v: formatarValor(passivoCirculante) },
        { t: 'Caixa ÷ Passivo circulante', v: txt(liqImediata), forte: true },
      ],
      status: statusProximoDe1(liqImediata),
    },
    {
      id: 'liq_seca', titulo: 'Liquidez seca', valor: txt(liqSeca),
      meta: 'Quanto mais perto de 1, melhor', detalhe: '(Ativo Circ. − Estoques) ÷ Passivo Circ.',
      memoria: [
        { t: 'Ativo circulante', v: formatarValor(ativoCirculante) },
        { t: '(−) Estoques', v: formatarValor(estoques) },
        { t: 'Passivo circulante', v: formatarValor(passivoCirculante) },
        { t: '(AC − Estoques) ÷ PC', v: txt(liqSeca), forte: true },
      ],
      status: statusProximoDe1(liqSeca),
    },
    {
      id: 'liq_corrente', titulo: 'Liquidez corrente', valor: txt(liqCorrente),
      meta: 'Sempre acima de 1', detalhe: 'Ativo Circulante ÷ Passivo Circulante',
      memoria: [
        { t: 'Ativo circulante', v: formatarValor(ativoCirculante) },
        { t: 'Passivo circulante', v: formatarValor(passivoCirculante) },
        { t: 'AC ÷ PC', v: txt(liqCorrente), forte: true },
      ],
      status: liqCorrente === null ? 'neutro' : liqCorrente >= 1 ? 'ok' : liqCorrente >= 0.9 ? 'atencao' : 'ruim',
    },
    {
      id: 'roe', titulo: 'ROE', valor: roe === null ? (dre ? '-' : 'Carregando...') : `${fmtIndice(roe)}%`,
      meta: 'Lucro 12 meses ÷ patrimônio líquido',
      detalhe: dre ? `Lucro 12m (${mesAno(dre.inicio)} a ${mesAno(dre.fim)}): ${formatarValor(dre.lucroLiquido12m)}` : 'Lucro líquido da DRE consolidada',
      memoria: [
        { t: `Lucro líquido 12m${dre ? ` (${mesAno(dre.inicio)} a ${mesAno(dre.fim)})` : ''}`, v: dre ? formatarValor(dre.lucroLiquido12m) : '...' },
        { t: 'Ativos totais', v: formatarValor(totalAtivos) },
        { t: '(−) Passivo total', v: formatarValor(Math.abs(totalPassivo)) },
        { t: 'Patrimônio líquido', v: formatarValor(patrimonioLiquido) },
        { t: 'Lucro 12m ÷ PL', v: roe === null ? '-' : `${fmtIndice(roe)}%`, forte: true },
      ],
      status: 'neutro',
    },
    {
      id: 'divida_ebitda', titulo: 'Dívida líquida ÷ EBITDA',
      valor: dividaEbitda === null ? (dre ? 'Exige análise' : 'Carregando...') : `${fmtIndice(dividaEbitda)}x`,
      meta: 'Máximo de 3,00x',
      detalhe: dre
        ? `Bruta ${formatarValor(dividaBruta)} − caixa ${formatarValor(caixaDisponivel)} = líquida ${formatarValor(dividaLiquida)} · EBITDA 12m (${mesAno(dre.inicio)} a ${mesAno(dre.fim)}): ${formatarValor(dre.ebitda12m)}${ebitdaValido ? '' : ' (zero ou negativo: índice exige análise específica)'}`
        : 'Empréstimos e financiamentos − caixa disponível',
      memoria: memoriaDivida(false),
      status: dividaEbitda === null ? 'neutro' : statusAlavancagem(dividaEbitda),
    },
    {
      id: 'alavancagem', titulo: 'Alavancagem ajustada',
      valor: alavancagemAjustada === null ? (dre ? 'Exige análise' : 'Carregando...') : `${fmtIndice(alavancagemAjustada)}x`,
      meta: 'Inclui compra de imóveis · gerencial',
      detalhe: dre
        ? `Dívida financeira ${formatarValor(dividaBruta)} + imóveis ${formatarValor(imoveisCP + imoveisLP)} − caixa ${formatarValor(caixaDisponivel)} = ${formatarValor(dividaAjustadaLiquida)}`
        : 'Dívida financeira + imóveis − caixa disponível',
      memoria: memoriaDivida(true),
      status: alavancagemAjustada === null ? 'neutro' : statusAlavancagem(alavancagemAjustada),
    },
  ];
}

// Valores do dict da API so dos codigos do plano de contas (igual filtrarPorPlano da tela do balanco).
export function montarValoresBalanco(valoresApi: Record<string, number>): Record<string, number> {
  const codigos = new Set(
    [...PLANO_ATIVOS, ...PLANO_PASSIVO].flatMap((g) => (g.filhos || []).flatMap((f) => [f.codigo, ...(f.detalhes || []).map((d) => d.codigo)]))
  );
  const out: Record<string, number> = {};
  for (const [c, v] of Object.entries(valoresApi)) if (codigos.has(c)) out[c] = v;
  return out;
}
