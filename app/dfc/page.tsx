'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Calendar,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  DollarSign,
  HelpCircle,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';

import { type PeriodoDRE } from '../dre-fabrica/dreCalculos';
import { formatarValor } from '../utils/formatters';

interface OpcaoFiltro {
  valor: string;
  label: string;
  tipo: string;
}

interface Duplicata {
  id: number;
  nrDuplicata?: string;
  cdDespesaItem: number;
  descricao: string;
  dtEmissao: string;
  dtVencimento?: string;
  dtBaixa?: string;
  valor: number;
  cdCCusto: number;
  nomeCCusto: string;
  cdFornecedor?: number | string;
  nmFornecedor?: string;
}

interface SubgrupoDFC {
  codigo: string;
  nome: string;
}

interface GrupoDFC {
  codigo: string;
  nome: string;
  subgrupos: SubgrupoDFC[];
}

interface DespesaValorItem {
  cdDespesaitem: number;
  descricao: string;
  total: number;
  [periodo: string]: number | string;
}

type ValoresPorConta = Record<string, Record<string, number>>;
type DespesasPorSubgrupo = Record<string, DespesaValorItem[]>;

export default function DFCPage() {
  const [loading, setLoading] = useState(false);
  const [consultaExecutada, setConsultaExecutada] = useState(false);
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
  const [grupos, setGrupos] = useState<GrupoDFC[]>([]);
  const [gruposReceita, setGruposReceita] = useState<GrupoDFC[]>([]);
  const [valores, setValores] = useState<ValoresPorConta>({});
  const [despesasPorSubgrupo, setDespesasPorSubgrupo] = useState<DespesasPorSubgrupo>({});
  const [nomesCustomizados, setNomesCustomizados] = useState<Record<string, string>>({});
  const [tiposCusto, setTiposCusto] = useState<Record<string, 'fixo' | 'variavel'>>({});
  const [gruposOcultos, setGruposOcultos] = useState<Set<string>>(new Set());
  const [naoClassificados, setNaoClassificados] = useState(0);
  const [prazoMedioRecebimento, setPrazoMedioRecebimento] = useState<number | null>(null);
  const [prazoMedioPagamento, setPrazoMedioPagamento] = useState<number | null>(null);
  const [prazoMedioRecebimentoPorSubgrupo, setPrazoMedioRecebimentoPorSubgrupo] = useState<Record<string, number>>({});
  const [gruposExpandidos, setGruposExpandidos] = useState<Set<string>>(new Set(['REC', 'OP', 'INV', 'FIN']));
  const [subgruposExpandidos, setSubgruposExpandidos] = useState<Set<string>>(new Set());
  const [statusCarregamento, setStatusCarregamento] = useState<string | null>(null);
  const [filtroInfo, setFiltroInfo] = useState<string>('');
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState<string | null>(null);
  const [modalDuplicatas, setModalDuplicatas] = useState<{
    aberto: boolean;
    conta: string;
    nomeConta: string;
    periodo: string;
    labelPeriodo: string;
    duplicatas: Duplicata[];
    total: number;
    loading: boolean;
  }>({
    aberto: false,
    conta: '',
    nomeConta: '',
    periodo: '',
    labelPeriodo: '',
    duplicatas: [],
    total: 0,
    loading: false,
  });

  const primeiraRenderizacaoRef = React.useRef(true);

  useEffect(() => {
    try {
      const salvo = localStorage.getItem('dfc_filtros');
      if (salvo) {
        const { dataInicio: di, dataFim: df, filtro: f } = JSON.parse(salvo);
        if (di) setDataInicio(di);
        if (df) setDataFim(df);
        if (f) setFiltro(f);
      }
    } catch (error) {
      console.error('Erro ao restaurar filtros do DFC:', error);
    }
  }, []);

  useEffect(() => {
    if (primeiraRenderizacaoRef.current) {
      primeiraRenderizacaoRef.current = false;
      return;
    }
    try {
      localStorage.setItem('dfc_filtros', JSON.stringify({ dataInicio, dataFim, filtro }));
    } catch (error) {
      console.error('Erro ao salvar filtros do DFC:', error);
    }
  }, [dataInicio, dataFim, filtro]);

  useEffect(() => {
    async function carregarOpcoesFiltro() {
      try {
        const response = await fetch('/api/dre/centros-custo');
        const data = await response.json();
        if (data.opcoes) setOpcoesFiltro(data.opcoes);
      } catch (error) {
        console.error('Erro ao carregar opcoes de filtro:', error);
      }
    }
    carregarOpcoesFiltro();
  }, []);

  useEffect(() => {
    async function carregarPlanoContas() {
      try {
        const response = await fetch('/api/dfc/plano-contas', { cache: 'no-store' });
        const data = await response.json();
        setGrupos(data.grupos || []);
        setGruposReceita(data.gruposReceita || []);
      } catch (error) {
        console.error('Erro ao carregar plano de contas do DFC:', error);
      }
    }
    carregarPlanoContas();
  }, []);

  useEffect(() => {
    async function carregarNomesCustomizados() {
      try {
        const response = await fetch('/api/plano-contas-dre/nomes', { cache: 'no-store' });
        const data = await response.json();
        setNomesCustomizados(data || {});
      } catch (error) {
        console.error('Erro ao buscar nomes customizados do plano de contas:', error);
      }
    }
    carregarNomesCustomizados();
  }, []);

  useEffect(() => {
    async function carregarTiposCusto() {
      try {
        const response = await fetch('/api/plano-contas-dre/tipo-custo', { cache: 'no-store' });
        const data = await response.json();
        setTiposCusto(data || {});
      } catch (error) {
        console.error('Erro ao buscar tipo de custo do plano de contas:', error);
      }
    }
    carregarTiposCusto();
  }, []);

  useEffect(() => {
    async function carregarGruposOcultos() {
      try {
        const response = await fetch('/api/dfc/grupos-ocultos', { cache: 'no-store' });
        const data = await response.json();
        setGruposOcultos(new Set(data.ocultos || []));
      } catch (error) {
        console.error('Erro ao buscar grupos ocultos do DFC:', error);
      }
    }
    carregarGruposOcultos();
  }, []);

  async function buscarDados() {
    setLoading(true);
    setStatusCarregamento(null);
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 300000);
      const params = new URLSearchParams({ dataInicio, dataFim, filtro });
      const response = await fetch(`/api/dfc/unificada?${params.toString()}`, {
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
        setNaoClassificados(m.naoClassificados || 0);
        setPrazoMedioRecebimento(m.prazoMedioRecebimento ?? null);
        setPrazoMedioPagamento(m.prazoMedioPagamento ?? null);
        setPrazoMedioRecebimentoPorSubgrupo(m.prazoMedioRecebimentoPorSubgrupo || {});
      }

      if (data.periodos) setPeriodos(data.periodos);

      // Os saldos de caixa (checkpoints e final) sao recalculados no cliente,
      // reagindo aos grupos ocultos - ver useMemo `checkpointsSaldo` abaixo.
      setValores(data.valores || {});
      setDespesasPorSubgrupo(data.despesasPorSubgrupo || {});
      setUltimaAtualizacao(new Date().toLocaleString('pt-BR'));
      setConsultaExecutada(true);
    } catch (error) {
      console.error('Erro ao buscar dados do DFC:', error);
      setStatusCarregamento('Erro ao buscar dados do DFC. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  async function abrirDuplicatas(
    conta: string,
    nomeConta: string,
    periodo: string,
    labelPeriodo: string,
    despesaItem?: number
  ) {
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
      const params = new URLSearchParams({ conta, periodo, filtro });
      if (despesaItem) params.set('despesaItem', String(despesaItem));
      const response = await fetch(`/api/dfc/unificada/duplicatas?${params.toString()}`, {
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
      console.error('Erro ao buscar duplicatas do DFC:', error);
      setModalDuplicatas((prev) => ({ ...prev, loading: false }));
    }
  }

  function fecharModal() {
    setModalDuplicatas((prev) => ({ ...prev, aberto: false }));
  }

  function toggleGrupo(codigo: string) {
    setGruposExpandidos((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  function expandirTodos() {
    setGruposExpandidos(new Set([...gruposReceita, ...grupos].map((g) => g.codigo)));
  }

  function recolherTodos() {
    setGruposExpandidos(new Set());
    setSubgruposExpandidos(new Set());
  }

  function formatarData(dataStr: string | null | undefined): string {
    if (!dataStr) return '-';
    const [ano, mes, dia] = dataStr.split('T')[0].split('-');
    return `${dia}/${mes}/${ano}`;
  }

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

  function definirAnoAtual() {
    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    const fimMesAnterior = new Date(anoAtual, hoje.getMonth(), 0);
    const dataFimAnoAtual =
      fimMesAnterior.getFullYear() === anoAtual ? fimMesAnterior : new Date(anoAtual, hoje.getMonth() + 1, 0);
    setDataInicio(`${anoAtual}-01-01`);
    setDataFim(
      `${dataFimAnoAtual.getFullYear()}-${String(dataFimAnoAtual.getMonth() + 1).padStart(2, '0')}-${String(dataFimAnoAtual.getDate()).padStart(2, '0')}`
    );
  }

  function valorConta(codigo: string, periodoKey?: string): number {
    const v = valores[codigo];
    if (!v) return 0;
    if (periodoKey) return v[periodoKey] || 0;
    return v.total || 0;
  }

  // Receita bruta = soma de todos os subgrupos de recebimento do grupo REC
  // (dinheiro, e futuramente cartão/pix/boleto...), exceto devoluções
  // (REC.99, que fica de fora por convenção).
  function receitaBrutaValor(periodoKey?: string): number {
    const grupoRec = gruposReceita.find((g) => g.codigo === 'REC');
    if (!grupoRec) return 0;
    return grupoRec.subgrupos
      .filter((s) => s.codigo !== 'REC.99')
      .reduce((acc, s) => acc + valorConta(s.codigo, periodoKey), 0);
  }

  const receitaBruta = receitaBrutaValor();
  const totalOperacional = valorConta('OP');
  const totalInvestimentoFinanciamento = valorConta('INV') + valorConta('FIN');

  // Saldo de caixa corrido: soma so os grupos VISIVEIS (grupo oculto na
  // Config DFC nao entra na conta, nem na tela nem no calculo). Um checkpoint
  // por grupo de despesa visivel, na ordem OP -> INV -> FIN; NAO_CLASSIFICADO
  // entra junto do checkpoint de Operacional.
  const { checkpointsSaldo, saldoBase } = useMemo(() => {
    const passos: { codigo: string; nome: string; valores: Record<string, number> }[] = [];
    const acumulado: Record<string, number> = { total: 0 };
    for (const p of periodos) acumulado[p.key] = 0;

    const somarEm = (codigo: string) => {
      const v = valores[codigo];
      if (!v) return;
      acumulado.total += v.total || 0;
      for (const p of periodos) acumulado[p.key] = (acumulado[p.key] || 0) + (v[p.key] || 0);
    };

    for (const g of gruposReceita) {
      if (!gruposOcultos.has(g.codigo)) somarEm(g.codigo);
    }
    const base = { ...acumulado };

    for (const g of grupos) {
      if (gruposOcultos.has(g.codigo)) continue;
      somarEm(g.codigo);
      if (g.codigo === 'OP') somarEm('NAO_CLASSIFICADO');
      passos.push({
        codigo: `SALDO_APOS_${g.codigo}`,
        nome: (nomesCustomizados[g.codigo] ?? g.nome).toLowerCase(),
        valores: { ...acumulado },
      });
    }

    return { checkpointsSaldo: passos, saldoBase: base };
  }, [valores, grupos, gruposReceita, gruposOcultos, periodos, nomesCustomizados]);

  const saldoFinal = checkpointsSaldo.length > 0 ? checkpointsSaldo[checkpointsSaldo.length - 1].valores : saldoBase;
  const saldoCaixa = saldoFinal.total || 0;

  const gruposPorAno = useMemo(() => {
    const anos: { ano: string; qtd: number }[] = [];
    for (const periodo of periodos) {
      const ano = periodo.key.split('-')[0];
      const ultimo = anos[anos.length - 1];
      if (ultimo && ultimo.ano === ano) ultimo.qtd += 1;
      else anos.push({ ano, qtd: 1 });
    }
    return anos;
  }, [periodos]);

  function calcularAV(valor: number): string {
    if (receitaBruta === 0) return '-';
    const receitaAbs = Math.abs(receitaBruta);
    const percentual = (valor / receitaAbs) * 100;
    const percentualFinal = valor < 0 ? -Math.abs(percentual) : Math.abs(percentual);
    return `${percentualFinal.toFixed(2)}%`;
  }

  function calcularAVPeriodo(valor: number, periodo: string): string {
    const receitaPeriodo = receitaBrutaValor(periodo);
    if (receitaPeriodo === 0) return '-';
    const receitaAbs = Math.abs(receitaPeriodo);
    const percentual = (valor / receitaAbs) * 100;
    const percentualFinal = valor < 0 ? -Math.abs(percentual) : Math.abs(percentual);
    return `${percentualFinal.toFixed(2)}%`;
  }

  function renderizarLinhaValores(
    codigo: string,
    nome: string,
    nivel: number,
    opcoes: {
      bold?: boolean;
      corFundo?: string;
      clicavel?: boolean;
      corTextoTotal?: string;
      expandivel?: boolean;
      expandido?: boolean;
      onToggle?: () => void;
      valoresOverride?: Record<string, number>;
      tooltip?: string;
    } = {}
  ) {
    const { bold, corFundo, clicavel, corTextoTotal, expandivel, expandido, onToggle, valoresOverride, tooltip } = opcoes;
    const valorDe = (periodoKey?: string) => {
      if (valoresOverride) return (periodoKey ? valoresOverride[periodoKey] : valoresOverride.total) || 0;
      return valorConta(codigo, periodoKey);
    };
    const total = valorDe();
    return (
      <tr key={codigo} className={`${corFundo || 'bg-white'} hover:bg-gray-100 transition-colors`}>
        <td className="px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10">
          <div
            className={`flex items-center gap-2 ${expandivel ? 'cursor-pointer' : ''}`}
            style={{ paddingLeft: `${nivel * 16}px` }}
            onClick={expandivel ? onToggle : undefined}
          >
            {expandivel ? (
              expandido ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <div className="w-4" />
            )}
            <span className="font-mono text-xs text-gray-500">{codigo}</span>
            <span className={`text-sm ${bold ? 'font-bold' : ''}`}>{nome}</span>
            {tooltip && (
              <span className="group relative inline-flex text-gray-400 hover:text-gray-600">
                <HelpCircle className="w-3.5 h-3.5" strokeWidth={2.5} />
                <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-max max-w-xs whitespace-normal rounded bg-gray-900 px-2 py-1.5 text-left text-xs font-normal leading-snug text-white shadow-lg group-hover:block">
                  {tooltip}
                </span>
              </span>
            )}
          </div>
        </td>
        {periodos.map((periodo) => {
          const valorPeriodo = valorDe(periodo.key);
          const podeClicar = clicavel && valorPeriodo !== 0;
          return (
            <React.Fragment key={periodo.key}>
              <td className={`px-2 py-2 border-b border-gray-200 text-right text-sm whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-600' : ''}`}>
                {podeClicar ? (
                  <button
                    onClick={() => abrirDuplicatas(codigo, nome, periodo.key, periodo.label)}
                    className="hover:underline hover:text-blue-600 cursor-pointer"
                    title="Clique para ver duplicatas pagas nesse mês"
                  >
                    {formatarValor(valorPeriodo)}
                  </button>
                ) : (
                  formatarValor(valorPeriodo)
                )}
              </td>
              <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-gray-50 whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                {calcularAVPeriodo(valorPeriodo, periodo.key)}
              </td>
            </React.Fragment>
          );
        })}
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold whitespace-nowrap ${corTextoTotal || (total < 0 ? 'text-red-600' : '')}`}>
          {formatarValor(total)}
        </td>
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm whitespace-nowrap ${total < 0 ? 'text-red-500' : 'text-gray-600'}`}>
          {calcularAV(total)}
        </td>
      </tr>
    );
  }

  function renderizarLinhaDespesa(item: DespesaValorItem, subgrupoCodigo: string, nivel: number) {
    const codigo = String(item.cdDespesaitem);
    const total = item.total;
    return (
      <tr key={`${subgrupoCodigo}-${codigo}`} className="bg-white hover:bg-gray-100 transition-colors">
        <td className="px-4 py-1.5 border-b border-gray-100 sticky left-0 bg-inherit z-10">
          <div className="flex items-center gap-2" style={{ paddingLeft: `${nivel * 16}px` }}>
            <div className="w-3.5" />
            <span className="font-mono text-[11px] text-gray-400">{codigo}</span>
            <span className="text-xs text-gray-600">{item.descricao}</span>
          </div>
        </td>
        {periodos.map((periodo) => {
          const valorPeriodo = (item[periodo.key] as number) || 0;
          const podeClicar = valorPeriodo !== 0;
          return (
            <React.Fragment key={periodo.key}>
              <td className={`px-2 py-1.5 border-b border-gray-100 text-right text-xs whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-500' : ''}`}>
                {podeClicar ? (
                  <button
                    onClick={() => abrirDuplicatas(subgrupoCodigo, item.descricao, periodo.key, periodo.label, item.cdDespesaitem)}
                    className="hover:underline hover:text-blue-600 cursor-pointer"
                    title="Clique para ver duplicatas pagas nesse mês"
                  >
                    {formatarValor(valorPeriodo)}
                  </button>
                ) : (
                  formatarValor(valorPeriodo)
                )}
              </td>
              <td className={`px-2 py-1.5 border-b border-gray-100 text-right text-[11px] bg-gray-50 whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                {calcularAVPeriodo(valorPeriodo, periodo.key)}
              </td>
            </React.Fragment>
          );
        })}
        <td className={`px-3 py-1.5 border-b border-gray-100 text-right text-xs font-semibold whitespace-nowrap ${total < 0 ? 'text-red-500' : ''}`}>
          {formatarValor(total)}
        </td>
        <td className={`px-3 py-1.5 border-b border-gray-100 text-right text-[11px] whitespace-nowrap ${total < 0 ? 'text-red-400' : 'text-gray-400'}`}>
          {calcularAV(total)}
        </td>
      </tr>
    );
  }

  function toggleSubgrupo(codigo: string) {
    setSubgruposExpandidos((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  function renderizarGrupo(grupo: GrupoDFC): React.ReactNode[] {
    const linhas: React.ReactNode[] = [];
    const expandido = gruposExpandidos.has(grupo.codigo);
    const total = valorConta(grupo.codigo);

    linhas.push(
      <tr key={grupo.codigo} className="bg-purple-50 font-bold text-purple-900 hover:bg-purple-100 transition-colors">
        <td className="px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => toggleGrupo(grupo.codigo)}>
            {expandido ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <span className="font-mono text-xs text-purple-700">{grupo.codigo}</span>
            <span className="text-sm font-bold">{nomesCustomizados[grupo.codigo] ?? grupo.nome}</span>
          </div>
        </td>
        {periodos.map((periodo) => {
          const valorPeriodo = valorConta(grupo.codigo, periodo.key);
          return (
            <React.Fragment key={periodo.key}>
              <td className={`px-2 py-2 border-b border-gray-200 text-right text-sm font-bold whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-600' : ''}`}>
                {formatarValor(valorPeriodo)}
              </td>
              <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-purple-50 whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                {calcularAVPeriodo(valorPeriodo, periodo.key)}
              </td>
            </React.Fragment>
          );
        })}
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold whitespace-nowrap ${total < 0 ? 'text-red-600' : ''}`}>
          {formatarValor(total)}
        </td>
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm whitespace-nowrap ${total < 0 ? 'text-red-500' : 'text-gray-600'}`}>
          {calcularAV(total)}
        </td>
      </tr>
    );

    const renderizarLinhaSubgrupo = (sub: SubgrupoDFC, nivelSub: number) => {
      const despesasDoSub = despesasPorSubgrupo[sub.codigo] || [];
      const subExpandido = subgruposExpandidos.has(sub.codigo);
      linhas.push(
        renderizarLinhaValores(sub.codigo, nomesCustomizados[sub.codigo] ?? sub.nome, nivelSub, {
          clicavel: true,
          expandivel: despesasDoSub.length > 0,
          expandido: subExpandido,
          onToggle: () => toggleSubgrupo(sub.codigo),
        })
      );
      if (subExpandido) {
        const despesasOrdenadas = [...despesasDoSub].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
        for (const item of despesasOrdenadas) {
          linhas.push(renderizarLinhaDespesa(item, sub.codigo, nivelSub + 1));
        }
      }
    };

    if (expandido) {
      if (grupo.codigo === 'OP') {
        const fixos = grupo.subgrupos.filter((s) => tiposCusto[s.codigo] === 'fixo');
        const variaveis = grupo.subgrupos.filter((s) => tiposCusto[s.codigo] === 'variavel');
        const semClassificacao = grupo.subgrupos.filter((s) => !tiposCusto[s.codigo]);

        const ordenarPorValor = (itens: SubgrupoDFC[]) =>
          [...itens].sort((a, b) => Math.abs(valorConta(b.codigo)) - Math.abs(valorConta(a.codigo)));

        const renderizarBloco = (titulo: string, corTexto: string, itens: SubgrupoDFC[]) => {
          if (itens.length === 0) return;
          const totalGeral = itens.reduce((acc, item) => acc + valorConta(item.codigo), 0);
          linhas.push(
            <tr key={`bloco-${grupo.codigo}-${titulo}`} className="bg-gray-50">
              <td className="px-4 py-1.5 border-b border-gray-200 sticky left-0 bg-gray-50 z-10" style={{ paddingLeft: '16px' }}>
                <span className={`text-[11px] font-bold tracking-wide ${corTexto}`}>{titulo}</span>
              </td>
              {periodos.map((periodo) => {
                const totalPeriodo = itens.reduce((acc, item) => acc + valorConta(item.codigo, periodo.key), 0);
                return (
                  <React.Fragment key={periodo.key}>
                    <td className={`px-2 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-xs font-bold whitespace-nowrap ${totalPeriodo < 0 ? 'text-red-600' : 'text-gray-700'}`}>
                      {formatarValor(totalPeriodo)}
                    </td>
                    <td className={`px-2 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-[11px] whitespace-nowrap ${totalPeriodo < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                      {calcularAVPeriodo(totalPeriodo, periodo.key)}
                    </td>
                  </React.Fragment>
                );
              })}
              <td className={`px-3 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-xs font-bold whitespace-nowrap ${totalGeral < 0 ? 'text-red-600' : 'text-gray-700'}`}>
                {formatarValor(totalGeral)}
              </td>
              <td className={`px-3 py-1.5 border-b border-gray-200 bg-gray-50 text-right text-[11px] whitespace-nowrap ${totalGeral < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                {calcularAV(totalGeral)}
              </td>
            </tr>
          );
          for (const sub of ordenarPorValor(itens)) {
            renderizarLinhaSubgrupo(sub, 2);
          }
        };

        renderizarBloco('DESPESAS FIXAS', 'text-blue-700', fixos);
        renderizarBloco('DESPESAS VARIÁVEIS', 'text-orange-700', variaveis);
        renderizarBloco('NÃO CLASSIFICADO', 'text-gray-400', semClassificacao);
      } else {
        const subgruposOrdenados = [...grupo.subgrupos].sort(
          (a, b) => Math.abs(valorConta(b.codigo)) - Math.abs(valorConta(a.codigo))
        );
        for (const sub of subgruposOrdenados) {
          renderizarLinhaSubgrupo(sub, 1);
        }
      }
    }

    return linhas;
  }

  function renderizarGrupoReceita(grupo: GrupoDFC): React.ReactNode[] {
    const linhas: React.ReactNode[] = [];
    const expandido = gruposExpandidos.has(grupo.codigo);
    const total = valorConta(grupo.codigo);

    linhas.push(
      <tr key={grupo.codigo} className="bg-green-50 font-bold text-green-900 hover:bg-green-100 transition-colors">
        <td className="px-4 py-2 border-b border-gray-200 sticky left-0 bg-inherit z-10">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => toggleGrupo(grupo.codigo)}>
            {expandido ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <span className="font-mono text-xs text-green-700">{grupo.codigo}</span>
            <span className="text-sm font-bold">{nomesCustomizados[grupo.codigo] ?? grupo.nome} (RECEITA LÍQUIDA)</span>
          </div>
        </td>
        {periodos.map((periodo) => {
          const valorPeriodo = valorConta(grupo.codigo, periodo.key);
          return (
            <React.Fragment key={periodo.key}>
              <td className={`px-2 py-2 border-b border-gray-200 text-right text-sm font-bold whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-600' : ''}`}>
                {formatarValor(valorPeriodo)}
              </td>
              <td className={`px-2 py-2 border-b border-gray-200 text-right text-xs bg-green-50 whitespace-nowrap ${valorPeriodo < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                {calcularAVPeriodo(valorPeriodo, periodo.key)}
              </td>
            </React.Fragment>
          );
        })}
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm font-bold whitespace-nowrap ${total < 0 ? 'text-red-600' : ''}`}>
          {formatarValor(total)}
        </td>
        <td className={`px-3 py-2 border-b border-gray-200 text-right text-sm whitespace-nowrap ${total < 0 ? 'text-red-500' : 'text-gray-600'}`}>
          {calcularAV(total)}
        </td>
      </tr>
    );

    if (expandido) {
      for (const sub of grupo.subgrupos) {
        const prazoMedio = prazoMedioRecebimentoPorSubgrupo[sub.codigo];
        const tooltip = prazoMedio !== undefined ? `Prazo médio de recebimento: ${prazoMedio.toFixed(1)} dias` : undefined;
        linhas.push(renderizarLinhaValores(sub.codigo, nomesCustomizados[sub.codigo] ?? sub.nome, 1, { tooltip }));
      }
    }

    return linhas;
  }

  const filtrosSelecionados = filtro.split(',').filter(Boolean);
  const opcoesLojas = opcoesFiltro.filter((o) => o.tipo === 'loja');
  const filtrosLojasSelecionados = filtrosSelecionados.filter((v) => opcoesLojas.some((o) => o.valor === v));
  const filtroLabel = filtro === 'consolidado'
    ? 'CONSOLIDADO (TODAS)'
    : filtro === 'fabrica'
      ? 'FABRICA'
      : filtrosLojasSelecionados.length === 1
        ? opcoesFiltro.find((o) => o.valor === filtrosLojasSelecionados[0])?.label || filtro
        : `${filtrosLojasSelecionados.length} LOJAS`;

  function selecionarFiltroUnico(valor: string) {
    setFiltro(valor);
    setFiltroAberto(false);
  }

  function toggleFiltroLoja(valor: string) {
    setFiltro((atual) => {
      const selecionadasAtuais = atual.split(',').filter((item) => opcoesLojas.some((loja) => loja.valor === item));
      const novas = selecionadasAtuais.includes(valor)
        ? selecionadasAtuais.filter((item) => item !== valor)
        : [...selecionadasAtuais, valor];
      return novas.length > 0 ? novas.join(',') : 'consolidado';
    });
  }

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="mb-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-purple-100 rounded-lg">
            <Wallet className="w-6 h-6 text-purple-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">DFC - Demonstrativo de Fluxo de Caixa</h1>
            <p className="text-sm text-gray-500">
              Regime de caixa (data de baixa/pagamento efetivo) — plano de contas próprio (Operacionais /
              Investimentos / Financiamento), definido pela consultoria contábil.
            </p>
          </div>
        </div>
      </div>

      {consultaExecutada && (
        <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-cyan-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <ArrowDownToLine className="w-4 h-4" />
              Prazo Médio de Recebimento
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {prazoMedioRecebimento !== null ? `${prazoMedioRecebimento.toFixed(1)} dias` : '-'}
            </p>
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-pink-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <ArrowUpFromLine className="w-4 h-4" />
              Prazo Médio de Pagamento
            </div>
            <p className="text-lg font-bold mt-1 text-black">
              {prazoMedioPagamento !== null ? `${prazoMedioPagamento.toFixed(1)} dias` : '-'}
            </p>
          </div>
        </div>
      )}

      {consultaExecutada && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-blue-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <DollarSign className="w-4 h-4" />
              Receita Bruta
            </div>
            <p className="text-lg font-bold mt-1 text-black">{formatarValor(receitaBruta)}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-orange-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Fluxo Operacional
            </div>
            <p className="text-lg font-bold mt-1 text-black">{formatarValor(totalOperacional)}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-3 border-l-4 border-yellow-500">
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              <TrendingDown className="w-4 h-4" />
              Investimento + Financiamento
            </div>
            <p className="text-lg font-bold mt-1 text-black">{formatarValor(totalInvestimentoFinanciamento)}</p>
          </div>
          <div className={`bg-white rounded-lg shadow p-3 border-l-4 ${saldoCaixa >= 0 ? 'border-green-500' : 'border-red-500'}`}>
            <div className="flex items-center gap-2 text-black text-xs font-medium">
              {saldoCaixa >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              Saldo de Caixa
            </div>
            <p className={`text-lg font-bold mt-1 ${saldoCaixa >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatarValor(saldoCaixa)}
            </p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-5 h-5 text-brand-primary" />
          <h2 className="text-base font-semibold text-brand-dark">Período</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <span className="text-gray-500 text-sm">até</span>
          <input
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          />

          <div className="relative">
            <button
              onClick={() => setFiltroAberto(!filtroAberto)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-50 min-w-[160px] text-left"
            >
              {filtroLabel}
            </button>
            {filtroAberto && (
              <div className="absolute z-50 mt-1 w-64 max-h-80 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                <button
                  onClick={() => selecionarFiltroUnico('consolidado')}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${filtro === 'consolidado' ? 'bg-blue-50 font-semibold' : ''}`}
                >
                  CONSOLIDADO (TODAS)
                </button>
                <button
                  onClick={() => selecionarFiltroUnico('fabrica')}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${filtro === 'fabrica' ? 'bg-blue-50 font-semibold' : ''}`}
                >
                  FABRICA
                </button>
                <div className="border-t border-gray-100 my-1" />
                {opcoesLojas.map((opcao) => (
                  <label key={opcao.valor} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-100 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filtrosLojasSelecionados.includes(opcao.valor)}
                      onChange={() => toggleFiltroLoja(opcao.valor)}
                    />
                    {opcao.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => buscarDados()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
            Consultar
          </button>
          <button
            onClick={() => buscarDados()}
            disabled={loading}
            title="Atualizar dados"
            className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={definirMesAnterior} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Mês Anterior
          </button>
          <button onClick={definirMesAtual} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Mês Atual
          </button>
          <button onClick={() => definirUltimosMeses(3)} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Últimos 3 Meses
          </button>
          <button onClick={() => definirUltimosMeses(6)} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Últimos 6 Meses
          </button>
          <button onClick={() => definirUltimosMeses(12)} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Últimos 12 Meses
          </button>
          <button onClick={definirAnoAtual} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors">
            Ano Atual
          </button>

          {consultaExecutada && (
            <>
              <div className="w-px h-6 bg-gray-300 mx-2" />
              <button onClick={expandirTodos} className="flex items-center gap-2 px-3 py-2 rounded-md bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors">
                <ChevronsDown className="w-4 h-4" />
                Expandir tudo
              </button>
              <button onClick={recolherTodos} className="flex items-center gap-2 px-3 py-2 rounded-md bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors">
                <ChevronsUp className="w-4 h-4" />
                Recolher tudo
              </button>
            </>
          )}
        </div>

        {filtroInfo && (
          <div className="mt-2 px-3 py-2 border rounded-md text-sm bg-purple-50 border-purple-200 text-purple-800">
            <strong>Filtros ativos:</strong> {filtroInfo}
          </div>
        )}
        {naoClassificados > 0 && (
          <div className="mt-2 px-3 py-2 border rounded-md text-sm bg-amber-50 border-amber-200 text-amber-800">
            {naoClassificados} despesa(s) sem classificação DFC neste período — ajuste em Config DFC.
          </div>
        )}
        {statusCarregamento && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {statusCarregamento}
          </div>
        )}
        {ultimaAtualizacao && (
          <p className="mt-2 text-xs text-gray-400">Última atualização: {ultimaAtualizacao}</p>
        )}
      </div>

      {loading && (
        <div className="bg-white rounded-lg shadow-lg border border-purple-100 p-8">
          <div className="flex flex-col items-center justify-center gap-3 text-gray-600">
            <RefreshCw className="w-8 h-8 animate-spin text-purple-600" />
            <p className="font-semibold text-gray-800">Carregando DFC...</p>
          </div>
        </div>
      )}

      {!loading && !consultaExecutada && (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center text-gray-500">
          Escolha o período e clique em Consultar para carregar o DFC.
        </div>
      )}

      {!loading && consultaExecutada && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gradient-to-r from-purple-600 to-purple-700">
                  <th className="px-4 py-2 text-left text-sm font-bold text-white border-b border-purple-500 sticky left-0 bg-purple-600 z-20 min-w-[320px]">
                    CONTA
                  </th>
                  {gruposPorAno.length > 0 ? (
                    gruposPorAno.map((grupo) => (
                      <th
                        key={grupo.ano}
                        colSpan={grupo.qtd * 2}
                        className="px-3 py-2 text-center text-sm font-bold text-white border-b border-purple-500 border-r border-purple-400 last:border-r-0"
                      >
                        EXERCÍCIO {grupo.ano}
                      </th>
                    ))
                  ) : (
                    <th className="px-3 py-2 text-center text-sm font-bold text-white border-b border-purple-500">EXERCÍCIO</th>
                  )}
                  <th colSpan={2} className="px-3 py-2 text-center text-sm font-bold text-white border-b border-purple-500 bg-purple-800">
                    ACUMULADO
                  </th>
                </tr>
                <tr className="bg-gray-100">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 border-b border-gray-300 sticky left-0 bg-gray-100 z-20" />
                  {periodos.map((periodo) => {
                    const [, mes] = periodo.key.split('-');
                    const meses = ['', 'JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
                    const nomeMes = meses[parseInt(mes, 10)] || mes;
                    return (
                      <th key={periodo.key} colSpan={2} className="px-2 py-2 text-center text-xs font-bold text-gray-700 border-b border-gray-300 bg-gray-50">
                        {nomeMes}
                      </th>
                    );
                  })}
                  <th className="px-3 py-2 text-center text-xs font-bold text-blue-700 border-b border-gray-300 bg-blue-50">TOTAL</th>
                  <th className="px-3 py-2 text-center text-xs font-bold text-green-700 border-b border-gray-300 bg-green-50">A/V %</th>
                </tr>
                <tr className="bg-gray-50">
                  <th className="px-4 py-1 text-left text-[10px] text-gray-400 border-b border-gray-200 sticky left-0 bg-gray-50 z-20" />
                  {periodos.map((periodo) => (
                    <React.Fragment key={`sub-${periodo.key}`}>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200">R$</th>
                      <th className="px-2 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-gray-100">%</th>
                    </React.Fragment>
                  ))}
                  <th className="px-3 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-blue-50">R$</th>
                  <th className="px-3 py-1 text-right text-[10px] text-gray-400 border-b border-gray-200 bg-green-50" />
                </tr>
              </thead>
              <tbody>
                {gruposReceita.filter((grupo) => !gruposOcultos.has(grupo.codigo)).map((grupo) => renderizarGrupoReceita(grupo))}
                {grupos.filter((grupo) => !gruposOcultos.has(grupo.codigo)).map((grupo) => {
                  const checkpoint = checkpointsSaldo.find((c) => c.codigo === `SALDO_APOS_${grupo.codigo}`);
                  return (
                    <React.Fragment key={`wrap-${grupo.codigo}`}>
                      {renderizarGrupo(grupo)}
                      {grupo.codigo === 'OP' && naoClassificados > 0 &&
                        renderizarLinhaValores('NAO_CLASSIFICADO', 'NÃO CLASSIFICADO', 1, { clicavel: true })}
                      {checkpoint &&
                        renderizarLinhaValores(checkpoint.codigo, `SALDO DE CAIXA (após ${checkpoint.nome})`, 0, {
                          bold: true,
                          corFundo: 'bg-blue-50',
                          corTextoTotal: checkpoint.valores.total >= 0 ? 'text-green-700' : 'text-red-700',
                          valoresOverride: checkpoint.valores,
                        })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modalDuplicatas.aberto && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4" onClick={fecharModal}>
          <div className="bg-white rounded-lg shadow-xl w-[95vw] max-w-6xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50 rounded-t-lg">
              <div>
                <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-purple-600" />
                  Duplicatas pagas - {modalDuplicatas.conta} {modalDuplicatas.nomeConta}
                </h3>
                <p className="text-sm text-gray-600">
                  Período: {modalDuplicatas.labelPeriodo} | Total: <span className="font-semibold text-red-600">{formatarValor(modalDuplicatas.total)}</span>
                </p>
              </div>
              <button onClick={fecharModal} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-hidden flex flex-col">
              {modalDuplicatas.loading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-8 h-8 animate-spin text-purple-600" />
                  <span className="ml-3 text-gray-600">Carregando duplicatas...</span>
                </div>
              ) : modalDuplicatas.duplicatas.length === 0 ? (
                <div className="text-center py-12 text-gray-500">Nenhuma duplicata paga encontrada para este período.</div>
              ) : (
                <div className="flex-1 overflow-auto">
                  <table className="w-full table-fixed border-collapse text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-gray-100">
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-24">Nr Duplicata</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-24">Data Baixa</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-32">Centro de Custo</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-20">Cód. Fornecedor</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-1/5">Fornecedor</th>
                        <th className="px-4 py-3 text-left border-b-2 border-gray-300 font-semibold text-gray-700 w-1/5">Descricao</th>
                        <th className="px-4 py-3 text-right border-b-2 border-gray-300 font-semibold text-gray-700 w-24">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalDuplicatas.duplicatas.map((dup, idx) => (
                        <tr key={idx} className="hover:bg-purple-50 border-b border-gray-100">
                          <td className="px-4 py-2.5 text-gray-600 font-mono text-xs">{dup.nrDuplicata || dup.id || '-'}</td>
                          <td className="px-4 py-2.5 text-gray-600">{formatarData(dup.dtBaixa)}</td>
                          <td className="px-4 py-2.5">
                            <span className="block truncate text-gray-700" title={dup.nomeCCusto}>{dup.nomeCCusto || '-'}</span>
                          </td>
                          <td className="px-4 py-2.5 text-gray-600 font-mono text-xs">{dup.cdFornecedor ?? '-'}</td>
                          <td className="px-4 py-2.5">
                            <span className="block truncate text-gray-700" title={dup.nmFornecedor}>{dup.nmFornecedor || 'N/A'}</span>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="block truncate text-gray-600" title={dup.descricao}>{dup.descricao || '-'}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-medium text-red-600 whitespace-nowrap">{formatarValor(dup.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {!modalDuplicatas.loading && modalDuplicatas.duplicatas.length > 0 && (
              <div className="border-t-2 border-gray-300 bg-gray-100 px-4 py-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-semibold text-gray-700">
                    TOTAL ({modalDuplicatas.duplicatas.length} {modalDuplicatas.duplicatas.length === 1 ? 'registro' : 'registros'})
                  </span>
                  <span className="text-base font-bold text-red-600">{formatarValor(modalDuplicatas.total)}</span>
                </div>
              </div>
            )}

            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button onClick={fecharModal} className="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors font-medium">
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
