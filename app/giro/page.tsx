'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RotateCw, Loader2, ChevronDown, Calendar } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { carregarFiltro, salvarFiltro } from '../utils/persistirFiltro';

interface EmpresaOpcao {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
}

interface ItemGiro {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
  estoqueAtual: number;
  vendaMedia3m: number;
  giro: number | null;
}

interface Consolidado {
  estoqueAtual: number;
  vendaMedia3m: number;
  giro: number | null;
}

interface EmpresaFaltante {
  cdEmpresa: number;
  nome: string;
}

interface ItemProdutoGiro {
  cdProduto: number;
  referencia: string;
  nome: string;
  estoqueAtual: number;
  vendaMedia3m: number;
  giro: number | null;
}

interface TopProdutos {
  melhorGiro: ItemProdutoGiro[];
  piorGiro: ItemProdutoGiro[];
}

interface DadosGiro {
  itens: ItemGiro[];
  consolidadoFabrica: Consolidado | null;
  consolidadoLojas: Consolidado | null;
  consolidadoGeral: Consolidado | null;
  dtCalculado: string | null;
  mesIni: string | null;
  mesFim: string | null;
  mesReferencia: string;
  empresasFaltantes: EmpresaFaltante[];
  topProdutos: TopProdutos;
}

type DimensaoGiro = 'grupo' | 'linha' | 'familia' | 'status' | 'colecao';

interface ItemDimensaoGiro {
  chave: string;
  estoqueTotal: number;
  vendaTotal: number;
  giro: number | null;
}

interface RespostaDimensaoGiro {
  dimensao: DimensaoGiro;
  itens: ItemDimensaoGiro[];
  mesReferencia: string;
}

const DIMENSOES_GIRO: { chave: DimensaoGiro; label: string }[] = [
  { chave: 'grupo', label: 'Grupo' },
  { chave: 'linha', label: 'Linha' },
  { chave: 'familia', label: 'Família' },
  { chave: 'status', label: 'Status' },
  { chave: 'colecao', label: 'Coleção' },
];

interface GiroLoja {
  estoque: number;
  venda: number;
  giro: number | null;
}

interface ItemMatrizGiro {
  referencia: string;
  nome: string;
  porLoja: Record<string, GiroLoja>;
  estoqueTotal: number;
  vendaTotal: number;
  giroTotal: number | null;
  precoFabrica: number | null;
  precoAtacado: number | null;
  precoVarejo: number | null;
  promocoes?: { tipo: 'Fábrica' | 'Atacado' | 'Varejo'; precoPromo: number; precoAnterior: number | null }[];
  temLeveDefeito?: boolean;
  cores?: string[];
  dtPrimeiraOportunidade?: string | null;
  mesesOportunidade?: number | null;
}

interface MatrizGiro {
  itens: ItemMatrizGiro[];
  empresas: EmpresaFaltante[];
  totalProdutos: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  empresasFaltantes: EmpresaFaltante[];
  mesReferencia: string;
}

