'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RotateCw, Loader2, ChevronDown, Calendar } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
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

const COR_BARRA = '#2a78d6';

function formatarQtd(valor: number): string {
  return valor.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
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
// estoque mas nao vendeu nada - o pior caso (estoque parado); "-" cinza so
// quando nao tem NADA (nem estoque nem venda) - referencias assim nem
// aparecem mais na tabela, mas uma loja isolada dentro de uma referencia
// com movimento em outras lojas pode cair aqui.
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
  return <span className="text-gray-400">-</span>;
}

// Tooltip da matriz por referencia: mostra a conta que chegou naquele giro
// (estoque atual / venda media dos ultimos 3 meses), tanto por loja quanto
// no total.
function tooltipGiro(estoque: number, venda: number, giro: number | null): string {
  const vendaFmt = venda.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (giro === null) {
    const motivo = estoque > 0 ? 'sem venda nos últimos 3 meses (SV-3M)' : 'sem estoque e sem venda no período';
    return `Estoque: ${formatarQtd(estoque)} ÷ Venda média: ${vendaFmt} = ${motivo}`;
  }
  return `Estoque: ${formatarQtd(estoque)} ÷ Venda média: ${vendaFmt} = ${formatarGiro(giro)}`;
}

function formatarPreco(valor: number | null): string {
  if (valor === null) return '-';
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function labelMes(anoMes: string): string {
  const [ano, mes] = anoMes.split('-');
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${nomes[Number(mes) - 1]}/${ano.slice(2)}`;
}

function nomeCurto(nome: string): string {
  return nome.length > 14 ? `${nome.slice(0, 13)}…` : nome;
}

// Apelidos especificos pro cabecalho da matriz - nao seguem um padrao
// generico pra derivar automaticamente, entao e uma lista fixa.
const APELIDOS_COLUNA_LOJA: Record<string, string> = {
  'RIO MAR RECIFE': 'RECIFE',
  'NORTH JOQUEI': 'JOQUEI',
  'RIOMAR KENNEDY': 'KENNEDY',
  ECOMMERCE: 'ECOM',
  'DOM LUIS': 'D.LUIS',
};

// So pro cabecalho da matriz por referencia: usa o apelido especifico
// quando tem um, senao tira "SHOPPING" e o sufixo de cidade que sobra
// depois (ex: "BARRA SHOPPING - RJ" -> "BARRA", "SALVADOR SHOPPING - BA"
// -> "SALVADOR", "MORUMBI SHOPPING" -> "MORUMBI") - nao mexe no nome em
// nenhum outro lugar da tela (filtro de lojas, tabela principal), so no
// cabecalho de coluna, onde o espaco e curto.
function nomeColunaLoja(nome: string): string {
  if (APELIDOS_COLUNA_LOJA[nome]) return APELIDOS_COLUNA_LOJA[nome];
  const limpo = nome
    .replace(/\s*SHOPPING\s*/gi, ' ')
    .replace(/\s*-\s*[A-Z]{2}\s*$/i, '')
    .trim();
  return nomeCurto(limpo || nome);
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
  valor: number;
  tooltip?: string;
}

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

// Barras do giro (razao estoque/venda media, "meses de cobertura") - mesmo
// estilo dos graficos de % do CMV Detalhado, so que o eixo/rotulo mostra um
// numero com 2 casas em vez de %.
function GraficoGiro({ dados }: { dados: BarraDado[] }) {
  if (dados.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem giro calculado ainda.</p>;
  }
  const muitasCategorias = dados.length > 8;

  return (
    <div role="img" aria-label="Giro por loja e fábrica">
      <ResponsiveContainer width="100%" height={muitasCategorias ? 320 : 260}>
        <BarChart data={dados} margin={{ top: 24, right: 8, left: 0, bottom: muitasCategorias ? 64 : 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#52514e' }}
            interval={0}
            angle={muitasCategorias ? -35 : 0}
            textAnchor={muitasCategorias ? 'end' : 'middle'}
            axisLine={{ stroke: '#c3c2b7' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#898781' }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip content={<TooltipBarra />} cursor={{ fill: 'rgba(11,11,11,0.04)' }} />
          <Bar dataKey="valor" fill={COR_BARRA} radius={[4, 4, 0, 0]} maxBarSize={56}>
            <LabelList
              dataKey="valor"
              position="top"
              formatter={(v: React.ReactNode) => formatarGiro(v as number)}
              style={{ fontSize: 11, fontWeight: 700, fill: '#0b0b0b' }}
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
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{titulo}</p>
      <p className="text-3xl font-bold text-gray-900 mt-1">{dado ? formatarGiro(dado.giro) : '-'}</p>
      <p className="text-xs text-gray-400 mt-0.5">meses de cobertura</p>
      {dado && (
        <div className="flex justify-between text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100">
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
  const [matrizOrdenarPor, setMatrizOrdenarPor] = useState('referencia');
  const [matrizOrdem, setMatrizOrdem] = useState<'asc' | 'desc'>('asc');
  const MATRIZ_POR_PAGINA = 50;

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
  async function buscarMatriz(mesRef: string, empresasParam: string, pagina: number, ordenarPor: string, ordem: 'asc' | 'desc', giroMinimo: string) {
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
      const response = await fetch(`/api/giro/matriz-produtos?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) {
        setErro(`Erro do backend: ${data.detail || data.error || 'Erro desconhecido'}`);
        return;
      }
      setMatriz(data);
      setMatrizPagina(pagina);
    } catch (error) {
      console.error('Erro ao buscar matriz de giro:', error);
      setErro('Erro ao buscar a matriz por loja.');
    } finally {
      setMatrizCarregando(false);
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
    setMatrizOrdenarPor('referencia');
    setMatrizOrdem('asc');
    buscarMatriz(mesReferencia, empresasParam, 1, 'referencia', 'asc', matrizGiroMinimo);
  }

  function trocarPaginaMatriz(novaPagina: number) {
    buscarMatriz(mesReferencia, Array.from(empresasSelecionadas).join(','), novaPagina, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo);
  }

  // Clicar numa coluna ja ordenada inverte o sentido; numa coluna nova,
  // comeca ascendente. Sempre volta pra pagina 1 (a ordenacao e da base
  // inteira, nao so da pagina atual).
  function ordenarMatrizPor(coluna: string) {
    const novoOrdem: 'asc' | 'desc' = matrizOrdenarPor === coluna && matrizOrdem === 'asc' ? 'desc' : 'asc';
    setMatrizOrdenarPor(coluna);
    setMatrizOrdem(novoOrdem);
    buscarMatriz(mesReferencia, Array.from(empresasSelecionadas).join(','), 1, coluna, novoOrdem, matrizGiroMinimo);
  }

  // Aplica o filtro "giro maior que X" digitado - volta pra pagina 1
  // mantendo a ordenacao atual.
  function aplicarFiltroGiroMinimo() {
    buscarMatriz(mesReferencia, Array.from(empresasSelecionadas).join(','), 1, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo);
  }

  function limparFiltroGiroMinimo() {
    setMatrizGiroMinimo('');
    buscarMatriz(mesReferencia, Array.from(empresasSelecionadas).join(','), 1, matrizOrdenarPor, matrizOrdem, '');
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
      await buscarMatriz(mesReferencia, empresasParam, matrizPagina, matrizOrdenarPor, matrizOrdem, matrizGiroMinimo);
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
  const itensOrdenados = dados
    ? [...dados.itens].sort((a, b) => (b.giro ?? -1) - (a.giro ?? -1))
    : [];

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-rose-100 rounded-lg">
            <RotateCw className="w-6 h-6 text-rose-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">Giro</h1>
            <p className="text-sm text-gray-500">Estoque no mês x venda média dos 3 meses cheios anteriores, por loja, fábrica e consolidado.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Período</h2>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-gray-500">Mês de referência</label>
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
              <ChevronDown className="w-4 h-4 text-gray-500" />
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
                  <button className="text-xs font-medium text-gray-600 hover:text-gray-900" onClick={() => setEmpresasSelecionadas(new Set())}>
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
              <ChevronDown className="w-4 h-4 text-gray-500" />
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
                  <button className="text-xs font-medium text-gray-600 hover:text-gray-900" onClick={() => setStatusSelecionados(new Set())}>
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
          <p className="text-xs text-gray-400 mt-3">
            Último cálculo em {new Date(dados.dtCalculado).toLocaleString('pt-BR')}
            {dados.mesIni && dados.mesFim && <> — venda média referente a {labelMes(dados.mesIni)} a {labelMes(dados.mesFim)}</>}
          </p>
        )}
      </div>

      {erro && <p className="text-sm text-red-600">{erro}</p>}

      {carregandoInicial && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          <span className="ml-3 text-gray-600">Carregando...</span>
        </div>
      )}

      {!carregandoInicial && !consultaExecutada && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
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
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
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
            <h2 className="text-base font-semibold text-gray-800 mb-1">Giro por loja e fábrica</h2>
            <p className="text-xs text-gray-500 mb-3">
              Giro = estoque no mês ÷ venda média mensal dos 3 meses cheios anteriores — meses de cobertura do estoque no ritmo de venda (quanto menor, mais rápido o giro).
            </p>
            <GraficoGiro
              dados={itensOrdenados
                .filter((i) => i.giro !== null)
                .map((i) => ({
                  chave: i.cdEmpresa,
                  label: nomeCurto(i.nome),
                  valor: i.giro as number,
                  tooltip: `${i.nome}: ${formatarGiro(i.giro)} meses de cobertura (estoque ${formatarQtd(i.estoqueAtual)} un. / venda média ${formatarQtd(i.vendaMedia3m)} un./mês)`,
                }))}
            />
          </div>

          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Empresa</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Tipo</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Estoque Atual</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Venda Média 3m</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600">Giro</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {itensOrdenados.map((item) => (
                    <tr key={item.cdEmpresa} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-800">{item.nome}</td>
                      <td className="px-4 py-2 text-gray-500 capitalize">{item.tipo}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.estoqueAtual)}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{formatarQtd(item.vendaMedia3m)}</td>
                      <td className="px-4 py-2 text-right font-medium text-gray-900">{formatarGiro(item.giro)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>


          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="px-4 pt-3 flex items-center gap-2 text-sm flex-wrap">
              <label htmlFor="giro-minimo" className="text-gray-600">Giro maior que:</label>
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
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md text-xs disabled:opacity-40 transition-colors"
              >
                Aplicar
              </button>
              {matrizGiroMinimo.trim() !== '' && (
                <button
                  onClick={limparFiltroGiroMinimo}
                  disabled={matrizCarregando}
                  className="text-xs text-gray-400 hover:text-gray-600 underline disabled:opacity-40"
                >
                  Limpar
                </button>
              )}
            </div>
            <div className="p-4 pb-2 flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-800">Giro por referência e loja</h2>
                <p className="text-xs text-gray-500">
                  Cada linha é uma referência (soma de todas as cores/tamanhos dela) — uma coluna de giro por
                  loja/fábrica selecionada, e o giro total no final (estoque somado ÷ venda média somada de todas as
                  empresas do filtro).
                </p>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-500">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Giro rápido</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Atenção</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" /> Estoque parado</span>
                  <span className="flex items-center gap-1">
                    <span className="px-1 py-0.5 text-[10px] font-semibold rounded bg-amber-50 text-amber-700 border border-amber-200">SV-3M</span>
                    Tem estoque mas sem venda nos últimos 3 meses
                  </span>
                  <span className="flex items-center gap-1"><span className="text-gray-400 font-medium">-</span> Sem estoque e sem venda nessa loja</span>
                </div>
              </div>
              {matriz && (
                <div className="flex items-center gap-2 text-sm shrink-0">
                  <button
                    onClick={() => trocarPaginaMatriz(matrizPagina - 1)}
                    disabled={matrizCarregando || matrizPagina <= 1}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md disabled:opacity-40 transition-colors"
                  >
                    ← Anterior
                  </button>
                  <span className="text-gray-500 text-xs whitespace-nowrap">
                    Página {matriz.pagina} de {matriz.totalPaginas} ({formatarQtd(matriz.totalProdutos)} produtos)
                  </span>
                  <button
                    onClick={() => trocarPaginaMatriz(matrizPagina + 1)}
                    disabled={matrizCarregando || matrizPagina >= matriz.totalPaginas}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md disabled:opacity-40 transition-colors"
                  >
                    Próxima →
                  </button>
                </div>
              )}
            </div>

            {matrizCarregando && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-rose-600" />
                <span className="ml-3 text-gray-500 text-sm">Carregando...</span>
              </div>
            )}

            {!matrizCarregando && matriz && matriz.itens.length === 0 && (
              <p className="text-sm text-gray-400 py-8 text-center">Nenhum produto encontrado.</p>
            )}

            {!matrizCarregando && matriz && matriz.itens.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 sticky left-0 bg-gray-50 z-10 min-w-[100px]">
                        <button onClick={() => ordenarMatrizPor('referencia')} className="flex items-center gap-1 hover:text-gray-900">
                          Referência{indicadorOrdenacao('referencia')}
                        </button>
                      </th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 sticky left-[100px] bg-gray-50 z-10 min-w-[220px]">
                        <button onClick={() => ordenarMatrizPor('nome')} className="flex items-center gap-1 hover:text-gray-900">
                          Produto{indicadorOrdenacao('nome')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-blue-700 bg-blue-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoFabrica')} className="flex items-center gap-1 ml-auto hover:text-blue-900">
                          Preço Fábrica{indicadorOrdenacao('precoFabrica')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-blue-700 bg-blue-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoAtacado')} className="flex items-center gap-1 ml-auto hover:text-blue-900">
                          Preço Atacado{indicadorOrdenacao('precoAtacado')}
                        </button>
                      </th>
                      <th className="text-right px-3 py-2 font-medium text-blue-700 bg-blue-50/60 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('precoVarejo')} className="flex items-center gap-1 ml-auto hover:text-blue-900">
                          Preço Varejo{indicadorOrdenacao('precoVarejo')}
                        </button>
                      </th>
                      {matriz.empresas.map((e) => (
                        <th key={e.cdEmpresa} className="text-right px-3 py-2 font-medium text-gray-600 whitespace-nowrap">
                          <button
                            onClick={() => ordenarMatrizPor(String(e.cdEmpresa))}
                            className="flex items-center gap-1 ml-auto hover:text-gray-900"
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
                      <th className="text-right px-4 py-2 font-semibold text-gray-800 bg-gray-200/70 border-l-2 border-gray-300 whitespace-nowrap">
                        <button onClick={() => ordenarMatrizPor('total')} className="flex items-center gap-1 ml-auto hover:text-gray-600">
                          Total{indicadorOrdenacao('total')}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {matriz.itens.map((item, idx) => (
                      <tr key={item.referencia} className={`${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-rose-50 transition-colors`}>
                        <td className="px-4 py-2 text-gray-500 sticky left-0 bg-inherit z-10">{item.referencia}</td>
                        <td className="px-4 py-2 text-gray-800 sticky left-[100px] bg-inherit z-10">{item.nome}</td>
                        <td className="px-3 py-2 text-right text-blue-900 bg-blue-50/30 whitespace-nowrap">{formatarPreco(item.precoFabrica)}</td>
                        <td className="px-3 py-2 text-right text-blue-900 bg-blue-50/30 whitespace-nowrap">{formatarPreco(item.precoAtacado)}</td>
                        <td className="px-3 py-2 text-right text-blue-900 bg-blue-50/30 whitespace-nowrap">{formatarPreco(item.precoVarejo)}</td>
                        {matriz.empresas.map((e) => {
                          const dados = item.porLoja[String(e.cdEmpresa)];
                          return (
                            <td
                              key={e.cdEmpresa}
                              className="px-3 py-2 text-right cursor-default"
                              onMouseEnter={(ev) => dados && setTooltipCelula({ texto: tooltipGiro(dados.estoque, dados.venda, dados.giro), x: ev.clientX, y: ev.clientY })}
                              onMouseMove={(ev) => dados && setTooltipCelula({ texto: tooltipGiro(dados.estoque, dados.venda, dados.giro), x: ev.clientX, y: ev.clientY })}
                              onMouseLeave={() => setTooltipCelula(null)}
                            >
                              {dados ? <CelulaGiro estoque={dados.estoque} giro={dados.giro} /> : <span className="text-gray-400">-</span>}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right text-slate-700 bg-slate-50/50 whitespace-nowrap">{formatarQtd(item.estoqueTotal)}</td>
                        <td className="px-3 py-2 text-right text-slate-700 bg-slate-50/50 whitespace-nowrap">{formatarGiro(item.vendaTotal)}</td>
                        <td
                          className="px-4 py-2 text-right font-semibold bg-gray-100/70 border-l-2 border-gray-200 cursor-default"
                          onMouseEnter={(ev) => setTooltipCelula({ texto: tooltipGiro(item.estoqueTotal, item.vendaTotal, item.giroTotal), x: ev.clientX, y: ev.clientY })}
                          onMouseMove={(ev) => setTooltipCelula({ texto: tooltipGiro(item.estoqueTotal, item.vendaTotal, item.giroTotal), x: ev.clientX, y: ev.clientY })}
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
                className="fixed z-50 bg-gray-900 text-white text-xs rounded px-2.5 py-1.5 shadow-lg pointer-events-none whitespace-nowrap"
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
        </>
      )}
    </div>
  );
}
