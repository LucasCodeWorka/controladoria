// Tipos e formatadores da tela Balanço Lojas (contagens de estoque das lojas).

export type StatusAcur = 'ok' | 'atencao' | 'ruim' | 'neutro';

export interface Agg {
  balancos: number;
  itensAtivos: number;
  itensContados: number;
  itensDivergentes: number;
  pecasSaldo: number;
  pecasContadas: number;
  pecasFalta: number;
  pecasSobra: number;
  valorFalta: number;
  valorSobra: number;
  valorSaldo: number;
  valorLiquido: number;
  acuracidadeFisica: number | null;
  acuracidadeEtiq: number | null;
  pecasDifFisica: number;
  pecasDifEtiq: number;
  acuracidadeValor: number | null;
  status: StatusAcur;
}

export interface LojaRow extends Agg {
  cdEmpresa: number;
  loja: string;
  cancelados: number;
  diasComBalanco: number;
  diasUteis: number;
  cobertura: number | null;
  ultimoBalanco: string | null;
  diasSemBalanco: number | null;
}

export interface TotalAgg extends Agg {
  cancelados: number;
  emAndamento: number;
  balancosTotal: number;
  balancosSemContagem: number;
  balancosComDivergencia: number;
  pctBalancosComDivergencia: number | null;
  pctCancelados: number | null;
  horasAteContar: number | null;
}

export interface DiaRow {
  data: string;
  balancos: number;
  itensAtivos: number;
  itensDivergentes: number;
  acuracidadeFisica: number | null;
  acuracidadeEtiq: number | null;
  valorFalta: number;
  valorSobra: number;
}

export interface Resumo {
  periodo: { inicio: string; fim: string };
  filtros: { empresas: number[]; tipos: string[] };
  total: TotalAgg;
  porLoja: LojaRow[];
  porDia: DiaRow[];
  porTipo: (Agg & { tipo: string })[];
  porOperador: (Agg & { cdOperador: number | null; operador: string })[];
  diasUteis: number;
  metas: { ok: number; atencao: number };
}

export interface BalancoRow {
  cdEmpresa: number;
  loja: string;
  nrBalanco: number;
  data: string | null;
  descricao: string | null;
  tipo: string;
  situacao: string;
  tpSituacao: number;
  operador: string | null;
  itensLista: number;
  itensAtivos: number;
  itensContados: number;
  itensDivergentes: number;
  pecasSaldo: number;
  pecasContadas: number;
  pecasFalta: number;
  pecasSobra: number;
  valorFalta: number;
  valorSobra: number;
  acuracidadeFisica: number | null;
  acuracidadeEtiq: number | null;
  status: StatusAcur;
  horasAteContar: number | null;
}

export interface ProdutoNome { referencia: string | null; produto: string | null; cor: string | null; tamanho: string | null; grupo: string | null }
export interface Reincidente extends ProdutoNome { cdProduto: number; vezes: number; lojas: number; pecasAbs: number; pecasLiquidas: number; valorAbs: number; ultima: string }
export interface MaiorDif extends ProdutoNome { cdProduto: number; cdEmpresa: number; loja: string; nrBalanco: number; data: string; saldo: number; contagem: number; diferenca: number; preco: number; valorDiferenca: number }
export interface Criticos { reincidentes: Reincidente[]; maiores: MaiorDif[] }

export interface StatusSync {
  rodando: boolean;
  janelasFeitas: number;
  janelasTotal: number;
  balancosGravados: number;
  atualizadoEm: string | null;
  janelasGravadas: number;
  janelasHistorico: number;
  historicoCompleto: boolean;
  erro: string | null;
}

export interface Opcoes {
  lojas: { cdEmpresa: number; nome: string }[];
  tipos: { id: string; padrao: boolean }[];
  metaOk: number;
  metaAtencao: number;
}

export const NOME_TIPO: Record<string, string> = {
  ROTATIVO: 'Rotativo (diário)',
  PRINCIPAL: 'Principal (geral)',
  RECONTAGEM: 'Recontagem',
  AJUSTE: 'Ajuste de estoque',
};

export const fmtInt = (v: number | null | undefined) => (v == null ? '-' : Math.round(v).toLocaleString('pt-BR'));
export const fmtPct = (v: number | null | undefined) => (v == null ? '-' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
export const fmtBRL = (v: number | null | undefined) =>
  v == null ? '-' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtBRL0 = (v: number | null | undefined) =>
  v == null ? '-' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const fmtNum1 = (v: number | null | undefined) => (v == null ? '-' : v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

export const fmtData = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = iso.slice(0, 10).split('-');
  return `${d[2]}/${d[1]}/${d[0]}`;
};
export const fmtDataHora = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const COR_STATUS: Record<StatusAcur, { texto: string; fundo: string; borda: string }> = {
  ok: { texto: 'text-green-700', fundo: 'bg-green-50', borda: 'border-green-300' },
  atencao: { texto: 'text-amber-700', fundo: 'bg-amber-50', borda: 'border-amber-300' },
  ruim: { texto: 'text-red-700', fundo: 'bg-red-50', borda: 'border-red-300' },
  neutro: { texto: 'text-gray-700', fundo: 'bg-gray-50', borda: 'border-gray-200' },
};

export function statusDe(acur: number | null, metas: { ok: number; atencao: number }): StatusAcur {
  if (acur == null) return 'neutro';
  return acur >= metas.ok ? 'ok' : acur >= metas.atencao ? 'atencao' : 'ruim';
}
