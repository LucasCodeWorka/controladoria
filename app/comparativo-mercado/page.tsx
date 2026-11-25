'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, ImageIcon, Info, X } from 'lucide-react';
import { QUERY_BALANCO_VISAO_LIEBE } from '../balanco-patrimonial/empresasLiebe';
import { PLANO_ATIVOS, PLANO_PASSIVO } from '../balanco-patrimonial/planoContasBalanco';
import { montarValoresBalanco, totalGrupo, totalGeral } from '../balanco-patrimonial/indicadoresBalanco';
import { DADOS_MERCADO, EMPRESAS_MERCADO, EXPLICACOES, GRUPOS, mediaMercado, type DefIndicador, type IdIndicador } from './dadosMercado';

const ALIQUOTA_IR_CSLL = 0.34; // usada so no ROIC (NOPAT = EBIT x (1 - 34%))

interface DreLiebe {
  lucroLiquido12m: number; ebitda12m: number; receitaLiquida12m: number; cmv12m: number; depreciacao12m: number;
  inicio: string; fim: string;
}
interface LinhaMemoria { t: string; v: string; forte?: boolean }
interface BalancoLiebe { valores: Record<string, number>; caixaDisponivel: number | null; chequeEspecial: number }

const NAO_APLICAVEL_MOTIVO = 'Depende de cotação/ações em bolsa — a Liebe não é listada';