function formatarQtd(valor: number): string {
  return valor.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

// Data ISO (YYYY-MM-DD) -> DD/MM/AAAA sem passar por Date() - Date() com
// string so-de-data interpreta como UTC meia-noite, o que pode voltar um
// dia no fuso local (mesmo bug ja visto em outras telas deste app).
function formatarDataBR(dataIso: string): string {
  const [ano, mes, dia] = dataIso.split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarGiro(valor: number | null): string {
  if (valor === null) return '-';
  return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Cor do numero de giro - "meses de cobertura" de estoque no ritmo medio
// de venda: baixo gira rapido (bom), alto fica parado demais (ruim).
// Limiares aproximados, so pra dar um sinal visual rapido.
function classeGiro(giro: number): string {
  if (giro <= 3) return 'text-emerald-700';
  if (giro <= 8) return 'text-amber-700';
  return 'text-rose-700';
}

// Celula de giro: numero colorido quando da pra calcular (teve venda no
// periodo); badge ambar "SV-3M" (sem venda nos ultimos 3 meses) quando tem
// estoque mas nao vendeu nada - o pior caso (estoque parado); badge cinza
// "SE-SV" (sem estoque e sem venda) so quando nao tem NADA - referencias
// assim nem aparecem mais na tabela, mas uma loja isolada dentro de uma
// referencia com movimento em outras lojas pode cair aqui.
function CelulaGiro({ estoque, giro }: { estoque: number; giro: number | null }) {
  if (giro !== null) {
    return <span className={`font-medium ${classeGiro(giro)}`}>{formatarGiro(giro)}</span>;
  }
  if (estoque > 0) {
    return (
      <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-50 text-amber-700 border border-amber-200">
        SV-3M
      </span>
    );
  }
  return (
    <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-gray-100 text-black border border-gray-200">
      SE-SV
    </span>
  );
}

const NOMES_MES_CURTO_GIRO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function labelMesCurtoGiro(mesChave: string): string {
  const [ano, mes] = mesChave.split('-').map(Number);
  return `${NOMES_MES_CURTO_GIRO[mes - 1]}/${String(ano).slice(2)}`;
}

// Meses (chave "YYYY-MM", do mais antigo pro mais novo) que entram na janela
// de venda usada pro giro - mesma regra do backend (_janela_venda_fl em
// giro.py): 3 meses cheios antes do mes filtrado por padrao; so o ultimo mes
// fechado quando Mes FL = 0; os meses JA FECHADOS do semestre do mes
// filtrado quando Mes FL > 0 (caindo pro ultimo mes fechado se o mes
// filtrado for o 1o do semestre, sem nenhum mes fechado ainda).
function mesesDaJanelaGiro(mesReferencia: string, mesesOportunidade: number | null | undefined): string[] {
  const [anoRef, mesRefN] = mesReferencia.split('-').map(Number);
  const mesChave = (ano: number, mes: number) => `${ano}-${String(mes).padStart(2, '0')}`;

  let anoFim = anoRef;
  let mesFimN = mesRefN - 1;
  if (mesFimN <= 0) {
    mesFimN += 12;
    anoFim -= 1;
  }

  if (mesesOportunidade === null || mesesOportunidade === undefined) {
    const meses: string[] = [];
    let ano = anoFim;
    let mes = mesFimN;
    for (let i = 0; i < 3; i++) {
      meses.unshift(mesChave(ano, mes));
      mes -= 1;
      if (mes <= 0) {
        mes += 12;
        ano -= 1;
      }
    }
    return meses;
  }

  if (mesesOportunidade === 0) {
    return [mesChave(anoFim, mesFimN)];
  }

  const mesInicioSem = mesRefN <= 6 ? 1 : 7;
  const mesesFechadosSem = mesRefN - mesInicioSem;
  if (mesesFechadosSem <= 0) {
    return [mesChave(anoFim, mesFimN)];
  }
  const meses: string[] = [];
  for (let m = mesInicioSem; m < mesRefN; m++) {
    meses.push(mesChave(anoRef, m));
  }
  return meses;
}

// Descreve qual janela de venda entrou na conta do giro (memoria de
// calculo): regra padrao (3 meses cheios antes do mes filtrado) pra quem
// nao esta em oportunidade, ou a janela especial de Mes FL (so o ultimo mes
// fechado quando Mes FL = 0; soma dos meses JA FECHADOS do semestre do mes
// filtrado, dividida pela quantidade deles, quando Mes FL > 0).
function descricaoJanelaGiro(mesReferencia: string, mesesOportunidade: number | null | undefined): string {
  const meses = mesesDaJanelaGiro(mesReferencia, mesesOportunidade);
  const mesIniLabel = labelMesCurtoGiro(meses[0]);
  const mesFimLabel = labelMesCurtoGiro(meses[meses.length - 1]);

  if (mesesOportunidade === null || mesesOportunidade === undefined) {
    return `Venda média = 3 meses cheios antes do mês filtrado (${mesIniLabel} a ${mesFimLabel}) ÷ 3`;
  }
  if (mesesOportunidade === 0 || meses.length === 1) {
    const motivoUnico = mesesOportunidade > 0 ? ', mas o mês filtrado é o 1º do semestre (nenhum mês fechado ainda)' : '';
    return `Meses FL = ${mesesOportunidade}${motivoUnico}: venda média = só o último mês fechado (${mesFimLabel}) ÷ 1`;
  }
  const plural = meses.length === 1 ? 'mês fechado' : 'meses fechados';
  return `Meses FL = ${mesesOportunidade}: venda média = soma de ${mesIniLabel} a ${mesFimLabel} (${meses.length} ${plural} do semestre) ÷ ${meses.length}`;
}

// Detalhe "venda de cada mes" - so mostra quando a janela tem mais de 1 mes
// (senao seria repetir o mesmo numero da venda media).
function detalheVendaMensalGiro(meses: string[], vendaPorMes: Record<string, number> | undefined): string {
  if (meses.length <= 1) return '';
  const partes = meses.map((m) => `${labelMesCurtoGiro(m)}: ${formatarQtd(vendaPorMes?.[m] ?? 0)}`);
  return `Venda por mês: ${partes.join(' | ')}`;
}

// Tooltip da matriz por referencia: mostra a conta que chegou naquele giro
// (estoque atual / venda media do periodo), a memoria de calculo de qual
// janela de venda foi usada, e a venda de cada mes quando a janela tem mais
// de 1 mes - tanto por loja quanto no total.
function tooltipGiro(
  estoque: number,
  venda: number,
  giro: number | null,
  mesReferencia: string,
  mesesOportunidade: number | null | undefined,
  vendaPorMes?: Record<string, number>
): string {
  const vendaFmt = venda.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const meses = mesesDaJanelaGiro(mesReferencia, mesesOportunidade);
  const janela = descricaoJanelaGiro(mesReferencia, mesesOportunidade);
  const detalheMensal = detalheVendaMensalGiro(meses, vendaPorMes);
  const linhas = [
    giro === null
      ? `Estoque: ${formatarQtd(estoque)} ÷ Venda média: ${vendaFmt} = ${estoque > 0 ? 'sem venda no período (SV-3M)' : 'sem estoque e sem venda no período'}`
      : `Estoque: ${formatarQtd(estoque)} ÷ Venda média: ${vendaFmt} = ${formatarGiro(giro)}`,
    janela,
  ];
  if (detalheMensal) linhas.push(detalheMensal);
  return linhas.join('\n');
}

// Soma a venda mes a mes de uma referencia, atraves de varias lojas (usado
// no tooltip da coluna Total) - a partir do mapa page-scoped ja carregado.
function vendaMensalTotalReferencia(
  referencia: string,
  empresas: { cdEmpresa: number }[],
  vendaMensalPorReferencia: Record<string, Record<string, Record<string, number>>>
): Record<string, number> {
  const porEmpresa = vendaMensalPorReferencia[referencia] || {};
  const total: Record<string, number> = {};
  for (const e of empresas) {
    const porMes = porEmpresa[String(e.cdEmpresa)] || {};
    for (const mes of Object.keys(porMes)) {
      total[mes] = (total[mes] || 0) + porMes[mes];
    }
  }
  return total;
}

// Tooltip da coluna Estoque (total): abre o estoque em cada loja do filtro
// aplicado, maior pra menor - so pra dar uma visao rapida de onde esta
// concentrado sem precisar rolar a tabela ate as colunas de loja.
function tooltipEstoquePorLoja(item: ItemMatrizGiro, empresas: EmpresaFaltante[]): string {
  const linhas = empresas
    .map((e) => ({ nome: nomeColunaLoja(e.nome), estoque: item.porLoja[String(e.cdEmpresa)]?.estoque ?? 0 }))
    .sort((a, b) => b.estoque - a.estoque)
    .map((l) => `${l.nome}: ${formatarQtd(l.estoque)}`);
  return `Estoque por loja:\n${linhas.join('\n')}`;
}

function formatarPreco(valor: number | null): string {
  if (valor === null) return '-';
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Variacao % do preco fabrica pro preco pedido (atacado/varejo) - null
// quando nao da pra calcular (sem um dos dois precos, ou fabrica = 0).
function variacaoPercentual(precoFabrica: number | null, preco: number | null): number | null {
  if (precoFabrica === null || preco === null || precoFabrica === 0) return null;
  return ((preco - precoFabrica) / precoFabrica) * 100;
}

function formatarVariacao(pct: number | null): string {
  if (pct === null) return '';
  const sinal = pct > 0 ? '+' : '';
  return `${sinal}${pct.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

// Regra de desconto pra sugestao de campanha, com base no Giro Total (do
// filtro de loja atual) e em ha quantos meses a referencia esta em FL
// (oportunidade). So se aplica a quem tem Meses FL preenchido (>= 0, ou
// seja, esta em oportunidade agora) - quem nao esta em FL nao entra na
// campanha, mesmo com giro baixo (pedido explicito do usuario). A faixa de
// "meses como FL" manda mais que a faixa de giro simples quando as duas
// batem.
function calcularPercentualCampanha(giroTotal: number | null, mesesOportunidade: number | null | undefined): number {
  if (giroTotal === null) return 0;
  if (mesesOportunidade === null || mesesOportunidade === undefined || mesesOportunidade < 0) return 0;
  if (giroTotal > 6 && mesesOportunidade >= 24) return 70;
  if (giroTotal > 6 && mesesOportunidade >= 12) return 60;
  if (giroTotal > 6) return 50;
  if (giroTotal >= 4) return 30;
  return 0;
}

function calcularPrecoCampanha(precoBase: number | null, percentual: number): number | null {
  if (precoBase === null || percentual <= 0) return null;
  return precoBase * (1 - percentual / 100);
}

function labelMes(anoMes: string): string {
  const [ano, mes] = anoMes.split('-');
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${nomes[Number(mes) - 1]}/${ano.slice(2)}`;
}

function nomeCurto(nome: string): string {
  return nome.length > 14 ? `${nome.slice(0, 13)}…` : nome;
}

// Corte maior que nomeCurto, pra categorias de dimensao (status/familia/...)
// - com 14 caracteres, valores como "OPORTUNIDADE ATE 1 ANO" e "OPORTUNIDADE
// ACIMA DE 2 ANOS" ficavam identicos, parecendo repetidos.
function nomeCurtoDimensao(nome: string): string {
  return nome.length > 22 ? `${nome.slice(0, 21)}…` : nome;
}

// Apelidos especificos pro cabecalho da matriz - nao seguem um padrao
// generico pra derivar automaticamente, entao e uma lista fixa.
const APELIDOS_COLUNA_LOJA: Record<string, string> = {
  'RIO MAR RECIFE': 'RECIFE',
  'NORTH JOQUEI': 'JOQUEI',
  'RIOMAR KENNEDY': 'KENNEDY',
  ECOMMERCE: 'ECOM',
  'DOM LUIS': 'D.LUIS',
  'PORTO ALEGRE': 'P. ALEGRE',
};

// So pro cabecalho da matriz por referencia: usa o apelido especifico
// quando tem um, senao tira "SHOPPING" e o sufixo de cidade que sobra
// depois (ex: "BARRA SHOPPING - RJ" -> "BARRA", "SALVADOR SHOPPING - BA"
// -> "SALVADOR", "MORUMBI SHOPPING" -> "MORUMBI") - nao mexe no nome em
// nenhum outro lugar da tela (filtro de lojas, tabela principal), so no
// cabecalho de coluna, onde o espaco e curto.
function nomeColunaLoja(nome: string): string {
  const base = APELIDOS_COLUNA_LOJA[nome] || nome
    .replace(/\s*SHOPPING\s*/gi, ' ')
    .replace(/\s*-\s*[A-Z]{2}\s*$/i, '')
    .trim() || nome;
  // Maximo 5 caracteres no cabecalho da coluna (espaco curto demais pra
  // nome completo com muitas lojas lado a lado) - o nome completo continua
  // no title do botao (tooltip ao passar o mouse).
  return base.length > 5 ? base.slice(0, 5) : base;
}

function mesAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

function labelMesCompleto(anoMes: string): string {
  const [ano, mes] = anoMes.split('-');
  const nomes = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
  ];
  return `${nomes[Number(mes) - 1]} ${ano}`;
}

// Opcoes de mes pra escolher num <select> em vez do <input type="month">
// nativo - no Safari ele exige digitar o mes manualmente em vez de dar uma
// lista pra escolher, confuso. Ultimos 24 meses, mais recente primeiro.
function opcoesMesReferencia(): string[] {
  const hoje = new Date();
  const opcoes: string[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    opcoes.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return opcoes;
}

interface BarraDado {
  chave: string | number;
  label: string;
  // Valor usado pra ALTURA da barra - precisa ser > 0 (escala log nao
  // aceita zero: log(0) e indefinido e quebra o grafico inteiro, nao so
  // essa barra - ja aconteceu com "familia", que tem categoria com estoque
  // zerado mas venda no periodo, ex: giro = 0). Quem monta o BarraDado deve
  // usar Math.max(giroReal, EPSILON_GIRO), nunca o giro cru.
  valor: number;
  // Texto de verdade pra mostrar em cima da barra (ex: "0,00") - separado
  // de `valor` porque `valor` pode estar "inflado" pro epsilon acima.
  labelTexto: string;
  tooltip?: string;
}

// Piso pra escala log (Y axis usa domain [EPSILON_GIRO, 'auto']) - qualquer
// giro real <= 0 vira essa altura minima na barra, mas o rotulo em cima
// continua mostrando o valor real (labelTexto), nao o piso.
const EPSILON_GIRO = 0.05;

interface PayloadTooltipBarra {
  active?: boolean;
  payload?: { payload: BarraDado }[];
}

function TooltipBarra({ active, payload }: PayloadTooltipBarra) {
  if (!active || !payload || payload.length === 0) return null;
  const dado = payload[0].payload;
  return (
    <div className="bg-gray-900 text-white text-xs rounded px-2.5 py-1.5 shadow-lg max-w-xs">
      {dado.tooltip || `${dado.label}: ${formatarGiro(dado.valor)}`}
    </div>
  );
}

// Cor da barra clicada/filtrada - bem mais escura, pra ficar obvio qual
// esta ativa sem sumir com as outras (o usuario quer ver todas as barras
// sempre, so a selecionada muda de cor) - tem prioridade sobre a cor de
// meta abaixo.
const COR_BARRA_ATIVA = '#8b1739';
// Meta de giro (meses de cobertura) - combinada com o usuario: ate 3 esta
// dentro da meta (verde), acima de 3 esta fora (vermelho). Vale pros dois
// graficos (loja e dimensao), que usam o mesmo componente.
const META_GIRO = 3;
const COR_DENTRO_META = '#16a34a';
const COR_ACIMA_META = '#dc2626';

// Barras do giro (razao estoque/venda media, "meses de cobertura") - mesmo
// estilo dos graficos de % do CMV Detalhado, so que o eixo/rotulo mostra um
// numero com 2 casas em vez de %. onBarClick e opcional - so o grafico "por
// dimensao" e o "por loja e fabrica" usam, pra filtrar a tabela de
// referencia/loja ao clicar numa barra. chaveAtiva pinta a barra clicada
// com COR_BARRA_ATIVA, mantendo as demais coloridas por meta (verde/
// vermelho) - nenhuma barra desaparece do grafico so por causa do filtro.
// Linha tracejada em META_GIRO deixa visualmente claro quem esta dentro/
// fora, alem da cor.
function GraficoGiro({ dados, onBarClick, chaveAtiva }: { dados: BarraDado[]; onBarClick?: (chave: string | number) => void; chaveAtiva?: string | number | null }) {
  if (dados.length === 0) {
    return <p className="text-sm text-black py-8 text-center">Sem giro calculado ainda.</p>;
  }
  const muitasCategorias = dados.length > 8;

  return (
    <div role="img" aria-label="Giro por loja e fábrica">
      <ResponsiveContainer width="100%" height={muitasCategorias ? 320 : 260}>
        <BarChart data={dados} margin={{ top: 24, right: 8, left: 0, bottom: muitasCategorias ? 64 : 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#000000' }}
            interval={0}
            angle={muitasCategorias ? -35 : 0}
            textAnchor={muitasCategorias ? 'end' : 'middle'}
            axisLine={{ stroke: '#c3c2b7' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#000000' }}
            axisLine={false}
            tickLine={false}
            width={36}
            scale="log"
            domain={[EPSILON_GIRO, 'auto']}
            allowDataOverflow={false}
          />
          <Tooltip content={<TooltipBarra />} cursor={{ fill: 'rgba(11,11,11,0.04)' }} />
          <ReferenceLine
            y={META_GIRO}
            stroke="#57534e"
            strokeDasharray="5 4"
            strokeWidth={1.5}
            label={{ value: `Meta: ${META_GIRO}`, position: 'insideTopRight', fontSize: 11, fill: '#000000', fontWeight: 600 }}
          />
          <Bar
            dataKey="valor"
            radius={[4, 4, 0, 0]}
            maxBarSize={56}
            cursor={onBarClick ? 'pointer' : undefined}
            onClick={onBarClick ? (data: any) => data?.payload?.chave !== undefined && onBarClick(data.payload.chave) : undefined}
          >
            {dados.map((d) => {
              const ativa = chaveAtiva !== null && chaveAtiva !== undefined && String(d.chave) === String(chaveAtiva);
              const cor = ativa ? COR_BARRA_ATIVA : d.valor <= META_GIRO ? COR_DENTRO_META : COR_ACIMA_META;
              return <Cell key={d.chave} fill={cor} />;
            })}
            <LabelList
              dataKey="labelTexto"
              position="top"
              style={{ fontSize: 11, fontWeight: 700, fill: '#000000' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CardConsolidado({ titulo, dado }: { titulo: string; dado: Consolidado | null }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-5">
      <p className="text-xs font-medium text-black uppercase tracking-wide">{titulo}</p>
      <p className="text-3xl font-bold text-black mt-1">{dado ? formatarGiro(dado.giro) : '-'}</p>
      <p className="text-xs text-black mt-0.5">meses de cobertura</p>
      {dado && (
        <div className="flex justify-between text-xs text-black mt-3 pt-3 border-t border-gray-100">
          <span>Estoque: {formatarQtd(dado.estoqueAtual)} un.</span>
          <span>Venda média/mês: {formatarQtd(dado.vendaMedia3m)} un.</span>
        </div>
      )}
    </div>
  );
}

export default function GiroPage() {
  const [mesReferencia, setMesReferencia] = useState(mesAtual());
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaOpcao[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<Set<number>>(new Set());
  const [filtroLojasAberto, setFiltroLojasAberto] = useState(false);

  // Status de produto (EM LINHA, OPORTUNIDADE, LEVE DEFEITO...) - vazio =
  // todos (sem filtro, mais rapido, le direto do agregado por empresa).
  const [statusDisponiveis, setStatusDisponiveis] = useState<string[]>([]);
  const [statusSelecionados, setStatusSelecionados] = useState<Set<string>>(new Set());
  const [filtroStatusAberto, setFiltroStatusAberto] = useState(false);

  const [dados, setDados] = useState<DadosGiro | null>(null);
  const [carregandoInicial, setCarregandoInicial] = useState(false);
  const [consultaExecutada, setConsultaExecutada] = useState(false);
  const [recalculando, setRecalculando] = useState(false);
  const [progressoCalculo, setProgressoCalculo] = useState<{ atual: number; total: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  // Matriz referencia x loja - le do mesmo cache por produto, paginada
  // (um mes cheio pode ter 20+ mil produtos distintos).
  const [matriz, setMatriz] = useState<MatrizGiro | null>(null);
  const [matrizPagina, setMatrizPagina] = useState(1);
  const [matrizCarregando, setMatrizCarregando] = useState(false);
  // Venda mes a mes por referencia (so das referencias da pagina atual, ja
  // carregada) - alimenta o detalhe "venda de cada mes" no tooltip do giro.
  // referencia -> cdEmpresa (string) -> "YYYY-MM" -> qtd vendida.
  const [vendaMensalPorReferencia, setVendaMensalPorReferencia] = useState<Record<string, Record<string, Record<string, number>>>>({});
  // Padrao: Total (giro), do pior (maior = mais meses de estoque parado)
  // pro melhor - pedido do usuario. Continua ordenavel por qualquer coluna
  // clicando no cabecalho, isso e so o estado inicial.
  const [matrizOrdenarPor, setMatrizOrdenarPor] = useState('total');
  const [matrizOrdem, setMatrizOrdem] = useState<'asc' | 'desc'>('desc');
  const MATRIZ_POR_PAGINA = 50;
  // Filtro da tabela "Giro por referencia e loja" ao clicar numa barra do
  // grafico "Giro por dimensao" (grupo/linha/familia/colecao/status).
  const [filtroDimensaoMatriz, setFiltroDimensaoMatriz] = useState<{ dimensao: DimensaoGiro; categoria: string } | null>(null);
  // Filtro da mesma tabela ao clicar numa barra do grafico "Giro por loja e
  // fabrica" - SEPARADO de empresasSelecionadas (o filtro la de cima) de
  // proposito: clicar numa barra so filtra a tabela, sem re-buscar/encolher
  // os graficos pra 1 loja so (o usuario quer ver todas as barras sempre,
  // so a clicada muda de cor).
  const [filtroLojaMatriz, setFiltroLojaMatriz] = useState<number | null>(null);

  function empresasParaMatriz(): string {
    return filtroLojaMatriz !== null ? String(filtroLojaMatriz) : Array.from(empresasSelecionadas).join(',');
  }

  // Tooltip com foto do produto ao passar o mouse na referencia - mesmo
  // padrao/endpoint ja usado no CMV Detalhado (API publica da VTEX via
  // /api/foto, cacheada). Guarda a referencia em hover tambem em ref, pra
  // descartar resposta atrasada se o mouse ja passou pra outra linha antes
  // da foto chegar.
  const [fotoTooltip, setFotoTooltip] = useState<{ referencia: string; url: string | null; carregando: boolean; erro: boolean; x: number; y: number } | null>(null);
  const cacheFotoRef = useRef<Map<string, string | null>>(new Map());
  const hoverFotoRef = useRef<string | null>(null);

  function mostrarFotoRef(referencia: string, x: number, y: number) {
    hoverFotoRef.current = referencia;
    const emCache = cacheFotoRef.current.get(referencia);
    if (emCache !== undefined) {
      setFotoTooltip({ referencia, url: emCache, carregando: false, erro: false, x, y });
      return;
    }
    setFotoTooltip({ referencia, url: null, carregando: true, erro: false, x, y });
    fetch(`/api/foto?ref=${encodeURIComponent(referencia)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const url = data?.url ?? null;
        cacheFotoRef.current.set(referencia, url);
        if (hoverFotoRef.current === referencia) {
          setFotoTooltip((atual) => (atual && atual.referencia === referencia ? { ...atual, url, carregando: false } : atual));
        }
      })
      .catch(() => {
        cacheFotoRef.current.set(referencia, null);
        if (hoverFotoRef.current === referencia) {
          setFotoTooltip((atual) => (atual && atual.referencia === referencia ? { ...atual, url: null, carregando: false } : atual));
        }
      });
  }

  function moverFotoRef(referencia: string, x: number, y: number) {
    setFotoTooltip((atual) => (atual && atual.referencia === referencia ? { ...atual, x, y } : atual));
  }

  function imagemFalhou(referencia: string) {
    setFotoTooltip((atual) => (atual && atual.referencia === referencia ? { ...atual, erro: true } : atual));
  }

  function esconderFotoRef() {
    hoverFotoRef.current = null;
    setFotoTooltip(null);
  }

  // Giro por dimensao do produto (grupo/linha/familia/status/colecao) - as
  // 5 vem juntas na consulta, trocar de aba so troca qual ja veio (sem
  // refazer a busca).
  const [dimensaoSelecionada, setDimensaoSelecionada] = useState<DimensaoGiro>('grupo');
  const [dadosPorDimensao, setDadosPorDimensao] = useState<Record<DimensaoGiro, RespostaDimensaoGiro | null>>({
    grupo: null, linha: null, familia: null, status: null, colecao: null,
  });

  // Filtro "giro maior que X" - texto cru do input (permite vazio = sem
  // filtro) ate clicar em Aplicar/Enter, pra nao refazer a busca a cada
  // digito.
  const [matrizGiroMinimo, setMatrizGiroMinimo] = useState('');

  // Tooltip da matriz com o calculo do giro (estoque / venda = giro) - o
  // atributo title nativo do navegador demora pra aparecer e alguns
  // usuarios nem percebem que existe, entao usa um balao proprio que segue
  // o mouse, igual ao dos graficos.
  const [tooltipCelula, setTooltipCelula] = useState<{ texto: string; x: number; y: number } | null>(null);

  useEffect(() => {
    fetch('/api/cmv-detalhado/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const lista: EmpresaOpcao[] = data.empresas || [];
        setEmpresasDisponiveis(lista);
        // Restaura o filtro salvo da ultima visita, se houver - senao,
        // seleciona todas por padrao (mesmo padrao do DRE/DFC).
        const salvo = carregarFiltro<{ mesReferencia: string; empresas: number[]; status: string[] }>('giro_filtros');
        const validas = new Set(lista.map((e) => e.cdEmpresa));
        if (salvo) {
          if (salvo.mesReferencia) setMesReferencia(salvo.mesReferencia);
          // So aceita empresas que ainda existem na lista atual - uma
          // selecao salva antes (ex: um codigo que deixou de ser listado)
          // nao pode virar um pedido invalido pro backend.
          const empresasValidas = (salvo.empresas || []).filter((cd) => validas.has(cd));
          setEmpresasSelecionadas(new Set(empresasValidas.length > 0 ? empresasValidas : lista.map((e) => e.cdEmpresa)));
          if (salvo.status) setStatusSelecionados(new Set(salvo.status));
        } else {
          setEmpresasSelecionadas(new Set(lista.map((e) => e.cdEmpresa)));
        }
      })
      .catch((e) => console.error('Erro ao buscar empresas do giro:', e));

    fetch('/api/giro/status-produtos', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => setStatusDisponiveis(data.status || []))
      .catch((e) => console.error('Erro ao buscar status de produto:', e));
  }, []);

  // Salva o filtro atual sempre que o usuario alterar mes, lojas ou status,
  // pulando a primeira renderizacao pra nao sobrescrever o que acabou de
  // ser restaurado acima com os valores padrao.
  const primeiraRenderizacaoFiltroRef = useRef(true);
  useEffect(() => {
    if (primeiraRenderizacaoFiltroRef.current) {
      primeiraRenderizacaoFiltroRef.current = false;
      return;
    }
    salvarFiltro('giro_filtros', {
      mesReferencia,
      empresas: Array.from(empresasSelecionadas),
      status: Array.from(statusSelecionados),
    });
  }, [mesReferencia, empresasSelecionadas, statusSelecionados]);

  async function buscarSnapshot(mesRef: string, empresasParam: string, statusParam: string) {
    try {
      const params = new URLSearchParams({ mesReferencia: mesRef, empresas: empresasParam });
      if (statusParam) params.set('status', statusParam);
      const response = await fetch(`/api/giro/dados?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      // !response.ok cobre qualquer erro do backend, nao so o formato
      // {error: ...} - o FastAPI usa {detail: ...} - sem isso, um erro
      // (ex: empresa invalida) virava "dados" com formato errado e
      // quebrava a tela ao tentar renderizar.
      if (!response.ok || data.error) {
        setErro(`Erro do backend: ${data.detail || data.error || 'Erro desconhecido'}`);
        return;
      }
      setDados(data);
    } catch (error) {
      console.error('Erro ao buscar giro:', error);
      setErro('Erro ao buscar os dados de giro.');
    }
  }

  // Nao consulta sozinho ao abrir a tela - so no clique em "Consultar".
  async function buscarMatriz(mesRef: string, empresasParam: string, pagina: number, ordenarPor: string, ordem: 'asc' | 'desc', giroMinimo: string, statusParam: string, filtroDimensao: { dimensao: DimensaoGiro; categoria: string } | null = null) {
    setMatrizCarregando(true);
    try {
      const params = new URLSearchParams({
        mesReferencia: mesRef,
        empresas: empresasParam,
        pagina: String(pagina),
        porPagina: String(MATRIZ_POR_PAGINA),
        ordenarPor,
        ordem,
      });
      const giroMinimoNum = Number(giroMinimo.trim().replace(',', '.'));
      if (giroMinimo.trim() !== '' && !Number.isNaN(giroMinimoNum)) {
        params.set('giroMinimo', String(giroMinimoNum));
      }
      if (filtroDimensao) {
        params.set('dimensaoFiltro', filtroDimensao.dimensao);
        params.set('categoriaFiltro', filtroDimensao.categoria);
      }
      if (statusParam) {
        params.set('status', statusParam);
      }
      const response = await fetch(`/api/giro/matriz-produtos?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) {
        setErro(`Erro do backend: ${data.detail || data.error || 'Erro desconhecido'}`);
        return;
      }
      setMatriz(data);
      setMatrizPagina(pagina);
      buscarVendaMensalReferencias(mesRef, empresasParam, (data.itens || []).map((i: ItemMatrizGiro) => i.referencia), statusParam);
    } catch (error) {
      console.error('Erro ao buscar matriz de giro:', error);
      setErro('Erro ao buscar a matriz por loja.');
    } finally {
      setMatrizCarregando(false);
    }
  }

  // Busca a venda mes a mes so das referencias que estao na pagina atual
  // (mesmo padrao "so o que esta na tela" ja usado pra preco/promo/Meses
  // FL) - so enriquece o tooltip do giro, nao bloqueia o carregamento da
  // matriz nem trava a tela se falhar.
  async function buscarVendaMensalReferencias(mesRef: string, empresasParam: string, referencias: string[], statusParam: string) {
    if (referencias.length === 0) {
      setVendaMensalPorReferencia({});
      return;
    }
    try {
      const params = new URLSearchParams({
        referencias: referencias.join(','),
        empresas: empresasParam,
        mesReferencia: mesRef,
      });
      if (statusParam) {
        params.set('status', statusParam);
      }
      const response = await fetch(`/api/giro/venda-mensal-referencias?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (response.ok && !data.error) {
        setVendaMensalPorReferencia(data);
      }
    } catch (error) {
      console.error('Erro ao buscar venda mensal por referência:', error);
    }
  }

  // Busca as 5 dimensoes juntas (paralelo) - trocar de aba depois so troca
  // qual delas ja veio, sem refazer a busca a cada clique.
  // Giro por loja recalculado pra uma categoria especifica (filtro cruzado:
  // clicou numa barra do grafico "por dimensao") - separado de `dados`
  // (que alimenta os cards consolidados/recalculo e NAO deve mudar so
  // porque o usuario clicou numa categoria). null = sem filtro de
  // dimensao ativo, o grafico de loja usa itensPorEstoqueDesc normal.
  const [giroPorLojaFiltrado, setGiroPorLojaFiltrado] = useState<ItemGiro[] | null>(null);

  async function buscarGiroPorLoja(mesRef: string, empresasParam: string, filtroDimensao: { dimensao: DimensaoGiro; categoria: string } | null) {
    if (!filtroDimensao) {
      setGiroPorLojaFiltrado(null);
      return;
    }
    try {
      const params = new URLSearchParams({
        mesReferencia: mesRef,
        empresas: empresasParam,
        dimensaoFiltro: filtroDimensao.dimensao,
        categoriaFiltro: filtroDimensao.categoria,
      });
      const response = await fetch(`/api/giro/por-loja?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) return;
      setGiroPorLojaFiltrado(data.itens || []);
    } catch (error) {
      console.error('Erro ao buscar giro por loja (filtro cruzado):', error);
    }
  }

  async function buscarDimensoes(mesRef: string, empresasParam: string) {
    try {
      const respostas = await Promise.all(
        DIMENSOES_GIRO.map((d) => {
          const params = new URLSearchParams({ dimensao: d.chave, mesReferencia: mesRef, empresas: empresasParam });
          return fetch(`/api/giro/por-dimensao?${params.toString()}`, { cache: 'no-store' }).then((r) => r.json());
        })
      );
      const novosDados: Record<DimensaoGiro, RespostaDimensaoGiro | null> = {
        grupo: null, linha: null, familia: null, status: null, colecao: null,
      };
      DIMENSOES_GIRO.forEach((d, i) => {
        if (!respostas[i].error && !respostas[i].detail) {
          novosDados[d.chave] = respostas[i];
        }
      });
      setDadosPorDimensao(novosDados);
    } catch (error) {
      console.error('Erro ao buscar giro por dimensão:', error);
    }
  }

  function consultar() {
    if (empresasSelecionadas.size === 0) {
      setErro('Selecione pelo menos uma loja/fábrica.');
      return;
    }
    setErro(null);
    setCarregandoInicial(true);
    const empresasParam = Array.from(empresasSelecionadas).join(',');
    buscarSnapshot(mesReferencia, empresasParam, Array.from(statusSelecionados).join(','))
      .then(() => setConsultaExecutada(true))
      .finally(() => setCarregandoInicial(false));
    setMatrizOrdenarPor('total');
    setMatrizOrdem('desc');
    setFiltroDimensaoMatriz(null);
    setFiltroLojaMatriz(null);
    setGiroPorLojaFiltrado(null);
    buscarMatriz(mesReferencia, empresasParam, 1, 'total', 'desc', matrizGiroMinimo, Array.from(statusSelecionados).join(','), null);
    buscarDimensoes(mesReferencia, empresasParam);
  }

  // Clique numa barra do grafico "Giro por loja e fabrica" - filtra a
  // tabela "Giro por referencia e loja" pra essa loja E recalcula o
  // grafico "por dimensao" so com os dados dela (filtro cruzado) - sem
  // nenhum dos dois graficos perder barras, so a clicada muda de cor.
  // Clicar de novo na mesma barra remove o filtro. Combina com o filtro de
  // dimensao se ja tiver um ativo (mostra "sutia da Iguatemi", por
  // exemplo, quando os dois estao selecionados).
  function filtrarPorLojaGrafico(cdEmpresa: string | number) {
    const cd = Number(cdEmpresa);
    if (Number.isNaN(cd)) return;
    const novoFiltro = filtroLojaMatriz === cd ? null : cd;
    setFiltroLojaMatriz(novoFiltro);
    const empresasParam = novoFiltro !== null ? String(novoFiltro) : Array.from(empresasSelecionadas).join(',');
    buscarMatriz(mesReferencia, empresasParam, 1, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), filtroDimensaoMatriz);
    buscarDimensoes(mesReferencia, empresasParam);
  }

  function trocarPaginaMatriz(novaPagina: number) {
    buscarMatriz(mesReferencia, empresasParaMatriz(), novaPagina, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), filtroDimensaoMatriz);
  }

  // Clicar numa coluna ja ordenada inverte o sentido; numa coluna nova,
  // comeca ascendente. Sempre volta pra pagina 1 (a ordenacao e da base
  // inteira, nao so da pagina atual).
  function ordenarMatrizPor(coluna: string) {
    const novoOrdem: 'asc' | 'desc' = matrizOrdenarPor === coluna && matrizOrdem === 'asc' ? 'desc' : 'asc';
    setMatrizOrdenarPor(coluna);
    setMatrizOrdem(novoOrdem);
    buscarMatriz(mesReferencia, empresasParaMatriz(), 1, coluna, novoOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), filtroDimensaoMatriz);
  }

  // Aplica o filtro "giro maior que X" digitado - volta pra pagina 1
  // mantendo a ordenacao atual.
  function aplicarFiltroGiroMinimo() {
    buscarMatriz(mesReferencia, empresasParaMatriz(), 1, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), filtroDimensaoMatriz);
  }

  function limparFiltroGiroMinimo() {
    setMatrizGiroMinimo('');
    buscarMatriz(mesReferencia, empresasParaMatriz(), 1, matrizOrdenarPor, matrizOrdem, '', Array.from(statusSelecionados).join(','), filtroDimensaoMatriz);
  }

  // Clique numa barra do grafico "Giro por dimensao" - filtra a tabela de
  // referencia/loja por essa categoria E recalcula o grafico "por loja e
  // fabrica" so com produtos dessa categoria (filtro cruzado), usando
  // TODAS as lojas selecionadas no topo (nao so a que estiver com filtro
  // de loja ativo - esse so destaca a cor, o grafico de loja sempre mostra
  // todas as lojas). Clicar de novo na mesma categoria (ou no botao
  // "Limpar filtro") remove o filtro.
  function filtrarMatrizPorDimensao(dimensao: DimensaoGiro, categoria: string | number) {
    const categoriaStr = String(categoria);
    const novoFiltro = filtroDimensaoMatriz?.dimensao === dimensao && filtroDimensaoMatriz?.categoria === categoriaStr
      ? null
      : { dimensao, categoria: categoriaStr };
    setFiltroDimensaoMatriz(novoFiltro);
    buscarMatriz(mesReferencia, empresasParaMatriz(), 1, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), novoFiltro);
    buscarGiroPorLoja(mesReferencia, Array.from(empresasSelecionadas).join(','), novoFiltro);
  }

  function limparFiltroDimensaoMatriz() {
    setFiltroDimensaoMatriz(null);
    buscarMatriz(mesReferencia, empresasParaMatriz(), 1, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), null);
    setGiroPorLojaFiltrado(null);
  }

  function limparFiltroLojaMatriz() {
    setFiltroLojaMatriz(null);
    buscarMatriz(mesReferencia, Array.from(empresasSelecionadas).join(','), 1, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), filtroDimensaoMatriz);
    buscarDimensoes(mesReferencia, Array.from(empresasSelecionadas).join(','));
  }

  function indicadorOrdenacao(coluna: string): string {
    if (matrizOrdenarPor !== coluna) return '';
    return matrizOrdem === 'asc' ? ' ↑' : ' ↓';
  }

  async function calcularFaltantes() {
    if (!dados || dados.empresasFaltantes.length === 0) return;
    setRecalculando(true);
    setErro(null);
    const faltantes = dados.empresasFaltantes.map((e) => e.cdEmpresa);
    setProgressoCalculo({ atual: 0, total: faltantes.length });
    try {
      // Calcula uma empresa de cada vez, com progresso - cada uma leva uns
      // segundos a ~40s (fabrica e a mais pesada), dependendo do quanto a
      // parte de venda (view lenta) pesa pra ela.
      for (let i = 0; i < faltantes.length; i++) {
        const params = new URLSearchParams({ mesReferencia, empresas: String(faltantes[i]) });
        const response = await fetch(`/api/giro/recalcular?${params.toString()}`, { method: 'POST', cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || data.error) {
          setErro(`Erro ao calcular: ${data.detail || data.error || 'Erro desconhecido'}`);
          return;
        }
        setProgressoCalculo({ atual: i + 1, total: faltantes.length });
      }
      const empresasParam = Array.from(empresasSelecionadas).join(',');
      await buscarSnapshot(mesReferencia, empresasParam, Array.from(statusSelecionados).join(','));
      await buscarMatriz(mesReferencia, empresasParaMatriz(), matrizPagina, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo, Array.from(statusSelecionados).join(','), filtroDimensaoMatriz);
      await buscarDimensoes(mesReferencia, empresasParam);
    } catch (error) {
      console.error('Erro ao calcular giro:', error);
      setErro('Erro ao calcular o giro. Tente novamente.');
    } finally {
      setRecalculando(false);
      setProgressoCalculo(null);
    }
  }

  function toggleEmpresaFiltro(cd: number) {
    setEmpresasSelecionadas((atual) => {
      const novo = new Set(atual);
      if (novo.has(cd)) novo.delete(cd);
      else novo.add(cd);
      return novo;
    });
  }

  function toggleStatusFiltro(status: string) {
    setStatusSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(status)) novo.delete(status);
      else novo.add(status);
      return novo;
    });
  }

  const temDados = !!dados && dados.itens.length > 0;
  // Grafico "Giro por loja e fabrica" ordenado por estoque decrescente
  // (pedido do usuario) - o grafico de dimensao ja vem assim do backend.
  // Usa giroPorLojaFiltrado (recalculado pra categoria clicada) quando o
  // filtro cruzado de dimensao esta ativo, senao os dados normais.
  const itensPorEstoqueDesc = (giroPorLojaFiltrado ?? dados?.itens ?? [])
    .slice()
    .sort((a, b) => b.estoqueAtual - a.estoqueAtual);

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-rose-100 rounded-lg">
            <RotateCw className="w-6 h-6 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">Giro</h1>
            <p className="text-sm text-black">Estoque no mês x venda média dos 3 meses cheios anteriores, por loja, fábrica e consolidado.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Período</h2>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-black">Mês de referência</label>
          <select
            value={mesReferencia}
            onChange={(e) => setMesReferencia(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-primary bg-white"
          >
            {opcoesMesReferencia().map((m) => (
              <option key={m} value={m}>
                {labelMesCompleto(m)}
              </option>
            ))}
          </select>

          <div className="relative">
            <button
              onClick={() => setFiltroLojasAberto((v) => !v)}
              className="min-w-[160px] flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50"
            >
              Lojas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
              <ChevronDown className="w-4 h-4 text-black" />
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
                  <button className="text-xs font-medium text-black hover:text-black" onClick={() => setEmpresasSelecionadas(new Set())}>
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

          <div className="relative">
            <button
              onClick={() => setFiltroStatusAberto((v) => !v)}
              className="min-w-[160px] flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50"
            >
              Status ({statusSelecionados.size === 0 ? 'todos' : statusSelecionados.size})
              <ChevronDown className="w-4 h-4 text-black" />
            </button>
            {filtroStatusAberto && (
              <div className="absolute z-30 mt-1 w-72 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-xl p-2">
                <div className="flex justify-between px-1 pb-1 mb-1 border-b border-gray-100">
                  <button
                    className="text-xs font-medium text-purple-700 hover:text-purple-900"
                    onClick={() => setStatusSelecionados(new Set(statusDisponiveis))}
                  >
                    Todos
                  </button>
                  <button className="text-xs font-medium text-black hover:text-black" onClick={() => setStatusSelecionados(new Set())}>
                    Limpar
                  </button>
                </div>
                {statusDisponiveis.map((s) => (
                  <label key={s} className="flex items-center gap-2 px-1 py-1 text-sm hover:bg-gray-50 rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={statusSelecionados.has(s)}
                      onChange={() => toggleStatusFiltro(s)}
                    />
                    {s.replace(/\s+/g, ' ')}
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={consultar}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors"
          >
            Consultar
          </button>
        </div>

        {dados?.dtCalculado && (
          <p className="text-xs text-black mt-3">
            Último cálculo em {new Date(dados.dtCalculado).toLocaleString('pt-BR')}
            {dados.mesIni && dados.mesFim && <> — venda média referente a {labelMes(dados.mesIni)} a {labelMes(dados.mesFim)}</>}
          </p>
        )}
      </div>

      {erro && <p className="text-sm text-red-600">{erro}</p>}

      {carregandoInicial && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-black">Carregando...</span>
        </div>
      )}

      {!carregandoInicial && !consultaExecutada && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-black">
          Escolha o mês de referência e as lojas e clique em Consultar.
        </div>
      )}

      {!carregandoInicial && consultaExecutada && dados && dados.empresasFaltantes.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <p className="text-xs text-amber-700">
            {recalculando && progressoCalculo
              ? `Calculando... empresa ${progressoCalculo.atual} de ${progressoCalculo.total}.`
              : `${dados.empresasFaltantes.length} empresa(s) sem giro calculado pra ${labelMes(mesReferencia)} (${dados.empresasFaltantes.map((e) => e.nome).join(', ')}) — cada uma leva alguns segundos a ~40s.`}
          </p>
          <button
            onClick={calcularFaltantes}
            disabled={recalculando}
            className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors disabled:opacity-60 flex items-center gap-1.5 shrink-0"
          >
            {recalculando && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Calcular faltantes
          </button>
        </div>
      )}

      {!carregandoInicial && consultaExecutada && !temDados && !recalculando && dados?.empresasFaltantes.length === 0 && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-black">
          Nenhuma empresa selecionada.
        </div>
      )}

      {consultaExecutada && temDados && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CardConsolidado titulo="Giro Fábrica" dado={dados!.consolidadoFabrica} />
            <CardConsolidado titulo="Giro Lojas (consolidado)" dado={dados!.consolidadoLojas} />
            <CardConsolidado titulo="Giro Geral" dado={dados!.consolidadoGeral} />
          </div>

          <div className="bg-white rounded-lg shadow-lg p-5">
            <h2 className="text-base font-semibold text-black mb-1">Giro por loja e fábrica</h2>
            <p className="text-xs text-black mb-3">
              Giro = estoque no mês ÷ venda média mensal dos 3 meses cheios anteriores — meses de cobertura do estoque no ritmo de venda (quanto menor, mais rápido o giro). Escala logarítmica no eixo, pra uma barra bem mais alta que as outras não achatar o gráfico.
            </p>
            <GraficoGiro
              dados={itensPorEstoqueDesc
                .filter((i) => i.giro !== null)
                .map((i) => ({
                  chave: i.cdEmpresa,
                  label: nomeCurto(i.nome),
                  valor: Math.max(i.giro as number, EPSILON_GIRO),
                  labelTexto: formatarGiro(i.giro),
                  tooltip: `${i.nome}: ${formatarGiro(i.giro)} meses de cobertura (estoque ${formatarQtd(i.estoqueAtual)} un. / venda média ${formatarQtd(i.vendaMedia3m)} un./mês) — clique pra ver só essa loja`,
                }))}
              onBarClick={filtrarPorLojaGrafico}
              chaveAtiva={filtroLojaMatriz}
            />
          </div>

          <div className="bg-white rounded-lg shadow-lg p-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
              <h2 className="text-base font-semibold text-black">Giro por {DIMENSOES_GIRO.find((d) => d.chave === dimensaoSelecionada)?.label.toLowerCase()}</h2>
              <div className="flex items-center gap-1.5 flex-wrap">
                {DIMENSOES_GIRO.map((d) => (
                  <button
                    key={d.chave}
                    onClick={() => setDimensaoSelecionada(d.chave)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      dimensaoSelecionada === d.chave
                        ? 'bg-rose-600 text-white'
                        : 'bg-gray-100 text-black hover:bg-gray-200'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-black mb-3">
              Giro (estoque somado ÷ venda média somada) por {DIMENSOES_GIRO.find((d) => d.chave === dimensaoSelecionada)?.label.toLowerCase()} do produto, somando todas as empresas do filtro — clique numa barra pra filtrar a tabela abaixo. Escala logarítmica no eixo, pra uma barra bem mais alta que as outras não achatar o gráfico.
            </p>
            <GraficoGiro
              dados={(dadosPorDimensao[dimensaoSelecionada]?.itens || [])
                .filter((item) => item.giro !== null)
                .map((item) => ({
                  chave: item.chave,
                  label: nomeCurtoDimensao(item.chave),
                  valor: Math.max(item.giro as number, EPSILON_GIRO),
                  labelTexto: formatarGiro(item.giro),
                  tooltip: `${item.chave}: ${formatarGiro(item.giro)} meses de cobertura (estoque ${formatarQtd(item.estoqueTotal)} un. / venda média ${formatarQtd(item.vendaTotal)} un./mês) — clique pra filtrar a tabela abaixo`,
                }))}
              onBarClick={(chave) => filtrarMatrizPorDimensao(dimensaoSelecionada, chave)}
              chaveAtiva={filtroDimensaoMatriz?.dimensao === dimensaoSelecionada ? filtroDimensaoMatriz.categoria : null}
            />
          </div>

          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="px-4 pt-3 flex items-center gap-2 text-sm flex-wrap">
              <label htmlFor="giro-minimo" className="text-black">Giro maior que:</label>
              <input
                id="giro-minimo"
                type="number"
                step="0.01"
                min="0"
                placeholder="ex: 2"
                value={matrizGiroMinimo}
                onChange={(e) => setMatrizGiroMinimo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') aplicarFiltroGiroMinimo(); }}
                className="w-24 border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-rose-500"
              />
              <button
                onClick={aplicarFiltroGiroMinimo}
                disabled={matrizCarregando}
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-black rounded-md text-xs disabled:opacity-40 transition-colors"
              >
                Aplicar
              </button>
              {matrizGiroMinimo.trim() !== '' && (
                <button
                  onClick={limparFiltroGiroMinimo}
                  disabled={matrizCarregando}
                  className="text-xs text-black hover:text-black underline disabled:opacity-40"
                >
                  Limpar
                </button>
              )}
            </div>
            <div className="p-4 pb-2 flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-base font-semibold text-black">Giro por referência e loja</h2>
                <p className="text-xs text-black">
                  Cada linha é uma referência (soma de todas as cores/tamanhos dela) — uma coluna de giro por
                  loja/fábrica selecionada, e o giro total no final (estoque somado ÷ venda média somada de todas as
                  empresas do filtro).
                </p>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-black">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Giro rápido</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Atenção</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" /> Estoque parado</span>
                  <span className="flex items-center gap-1">
                    <span className="px-1 py-0.5 text-[10px] font-semibold rounded bg-amber-50 text-amber-700 border border-amber-200">SV-3M</span>
                    Tem estoque mas sem venda nos últimos 3 meses
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="px-1 py-0.5 text-[10px] font-semibold rounded bg-gray-100 text-black border border-gray-200">SE-SV</span>
                    Sem estoque e sem venda nessa loja
                  </span>
                </div>
              </div>
              {matriz && (
                <div className="flex items-center gap-2 text-sm shrink-0">
                  <button
                    onClick={() => trocarPaginaMatriz(matrizPagina - 1)}
                    disabled={matrizCarregando || matrizPagina <= 1}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-black rounded-md disabled:opacity-40 transition-colors"
                  >
                    ← Anterior
                  </button>
                  <span className="text-black text-xs whitespace-nowrap">
                    Página {matriz.pagina} de {matriz.totalPaginas} ({formatarQtd(matriz.totalProdutos)} produtos)
                  </span>
                  <button
                    onClick={() => trocarPaginaMatriz(matrizPagina + 1)}
                    disabled={matrizCarregando || matrizPagina >= matriz.totalPaginas}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-black rounded-md disabled:opacity-40 transition-colors"
                  >
                    Próxima →
                  </button>
                </div>
              )}
            </div>

            {(filtroDimensaoMatriz || filtroLojaMatriz !== null) && (
              <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
                {filtroLojaMatriz !== null && (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200 rounded-md">
                    Filtrando por Loja: {empresasDisponiveis.find((e) => e.cdEmpresa === filtroLojaMatriz)?.nome || filtroLojaMatriz}
                    <button onClick={limparFiltroLojaMatriz} className="hover:text-rose-900 font-bold ml-0.5" title="Limpar filtro">
                      ×
                    </button>
                  </span>
                )}
                {filtroDimensaoMatriz && (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200 rounded-md">
                    Filtrando por {DIMENSOES_GIRO.find((d) => d.chave === filtroDimensaoMatriz.dimensao)?.label}: {filtroDimensaoMatriz.categoria}
                    <button onClick={limparFiltroDimensaoMatriz} className="hover:text-rose-900 font-bold ml-0.5" title="Limpar filtro">
                      ×
                    </button>
                  </span>
                )}
              </div>
            )}

            {matrizCarregando && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-rose-600" />
                <span className="ml-3 text-black text-sm">Carregando...</span>
              </div>
            )}

            {!matrizCarregando && matriz && matriz.itens.length === 0 && (
              <p className="text-sm text-black py-8 text-center">Nenhum produto encontrado.</p>
            )}

            {!matrizCarregando && matriz && matriz.itens.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-black sticky left-0 bg-gray-50 z-10 min-w-[100px]">
                        <button onClick={() => ordenarMatrizPor('referencia')} className="flex items-center gap-1 hover:text-black">
                          Referência{indicadorOrdenacao('referencia')}
                        </button>
                      </th>
                      <th className="text-left px-4 py-2 font-medium text-black sticky left-[100px] bg-gray-50 z-10 min-w-[220px]">
                        <button onClick={() => ordenarMatrizPor('nome')} className="flex items-center gap-1 hover:text-black">
                          Produto{indicadorOrdenacao('nome')}
                        </button>
                      </th>
                      <th className="text-left px-3 py-2 font-medium text-black whitespace-nowrap min-w-[150px]">
                        Cores
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-orange-700 bg-orange-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('mesesOportunidade')} className="flex items-center gap-1 ml-auto hover:text-orange-900">
                          Meses FL{indicadorOrdenacao('mesesOportunidade')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-blue-700 bg-blue-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoFabrica')} className="flex items-center gap-1 ml-auto hover:text-blue-900">
                          Fábrica{indicadorOrdenacao('precoFabrica')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-blue-700 bg-blue-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoAtacado')} className="flex items-center gap-1 ml-auto hover:text-blue-900">
                          Atacado{indicadorOrdenacao('precoAtacado')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-blue-700 bg-blue-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoVarejo')} className="flex items-center gap-1 ml-auto hover:text-blue-900">
                          Varejo{indicadorOrdenacao('precoVarejo')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-amber-700 bg-amber-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoPromo')} className="flex items-center gap-1 ml-auto hover:text-amber-900" title="Preço Promo">
                          Promo Atac{indicadorOrdenacao('precoPromo')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-amber-700 bg-amber-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoPromo')} className="flex items-center gap-1 ml-auto hover:text-amber-900" title="Preço Promo">
                          Promo Var{indicadorOrdenacao('precoPromo')}
                        </button>
                      </th>
                      <th
                        className="text-right px-3 py-2 font-medium text-rose-700 bg-rose-50/60 whitespace-nowrap"
                        title="Sugestão de desconto pro Giro Total do filtro atual: <4 giro=0%, 4-6=30%, >6=50%, >6 e 12+ meses FL=60%, >6 e 24+ meses FL=70%"
                      >
                        Camp Atac
                      </th>
                      <th
                        className="text-right px-3 py-2 font-medium text-rose-700 bg-rose-50/60 whitespace-nowrap"
                        title="Sugestão de desconto pro Giro Total do filtro atual: <4 giro=0%, 4-6=30%, >6=50%, >6 e 12+ meses FL=60%, >6 e 24+ meses FL=70%"
                      >
                        Camp Var
                      </th>
                      {matriz.empresas.map((e) => (
                        <th key={e.cdEmpresa} className="text-right px-3 py-2 font-medium text-black whitespace-nowrap">
                          <button
                            onClick={() => ordenarMatrizPor(String(e.cdEmpresa))}
                            className="flex items-center gap-1 ml-auto hover:text-black"
                            title={e.nome}
                          >
                            {nomeColunaLoja(e.nome)}{indicadorOrdenacao(String(e.cdEmpresa))}
                          </button>
                        </th>
                      ))}
                      <th className="text-right px-3 py-2 font-medium text-slate-700 bg-slate-50 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('estoque')} className="flex items-center gap-1 ml-auto hover:text-slate-900">
                          Estoque{indicadorOrdenacao('estoque')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-slate-700 bg-slate-50 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('totalVenda')} className="flex items-center gap-1 ml-auto hover:text-slate-900">
                          Total Venda{indicadorOrdenacao('totalVenda')}
                        </button>
                      </th>
                      <th className="text-right px-4 py-2 font-semibold text-black bg-gray-200/70 border-l-2 border-gray-300 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('total')} className="flex items-center gap-1 ml-auto hover:text-black">
                          Total{indicadorOrdenacao('total')}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {matriz.itens.map((item, idx) => (
                      <tr key={item.referencia} className={`${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-rose-50 transition-colors`}>
                        <td
                          className="px-4 py-2 text-black sticky left-0 bg-inherit z-10 cursor-help"
                          onMouseEnter={(ev) => mostrarFotoRef(item.referencia, ev.clientX, ev.clientY)}
                          onMouseMove={(ev) => moverFotoRef(item.referencia, ev.clientX, ev.clientY)}
                          onMouseLeave={esconderFotoRef}
                        >
                          <div className="flex items-center gap-1.5">
                            {item.referencia}
                            {item.temLeveDefeito && (
                              <span
                                className="px-1 py-0.5 text-[9px] font-medium bg-orange-100 text-orange-700 rounded"
                                title="Alguma cor/tamanho dessa referência está classificado como Leve Defeito"
                              >
                                LD
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-black sticky left-[100px] bg-inherit z-10">{item.nome}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {item.cores && item.cores.length > 0 ? (
                            <div className="flex flex-wrap gap-1 max-w-[160px]">
                              {item.cores.slice(0, 3).map((cor) => (
                                <span key={cor} className="px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-black border border-gray-200 rounded" title={cor}>
                                  {cor}
                                </span>
                              ))}
                              {item.cores.length > 3 && (
                                <span
                                  className="px-1.5 py-0.5 text-[10px] font-medium bg-gray-200 text-black border border-gray-300 rounded cursor-help"
                                  onMouseEnter={(ev) => setTooltipCelula({ texto: item.cores!.slice(3).join(', '), x: ev.clientX, y: ev.clientY })}
                                  onMouseMove={(ev) => setTooltipCelula({ texto: item.cores!.slice(3).join(', '), x: ev.clientX, y: ev.clientY })}
                                  onMouseLeave={() => setTooltipCelula(null)}
                                >
                                  +{item.cores.length - 3}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-black">-</span>
                          )}
                        </td>
                        <td
                          className="px-3 py-2 text-right text-orange-900 bg-orange-50/30 whitespace-nowrap cursor-help"
                          onMouseEnter={(ev) => item.dtPrimeiraOportunidade && setTooltipCelula({ texto: `Virou oportunidade em ${formatarDataBR(item.dtPrimeiraOportunidade)} (SKU mais antigo ainda em oportunidade hoje)`, x: ev.clientX, y: ev.clientY })}
                          onMouseMove={(ev) => item.dtPrimeiraOportunidade && setTooltipCelula({ texto: `Virou oportunidade em ${formatarDataBR(item.dtPrimeiraOportunidade)} (SKU mais antigo ainda em oportunidade hoje)`, x: ev.clientX, y: ev.clientY })}
                          onMouseLeave={() => setTooltipCelula(null)}
                        >
                          {item.mesesOportunidade !== null && item.mesesOportunidade !== undefined ? item.mesesOportunidade : <span className="text-black">-</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-blue-900 bg-blue-50/30 whitespace-nowrap">{formatarPreco(item.precoFabrica)}</td>
                        <td className="px-3 py-2 text-right text-blue-900 bg-blue-50/30 whitespace-nowrap">
                          <div className="text-[10px] text-blue-400 leading-tight">{formatarVariacao(variacaoPercentual(item.precoFabrica, item.precoAtacado))}</div>
                          {formatarPreco(item.precoAtacado)}
                        </td>
                        <td className="px-3 py-2 text-right text-blue-900 bg-blue-50/30 whitespace-nowrap">
                          <div className="text-[10px] text-blue-400 leading-tight">{formatarVariacao(variacaoPercentual(item.precoFabrica, item.precoVarejo))}</div>
                          {formatarPreco(item.precoVarejo)}
                        </td>
                        {(() => {
                          const promoAtacado = item.promocoes?.find((p) => p.tipo === 'Atacado');
                          const promoVarejo = item.promocoes?.find((p) => p.tipo === 'Varejo');
                          const pctPromoAtacado = promoAtacado ? variacaoPercentual(item.precoAtacado, promoAtacado.precoPromo) : null;
                          const pctPromoVarejo = promoVarejo ? variacaoPercentual(item.precoVarejo, promoVarejo.precoPromo) : null;
                          const percentualCampanha = calcularPercentualCampanha(item.giroTotal, item.mesesOportunidade);
                          const precoAtacadoCampanha = calcularPrecoCampanha(item.precoAtacado, percentualCampanha);
                          const precoVarejoCampanha = calcularPrecoCampanha(item.precoVarejo, percentualCampanha);
                          return (
                            <>
                              <td className="px-3 py-2 text-right text-amber-900 bg-amber-50/30 whitespace-nowrap">
                                {promoAtacado ? (
                                  <>
                                    <div className="text-[10px] text-amber-500 leading-tight">{formatarVariacao(pctPromoAtacado)}</div>
                                    {formatarPreco(promoAtacado.precoPromo)}
                                  </>
                                ) : (
                                  <span className="text-black">-</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right text-amber-900 bg-amber-50/30 whitespace-nowrap">
                                {promoVarejo ? (
                                  <>
                                    <div className="text-[10px] text-amber-500 leading-tight">{formatarVariacao(pctPromoVarejo)}</div>
                                    {formatarPreco(promoVarejo.precoPromo)}
                                  </>
                                ) : (
                                  <span className="text-black">-</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right text-rose-900 bg-rose-50/30 whitespace-nowrap">
                                {precoAtacadoCampanha !== null ? (
                                  <>
                                    <div className="text-[10px] text-rose-500 leading-tight">-{percentualCampanha}%</div>
                                    {formatarPreco(precoAtacadoCampanha)}
                                  </>
                                ) : (
                                  <span className="text-black">-</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right text-rose-900 bg-rose-50/30 whitespace-nowrap">
                                {precoVarejoCampanha !== null ? (
                                  <>
                                    <div className="text-[10px] text-rose-500 leading-tight">-{percentualCampanha}%</div>
                                    {formatarPreco(precoVarejoCampanha)}
                                  </>
                                ) : (
                                  <span className="text-black">-</span>
                                )}
                              </td>
                            </>
                          );
                        })()}
                        {matriz.empresas.map((e) => {
                          const dados = item.porLoja[String(e.cdEmpresa)];
                          return (
                            <td
                              key={e.cdEmpresa}
                              className="px-3 py-2 text-right cursor-default"
                              onMouseEnter={(ev) => dados && setTooltipCelula({ texto: tooltipGiro(dados.estoque, dados.venda, dados.giro, mesReferencia, item.mesesOportunidade, vendaMensalPorReferencia[item.referencia]?.[String(e.cdEmpresa)]), x: ev.clientX, y: ev.clientY })}
                              onMouseMove={(ev) => dados && setTooltipCelula({ texto: tooltipGiro(dados.estoque, dados.venda, dados.giro, mesReferencia, item.mesesOportunidade, vendaMensalPorReferencia[item.referencia]?.[String(e.cdEmpresa)]), x: ev.clientX, y: ev.clientY })}
                              onMouseLeave={() => setTooltipCelula(null)}
                            >
                              <CelulaGiro estoque={dados?.estoque ?? 0} giro={dados?.giro ?? null} />
                            </td>
                          );
                        })}
                        <td
                          className="px-3 py-2 text-right text-slate-700 bg-slate-50/50 whitespace-nowrap cursor-default"
                          onMouseEnter={(ev) => setTooltipCelula({ texto: tooltipEstoquePorLoja(item, matriz.empresas), x: ev.clientX, y: ev.clientY })}
                          onMouseMove={(ev) => setTooltipCelula({ texto: tooltipEstoquePorLoja(item, matriz.empresas), x: ev.clientX, y: ev.clientY })}
                          onMouseLeave={() => setTooltipCelula(null)}
                        >
                          {formatarQtd(item.estoqueTotal)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-700 bg-slate-50/50 whitespace-nowrap">{formatarGiro(item.vendaTotal)}</td>
                        <td
                          className="px-4 py-2 text-right font-semibold bg-gray-100/70 border-l-2 border-gray-200 cursor-default"
                          onMouseEnter={(ev) => setTooltipCelula({ texto: tooltipGiro(item.estoqueTotal, item.vendaTotal, item.giroTotal, mesReferencia, item.mesesOportunidade, vendaMensalTotalReferencia(item.referencia, matriz.empresas, vendaMensalPorReferencia)), x: ev.clientX, y: ev.clientY })}
                          onMouseMove={(ev) => setTooltipCelula({ texto: tooltipGiro(item.estoqueTotal, item.vendaTotal, item.giroTotal, mesReferencia, item.mesesOportunidade, vendaMensalTotalReferencia(item.referencia, matriz.empresas, vendaMensalPorReferencia)), x: ev.clientX, y: ev.clientY })}
                          onMouseLeave={() => setTooltipCelula(null)}
                        >
                          <CelulaGiro estoque={item.estoqueTotal} giro={item.giroTotal} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tooltipCelula && (
              <div
                className="fixed z-50 bg-gray-900 text-white text-xs rounded px-2.5 py-1.5 shadow-lg pointer-events-none whitespace-pre-line"
                style={{ left: tooltipCelula.x + 12, top: tooltipCelula.y + 12 }}
              >
                {tooltipCelula.texto}
              </div>
            )}

            {matriz && matriz.empresasFaltantes.length > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border-t border-amber-200 px-4 py-2">
                Sem cálculo pra {matriz.empresasFaltantes.map((e) => e.nome).join(', ')} nesse mês — as colunas dessas empresas ficam vazias até calcular.
              </p>
            )}
          </div>

          {fotoTooltip && (
            <div
              className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-xl p-1.5 pointer-events-none"
              style={{ left: fotoTooltip.x + 12, top: fotoTooltip.y + 12 }}
            >
              {fotoTooltip.carregando ? (
                <div className="w-[400px] h-[200px] flex items-center justify-center text-xs text-black">
                  Carregando...
                </div>
              ) : fotoTooltip.url && !fotoTooltip.erro ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={fotoTooltip.url}
                  alt={fotoTooltip.referencia}
                  className="block w-[400px] h-[400px] object-contain rounded"
                  onError={() => imagemFalhou(fotoTooltip.referencia)}
                />
              ) : (
                <div className="w-[400px] h-[200px] flex items-center justify-center text-center text-xs text-black">
                  {fotoTooltip.erro ? 'Não foi possível carregar a imagem' : 'Sem foto na loja'}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
