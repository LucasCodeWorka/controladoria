'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Scale, ChevronDown, ChevronRight, RefreshCw, FileDown, Wallet, Landmark, Users,
  Building2, CalendarDays, SlidersHorizontal, RotateCcw, ArrowDownLeft,
  ArrowUpRight, TrendingUp, Layers3, Droplets, Gauge, Target, Clock3,
  CheckCircle2, AlertCircle, MinusCircle, Boxes, Receipt, Sigma, type LucideIcon,
} from 'lucide-react';
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

const TEMAS = {
  ativo: { texto: 'text-teal-800', fundo: 'bg-teal-50', icone: 'bg-teal-100 text-teal-700', borda: 'border-teal-200', faixa: 'bg-teal-600' },
  passivo: { texto: 'text-[#92485d]', fundo: 'bg-[#faf0f3]', icone: 'bg-[#f3dce4] text-[#92485d]', borda: 'border-[#ebcbd6]', faixa: 'bg-[#b76e86]' },
  patrimonio: { texto: 'text-indigo-800', fundo: 'bg-indigo-50', icone: 'bg-indigo-100 text-indigo-700', borda: 'border-indigo-200', faixa: 'bg-indigo-500' },
};

const ICONES_CONTAS: Record<string, LucideIcon> = {
  'AC.1': Wallet, 'AC.2': Receipt, 'AC.3': Boxes,
  'ANC.4': Receipt, 'ANC.5': TrendingUp, 'ANC.6': Building2,
  'PC.1': Building2, 'PC.2': Boxes, 'PC.3': Landmark, 'PC.IMV': Building2, 'PC.4': Users,
  'PNC.7': Building2, 'PNC.8': Landmark, 'PNC.IMV': Building2,
};

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
    <div className="bg-white border border-[#e5e7eb] rounded-xl shadow-sm overflow-hidden flex flex-col h-full min-w-0 print:shadow-none print:h-auto print:break-inside-avoid">
      {secao}
      <div ref={topo} onScroll={() => sync(topo.current, corpo.current)} className="overflow-x-auto overflow-y-hidden h-[14px] border-b border-[#e5e7eb] print:hidden">
        <div style={{ width: largura, height: 1 }} />
      </div>
      <div ref={corpo} onScroll={() => sync(corpo.current, topo.current)} className="overflow-auto max-h-[calc(100vh-320px)] flex-1 min-h-0 [transform:translateZ(0)] print:max-h-none print:overflow-visible">
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
  const ativo = titulo === 'Ativos';
  const tema = ativo ? TEMAS.ativo : TEMAS.passivo;
  const IconeTabela = ativo ? Wallet : Landmark;

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
        className={`sticky top-0 z-[2] px-4 py-0 text-[11px] font-semibold uppercase tracking-[.06em] select-none whitespace-nowrap ${esquerda ? 'text-left' : 'text-right'} ${
          ativa ? 'bg-[#f5ecef] text-[#8e5e68]' : 'bg-[#f3f4f6] text-[#6b7280] hover:bg-[#eceef1]'
        } ${extra}`}
      >
        <button type="button" onClick={() => alternarOrdenacao(campo)} className={`flex w-full items-center gap-1.5 py-3 uppercase tracking-[.06em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b3838c] ${esquerda ? 'justify-start' : 'justify-end'}`}>
          {rotulo}
          <span aria-hidden="true" className={`text-[10px] ${ativa ? 'text-[#8e5e68]' : 'text-[#9ca3af]'}`}>{seta}</span>
        </button>
      </th>
    );
  };

  const corValor = (v: number) => (v < 0 ? 'text-[#a34455]' : v === 0 ? 'text-[#6b7280]' : 'text-[#1d1d1d]');

  return (
    <DualScroll
      rodape={
        <div className={`flex items-center gap-3 border-t-2 ${tema.borda} ${tema.fundo} px-4 py-4 [font-variant-numeric:tabular-nums]`}>
          <Sigma aria-hidden="true" className={`h-4 w-4 shrink-0 ${tema.texto}`} />
          <div className={`flex-1 text-xs font-bold uppercase tracking-[.05em] ${tema.texto}`}>{ativo ? 'Total do ativo' : 'Total do passivo'}</div>
          <div className={`text-right text-base font-bold whitespace-nowrap ${corValor(total)}`}>{formatarValor(total)}</div>
        </div>
      }
      secao={
        <div className={`flex flex-wrap items-center justify-between gap-3 border-b border-t-[3px] ${tema.borda} ${tema.fundo} px-5 py-4`}>
          <div className="flex items-center gap-3">
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tema.icone}`}>
              <IconeTabela aria-hidden="true" className="h-5 w-5" />
            </span>
            <div>
              <h2 className={`text-sm font-bold uppercase tracking-[.1em] ${tema.texto}`}>{ativo ? 'Ativo' : 'Passivo'}</h2>
              <p className="mt-1 text-[10px] font-medium tracking-wide text-[#6b7280]">{ativo ? 'Bens e direitos' : 'Obrigações'}</p>
            </div>
          </div>
          <span className={`text-lg font-bold tracking-tight [font-variant-numeric:tabular-nums] ${corValor(total)}`}>{formatarValor(total)}</span>
        </div>
      }
    >
      <table aria-label={`Contas do ${titulo === 'Ativos' ? 'ativo' : 'passivo'}`} className="w-full min-w-[540px] table-fixed border-separate border-spacing-0 text-[13px] text-[#1d1d1d] [font-variant-numeric:tabular-nums]">
        <colgroup>
          <col />
          <col className="w-44" />
          {mostrarPercentual && <col className="w-28" />}
        </colgroup>
        <thead>
          <tr>
            {cabecalho('conta', 'Conta', true)}
            {cabecalho('valor', 'Saldo (R$)', false)}
            {mostrarPercentual && cabecalho('pct', '% do grupo', false)}
          </tr>
        </thead>
        <tbody>
          {grupos.length === 0 && (
            <tr><td colSpan={mostrarPercentual ? 3 : 2} className="px-3 py-6 text-center text-[#4b5563]">Nenhum registro para o filtro.</td></tr>
          )}
          {grupos.map((grupo) => {
            const expandido = contasExpandidas.has(grupo.codigo);
            const totalDoGrupo = totalGrupo(grupo, valores);
            const IconeGrupo = grupo.codigo === 'AC' || grupo.codigo === 'PC' ? Clock3 : Building2;
            const fundoGrupo = ativo ? 'bg-[#bfe5d6] group-hover:bg-[#aedcc9]' : 'bg-[#f6e7ed] group-hover:bg-[#efdbe3]';
            return (
              <React.Fragment key={grupo.codigo}>
                <tr className="group">
                  <td className={`px-4 py-3 font-bold ${tema.texto} ${fundoGrupo} border-b border-white border-l-[3px] ${ativo ? 'border-l-teal-500' : 'border-l-[#b3838c]'}`}>
                    <button type="button" aria-expanded={expandido} onClick={() => toggleExpansao(grupo.codigo)} className="flex w-full items-center gap-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b3838c]">
                      {expandido ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                      <IconeGrupo aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
                      {grupo.nome}
                    </button>
                  </td>
                  <td className={`px-4 py-3 text-right font-bold whitespace-nowrap ${fundoGrupo} border-b border-white ${corValor(totalDoGrupo)}`}>
                    {formatarValor(totalDoGrupo)}
                  </td>
                  {mostrarPercentual && (
                    <td className={`px-4 py-3 text-right font-normal whitespace-nowrap ${tema.texto} ${fundoGrupo} border-b border-white`}>
                      {totalDoGrupo === 0 ? '-' : '100,00%'}
                    </td>
                  )}
                </tr>
                {expandido &&
                  (grupo.filhos || []).map((conta, idx) => {
                    const valor = valores[conta.codigo] ?? 0;
                    const temDetalhes = !!conta.detalhes?.length;
                    const detalhesAbertos = temDetalhes && contasExpandidas.has(conta.codigo);
                    const IconeConta = ICONES_CONTAS[conta.codigo] ?? Receipt;
                    return (
                      <React.Fragment key={conta.codigo}>
                        <tr className="group">
                          <td className={`px-4 py-3 pl-7 font-medium group-hover:bg-[#faf3f5] border-b border-[#eef0f2] ${idx % 2 === 1 ? 'bg-[#fafafb]' : 'bg-white'} ${valor === 0 && !temDetalhes ? 'text-[#6b7280]' : 'text-[#1d1d1d]'}`}>
                            {temDetalhes ? (
                              <button type="button" aria-expanded={detalhesAbertos} onClick={() => toggleExpansao(conta.codigo)} className="flex w-full items-center gap-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b3838c]">
                                {detalhesAbertos ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#8e5e68]" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#8e5e68]" />}
                                <IconeConta aria-hidden="true" className={`h-4 w-4 shrink-0 ${tema.texto} opacity-70`} />
                                <span>{conta.nome}</span>
                              </button>
                            ) : (
                              <div className="flex items-center gap-2.5 pl-6"><IconeConta aria-hidden="true" className={`h-4 w-4 shrink-0 ${tema.texto} opacity-70`} /><span>{conta.nome}</span></div>
                            )}
                          </td>
                          <td className={`px-4 py-3 text-right whitespace-nowrap font-medium group-hover:bg-[#faf3f5] border-b border-[#eef0f2] ${idx % 2 === 1 ? 'bg-[#fafafb]' : 'bg-white'} ${corValor(valor)}`}>
                            {formatarValor(valor)}
                          </td>
                          {mostrarPercentual && (
                            <td className={`px-4 py-3 text-right whitespace-nowrap font-medium group-hover:bg-[#faf3f5] border-b border-[#eef0f2] ${idx % 2 === 1 ? 'bg-[#fafafb]' : 'bg-white'} text-[#6b7280]`}>
                              {formatarPercentual(valor, totalDoGrupo)}
                            </td>
                          )}
                        </tr>
                        {detalhesAbertos &&
                          conta.detalhes!.map((d) => {
                            const vd = valores[d.codigo] ?? 0;
                            return (
                              <tr key={d.codigo} className="group">
                                <td className="px-4 py-2.5 pl-14 text-[#4b5563] bg-[#fcfcfd] group-hover:bg-[#faf3f5] border-b border-[#eef0f2]">
                                  <span className="inline-block w-1.5 h-1.5 mr-2 rounded-full bg-[#c5949d] align-middle" />
                                  {d.nome}
                                </td>
                                <td className={`px-4 py-2.5 text-right whitespace-nowrap bg-[#fcfcfd] group-hover:bg-[#faf3f5] border-b border-[#eef0f2] ${corValor(vd)}`}>
                                  {formatarValor(vd)}
                                </td>
                                {mostrarPercentual && (
                                  <td className="px-4 py-2.5 text-right whitespace-nowrap text-[#4b5563] bg-[#fcfcfd] group-hover:bg-[#faf3f5] border-b border-[#eef0f2]">
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

function CardTotal({ rotulo, valor, nota, tom, icone: Icone }: {
  rotulo: string; valor: number; nota: string; tom: keyof typeof TEMAS; icone: LucideIcon;
}) {
  const tema = TEMAS[tom];
  return (
    <div className={`relative min-w-0 overflow-hidden rounded-xl border ${tema.borda} bg-white p-5 shadow-sm print:shadow-none`}>
      <div className={`absolute inset-x-0 top-0 h-1 ${tema.faixa}`} />
      <div className="flex items-center justify-between gap-3">
        <div className={`text-xs font-bold tracking-wide ${tema.texto}`}>{rotulo}</div>
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tema.icone}`}>
          <Icone aria-hidden="true" className="h-5 w-5" />
        </span>
      </div>
      <div className={`mt-3 break-words text-[clamp(1.25rem,2vw,1.875rem)] font-bold leading-tight tracking-tight tabular-nums ${valor < 0 ? 'text-[#a34455]' : tema.texto}`}>
        {formatarValor(valor)}
      </div>
      <div className="mt-3 text-[10px] font-medium leading-relaxed tracking-wide text-[#6b7280]">{nota}</div>
    </div>
  );
}

type Status = 'ok' | 'atencao' | 'ruim' | 'neutro';

const ESTILOS_STATUS = {
  ok: { texto: 'text-teal-700', fundo: 'bg-teal-50', borda: 'border-teal-100', rotulo: 'Dentro da referência', icone: CheckCircle2 },
  atencao: { texto: 'text-amber-800', fundo: 'bg-amber-50', borda: 'border-amber-200', rotulo: 'Atenção', icone: AlertCircle },
  ruim: { texto: 'text-rose-700', fundo: 'bg-rose-50', borda: 'border-rose-100', rotulo: 'Atenção', icone: AlertCircle },
  neutro: { texto: 'text-slate-600', fundo: 'bg-slate-100', borda: 'border-slate-200', rotulo: 'Informativo', icone: MinusCircle },
};

function CardIndicador({ rotulo, valor, meta, detalhe, status, icone: Icone }: {
  rotulo: string; valor: string; meta: string; detalhe: string; status: Status; icone: LucideIcon;
}) {
  const estilo = ESTILOS_STATUS[status];
  const IconeStatus = estilo.icone;
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm print:shadow-none">
      <div className="mb-3 flex items-center gap-2.5">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${estilo.fundo} ${estilo.texto}`}>
          <Icone aria-hidden="true" className="h-[18px] w-[18px]" />
        </span>
        <div className="text-[11px] font-bold leading-relaxed tracking-wide text-[#4b5563]">{rotulo}</div>
      </div>
      <div className={`break-words text-[28px] font-bold leading-tight tracking-tight tabular-nums ${estilo.texto}`}>{valor}</div>
      <div className="mt-2 text-[10px] font-semibold leading-relaxed text-[#4b5563]">Meta: {meta}</div>
      <div className="mb-4 mt-1 text-[10px] leading-relaxed text-[#6b7280]">{detalhe}</div>
      <div className={`mt-auto flex items-center gap-1.5 self-start rounded-md border px-2 py-1 text-[9px] font-bold tracking-wide ${estilo.fundo} ${estilo.texto} ${estilo.borda}`}>
        <IconeStatus aria-hidden="true" className="h-3 w-3 shrink-0" />{estilo.rotulo}
      </div>
    </div>
  );
}

// 'YYYY-MM-DD' -> 'mm/aa'
const mesAno = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(2, 4)}`;

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
  const [infoConsulta, setInfoConsulta] = useState<{ mes: string; empresas: string } | null>(null);

  // Valores zerados por padrao - linhas com consulta real ja ligada (ex:
  // PC.2) vem do endpoint /api/balanco-patrimonial/dados e sobrescrevem o
  // zero aqui; o resto continua zerado ate ser implementado.
  const [valoresAtivos, setValoresAtivos] = useState<Record<string, number>>(() => valoresZerados(PLANO_ATIVOS));
  const [valoresPassivo, setValoresPassivo] = useState<Record<string, number>>(() => valoresZerados(PLANO_PASSIVO));
  const [bens, setBens] = useState<{ codigo: string; linha: string; nome: string; valor: number }[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [indicadoresDre, setIndicadoresDre] = useState<{ lucroLiquido12m: number; ebitda12m: number; inicio: string; fim: string } | null>(null);

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
    const [anoRef, mesRef] = mes.split('-');
    setInfoConsulta({
      mes: `${mesRef}/${anoRef}`,
      empresas:
        empresas.size >= totalEmpresas
          ? 'Todas as empresas'
          : empresasDisponiveis.filter((e) => empresas.has(e.cdEmpresa)).map((e) => e.nome).join(', '),
    });
    setCarregando(true);
    setErro(null);
    setIndicadoresDre(null);
    setBens([]);
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
        .then((d) => { if (typeof d.lucroLiquido12m === 'number') setIndicadoresDre({ lucroLiquido12m: d.lucroLiquido12m, ebitda12m: d.ebitda12m, inicio: d.inicio, fim: d.fim }); })
        .catch((e) => console.error('Erro ao buscar indicadores da DRE:', e));
      const response = await fetch(`/api/balanco-patrimonial/dados?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error || !data.valores) throw new Error(data.error || data.detail || 'Erro ao buscar o balanço patrimonial');
      setBens(Array.isArray(data.bens) ? data.bens : []);
      setValoresAtivos((prev) => ({ ...prev, ...filtrarPorPlano(data.valores, PLANO_ATIVOS) }));
      setValoresPassivo((prev) => ({ ...prev, ...filtrarPorPlano(data.valores, PLANO_PASSIVO) }));
    } catch (error) {
      console.error('Erro ao buscar balanço patrimonial:', error);
      setErro(error instanceof Error ? error.message : 'Erro ao buscar o balanço patrimonial');
    } finally {
      setCarregando(false);
    }
  }

  // ANC.5/ANC.6 abrem em um bem por linha (so exibicao, nao soma no total).
  const planoAtivos = useMemo(
    () =>
      PLANO_ATIVOS.map((g) => ({
        ...g,
        filhos: g.filhos?.map((f) => {
          const doBem = bens.filter((b) => b.linha === f.codigo);
          return doBem.length ? { ...f, detalhes: doBem.map((b) => ({ codigo: b.codigo, nome: b.nome })) } : f;
        }),
      })),
    [bens]
  );
  const valoresAtivosComBens = useMemo(
    () => ({ ...valoresAtivos, ...Object.fromEntries(bens.map((b) => [b.codigo, b.valor])) }),
    [valoresAtivos, bens]
  );
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
    <div className="uppercase [&_button]:uppercase [&_input]:uppercase p-4 md:p-6 space-y-5 bg-[#f5f5f5] min-h-full text-[#1d1d1d] print:p-0 print:bg-white [print-color-adjust:exact] [-webkit-print-color-adjust:exact]">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#e8d7de] bg-gradient-to-r from-[#f5e7ed] via-[#faf5f7] to-white p-5 print:border-0 print:p-0 print:bg-none">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[#8e5e68] text-white shadow-sm print:shadow-none">
            <Scale aria-hidden="true" className="h-7 w-7" />
          </span>
          <div>
            <p className="mb-1 text-[10px] font-bold tracking-[.18em] text-[#8e5e68] print:hidden">Liebe · Controladoria</p>
            <h1 className="text-xl font-bold tracking-tight text-[#36282e] md:text-2xl">Balanço Patrimonial</h1>
            <p className="mt-1 text-[11px] leading-relaxed text-[#6b7280] print:hidden">Ativos e Passivo, por empresa e mês de referência.</p>
            {infoConsulta && (
              <p className="hidden print:block text-sm text-[#4b5563]">
                Mês de referência: {infoConsulta.mes} · {infoConsulta.empresas} · Gerado em {new Date().toLocaleString('pt-BR')}
              </p>
            )}
          </div>
        </div>
        {infoConsulta && (
          <span className="flex items-center gap-2 rounded-lg border border-[#e8d7de] bg-white px-3 py-2 text-xs font-semibold text-[#8e5e68] print:hidden">
            <CalendarDays aria-hidden="true" className="h-4 w-4" />Referência: {infoConsulta.mes}
          </span>
        )}
      </div>

      <div className="bg-white border border-[#e5e7eb] rounded-xl shadow-sm p-4 print:hidden">
        <div className="mb-4 flex items-center gap-2 border-b border-[#f0e7eb] pb-3 text-[11px] font-bold tracking-[.08em] text-[#8e5e68]">
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />Filtros da consulta
        </div>
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label htmlFor="balanco-mes" className="flex items-center gap-1.5 text-[11px] font-semibold text-[#4b5563] mb-1.5"><CalendarDays aria-hidden="true" className="h-3.5 w-3.5 text-[#8e5e68]" />Mês de referência</label>
            <input
              id="balanco-mes"
              type="month"
              value={mesReferencia}
              onChange={(e) => setMesReferencia(e.target.value)}
              className="px-3 py-2 border border-[#d1d5db] rounded-md text-sm text-[#1d1d1d] focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
          </div>

          <div className="relative">
            <label htmlFor="balanco-empresas" className="flex items-center gap-1.5 text-[11px] font-semibold text-[#4b5563] mb-1.5"><Building2 aria-hidden="true" className="h-3.5 w-3.5 text-[#8e5e68]" />Empresas</label>
            <button
              id="balanco-empresas"
              aria-expanded={filtroLojasAberto}
              onClick={() => setFiltroLojasAberto((v) => !v)}
              className="flex items-center justify-between gap-4 px-3 py-2 border border-[#d1d5db] rounded-md text-sm text-[#1d1d1d] bg-white hover:bg-[#f5ecef] min-w-[190px] text-left"
            >
              Empresas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
              <ChevronDown aria-hidden="true" className={`h-4 w-4 text-[#8e5e68] transition-transform ${filtroLojasAberto ? 'rotate-180' : ''}`} />
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
            className="flex items-center gap-2 px-4 py-2 border border-[#d1d5db] rounded-md text-sm font-medium text-[#4b5563] bg-white hover:bg-[#f5ecef]"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4 text-[#8e5e68]" />
            Limpar filtros
          </button>
          <button
            onClick={() => window.print()}
            disabled={!consultaExecutada || carregando}
            title={consultaExecutada ? 'Gerar PDF da página (Salvar como PDF na janela de impressão)' : 'Faça a consulta primeiro'}
            className="px-4 py-2 border border-[#d1d5db] rounded-md text-sm font-medium text-[#1d1d1d] bg-white hover:bg-[#f5ecef] flex items-center gap-2 disabled:opacity-50"
          >
            <FileDown className="w-4 h-4 text-[#8e5e68]" />
            Gerar PDF
          </button>
          {salvoAtivo && <span className="text-[13px] text-[#8e5e68] font-medium">Filtros salvos aplicados</span>}
        </div>
        {erro && (
          <div role="alert" className="mt-3 text-sm text-[#b91c1c] bg-[#fef2f2] border border-red-200 rounded px-3 py-2">{erro}</div>
        )}
      </div>

      {!consultaExecutada ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-[#d9c1cb] bg-white px-6 py-14 text-center">
          <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#f5e7ed] text-[#8e5e68]"><Layers3 aria-hidden="true" className="h-8 w-8" /></span>
          <h2 className="text-sm font-bold tracking-wide text-[#4d3841]">Sua posição patrimonial em uma visão</h2>
          <p className="mt-2 max-w-md text-xs leading-relaxed text-[#6b7280]">Escolha o mês e as empresas e clique em Consultar para visualizar os saldos e indicadores.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2 text-[10px] font-semibold">
            <span className="flex items-center gap-1.5 rounded-full bg-teal-50 px-3 py-1.5 text-teal-800"><Wallet aria-hidden="true" className="h-3.5 w-3.5" />Ativo</span>
            <span className="flex items-center gap-1.5 rounded-full bg-[#faf0f3] px-3 py-1.5 text-[#92485d]"><Landmark aria-hidden="true" className="h-3.5 w-3.5" />Passivo</span>
            <span className="flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1.5 text-indigo-800"><Gauge aria-hidden="true" className="h-3.5 w-3.5" />Indicadores</span>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs font-bold tracking-[.08em] text-[#6e4b59]"><Layers3 aria-hidden="true" className="h-4 w-4" />Visão patrimonial</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CardTotal rotulo="Total dos Ativos" valor={totalAtivos} tom="ativo" icone={ArrowDownLeft} nota="Bens e direitos da empresa" />
            <CardTotal rotulo="Total do Passivo" valor={totalPassivo} tom="passivo" icone={ArrowUpRight} nota="Obrigações de curto e longo prazo" />
            <CardTotal rotulo="Ativos − Passivo" valor={totalAtivos - Math.abs(totalPassivo)} tom="patrimonio" icone={Scale} nota="Ativo total menos o valor absoluto do passivo" />
          </div>
          <div className="flex items-center gap-2 text-xs font-bold tracking-[.08em] text-[#6e4b59]"><Target aria-hidden="true" className="h-4 w-4" />Indicadores financeiros</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
            <CardIndicador
              rotulo="Liquidez imediata"
              icone={Wallet}
              valor={liqImediata === null ? '-' : fmtIndice(liqImediata)}
              meta="quanto mais perto de 1, melhor"
              detalhe="Caixa ÷ Passivo Circulante"
              status={statusProximoDe1(liqImediata)}
            />
            <CardIndicador
              rotulo="Liquidez seca"
              icone={Droplets}
              valor={liqSeca === null ? '-' : fmtIndice(liqSeca)}
              meta="quanto mais perto de 1, melhor"
              detalhe="(Ativo Circ. − Estoques) ÷ Passivo Circ."
              status={statusProximoDe1(liqSeca)}
            />
            <CardIndicador
              rotulo="Liquidez corrente"
              icone={Gauge}
              valor={liqCorrente === null ? '-' : fmtIndice(liqCorrente)}
              meta="sempre acima de 1"
              detalhe="Ativo Circulante ÷ Passivo Circulante"
              status={liqCorrente === null ? 'neutro' : liqCorrente >= 1 ? 'ok' : liqCorrente >= 0.9 ? 'atencao' : 'ruim'}
            />
            <CardIndicador
              rotulo="ROE"
              icone={TrendingUp}
              valor={roe === null ? (indicadoresDre ? '-' : 'Carregando...') : `${fmtIndice(roe)}%`}
              meta="lucro 12 meses ÷ patrimônio líquido"
              detalhe={indicadoresDre ? `Lucro 12m (${mesAno(indicadoresDre.inicio)} a ${mesAno(indicadoresDre.fim)}): ${formatarValor(indicadoresDre.lucroLiquido12m)}` : 'Lucro líquido da DRE consolidada'}
              status="neutro"
            />
            <CardIndicador
              rotulo="Dívida líquida ÷ EBITDA"
              icone={Landmark}
              valor={dividaEbitda === null ? (indicadoresDre ? 'n/d' : 'Carregando...') : `${fmtIndice(dividaEbitda)}x`}
              meta="não pode passar de 3"
              detalhe={indicadoresDre ? `Dív. líq. ${formatarValor(dividaLiquida)} · EBITDA 12m (${mesAno(indicadoresDre.inicio)} a ${mesAno(indicadoresDre.fim)}): ${formatarValor(indicadoresDre.ebitda12m)}` : 'Fornecedores + empréstimos − caixa'}
              status={dividaEbitda === null ? (indicadoresDre ? 'ruim' : 'neutro') : dividaEbitda <= 2.5 ? 'ok' : dividaEbitda <= 3 ? 'atencao' : 'ruim'}
            />
          </div>
          <div className="flex items-center gap-2 text-xs font-bold tracking-[.08em] text-[#6e4b59]"><Receipt aria-hidden="true" className="h-4 w-4" />Detalhamento das contas</div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
            <TabelaBalanco
              titulo="Ativos"
              plano={planoAtivos}
              valores={valoresAtivosComBens}
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