function calcularLiebe(b: BalancoLiebe, d: DreLiebe): { valores: Partial<Record<IdIndicador, number | null>>; memoria: Partial<Record<IdIndicador, LinhaMemoria[]>>; base: { ebitda: number; dividaLiquida: number } } {
  const v = b.valores;
  const ativoCirc = totalGrupo(PLANO_ATIVOS[0], v);
  const passivoCirc = Math.abs(totalGrupo(PLANO_PASSIVO[0], v));
  const totalAtivos = totalGeral(PLANO_ATIVOS, v);
  const totalPassivo = Math.abs(totalGeral(PLANO_PASSIVO, v));
  const pl = totalAtivos - totalPassivo;
  const soma = (cs: string[]) => Math.abs(cs.reduce((s, c) => s + (v[c] ?? 0), 0));
  const dividaBruta = soma(['PC.3']) + soma(['PNC.8']) + (b.chequeEspecial ?? 0);
  const caixa = b.caixaDisponivel ?? (v['AC.1'] ?? 0);
  const dividaLiquida = dividaBruta - caixa;
  const rl = d.receitaLiquida12m;
  const ebitda = d.ebitda12m;
  const ebit = ebitda - d.depreciacao12m;
  const ll = d.lucroLiquido12m;
  const div = (a: number, bb: number, f = 1) => (bb > 0 ? (a / bb) * f : null);
  const capitalInvestido = pl + dividaLiquida;
  const valores: Partial<Record<IdIndicador, number | null>> = {
    div_liq_pl: div(dividaLiquida, pl),
    div_liq_ebitda: div(dividaLiquida, ebitda),
    div_liq_ebit: div(dividaLiquida, ebit),
    pl_ativos: div(pl, totalAtivos),
    passivos_ativos: div(totalPassivo, totalAtivos),
    liq_corrente: div(ativoCirc, passivoCirc),
    m_bruta: div(rl - d.cmv12m, rl, 100),
    m_ebitda: div(ebitda, rl, 100),
    m_ebit: div(ebit, rl, 100),
    m_liquida: div(ll, rl, 100),
    roe: pl !== 0 ? (ll / pl) * 100 : null,
    roa: div(ll, totalAtivos, 100),
    roic: capitalInvestido > 0 ? ((ebit * (1 - ALIQUOTA_IR_CSLL)) / capitalInvestido) * 100 : null,
    giro_ativos: div(rl, totalAtivos),
  };
  const R = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const X = (n: number | null) => (n === null ? 'n/c' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const P = (n: number | null) => (n === null ? 'n/c' : X(n) + '%');
  const L = (t: string, vv: string, forte = false): LinhaMemoria => ({ t, v: vv, forte });
  const dividaLinhas = [
    L('Empréstimos curto prazo (PC.3)', R(soma(['PC.3']))), L('Empréstimos longo prazo (PNC.8)', R(soma(['PNC.8']))),
    L('Cheque especial utilizado', R(b.chequeEspecial ?? 0)), L('(−) Caixa disponível (saldos positivos)', R(caixa)),
    L('Dívida líquida', R(dividaLiquida), true),
  ];
  const memoria: Partial<Record<IdIndicador, LinhaMemoria[]>> = {
    div_liq_pl: [...dividaLinhas, L('Patrimônio líquido (ativos − passivo)', R(pl)), L('Dívida líquida ÷ PL', X(valores.div_liq_pl ?? null) + 'x', true)],
    div_liq_ebitda: [...dividaLinhas, L('EBITDA 12m (DRE consolidada)', R(ebitda)), L('Dívida líquida ÷ EBITDA', X(valores.div_liq_ebitda ?? null) + 'x', true)],
    div_liq_ebit: [...dividaLinhas, L('EBITDA 12m', R(ebitda)), L('(−) Depreciação 12m (DRE)', R(d.depreciacao12m)), L('EBIT 12m', R(ebit), true), L('Dívida líquida ÷ EBIT', X(valores.div_liq_ebit ?? null) + 'x', true)],
    pl_ativos: [L('Ativos totais', R(totalAtivos)), L('(−) Passivo total', R(totalPassivo)), L('Patrimônio líquido', R(pl), true), L('PL ÷ ativos', X(valores.pl_ativos ?? null), true)],
    passivos_ativos: [L('Passivo total', R(totalPassivo)), L('Ativos totais', R(totalAtivos)), L('Passivo ÷ ativos', X(valores.passivos_ativos ?? null), true)],
    liq_corrente: [L('Ativo circulante', R(ativoCirc)), L('Passivo circulante', R(passivoCirc)), L('AC ÷ PC', X(valores.liq_corrente ?? null), true)],
    m_bruta: [L('Receita líquida 12m', R(rl)), L('(−) CMV 12m (conta 04.02)', R(d.cmv12m)), L('Lucro bruto', R(rl - d.cmv12m), true), L('Lucro bruto ÷ receita líquida', P(valores.m_bruta ?? null), true)],
    m_ebitda: [L('EBITDA 12m', R(ebitda)), L('Receita líquida 12m', R(rl)), L('EBITDA ÷ receita líquida', P(valores.m_ebitda ?? null), true)],
    m_ebit: [L('EBITDA 12m', R(ebitda)), L('(−) Depreciação 12m (DRE)', R(d.depreciacao12m)), L('EBIT 12m', R(ebit), true), L('Receita líquida 12m', R(rl)), L('EBIT ÷ receita líquida', P(valores.m_ebit ?? null), true)],
    m_liquida: [L('Lucro líquido 12m', R(ll)), L('Receita líquida 12m', R(rl)), L('Lucro líquido ÷ receita líquida', P(valores.m_liquida ?? null), true)],
    roe: [L('Lucro líquido 12m', R(ll)), L('Ativos totais', R(totalAtivos)), L('(−) Passivo total', R(totalPassivo)), L('Patrimônio líquido', R(pl), true), L('Lucro ÷ PL', P(valores.roe ?? null), true)],
    roa: [L('Lucro líquido 12m', R(ll)), L('Ativos totais', R(totalAtivos)), L('Lucro ÷ ativos', P(valores.roa ?? null), true)],
    roic: [L('EBIT 12m', R(ebit)), L('(×) 1 − alíquota IR/CSLL (34%)', '0,66'), L('NOPAT', R(ebit * (1 - ALIQUOTA_IR_CSLL)), true), L('Patrimônio líquido', R(pl)), L('(+) Dívida líquida', R(dividaLiquida)), L('Capital investido', R(capitalInvestido), true), L('NOPAT ÷ capital investido', P(valores.roic ?? null), true), L('Obs.: aproximação; o Status Invest pode usar outra base de capital investido', '')],
    giro_ativos: [L('Receita líquida 12m', R(rl)), L('Ativos totais', R(totalAtivos)), L('Receita ÷ ativos', X(valores.giro_ativos ?? null), true)],
    cagr_receitas: [L('Não calculável: a DRE do sistema só tem histórico a partir de 2024, sem 5 anos de receita', '')],
    cagr_lucros: [L('Não calculável: a DRE do sistema só tem histórico a partir de 2024, sem 5 anos de lucro', '')],
  };
  return { valores, memoria, base: { ebitda, dividaLiquida } };
}

const fmt = (n: number | null | undefined, f: 'pct' | 'x') =>
  n === null || n === undefined ? '—' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (f === 'pct' ? '%' : '');

export default function ComparativoMercadoPage() {
  const [balanco, setBalanco] = useState<BalancoLiebe | null>(null);
  const [dre, setDre] = useState<DreLiebe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [printAberto, setPrintAberto] = useState<string | null>(null);
  const [popup, setPopup] = useState<IdIndicador | null>(null);
  const [multiplos, setMultiplos] = useState<{ conservador: number; base: number; otimista: number }>({ conservador: 3, base: 4, otimista: 5 });

  const [tentativa, setTentativa] = useState(0);
  useEffect(() => {
    let vivo = true;
    setErro(null); setBalanco(null); setDre(null);
    const h = new Date();
    const mes = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}`;
    fetch(`/api/balanco-patrimonial/indicadores-dre?mesReferencia=${mes}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (vivo && typeof d.lucroLiquido12m === 'number') setDre(d); else if (vivo) setErro(d.detail || d.error || 'Erro ao buscar a DRE'); })
      .catch((e) => vivo && setErro(String(e)));
    fetch(`/api/balanco-patrimonial/dados?mesReferencia=${mes}&${QUERY_BALANCO_VISAO_LIEBE}${tentativa > 0 ? '&forcar=true' : ''}`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d.error || !d.valores) throw new Error(d.error || d.detail || 'Erro ao buscar o balanço patrimonial');
        if (Array.isArray(d.indisponiveis) && d.indisponiveis.length > 0) throw new Error(`Dados do balanço incompletos (consultas que falharam: ${d.indisponiveis.join(', ')}). Os indicadores não foram calculados para não mostrar valores errados. Clique em "Tentar de novo".`);
        if (vivo) setBalanco({ valores: montarValoresBalanco(d.valores), caixaDisponivel: typeof d.caixaDisponivel === 'number' ? d.caixaDisponivel : null, chequeEspecial: Number(d.chequeEspecial ?? 0) });
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)));
    return () => { vivo = false; };
  }, [tentativa]);

  const liebe = balanco && dre ? calcularLiebe(balanco, dre) : null;
  const fmtMes = (iso: string) => iso.slice(5, 7) + '/' + iso.slice(0, 4);

  const corDiferenca = (def: DefIndicador, l: number | null | undefined, m: number | null) => {
    if (l === null || l === undefined || m === null || def.melhor === null) return 'text-black';
    const melhor = def.melhor === 'maior' ? l >= m : l <= m;
    return melhor ? 'text-green-600' : 'text-red-600';
  };

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-brand-dark">COMPARATIVO DE INDICADORES — LIEBE x MERCADO</h1>
        <p className="text-xs text-black mt-1">
          Mercado: Status Invest (aba HOJE, prints de 25/11/2026). Liebe: balanço atual + DRE consolidada dos 12 meses fechados
          {dre ? ` (${fmtMes(dre.inicio)} a ${fmtMes(dre.fim)})` : ''}. Verde = Liebe melhor que a média; vermelho = pior.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-center text-sm">
        <span className="text-black font-medium">Prints originais:</span>
        {EMPRESAS_MERCADO.map((e) => (
          <button key={e.ticker} onClick={() => setPrintAberto(printAberto === e.print ? null : e.print)}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-gray-200 bg-white text-black hover:border-brand-primary hover:text-brand-primary">
            <ImageIcon className="w-3.5 h-3.5" /> {e.ticker}
          </button>
        ))}
      </div>
      {printAberto && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={printAberto} alt="Print do Status Invest" className="max-w-full" />
        </div>
      )}

      {erro && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="text-red-600">{erro}</p>
          <button onClick={() => setTentativa((t) => t + 1)} className="px-3 py-1 rounded-full border border-brand-primary text-brand-primary hover:bg-brand-primary hover:text-white">Tentar de novo</button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-600 text-white text-right">
              <th className="px-4 py-3 font-semibold text-left">Indicador</th>
              <th className="px-4 py-3 font-semibold">LIEBE</th>
              {EMPRESAS_MERCADO.map((e) => (<th key={e.ticker} className="px-4 py-3 font-semibold" title={e.nome}>{e.ticker}</th>))}
              <th className="px-4 py-3 font-semibold">Média mercado</th>
              <th className="px-4 py-3 font-semibold">Liebe − média</th>
            </tr>
          </thead>
          <tbody>
            {GRUPOS.map((g) => (
              <React.Fragment key={g.titulo}>
                <tr className="bg-gray-100">
                  <td colSpan={EMPRESAS_MERCADO.length + 4} className="px-4 py-2 font-bold text-black">{g.titulo}</td>
                </tr>
                {g.indicadores.map((def) => {
                  const media = mediaMercado(def.id);
                  const l = liebe?.valores[def.id];
                  const temLiebe = def.id in (liebe?.valores ?? {});
                  const dif = l !== null && l !== undefined && media !== null ? l - media : null;
                  const motivo = g.titulo.startsWith('Valuation') ? NAO_APLICAVEL_MOTIVO : (liebe?.memoria[def.id]?.[0]?.t ?? '');
                  return (
                    <tr key={def.id} className="border-t border-gray-100">
                      <td className="px-4 py-3 font-semibold text-black whitespace-nowrap">
                        <button onClick={() => setPopup(def.id)} className="inline-flex items-center gap-1.5 hover:text-brand-primary text-left" title="Ver explicação e memória de cálculo">
                          {def.titulo}<Info className="w-3.5 h-3.5 text-gray-500" />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold whitespace-nowrap" title={motivo}>
                        {!liebe && !erro ? <Loader2 className="w-4 h-4 animate-spin inline" /> : temLiebe ? (l === null || l === undefined ? <span className="text-gray-500" title={`Não calculável com os dados atuais (denominador zero ou negativo, ex.: PL negativo). ${motivo}`}>n/c</span> : <span className={corDiferenca(def, l, media)}>{fmt(l, def.formato)}</span>) : <span className="text-gray-500" title={motivo}>n/d</span>}
                      </td>
                      {EMPRESAS_MERCADO.map((e) => (
                        <td key={e.ticker} className="px-4 py-3 text-right text-black whitespace-nowrap">{fmt(DADOS_MERCADO[e.ticker][def.id], def.formato)}</td>
                      ))}
                      <td className="px-4 py-3 text-right font-semibold text-black whitespace-nowrap">{fmt(media, def.formato)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-black">
                        {dif === null ? '—' : (dif > 0 ? '+' : '') + fmt(dif, def.formato)}
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 text-xs text-black space-y-1">
        <p className="font-bold text-sm">Clique no nome de um indicador para ver a explicação e a memória de cálculo da Liebe.</p>
        <p><span className="font-semibold">Valuation:</span> {NAO_APLICAVEL_MOTIVO}; por isso aparecem só os valores do mercado e a média.</p>
        <p><span className="font-semibold">Média do mercado:</span> média simples das 5 empresas, ignorando as que não têm o dado. Em valuation, Track & Field distorce a média (múltiplos muito acima das demais).</p>
      </div>

      {liebe && (() => {
        const { ebitda, dividaLiquida } = liebe.base;
        const R = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
        const cenarios: { chave: 'conservador' | 'base' | 'otimista'; titulo: string }[] = [
          { chave: 'conservador', titulo: 'Conservador' }, { chave: 'base', titulo: 'Base' }, { chave: 'otimista', titulo: 'Otimista' },
        ];
        const faixa = Array.from({ length: 9 }, (_, i) => 2 + i * 0.5);
        const ev = (m: number) => m * ebitda;
        return (
          <div className="space-y-3">
            <h2 className="text-lg font-bold text-black">Análise de sensibilidade do valuation — múltiplo de EBITDA</h2>
            <p className="text-xs text-black">
              EBITDA 12 meses fechados{dre ? ` (${fmtMes(dre.inicio)} a ${fmtMes(dre.fim)})` : ''}: <span className="font-semibold">{R(ebitda)}</span> ·
              Dívida líquida (visão Liebe): <span className="font-semibold">{R(dividaLiquida)}</span>. Valor da firma = múltiplo × EBITDA; valor do acionista = valor da firma − dívida líquida.
              Os múltiplos dos cenários são editáveis.
            </p>
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-600 text-white text-right">
                    <th className="px-4 py-3 font-semibold text-left">Cenário</th>
                    {cenarios.map((c) => (<th key={c.chave} className="px-4 py-3 font-semibold">{c.titulo}</th>))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-gray-100">
                    <td className="px-4 py-3 font-semibold text-black">Múltiplo EV/EBITDA</td>
                    {cenarios.map((c) => (
                      <td key={c.chave} className="px-4 py-3 text-right">
                        <input type="number" step="0.1" min="0" value={multiplos[c.chave]}
                          onChange={(e) => setMultiplos((m) => ({ ...m, [c.chave]: Math.max(0, Number(e.target.value) || 0) }))}
                          className="w-20 text-right border border-gray-300 rounded px-2 py-1 text-black" /> x
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t border-gray-100">
                    <td className="px-4 py-3 text-black">× EBITDA 12m</td>
                    {cenarios.map((c) => (<td key={c.chave} className="px-4 py-3 text-right text-black">{R(ebitda)}</td>))}
                  </tr>
                  <tr className="border-t border-gray-200 bg-gray-50">
                    <td className="px-4 py-3 font-semibold text-black">Valor da firma (EV)</td>
                    {cenarios.map((c) => (<td key={c.chave} className="px-4 py-3 text-right font-semibold text-black">{R(ev(multiplos[c.chave]))}</td>))}
                  </tr>
                  <tr className="border-t border-gray-100">
                    <td className="px-4 py-3 text-black">(−) Dívida líquida</td>
                    {cenarios.map((c) => (<td key={c.chave} className="px-4 py-3 text-right text-black">{R(dividaLiquida)}</td>))}
                  </tr>
                  <tr className="border-t border-gray-200 bg-gray-50">
                    <td className="px-4 py-3 font-semibold text-black">Valor do acionista (equity)</td>
                    {cenarios.map((c) => {
                      const v = ev(multiplos[c.chave]) - dividaLiquida;
                      return <td key={c.chave} className={`px-4 py-3 text-right font-semibold ${v < 0 ? 'text-red-600' : 'text-black'}`}>{R(v)}</td>;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-600 text-white text-right">
                    <th className="px-4 py-3 font-semibold text-left">Sensibilidade</th>
                    {faixa.map((m) => (<th key={m} className="px-3 py-3 font-semibold whitespace-nowrap">{m.toLocaleString('pt-BR', { minimumFractionDigits: 1 })}x</th>))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-gray-100">
                    <td className="px-4 py-3 font-semibold text-black whitespace-nowrap">Valor da firma</td>
                    {faixa.map((m) => (<td key={m} className="px-3 py-3 text-right text-black whitespace-nowrap">{R(ev(m))}</td>))}
                  </tr>
                  <tr className="border-t border-gray-100">
                    <td className="px-4 py-3 font-semibold text-black whitespace-nowrap">Valor do acionista</td>
                    {faixa.map((m) => {
                      const v = ev(m) - dividaLiquida;
                      return <td key={m} className={`px-3 py-3 text-right whitespace-nowrap ${v < 0 ? 'text-red-600' : 'text-black'}`}>{R(v)}</td>;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 text-xs text-black space-y-1">
              <p className="font-bold text-sm">De onde vêm os múltiplos (premissas — não há múltiplo de mercado publicado para o porte da Liebe)</p>
              <p><span className="font-semibold">Conservador 3,0x:</span> média das 5 varejistas listadas dos seus prints (EV/EBITDA de 1,29x a 6,89x, média 3,07x).</p>
              <p><span className="font-semibold">Base 4,0x:</span> referências setoriais de companhias abertas (vestuário baixa renda a ~5,8x em set/2024, segundo a Genial; Kroll América Latina ~7,3x em 1T/2023) com desconto de iliquidez de ~41,5% para empresa fechada (estudo PUC-Rio sobre o mercado brasileiro) — resulta em ~3,4x a ~4,3x.</p>
              <p><span className="font-semibold">Otimista 5,0x:</span> referência de vestuário baixa renda (~5,8x) com desconto menor (~15%), como em empresas fechadas com crescimento e marca forte.</p>
              <p>Como contraste, o Damodaran (jan/2026) mostra ~10,3x para vestuário em empresas globais listadas — sem desconto de tamanho e liquidez, não é comparável à Liebe.</p>
              <p><span className="font-semibold">Limites:</span> a dívida líquida considera empréstimos e cheque especial menos caixa disponível; não inclui obrigações por compra de imóveis nem dívida tributária (a alavancagem ajustada da tela de Indicadores inclui os imóveis). O EBITDA vem da DRE consolidada sem depreciação lançada.</p>
              <p>Fontes: <a className="underline" href="https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/vebitda.html" target="_blank" rel="noreferrer">Damodaran</a> ·
                {' '}<a className="underline" href="https://analisa.genialinvestimentos.com.br/setores/vestuario/ceab3-inicio-de-cobertura-rumo-nova-era-de-margens/" target="_blank" rel="noreferrer">Genial (C&A)</a> ·
                {' '}<a className="underline" href="https://www.kroll.com/-/media/kroll-br/pdf/multiplos-da-industria-na-america-latina-2-trimestre-2023.pdf" target="_blank" rel="noreferrer">Kroll</a> ·
                {' '}<a className="underline" href="https://www.maxwell.vrac.puc-rio.br/28301/28301_6.PDF" target="_blank" rel="noreferrer">PUC-Rio (desconto de liquidez)</a></p>
            </div>
          </div>
        );
      })()}

      {popup && (() => {
        const def = GRUPOS.flatMap((g) => g.indicadores).find((d) => d.id === popup)!;
        const ehValuation = GRUPOS[0].indicadores.some((d) => d.id === popup);
        const exp = EXPLICACOES[popup];
        const mem = liebe?.memoria[popup];
        const l = liebe?.valores[popup];
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPopup(null)}>
            <div className="bg-white rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-lg font-bold text-black">{def.titulo}</h2>
                <button onClick={() => setPopup(null)} aria-label="Fechar" className="text-black hover:text-brand-primary"><X className="w-5 h-5" /></button>
              </div>
              <div className="text-sm text-black space-y-1">
                <p>{exp.o_que}</p>
                <p><span className="font-semibold">Fórmula:</span> {exp.formula}</p>
              </div>
              <div>
                <p className="font-semibold text-sm text-black mb-1">Memória de cálculo — Liebe{!ehValuation && l !== undefined && l !== null ? `: ${fmt(l, def.formato)}` : ''}</p>
                {ehValuation ? (
                  <p className="text-sm text-black">{NAO_APLICAVEL_MOTIVO}. Por isso aparecem só os valores do mercado.</p>
                ) : !mem ? (
                  <p className="text-sm text-black"><Loader2 className="w-4 h-4 animate-spin inline mr-1" />Carregando...</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {mem.map((m, i) => (
                        <tr key={i} className="border-t border-gray-100">
                          <td className={`py-1.5 pr-3 text-black ${m.forte ? 'font-semibold' : ''}`}>{m.t}</td>
                          <td className={`py-1.5 text-right whitespace-nowrap text-black ${m.forte ? 'font-semibold' : ''}`}>{m.v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <p className="font-semibold text-sm text-black mb-1">Mercado (Status Invest)</p>
                <table className="w-full text-sm">
                  <tbody>
                    {EMPRESAS_MERCADO.map((e) => (
                      <tr key={e.ticker} className="border-t border-gray-100">
                        <td className="py-1.5 text-black">{e.ticker} — {e.nome}</td>
                        <td className="py-1.5 text-right text-black">{fmt(DADOS_MERCADO[e.ticker][popup], def.formato)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-gray-200">
                      <td className="py-1.5 font-semibold text-black">Média</td>
                      <td className="py-1.5 text-right font-semibold text-black">{fmt(mediaMercado(popup), def.formato)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
