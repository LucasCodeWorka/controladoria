'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Scale, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { formatarValor } from '../utils/formatters';
import { carregarFiltro } from '../utils/persistirFiltro';
import { apagarCookie, carregarFiltroCookie, salvarFiltroCookie } from '../utils/filtrosCookie';
import { PLANO_ATIVOS, PLANO_PASSIVO, type ContaBalanco } from './planoContasBalanco';

interface EmpresaOpcao {
  cdEmpresa: number;
  nome: string;
  tipo: 'fabrica' | 'loja';
}

function primeiroDiaMesAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

// Soma dos filhos de um grupo nivel 1 (a estrutura so tem 2 niveis) - ou o
// proprio valor, se por algum motivo vier sem filhos.
function totalGrupo(grupo: ContaBalanco, valores: Record<string, number>): number {
  if (!grupo.filhos || grupo.filhos.length === 0) return valores[grupo.codigo] ?? 0;
  return grupo.filhos.reduce((acc, filho) => acc + (valores[filho.codigo] ?? 0), 0);
}

function totalGeral(plano: ContaBalanco[], valores: Record<string, number>): number {
  return plano.reduce((acc, grupo) => acc + totalGrupo(grupo, valores), 0);
}

// Inicializa todo codigo-folha (nivel 2) com 0 - as consultas reais serao
// plugadas depois, por enquanto e so a estrutura zerada.
function valoresZerados(plano: ContaBalanco[]): Record<string, number> {
  const valores: Record<string, number> = {};
  for (const grupo of plano) {
    for (const filho of grupo.filhos || []) {
      valores[filho.codigo] = 0;
      for (const d of filho.detalhes || []) valores[d.codigo] = 0;
    }
  }
  return valores;
}

// A API devolve um dict unico (codigos de Ativos e Passivo misturados) -
// filtra so os codigos que pertencem a este plano especifico antes de
// aplicar por cima dos valores zerados.
function filtrarPorPlano(valoresApi: Record<string, number>, plano: ContaBalanco[]): Record<string, number> {
  const codigosDoPlano = new Set(
    plano.flatMap((grupo) => (grupo.filhos || []).flatMap((f) => [f.codigo, ...(f.detalhes || []).map((d) => d.codigo)]))
  );
  const filtrado: Record<string, number> = {};
  for (const [codigo, valor] of Object.entries(valoresApi)) {
    if (codigosDoPlano.has(codigo)) filtrado[codigo] = valor;
  }
  return filtrado;
}

function formatarPercentual(valor: number, total: number): string {
  if (total === 0) return '-';
  return `${(((valor / total) * 100) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

type Campo = 'conta' | 'valor' | 'pct';
type Ordenacao = { campo: Campo; dir: 'asc' | 'desc' } | null;

const CHAVE_FILTROS = 'balanco_patrimonial_filtros';

// Barra de rolagem acima e abaixo da tabela, sincronizadas (padrao LIEBE).
function DualScroll({ children, secao, rodape }: { children: React.ReactNode; secao?: React.ReactNode; rodape?: React.ReactNode }) {
  const topo = useRef<HTMLDivElement>(null);
  const corpo = useRef<HTMLDivElement>(null);
  const [largura, setLargura] = useState(0);
  const travado = useRef(false);

  useEffect(() => {
    const el = corpo.current;
    if (!el) return;
    const medir = () => setLargura(el.scrollWidth);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [children]);

  const sync = (de: HTMLDivElement | null, para: HTMLDivElement | null) => {
    if (!de || !para || travado.current) return;
    travado.current = true;
    para.scrollLeft = de.scrollLeft;
    requestAnimationFrame(() => { travado.current = false; });
  };

  return (
    <div className="bg-white border border-[#e5e7eb] rounded-lg shadow-sm overflow-hidden flex flex-col h-full">
      {secao}
      <div ref={topo} onScroll={() => sync(topo.current, corpo.current)} className="overflow-x-auto overflow-y-hidden h-[14px] border-b border-[#e5e7eb]">
        <div style={{ width: largura, height: 1 }} />
      </div>
      <div ref={corpo} onScroll={() => sync(corpo.current, topo.current)} className="overflow-auto max-h-[calc(100vh-320px)] flex-1 min-h-0">
        {children}
      </div>
      {rodape}
    </div>
  );
}

interface TabelaBalancoProps {
  titulo: string;
  plano: ContaBalanco[];
  valores: Record<string, number>;
  mostrarPercentual: boolean;
  contasExpandidas: Set<string>;
  toggleExpansao: (codigo: string) => void;
  ordenacao: Ordenacao;
  alternarOrdenacao: (campo: Campo) => void;
}

function TabelaBalanco({ titulo, plano, valores, mostrarPercentual, contasExpandidas, toggleExpansao, ordenacao, alternarOrdenacao }: TabelaBalancoProps) {
  const total = totalGeral(plano, valores);

  const grupos = useMemo(() => {
    if (!ordenacao) return plano;
    const f = ordenacao.dir === 'asc' ? 1 : -1;
    const cmp = (nomeA: string, valA: number, nomeB: string, valB: number) =>
      ordenacao.campo === 'conta' ? nomeA.localeCompare(nomeB, 'pt-BR', { numeric: true }) * f : (valA - valB) * f;
    return [...plano]
      .map((g) => ({ ...g, filhos: g.filhos ? [...g.filhos].sort((a, b) => cmp(a.nome, valores[a.codigo] ?? 0, b.nome, valores[b.codigo] ?? 0)) : g.filhos }))
      .sort((a, b) => cmp(a.nome, totalGrupo(a, valores), b.nome, totalGrupo(b, valores)));
  }, [plano, valores, ordenacao]);

  const cabecalho = (campo: Campo, rotulo: string, esquerda: boolean, extra = '') => {
    const ativa = ordenacao?.campo === campo;
    const seta = !ativa ? '⇅' : ordenacao!.dir === 'asc' ? '▲' : '▼';
    return (
      <th
        scope="col"
        aria-sort={!ativa ? 'none' : ordenacao!.dir === 'asc' ? 'ascending' : 'descending'}
        onClick={() => alternarOrdenacao(campo)}
        className={`sticky top-0 z-[2] px-3 py-2 text-xs font-bold uppercase tracking-[.04em] cursor-pointer select-none whitespace-nowrap ${esquerda ? 'text-left' : 'text-right'} ${
          ativa ? 'bg-[#f5ecef] text-[#8e5e68]' : 'bg-[#d9dde3] text-[#1f2937] hover:bg-[#ced3da]'
        } ${extra}`}
      >
        {rotulo}
        <span className={`ml-1 text-[10px] ${ativa ? 'text-[#8e5e68]' : 'text-[#6b7280]'}`}>{seta}</span>
      </th>
    );
  };

  const corValor = (v: number) => (v < 0 ? 'text-[#b91c1c]' : v === 0 ? 'text-[#6b7280]' : 'text-[#1d1d1d]');

  return (
    <DualScroll
      rodape={
        <div className="flex border-t-2 border-[#b3838c] bg-[#dfe2e7] text-[13px] font-bold [font-variant-numeric:tabular-nums]">
          <div className="flex-1 px-3 py-3 text-[#1d1d1d]">Total</div>
          <div className={`w-44 px-3 py-3 text-right whitespace-nowrap ${corValor(total)}`}>{formatarValor(total)}</div>
          {mostrarPercentual && <div className="w-24 px-3 py-3" />}
        </div>
      }
      secao={
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#e5e7eb]">
          <h2 className="text-base font-bold text-[#1d1d1d]">{titulo}</h2>
          <span className={`text-base font-bold [font-variant-numeric:tabular-nums] ${total < 0 ? 'text-[#b91c1c]' : 'text-[#8e5e68]'}`}>{formatarValor(total)}</span>
        </div>
      }
    >
      <table className="w-full min-w-[420px] table-fixed border-separate border-spacing-0 text-[13px] text-[#1d1d1d] [font-variant-numeric:tabular-nums]">
        <colgroup>
          <col />
          <col className="w-44" />
          {mostrarPercentual && <col className="w-24" />}
        </colgroup>
        <thead>
          <tr>
            {cabecalho('conta', 'Conta', true)}
            {cabecalho('valor', 'R$', false)}
            {mostrarPercentual && cabecalho('pct', '%', false)}
          </tr>
        </thead>
        <tbody>
          {grupos.length === 0 && (
            <tr><td colSpan={3} className="px-3 py-6 text-center text-[#4b5563]">Nenhum registro para o filtro.</td></tr>
          )}
          {grupos.map((grupo) => {
            const expandido = contasExpandidas.has(grupo.codigo);
            const totalDoGrupo = totalGrupo(grupo, valores);
            return (
              <React.Fragment key={grupo.codigo}>
                <tr className="cursor-pointer group" onClick={() => toggleExpansao(grupo.codigo)}>
                  <td className="px-3 py-2.5 font-bold text-[#8e5e68] bg-[#e6cfd5] group-hover:bg-[#dcbfc7] border-b border-[#e5e7eb] border-l-4 border-l-[#b3838c]">
                    <div className="flex items-center gap-2">
                      {expandido ? <ChevronDown className="w-4 h-4 text-[#8e5e68]" /> : <ChevronRight className="w-4 h-4 text-[#8e5e68]" />}
                      {grupo.nome}
                    </div>
                  </td>
                  <td className={`px-3 py-2.5 text-right font-bold whitespace-nowrap bg-[#e6cfd5] group-hover:bg-[#dcbfc7] border-b border-[#e5e7eb] ${corValor(totalDoGrupo)}`}>
                    {formatarValor(totalDoGrupo)}
                  </td>
                  {mostrarPercentual && (
                    <td className="px-3 py-2.5 text-right font-bold whitespace-nowrap text-[#8e5e68] bg-[#e6cfd5] group-hover:bg-[#dcbfc7] border-b border-[#e5e7eb]">
                      {totalDoGrupo === 0 ? '-' : '100,00%'}
                    </td>
                  )}
                </tr>
                {expandido &&
                  (grupo.filhos || []).map((conta, idx) => {
                    const valor = valores[conta.codigo] ?? 0;
                    const temDetalhes = !!conta.detalhes?.length;
                    const detalhesAbertos = temDetalhes && contasExpandidas.has(conta.codigo);
                    return (
                      <React.Fragment key={conta.codigo}>
                        <tr className={`group ${idx % 2 === 1 ? 'bg-[#f0f1f4]' : 'bg-white'} ${temDetalhes ? 'cursor-pointer' : ''}`} onClick={temDetalhes ? () => toggleExpansao(conta.codigo) : undefined}>
                          <td className={`px-3 py-2 pl-10 font-semibold group-hover:bg-[#efdde2] border-b border-[#e5e7eb] ${valor === 0 && !temDetalhes ? 'text-[#6b7280]' : 'text-[#1d1d1d]'}`}>
                            <div className="flex items-center gap-2">
                              {temDetalhes ? (
                                detalhesAbertos ? <ChevronDown className="w-4 h-4 flex-shrink-0 text-[#8e5e68]" /> : <ChevronRight className="w-4 h-4 flex-shrink-0 text-[#8e5e68]" />
                              ) : (
                                <span className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                              )}
                              {conta.nome}
                            </div>
                          </td>
                          <td className={`px-3 py-2 text-right whitespace-nowrap font-semibold group-hover:bg-[#efdde2] border-b border-[#e5e7eb] ${corValor(valor)}`}>
                            {formatarValor(valor)}
                          </td>
                          {mostrarPercentual && (
                            <td className={`px-3 py-2 text-right whitespace-nowrap font-semibold group-hover:bg-[#efdde2] border-b border-[#e5e7eb] ${valor === 0 ? 'text-[#6b7280]' : ''}`}>
                              {formatarPercentual(valor, totalDoGrupo)}
                            </td>
                          )}
                        </tr>
                        {detalhesAbertos &&
                          conta.detalhes!.map((d) => {
                            const vd = valores[d.codigo] ?? 0;
                            return (
                              <tr key={d.codigo} className="group">
                                <td className="px-3 py-1.5 pl-16 text-[#4b5563] bg-[#e3e6ea] group-hover:bg-[#efdde2] border-b border-[#e5e7eb]">
                                  <span className="inline-block w-1.5 h-1.5 mr-2 rounded-full bg-[#c5949d] align-middle" />
                                  {d.nome}
                                </td>
                                <td className={`px-3 py-1.5 text-right whitespace-nowrap bg-[#e3e6ea] group-hover:bg-[#efdde2] border-b border-[#e5e7eb] ${corValor(vd)}`}>
                                  {formatarValor(vd)}
                                </td>
                                {mostrarPercentual && (
                                  <td className="px-3 py-1.5 text-right whitespace-nowrap text-[#4b5563] bg-[#e3e6ea] group-hover:bg-[#efdde2] border-b border-[#e5e7eb]">
                                    {formatarPercentual(vd, totalDoGrupo)}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    );
                  })}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </DualScroll>
  );
}

function CardTotal({ rotulo, valor, nota }: { rotulo: string; valor: number; nota?: string }) {
  return (
    <div className="bg-white border border-[#e5e7eb] rounded-lg px-5 py-4 shadow-sm">
      <div className="text-[13px] font-semibold text-[#4b5563]">{rotulo}</div>
      <div className={`mt-1 text-[28px] leading-tight font-bold [font-variant-numeric:tabular-nums] ${valor < 0 ? 'text-[#b91c1c]' : 'text-[#1d1d1d]'}`}>
        {formatarValor(valor)}
      </div>
      {nota && <div className="mt-1 text-xs text-[#4b5563]">{nota}</div>}
    </div>
  );
}

type Status = 'ok' | 'atencao' | 'ruim' | 'neutro';

const COR_STATUS: Record<Status, string> = { ok: 'text-[#15803d]', atencao: 'text-[#b45309]', ruim: 'text-[#b91c1c]', neutro: 'text-[#1d1d1d]' };
const BORDA_STATUS: Record<Status, string> = { ok: 'border-l-[#15803d]', atencao: 'border-l-[#b45309]', ruim: 'border-l-[#b91c1c]', neutro: 'border-l-[#d1d5db]' };

function CardIndicador({ rotulo, valor, meta, detalhe, status }: { rotulo: string; valor: string; meta: string; detalhe: string; status: Status }) {
  return (
    <div className={`bg-white border border-[#e5e7eb] border-l-4 ${BORDA_STATUS[status]} rounded-lg px-5 py-4 shadow-sm`}>
      <div className="text-[13px] font-semibold text-[#4b5563]">{rotulo}</div>
      <div className={`mt-1 text-[28px] leading-tight font-bold [font-variant-numeric:tabular-nums] ${COR_STATUS[status]}`}>{valor}</div>
      <div className="mt-1 text-xs font-semibold text-[#4b5563]">Meta: {meta}</div>
      <div className="text-xs text-[#4b5563]">{detalhe}</div>
    </div>
  );
}

const fmtIndice = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function BalancoPatrimonialPage() {
  const [mesReferencia, setMesReferencia] = useState(primeiroDiaMesAtual());
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaOpcao[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<Set<number>>(new Set());
  const [filtroLojasAberto, setFiltroLojasAberto] = useState(false);
  const [consultaExecutada, setConsultaExecutada] = useState(false);
  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(
    new Set([...PLANO_ATIVOS, ...PLANO_PASSIVO].flatMap((g) => [g.codigo, ...(g.filhos || []).filter((f) => f.detalhes).map((f) => f.codigo)]))
  );
  const [ordenacao, setOrdenacao] = useState<Ordenacao>(null);
  const [salvoAtivo, setSalvoAtivo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Valores zerados por padrao - linhas com consulta real ja ligada (ex:
  // PC.2) vem do endpoint /api/balanco-patrimonial/dados e sobrescrevem o
  // zero aqui; o resto continua zerado ate ser implementado.
  const [valoresAtivos, setValoresAtivos] = useState<Record<string, number>>(() => valoresZerados(PLANO_ATIVOS));
  const [valoresPassivo, setValoresPassivo] = useState<Record<string, number>>(() => valoresZerados(PLANO_PASSIVO));
  const [carregando, setCarregando] = useState(false);
  const [indicadoresDre, setIndicadoresDre] = useState<{ lucroLiquido12m: number; ebitda12m: number } | null>(null);

  function alternarOrdenacao(campo: Campo) {
    setOrdenacao((o) => (o?.campo !== campo ? { campo, dir: 'asc' } : o.dir === 'asc' ? { campo, dir: 'desc' } : null));
  }

  useEffect(() => {
    fetch('/api/cmv-detalhado/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const lista: EmpresaOpcao[] = data.empresas || [];
        setEmpresasDisponiveis(lista);
        // Cookie (padrao LIEBE) primeiro; cai no localStorage antigo pra quem
        // ja tinha filtro salvo antes da mudanca.
        const salvo =
          carregarFiltroCookie<{ mesReferencia: string; empresas: number[]; ordenacao: Ordenacao }>(CHAVE_FILTROS) ||
          carregarFiltro<{ mesReferencia: string; empresas: number[]; ordenacao: Ordenacao }>(CHAVE_FILTROS);
        const validas = new Set(lista.map((e) => e.cdEmpresa));
        let mes = mesReferencia;
        let empresas = new Set(lista.map((e) => e.cdEmpresa));
        if (salvo) {
          if (salvo.mesReferencia) mes = salvo.mesReferencia;
          const empresasValidas = (salvo.empresas || []).filter((cd) => validas.has(cd));
          if (empresasValidas.length > 0) empresas = new Set(empresasValidas);
          if (salvo.ordenacao && ['conta', 'valor', 'pct'].includes(salvo.ordenacao.campo)) setOrdenacao(salvo.ordenacao);
          setSalvoAtivo(true);
        }
        setMesReferencia(mes);
        setEmpresasSelecionadas(empresas);
      })
      .catch((error) => console.error('Erro ao buscar empresas:', error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (empresasDisponiveis.length === 0) return;
    const timer = setTimeout(() => {
      salvarFiltroCookie(CHAVE_FILTROS, { mesReferencia, empresas: Array.from(empresasSelecionadas), ordenacao });
    }, 400);
    return () => clearTimeout(timer);
  }, [mesReferencia, empresasSelecionadas, ordenacao, empresasDisponiveis]);

  function limparFiltros() {
    apagarCookie(CHAVE_FILTROS);
    try { localStorage.removeItem(CHAVE_FILTROS); } catch { /* segue com o padrao */ }
    setMesReferencia(primeiroDiaMesAtual());
    setEmpresasSelecionadas(new Set(empresasDisponiveis.map((e) => e.cdEmpresa)));
    setOrdenacao(null);
    setSalvoAtivo(false);
  }

  function toggleExpansao(codigo: string) {
    setContasExpandidas((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  function toggleEmpresa(cdEmpresa: number) {
    setEmpresasSelecionadas((prev) => {
      const novo = new Set(prev);
      if (novo.has(cdEmpresa)) novo.delete(cdEmpresa);
      else novo.add(cdEmpresa);
      return novo;
    });
  }

  async function consultar(sobrescrever?: { mes: string; empresas: Set<number>; total: number }) {
    const mes = sobrescrever?.mes ?? mesReferencia;
    const empresas = sobrescrever?.empresas ?? empresasSelecionadas;
    const totalEmpresas = sobrescrever?.total ?? empresasDisponiveis.length;
    setConsultaExecutada(true);
    setCarregando(true);
    setErro(null);
    setIndicadoresDre(null);
    // Reseta pro zerado antes de aplicar o que a API devolver - linhas sem
    // consulta ligada ainda ficam em 0.
    setValoresAtivos(valoresZerados(PLANO_ATIVOS));
    setValoresPassivo(valoresZerados(PLANO_PASSIVO));
    try {
      const params = new URLSearchParams({ mesReferencia: mes });
      // So manda o filtro de empresas quando o usuario de fato excluiu
      // alguma - com "todas" marcadas, manda sem filtro nenhum (soma TUDO
      // no banco). A lista de empresas dessa tela e so lojas/fabrica (17
      // codigos); as duplicatas reais de MP/emprestimo ficam em centros de
      // custo internos (ex: fabrica 500-514, diretoria/financeiro 513) que
      // nao estao nessa lista - mandar a lista completa como filtro
      // excluiria a maior parte dos lancamentos por engano.
      if (totalEmpresas > 0 && empresas.size < totalEmpresas) {
        params.set('empresas', Array.from(empresas).join(','));
      }
      // Lucro e EBITDA dos ultimos 12 meses (DRE) - nao trava o balanco se falhar.
      fetch(`/api/balanco-patrimonial/indicadores-dre?mesReferencia=${mes}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => { if (typeof d.lucroLiquido12m === 'number') setIndicadoresDre({ lucroLiquido12m: d.lucroLiquido12m, ebitda12m: d.ebitda12m }); })
        .catch((e) => console.error('Erro ao buscar indicadores da DRE:', e));
      const response = await fetch(`/api/balanco-patrimonial/dados?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error || !data.valores) throw new Error(data.error || data.detail || 'Erro ao buscar o balanço patrimonial');
      setValoresAtivos((prev) => ({ ...prev, ...filtrarPorPlano(data.valores, PLANO_ATIVOS) }));
      setValoresPassivo((prev) => ({ ...prev, ...filtrarPorPlano(data.valores, PLANO_PASSIVO) }));
    } catch (error) {
      console.error('Erro ao buscar balanço patrimonial:', error);
      setErro(error instanceof Error ? error.message : 'Erro ao buscar o balanço patrimonial');
    } finally {
      setCarregando(false);
    }
  }

  const totalAtivos = totalGeral(PLANO_ATIVOS, valoresAtivos);
  const totalPassivo = totalGeral(PLANO_PASSIVO, valoresPassivo);

  // Indicadores. Passivo vem negativo nas contas - aqui entra em valor absoluto.
  const ativoCirculante = totalGrupo(PLANO_ATIVOS[0], valoresAtivos);
  const passivoCirculante = Math.abs(totalGrupo(PLANO_PASSIVO[0], valoresPassivo));
  const caixa = valoresAtivos['AC.1'] ?? 0;
  const estoques = valoresAtivos['AC.3'] ?? 0;
  const patrimonioLiquido = totalAtivos - Math.abs(totalPassivo);
  // Divida = emprestimos (PC.3 e PNC.8, curto e longo prazo) + fornecedores (PC.1 aluguéis/fornecedores e PC.2 MP e servicos), menos o caixa.
  const dividaBruta = Math.abs((valoresPassivo['PC.1'] ?? 0) + (valoresPassivo['PC.2'] ?? 0) + (valoresPassivo['PC.3'] ?? 0) + (valoresPassivo['PNC.8'] ?? 0));
  const dividaLiquida = dividaBruta - caixa;

  const liqImediata = passivoCirculante > 0 ? caixa / passivoCirculante : null;
  const liqSeca = passivoCirculante > 0 ? (ativoCirculante - estoques) / passivoCirculante : null;
  const liqCorrente = passivoCirculante > 0 ? ativoCirculante / passivoCirculante : null;
  const roe = indicadoresDre && patrimonioLiquido > 0 ? (indicadoresDre.lucroLiquido12m / patrimonioLiquido) * 100 : null;
  const dividaEbitda = indicadoresDre && indicadoresDre.ebitda12m > 0 ? dividaLiquida / indicadoresDre.ebitda12m : null;

  // "Quanto mais proximo de 1 melhor": >= 0,8 ok, >= 0,5 atencao.
  const statusProximoDe1 = (v: number | null): Status => (v === null ? 'neutro' : v >= 0.8 ? 'ok' : v >= 0.5 ? 'atencao' : 'ruim');

  return (
    <div className="p-4 md:p-6 space-y-4 bg-[#f5f5f5] min-h-full text-[#1d1d1d]">
      <div className="flex items-center gap-3">
        <Scale className="w-7 h-7 text-[#8e5e68]" />
        <div>
          <h1 className="text-2xl font-bold text-[#1d1d1d]">Balanço Patrimonial</h1>
          <p className="text-sm text-[#4b5563]">Ativos e Passivo, por empresa e mês de referência.</p>
        </div>
      </div>

      <div className="bg-white border border-[#e5e7eb] rounded-lg shadow-sm p-4">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-[13px] font-semibold text-[#4b5563] mb-1">Mês de referência</label>
            <input
              type="month"
              value={mesReferencia}
              onChange={(e) => setMesReferencia(e.target.value)}
              className="px-3 py-2 border border-[#d1d5db] rounded-md text-sm text-[#1d1d1d] focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
          </div>

          <div className="relative">
            <label className="block text-[13px] font-semibold text-[#4b5563] mb-1">Empresas</label>
            <button
              onClick={() => setFiltroLojasAberto((v) => !v)}
              className="px-3 py-2 border border-[#d1d5db] rounded-md text-sm text-[#1d1d1d] bg-white hover:bg-[#f5ecef] min-w-[160px] text-left"
            >
              Empresas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
            </button>
            {filtroLojasAberto && (
              <div className="absolute z-20 mt-1 w-64 bg-white border border-[#e5e7eb] rounded-md shadow-lg max-h-72 overflow-y-auto">
                <div className="flex gap-3 p-2 border-b border-[#e5e7eb]">
                  <button
                    onClick={() => setEmpresasSelecionadas(new Set(empresasDisponiveis.map((e) => e.cdEmpresa)))}
                    className="text-[13px] font-medium text-[#8e5e68] hover:underline"
                  >
                    Selecionar todas
                  </button>
                  <button onClick={() => setEmpresasSelecionadas(new Set())} className="text-[13px] font-medium text-[#4b5563] hover:underline">
                    Limpar
                  </button>
                </div>
                {empresasDisponiveis.map((e) => (
                  <label key={e.cdEmpresa} className="flex items-center gap-2 px-3 py-1.5 text-sm text-[#1d1d1d] hover:bg-[#f5ecef] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={empresasSelecionadas.has(e.cdEmpresa)}
                      onChange={() => toggleEmpresa(e.cdEmpresa)}
                    />
                    {e.nome}
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => consultar()}
            disabled={carregando}
            className="px-5 py-2 bg-brand-primary text-white rounded-md text-sm font-semibold hover:bg-brand-secondary flex items-center gap-2 disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
            {carregando ? 'Carregando...' : 'Consultar'}
          </button>
          <button
            onClick={limparFiltros}
            className="px-4 py-2 border border-[#d1d5db] rounded-md text-sm font-medium text-[#4b5563] bg-white hover:bg-[#f5ecef]"
          >
            Limpar filtros
          </button>
          {salvoAtivo && <span className="text-[13px] text-[#8e5e68] font-medium">Filtros salvos aplicados</span>}
        </div>
        {erro && (
          <div role="alert" className="mt-3 text-sm text-[#b91c1c] bg-[#fef2f2] border border-red-200 rounded px-3 py-2">{erro}</div>
        )}
      </div>

      {!consultaExecutada ? (
        <div className="bg-white border border-[#e5e7eb] rounded-lg shadow-sm p-10 text-center text-sm text-[#4b5563]">
          Escolha o mês e as empresas e clique em Consultar.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            <CardTotal rotulo="Total dos Ativos" valor={totalAtivos} />
            <CardTotal rotulo="Total do Passivo" valor={totalPassivo} />
            <CardTotal rotulo="Ativos − Passivo" valor={totalAtivos - Math.abs(totalPassivo)} nota="Passivo aparece negativo nas contas; aqui entra em valor absoluto" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <CardIndicador
              rotulo="Liquidez imediata"
              valor={liqImediata === null ? '-' : fmtIndice(liqImediata)}
              meta="quanto mais perto de 1, melhor"
              detalhe="Caixa ÷ Passivo Circulante"
              status={statusProximoDe1(liqImediata)}
            />
            <CardIndicador
              rotulo="Liquidez seca"
              valor={liqSeca === null ? '-' : fmtIndice(liqSeca)}
              meta="quanto mais perto de 1, melhor"
              detalhe="(Ativo Circ. − Estoques) ÷ Passivo Circ."
              status={statusProximoDe1(liqSeca)}
            />
            <CardIndicador
              rotulo="Liquidez corrente"
              valor={liqCorrente === null ? '-' : fmtIndice(liqCorrente)}
              meta="sempre acima de 1"
              detalhe="Ativo Circulante ÷ Passivo Circulante"
              status={liqCorrente === null ? 'neutro' : liqCorrente >= 1 ? 'ok' : liqCorrente >= 0.9 ? 'atencao' : 'ruim'}
            />
            <CardIndicador
              rotulo="ROE"
              valor={roe === null ? (indicadoresDre ? '-' : 'Carregando...') : `${fmtIndice(roe)}%`}
              meta="lucro 12 meses ÷ patrimônio líquido"
              detalhe={indicadoresDre ? `Lucro 12m ${formatarValor(indicadoresDre.lucroLiquido12m)}` : 'Lucro líquido da DRE consolidada'}
              status="neutro"
            />
            <CardIndicador
              rotulo="Dívida líquida ÷ EBITDA"
              valor={dividaEbitda === null ? (indicadoresDre ? 'n/d' : 'Carregando...') : `${fmtIndice(dividaEbitda)}x`}
              meta="não pode passar de 3"
              detalhe={indicadoresDre ? `Dív. líq. ${formatarValor(dividaLiquida)} · EBITDA 12m ${formatarValor(indicadoresDre.ebitda12m)}` : 'Fornecedores + empréstimos − caixa'}
              status={dividaEbitda === null ? (indicadoresDre ? 'ruim' : 'neutro') : dividaEbitda <= 2.5 ? 'ok' : dividaEbitda <= 3 ? 'atencao' : 'ruim'}
            />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
            <TabelaBalanco
              titulo="Ativos"
              plano={PLANO_ATIVOS}
              valores={valoresAtivos}
              mostrarPercentual
              contasExpandidas={contasExpandidas}
              toggleExpansao={toggleExpansao}
              ordenacao={ordenacao}
              alternarOrdenacao={alternarOrdenacao}
            />
            <TabelaBalanco
              titulo="Passivo"
              plano={PLANO_PASSIVO}
              valores={valoresPassivo}
              mostrarPercentual
              contasExpandidas={contasExpandidas}
              toggleExpansao={toggleExpansao}
              ordenacao={ordenacao}
              alternarOrdenacao={alternarOrdenacao}
            />
          </div>
        </>
      )}
    </div>
  );
}
