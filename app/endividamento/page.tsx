'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Landmark, Loader2, RefreshCw, Plus, Save, Trash2 } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type Modalidade = 'SAC' | 'PRICE';
type Aba = 'painel' | 'sac' | 'price';

interface Contrato {
  id: number; nome: string; instituicao: string | null; cd_fornecedor: number | null; nr_duplicata: number | null;
  empresa: string | null; natureza: string | null; operacao: string | null; modalidade: Modalidade; base_juros: 'mensal' | 'dias';
  dt_liberacao: string; valor_liberado: number; prazo_meses: number; carencia_meses: number; per_juros_carencia: number;
  taxa_aa: number; parcela_fixa: number | null; primeiro_vencimento: string | null; taxa_confirmada: boolean; origem: string;
  metodo_calibracao: string | null; ajuste_erro: number | null; observacao: string | null;
  saldoAtual: number; proximaParcela: { vencimento: string; valor: number } | null; vencimentoFinal: string | null;
  jurosRestantes: number; parcelasRestantes: number; taxaMensal: number; titulosAbertos: { principal: number; juros: number };
}
interface LinhaCron { n: number; vencimento: string; dias: number; saldoInicial: number; juros: number; amortizacao: number; parcela: number; saldoDevedor: number; carencia: boolean }
interface Totais { juros: number; amortizacao: number; parcelas: number }
interface MesPainel {
  mes: string; n: number; saldo: number; custoMensal: number; custoAnual: number; despesaFinanceira: number; difMesAnterior: number;
  ganho12m: number; parcelas: number; jurosCronograma: number; distanciaMetaDivida: number | null; distanciaMetaCusto: number | null;
}
interface ItemDetalhe {
  id: number; nome: string; empresa: string | null; natureza: string | null; operacao: string | null; instituicao: string | null;
  modalidade: Modalidade; vencimentoFinal: string | null; taxaAa: number; taxaMensal: number; saldo: number; parcela: number;
  ponderacao: number; proporcaoTaxa: number; taxaConfirmada: boolean;
}
interface Painel {
  meses: MesPainel[];
  anos: { ano: number; mesInicial: string; mesFinal: string; saldoFinal: number; saldoMedio: number; despesaFinanceira: number; jurosCronograma: number; parcelas: number; custoMensalMedio: number }[];
  metas: { metaDivida: number | null; metaCustoMensal: number | null };
  detalheMes: { mes: string | null; contratos: ItemDetalhe[] };
  conferenciaBalanco: { principalTitulos: number; jurosTitulos: number; saldoModelo: number; diferenca: number };
  qtdContratos: number;
}

interface Selic { disponivel: boolean; aa: number | null; mensal: number | null; data: string | null; fonte: string }

const moeda = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (v: number | null | undefined, casas = 2) => (v === null || v === undefined ? '-' : `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`);
const NOMES_MES = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (m: string) => `${NOMES_MES[parseInt(m.split('-')[1], 10)]}/${m.split('-')[0].slice(2)}`;
const fmtData = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '-');
const DIAS_SEMANA = ['Domingo', 'Segunda-Feira', 'Terça-Feira', 'Quarta-Feira', 'Quinta-Feira', 'Sexta-Feira', 'Sábado'];
const diaSemana = (iso: string) => DIAS_SEMANA[new Date(`${iso.slice(0, 10)}T12:00:00`).getDay()];
const hojeISO = () => new Date().toISOString().slice(0, 10);

async function chamar<T>(caminho: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/endividamento/${caminho}`, { cache: 'no-store', ...init });
  const j = await r.json();
  if (!r.ok) throw new Error(j.detail || j.error || 'Erro na requisição');
  return j as T;
}

function Cartao({ rotulo, valor, detalhe, destaque }: { rotulo: string; valor: string; detalhe?: string; destaque?: boolean }) {
  return (
    <div className={`rounded-lg shadow-md p-4 ${destaque ? 'bg-blue-50 border border-blue-200' : 'bg-white'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-black">{rotulo}</p>
      <p className="text-2xl font-bold text-brand-dark mt-1">{valor}</p>
      {detalhe && <p className="text-xs text-black mt-1">{detalhe}</p>}
    </div>
  );
}

// Custo da divida x Selic: quanto a divida custa acima (ou abaixo) da taxa basica da economia.
function CartaoSelic({ selic, custoAnual, saldo, contratos }: { selic: Selic | null; custoAnual: number; saldo: number; contratos: ItemDetalhe[] }) {
  if (!selic) return <div className="bg-white rounded-lg shadow-md p-4 text-sm">Buscando a Selic…</div>;
  if (!selic.disponivel || selic.aa === null) {
    return <div className="bg-white rounded-lg shadow-md p-4 text-sm">Comparação com a Selic indisponível: não foi possível consultar o Banco Central agora.</div>;
  }
  const selicAa: number = selic.aa;
  const spread = custoAnual - selicAa;
  const razao = selicAa ? custoAnual / selicAa : 0;
  const efeitoAno = saldo * spread; // R$/ano a mais (ou a menos) do que custaria a Selic sobre o mesmo saldo
  const acima = spread > 0;
  const pp = (v: number) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} p.p.`;
  const maxTaxa = Math.max(selicAa, custoAnual, ...contratos.map((c) => c.taxaAa), 0.01);
  const barra = (v: number, cor: string) => <div className="h-2 rounded" style={{ width: `${Math.min(100, (v / maxTaxa) * 100)}%`, background: cor }} />;
  return (
    <div className="bg-white rounded-lg shadow-md p-4">
      <div className="flex flex-wrap items-baseline gap-2 mb-3">
        <h2 className="text-sm font-bold text-brand-dark">Custo da dívida × Selic</h2>
        <span className="text-xs">{selic.fonte}{selic.data ? ` · ${selic.data}` : ''}</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <div><p className="text-xs font-semibold uppercase">Selic (meta)</p><p className="text-2xl font-bold">{pct(selic.aa)}</p><p className="text-xs">a.a. · {pct(selic.mensal, 3)} a.m.</p></div>
        <div><p className="text-xs font-semibold uppercase">Custo médio da dívida</p><p className="text-2xl font-bold">{pct(custoAnual)}</p><p className="text-xs">a.a., ponderado pelo saldo</p></div>
        <div>
          <p className="text-xs font-semibold uppercase">Spread sobre a Selic</p>
          <p className={`text-2xl font-bold ${acima ? 'text-red-600' : 'text-green-700'}`}>{pp(spread)}</p>
          <p className="text-xs">a dívida custa {razao.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}× a Selic</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase">{acima ? 'Custo acima da Selic' : 'Custo abaixo da Selic'}</p>
          <p className={`text-2xl font-bold ${acima ? 'text-red-600' : 'text-green-700'}`}>{moeda(Math.abs(efeitoAno))}</p>
          <p className="text-xs">por ano, sobre o saldo de {moeda(saldo)}</p>
        </div>
      </div>
      <div className="space-y-2">
        <div className="grid grid-cols-[minmax(160px,260px)_1fr_150px] items-center gap-3 text-xs">
          <span className="font-semibold">Selic (meta)</span>{barra(selicAa, '#6b7280')}<span className="text-right">{pct(selicAa)}</span>
        </div>
        {contratos.map((c) => (
          <div key={c.id} className="grid grid-cols-[minmax(160px,260px)_1fr_150px] items-center gap-3 text-xs">
            <span className="truncate" title={c.nome}>{c.nome}</span>
            {barra(c.taxaAa, c.taxaAa > selicAa ? '#c5949d' : '#86efac')}
            <span className={`text-right ${c.taxaAa > selicAa ? 'text-red-600' : 'text-green-700'}`}>{pct(c.taxaAa)} ({pp(c.taxaAa - selicAa)})</span>
          </div>
        ))}
      </div>
      <p className="text-xs mt-3">Taxas efetivas anuais dos contratos modelados contra a meta Selic anual. Contratos &quot;a confirmar&quot; usam a taxa calibrada pelos títulos.</p>
    </div>
  );
}

// ───────────────────────── Painel Dívida Geral ─────────────────────────

function PainelDivida({ painel, selic, mesDetalhe, setMesDetalhe, onAbrir, onSalvarMetas }: {
  painel: Painel; selic: Selic | null; mesDetalhe: string; setMesDetalhe: (m: string) => void; onAbrir: (c: ItemDetalhe) => void;
  onSalvarMetas: (md: number | null, mc: number | null) => Promise<void>;
}) {
  const [metaDivida, setMetaDivida] = useState(painel.metas.metaDivida !== null ? String(painel.metas.metaDivida) : '');
  const [metaCusto, setMetaCusto] = useState(painel.metas.metaCustoMensal !== null ? (painel.metas.metaCustoMensal * 100).toFixed(2).replace('.', ',') : '');
  const [salvandoMetas, setSalvandoMetas] = useState(false);
  const m0 = painel.meses[0];
  const m1 = painel.meses[1];
  const conf = painel.conferenciaBalanco;
  const det = painel.detalheMes.contratos;
  const totSaldo = det.reduce((s, c) => s + c.saldo, 0);
  const totParcela = det.reduce((s, c) => s + c.parcela, 0);
  const totProporcao = det.reduce((s, c) => s + c.proporcaoTaxa, 0);
  const dados = painel.meses.map((m) => ({ mes: rotuloMes(m.mes), saldo: m.saldo, despesa: m.despesaFinanceira }));

  const linhas: { rotulo: string; valor: (m: MesPainel) => string; cor?: (m: MesPainel) => string }[] = [
    { rotulo: 'Total Dívida', valor: (m) => moeda(m.saldo) },
    { rotulo: 'Custo % Mensal', valor: (m) => pct(m.custoMensal, 3) },
    { rotulo: 'Custo % Anual', valor: (m) => pct(m.custoAnual) },
    { rotulo: 'Despesa Financeira', valor: (m) => moeda(m.despesaFinanceira) },
    { rotulo: 'Dif. Mês Anterior', valor: (m) => moeda(m.difMesAnterior), cor: (m) => (m.difMesAnterior < 0 ? 'text-green-700' : m.difMesAnterior > 0 ? 'text-red-600' : '') },
    { rotulo: 'Ganho em 12 meses', valor: (m) => moeda(m.ganho12m), cor: (m) => (m.ganho12m < 0 ? 'text-green-700' : m.ganho12m > 0 ? 'text-red-600' : '') },
    { rotulo: 'Parcelas pagas no mês', valor: (m) => moeda(m.parcelas) },
    { rotulo: 'Juros no cronograma', valor: (m) => moeda(m.jurosCronograma) },
    { rotulo: '(1) Meta R$ dívida', valor: () => (painel.metas.metaDivida !== null ? moeda(painel.metas.metaDivida) : '-') },
    { rotulo: 'Distância da Meta (1)', valor: (m) => (m.distanciaMetaDivida !== null ? moeda(m.distanciaMetaDivida) : '-'), cor: (m) => ((m.distanciaMetaDivida ?? 0) > 0 ? 'text-red-600' : 'text-green-700') },
    { rotulo: '(2) Meta custo da dívida', valor: () => (painel.metas.metaCustoMensal !== null ? pct(painel.metas.metaCustoMensal, 3) : '-') },
    { rotulo: 'Distância da Meta (2)', valor: (m) => (m.distanciaMetaCusto !== null ? pct(m.distanciaMetaCusto, 3) : '-'), cor: (m) => ((m.distanciaMetaCusto ?? 0) > 0 ? 'text-red-600' : 'text-green-700') },
  ];

  async function salvarMetas() {
    setSalvandoMetas(true);
    try {
      const md = metaDivida.trim() === '' ? null : Number(metaDivida.replace(/\./g, '').replace(',', '.'));
      const mc = metaCusto.trim() === '' ? null : Number(metaCusto.replace(',', '.')) / 100;
      await onSalvarMetas(md !== null && !Number.isNaN(md) ? md : null, mc !== null && !Number.isNaN(mc) ? mc : null);
    } finally {
      setSalvandoMetas(false);
    }
  }

  return (
    <div className="space-y-6 text-black">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Cartao rotulo="Dívida hoje (modelo)" valor={moeda(conf.saldoModelo)} detalhe={`${painel.qtdContratos} contratos modelados`} destaque />
        <Cartao rotulo="Custo mensal ponderado" valor={pct(m0?.custoMensal ?? 0, 3)} detalhe={`${pct(m0?.custoAnual ?? 0)} a.a. equivalente`} />
        <Cartao rotulo="Despesa financeira do mês" valor={moeda(m0?.despesaFinanceira ?? 0)} detalhe={m1 ? `Próximo mês: ${moeda(m1.despesaFinanceira)}` : undefined} />
        <Cartao
          rotulo="Conferência com o balanço"
          valor={moeda(conf.diferenca)}
          detalhe={`Títulos de principal em aberto (114): ${moeda(conf.principalTitulos)} − saldo do modelo ${moeda(conf.saldoModelo)}. Diferença = juros embutidos nas parcelas cheias e ajustes de calibração.`}
        />
      </div>


      <CartaoSelic selic={selic} custoAnual={m0?.custoAnual ?? 0} saldo={m0?.saldo ?? 0} contratos={painel.detalheMes.contratos} />

      <div className="bg-white rounded-lg shadow-md p-4">
        <h2 className="text-sm font-bold text-brand-dark mb-1">Saldo da dívida e despesa financeira — próximos {painel.meses.length} meses</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={dados} margin={{ top: 10, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="mes" tick={{ fontSize: 11, fill: '#000' }} />
              <YAxis yAxisId="esq" tick={{ fontSize: 11, fill: '#000' }} tickFormatter={(v) => `${(Number(v) / 1_000_000).toFixed(1)} mi`} />
              <YAxis yAxisId="dir" orientation="right" tick={{ fontSize: 11, fill: '#000' }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
              <Tooltip formatter={(v, n) => [moeda(Number(v)), n === 'saldo' ? 'Saldo da dívida' : 'Despesa financeira']} />
              <Legend formatter={(v) => (v === 'saldo' ? 'Saldo da dívida' : 'Despesa financeira')} />
              <Bar yAxisId="esq" dataKey="saldo" fill="#c5949d" name="saldo" />
              <Line yAxisId="dir" type="monotone" dataKey="despesa" stroke="#8B6E5A" strokeWidth={2} dot={false} name="despesa" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <h2 className="text-sm font-bold text-brand-dark mr-auto">Acompanhamento do pagamento da dívida (valores em reais)</h2>
          <label className="text-xs font-medium">
            <span className="block mb-1">Meta R$ dívida</span>
            <input value={metaDivida} onChange={(e) => setMetaDivida(e.target.value)} placeholder="ex.: 1500000" className="px-2 py-1.5 border border-gray-300 rounded text-sm w-36" />
          </label>
          <label className="text-xs font-medium">
            <span className="block mb-1">Meta custo % a.m.</span>
            <input value={metaCusto} onChange={(e) => setMetaCusto(e.target.value)} placeholder="ex.: 1,5" className="px-2 py-1.5 border border-gray-300 rounded text-sm w-28" />
          </label>
          <button onClick={salvarMetas} disabled={salvandoMetas} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
            {salvandoMetas ? 'Salvando...' : 'Salvar metas'}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-100 text-xs">
                <th className="px-3 py-2 text-left sticky left-0 bg-gray-100 z-10 min-w-[190px]">Variáveis</th>
                {painel.meses.map((m) => <th key={m.mes} className="px-3 py-2 text-right whitespace-nowrap">Mês {m.n}<br /><span className="font-normal">{rotuloMes(m.mes)}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.rotulo} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-semibold sticky left-0 bg-white z-10">{l.rotulo}</td>
                  {painel.meses.map((m) => <td key={m.mes} className={`px-3 py-1.5 text-right whitespace-nowrap ${l.cor ? l.cor(m) : ''}`}>{l.valor(m)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-100 text-xs">
                <th className="px-3 py-2 text-left">Resumo anual</th>
                <th className="px-3 py-2 text-right">Saldo médio</th>
                <th className="px-3 py-2 text-right">Saldo no fim</th>
                <th className="px-3 py-2 text-right">Despesa financeira</th>
                <th className="px-3 py-2 text-right">Juros no cronograma</th>
                <th className="px-3 py-2 text-right">Parcelas pagas</th>
                <th className="px-3 py-2 text-right">Custo mensal médio</th>
              </tr>
            </thead>
            <tbody>
              {painel.anos.map((a) => (
                <tr key={a.ano} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-semibold">Ano {a.ano} ({rotuloMes(a.mesInicial)} a {rotuloMes(a.mesFinal)})</td>
                  <td className="px-3 py-1.5 text-right">{moeda(a.saldoMedio)}</td>
                  <td className="px-3 py-1.5 text-right">{moeda(a.saldoFinal)}</td>
                  <td className="px-3 py-1.5 text-right">{moeda(a.despesaFinanceira)}</td>
                  <td className="px-3 py-1.5 text-right">{moeda(a.jurosCronograma)}</td>
                  <td className="px-3 py-1.5 text-right">{moeda(a.parcelas)}</td>
                  <td className="px-3 py-1.5 text-right">{pct(a.custoMensalMedio, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-4">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h2 className="text-sm font-bold text-brand-dark mr-auto">Posição por contrato — custo da dívida com empréstimos</h2>
          <label className="text-xs font-medium flex items-center gap-2">
            Mês
            <select value={mesDetalhe} onChange={(e) => setMesDetalhe(e.target.value)} className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
              {painel.meses.map((m) => <option key={m.mes} value={m.mes}>Mês {m.n} — {rotuloMes(m.mes)}</option>)}
            </select>
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-100 text-xs">
                <th className="px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">Contrato</th>
                <th className="px-2 py-2 text-left">Natureza</th>
                <th className="px-2 py-2 text-left">Sistema</th>
                <th className="px-2 py-2 text-left">Venc. final</th>
                <th className="px-2 py-2 text-right">Taxa a.a.</th>
                <th className="px-2 py-2 text-right">Taxa a.m.</th>
                <th className="px-2 py-2 text-right">Saldo do mês</th>
                <th className="px-2 py-2 text-right">Ponderação</th>
                <th className="px-2 py-2 text-right">Prop. taxa mensal</th>
                <th className="px-2 py-2 text-right">Parcela pagamento</th>
              </tr>
            </thead>
            <tbody>
              {det.map((c, i) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-2 py-1.5">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <button onClick={() => onAbrir(c)} className="font-semibold underline text-left">{c.nome}</button>
                    {!c.taxaConfirmada && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-900" title="Modalidade e taxa calibradas pelos títulos; confirme na aba do contrato">a confirmar</span>}
                  </td>
                  <td className="px-2 py-1.5">{c.natureza ?? '-'}</td>
                  <td className="px-2 py-1.5">{c.modalidade}</td>
                  <td className="px-2 py-1.5">{fmtData(c.vencimentoFinal)}</td>
                  <td className="px-2 py-1.5 text-right">{pct(c.taxaAa)}</td>
                  <td className="px-2 py-1.5 text-right">{pct(c.taxaMensal, 3)}</td>
                  <td className="px-2 py-1.5 text-right">{moeda(c.saldo)}</td>
                  <td className="px-2 py-1.5 text-right">{pct(c.ponderacao)}</td>
                  <td className="px-2 py-1.5 text-right">{pct(c.proporcaoTaxa, 3)}</td>
                  <td className="px-2 py-1.5 text-right">{moeda(c.parcela)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-gray-300 font-bold">
                <td className="px-2 py-2" colSpan={7}>Total da dívida</td>
                <td className="px-2 py-2 text-right">{moeda(totSaldo)}</td>
                <td className="px-2 py-2 text-right">{pct(det.length ? 1 : 0)}</td>
                <td className="px-2 py-2 text-right">{pct(totProporcao, 3)}</td>
                <td className="px-2 py-2 text-right">{moeda(totParcela)}</td>
              </tr>
              <tr className="font-semibold">
                <td className="px-2 py-1.5" colSpan={9}>Taxa anual equivalente (custo ponderado)</td>
                <td className="px-2 py-1.5 text-right">{pct((1 + totProporcao) ** 12 - 1)}</td>
                <td></td>
              </tr>
              <tr className="font-semibold">
                <td className="px-2 py-1.5" colSpan={9}>Despesa financeira do mês (custo ponderado × saldo)</td>
                <td className="px-2 py-1.5 text-right">{moeda(totProporcao * totSaldo)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Modelos SAC / PRICE ─────────────────────────

interface Form {
  id: number | null; nome: string; instituicao: string; natureza: string; empresa: string; operacao: string;
  taxa: string; valor: string; prazo: string; carencia: string; perJuros: string; dtLiberacao: string; baseJuros: 'mensal' | 'dias';
  primeiroVenc: string; parcelaFixa: string; observacao: string; cd_fornecedor: number | null; nr_duplicata: number | null; origem: string;
}

const numBR = (t: string) => Number(t.trim().replace(/\./g, '').replace(',', '.'));
const numTxt = (n: number, casas = 2) => n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

function formVazio(mod: Modalidade): Form {
  return {
    id: null, nome: mod === 'SAC' ? 'Contrato B' : 'Contrato A', instituicao: '', natureza: 'Empréstimo Bancário', empresa: '', operacao: 'Empréstimo',
    taxa: '18,00', valor: '1.000.000,00', prazo: mod === 'SAC' ? '60' : '36', carencia: '0', perJuros: '3', dtLiberacao: hojeISO(),
    baseJuros: 'mensal', primeiroVenc: '', parcelaFixa: '', observacao: '', cd_fornecedor: null, nr_duplicata: null, origem: 'manual',
  };
}

function formDoContrato(c: Contrato): Form {
  return {
    id: c.id, nome: c.nome, instituicao: c.instituicao ?? '', natureza: c.natureza ?? '', empresa: c.empresa ?? '', operacao: c.operacao ?? '',
    taxa: numTxt(c.taxa_aa * 100, 2), valor: numTxt(c.valor_liberado), prazo: String(c.prazo_meses), carencia: String(c.carencia_meses),
    perJuros: String(c.per_juros_carencia), dtLiberacao: c.dt_liberacao.slice(0, 10), baseJuros: c.base_juros,
    primeiroVenc: c.primeiro_vencimento ? c.primeiro_vencimento.slice(0, 10) : '', parcelaFixa: c.parcela_fixa ? numTxt(c.parcela_fixa) : '',
    observacao: c.observacao ?? '', cd_fornecedor: c.cd_fornecedor, nr_duplicata: c.nr_duplicata, origem: c.origem,
  };
}

function corpoContrato(f: Form, mod: Modalidade) {
  return {
    nome: f.nome, instituicao: f.instituicao, cd_fornecedor: f.cd_fornecedor, nr_duplicata: f.nr_duplicata, empresa: f.empresa,
    natureza: f.natureza, operacao: f.operacao, modalidade: mod, base_juros: f.baseJuros, dt_liberacao: f.dtLiberacao,
    valor_liberado: numBR(f.valor), prazo_meses: parseInt(f.prazo, 10) || 0, carencia_meses: parseInt(f.carencia, 10) || 0,
    per_juros_carencia: parseInt(f.perJuros, 10) || 3, taxa_aa: numBR(f.taxa) / 100,
    parcela_fixa: mod === 'PRICE' && f.parcelaFixa.trim() ? numBR(f.parcelaFixa) : null,
    primeiro_vencimento: mod === 'PRICE' && f.primeiroVenc ? f.primeiroVenc : null,
    taxa_confirmada: true, observacao: f.observacao,
  };
}

function ModeloContrato({ modalidade, contratos, selecionadoInicial, recarregar }: {
  modalidade: Modalidade; contratos: Contrato[]; selecionadoInicial: number | null; recarregar: () => Promise<void>;
}) {
  const lista = contratos.filter((c) => c.modalidade === modalidade);
  const [form, setForm] = useState<Form>(() => {
    const c = lista.find((x) => x.id === selecionadoInicial) ?? lista[0];
    return c ? formDoContrato(c) : formVazio(modalidade);
  });
  const [cron, setCron] = useState<LinhaCron[]>([]);
  const [totais, setTotais] = useState<Totais | null>(null);
  const [parcelaCalc, setParcelaCalc] = useState<number | null>(null);
  const [lancado, setLancado] = useState<{ n: number; vencimento: string | null; principal: number; juros: number; aberto: boolean }[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [calculando, setCalculando] = useState(false);

  function selecionar(c: Contrato) { setForm(formDoContrato(c)); setMsg(null); }
  function atualizar<K extends keyof Form>(k: K, v: Form[K]) { setForm((f) => ({ ...f, [k]: v })); }

  // Recalcula ao vivo, como o "Recálculo Sistema SAC/PRICE" da planilha
  useEffect(() => {
    const corpo = corpoContrato(form, modalidade);
    if (!corpo.valor_liberado || !corpo.prazo_meses || Number.isNaN(corpo.taxa_aa) || !form.dtLiberacao) { setCron([]); setTotais(null); return; }
    setCalculando(true);
    const t = setTimeout(async () => {
      try {
        const r = await chamar<{ cronograma: LinhaCron[]; totais: Totais; parcelaPrice: number | null }>('simular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        setCron(r.cronograma); setTotais(r.totais); setParcelaCalc(r.parcelaPrice); setErro(null);
      } catch (e) {
        setErro(e instanceof Error ? e.message : 'Erro ao calcular');
      } finally {
        setCalculando(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [form, modalidade]);

  // O que ja esta lancado no contas a pagar, pra conferir com o cronograma
  useEffect(() => {
    setLancado([]);
    if (form.id === null) return;
    chamar<{ lancado: typeof lancado }>(`contratos/${form.id}/cronograma`).then((r) => setLancado(r.lancado)).catch(() => undefined);
  }, [form.id]);

  const lancadoPorLinha = useMemo(() => {
    const usados = new Set<number>();
    const mapa: Record<number, { principal: number; juros: number } | undefined> = {};
    for (const l of cron) {
      const alvo = new Date(l.vencimento).getTime();
      let melhor: (typeof lancado)[number] | undefined; let dif = Infinity;
      for (const x of lancado) {
        if (!x.vencimento || usados.has(x.n)) continue;
        const d = Math.abs(new Date(x.vencimento).getTime() - alvo) / 86400000;
        if (d <= 7 && d < dif) { melhor = x; dif = d; }
      }
      if (melhor) { usados.add(melhor.n); mapa[l.n] = { principal: melhor.principal, juros: melhor.juros }; }
    }
    return mapa;
  }, [cron, lancado]);

  async function salvar() {
    setSalvando(true); setMsg(null);
    try {
      const corpo = JSON.stringify(corpoContrato(form, modalidade));
      if (form.id === null) {
        const r = await chamar<{ id: number }>('contratos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo });
        setForm((f) => ({ ...f, id: r.id, origem: 'manual' }));
      } else {
        await chamar(`contratos/${form.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: corpo });
      }
      setMsg('Contrato salvo.');
      await recarregar();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Erro ao salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function excluir() {
    if (form.id === null || !window.confirm(`Excluir o contrato "${form.nome}"?`)) return;
    try {
      await chamar(`contratos/${form.id}`, { method: 'DELETE' });
      await recarregar();
      setForm(formVazio(modalidade));
      setMsg('Contrato excluído.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Erro ao excluir');
    }
  }

  const taxaAa = numBR(form.taxa) / 100;
  const taxaMes = Number.isNaN(taxaAa) ? 0 : (1 + taxaAa) ** (1 / 12) - 1;
  const taxaDia = Number.isNaN(taxaAa) ? 0 : (1 + taxaAa) ** (1 / 360) - 1;
  const hoje = hojeISO();
  const campo = 'px-2 py-1.5 border border-gray-300 rounded text-sm bg-white text-black w-full';

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-6 text-black">
      <div className="bg-white rounded-lg shadow-md p-4 h-fit">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-brand-dark">Contratos {modalidade}</h2>
          <button onClick={() => { setForm(formVazio(modalidade)); setMsg(null); }} className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">
            <Plus className="w-3 h-3" /> Novo
          </button>
        </div>
        {lista.length === 0 && <p className="text-xs">Nenhum contrato {modalidade} ainda. Use &quot;Novo&quot; ou sincronize com o contas a pagar no Painel.</p>}
        <div className="space-y-2">
          {lista.map((c) => (
            <button key={c.id} onClick={() => selecionar(c)} className={`w-full text-left rounded-md border px-3 py-2 ${form.id === c.id ? 'border-green-600 bg-green-50' : 'border-gray-200 hover:bg-gray-50'}`}>
              <div className="text-sm font-semibold">{c.nome}</div>
              <div className="text-xs">{pct(c.taxa_aa)} a.a. · saldo {moeda(c.saldoAtual)}</div>
              <div className="text-xs">{c.proximaParcela ? `próx. parcela ${fmtData(c.proximaParcela.vencimento)}: ${moeda(c.proximaParcela.valor)}` : 'sem parcelas futuras'}</div>
              {!c.taxa_confirmada && <span className="mt-1 inline-block px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-900">a confirmar</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-white rounded-lg shadow-md p-4">
          <h2 className="text-sm font-bold text-brand-dark mb-3">Recálculo sistema {modalidade} — painel de controle</h2>
          {form.id !== null && contratos.find((c) => c.id === form.id)?.metodo_calibracao && !contratos.find((c) => c.id === form.id)?.taxa_confirmada && (
            <p className="mb-3 text-xs px-3 py-2 rounded bg-amber-50 border border-amber-200">
              Contrato importado do contas a pagar. Modalidade, valor e taxa foram calibrados pelos títulos ({contratos.find((c) => c.id === form.id)?.metodo_calibracao}
              {contratos.find((c) => c.id === form.id)?.ajuste_erro != null ? `, erro médio ${pct(contratos.find((c) => c.id === form.id)?.ajuste_erro ?? 0, 1)}` : ''}). Confira com o contrato e salve para confirmar.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="text-xs font-medium col-span-2">Nome do contrato<input className={campo} value={form.nome} onChange={(e) => atualizar('nome', e.target.value)} /></label>
            <label className="text-xs font-medium col-span-2">Instituição financeira<input className={campo} value={form.instituicao} onChange={(e) => atualizar('instituicao', e.target.value)} /></label>
            <label className="text-xs font-medium">Natureza<input className={campo} value={form.natureza} onChange={(e) => atualizar('natureza', e.target.value)} /></label>
            <label className="text-xs font-medium">Empresa<input className={campo} value={form.empresa} onChange={(e) => atualizar('empresa', e.target.value)} /></label>
            <label className="text-xs font-medium">Juros a.a. (%)<input className={campo} value={form.taxa} onChange={(e) => atualizar('taxa', e.target.value)} /></label>
            <div className="text-xs font-medium">
              Equivalentes
              <div className="mt-1 text-xs">a.m. {pct(taxaMes, 4)} · a.d. {pct(taxaDia, 5)}</div>
            </div>
            <label className="text-xs font-medium">Valor da liberação (R$)<input className={campo} value={form.valor} onChange={(e) => atualizar('valor', e.target.value)} /></label>
            <label className="text-xs font-medium">Tempo em meses<input className={campo} value={form.prazo} onChange={(e) => atualizar('prazo', e.target.value)} /></label>
            <label className="text-xs font-medium">Data da liberação<input type="date" className={campo} value={form.dtLiberacao} onChange={(e) => atualizar('dtLiberacao', e.target.value)} /></label>
            {modalidade === 'SAC' ? (
              <>
                <label className="text-xs font-medium">Carência (meses)<input className={campo} value={form.carencia} onChange={(e) => atualizar('carencia', e.target.value)} /></label>
                <label className="text-xs font-medium">Pagamento de juros na carência (a cada n meses)<input className={campo} value={form.perJuros} onChange={(e) => atualizar('perJuros', e.target.value)} /></label>
                <label className="text-xs font-medium">Base dos juros
                  <select className={campo} value={form.baseJuros} onChange={(e) => atualizar('baseJuros', e.target.value as 'mensal' | 'dias')}>
                    <option value="mensal">Taxa mensal equivalente (planilha)</option>
                    <option value="dias">Dias corridos</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="text-xs font-medium">1º vencimento<input type="date" className={campo} value={form.primeiroVenc} onChange={(e) => atualizar('primeiroVenc', e.target.value)} /></label>
                <label className="text-xs font-medium">Parcela fixa (R$) — vazio = calcular<input className={campo} value={form.parcelaFixa} onChange={(e) => atualizar('parcelaFixa', e.target.value)} /></label>
                <div className="text-xs font-medium">
                  Parcela calculada
                  <div className="mt-1 text-sm font-bold">{moeda(parcelaCalc)}</div>
                </div>
              </>
            )}
            <label className="text-xs font-medium col-span-2 md:col-span-4">Observação<input className={campo} value={form.observacao} onChange={(e) => atualizar('observacao', e.target.value)} /></label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={salvar} disabled={salvando} className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
              {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar contrato
            </button>
            {form.id !== null && (
              <button onClick={excluir} className="flex items-center gap-2 px-3 py-2 text-sm border border-red-300 text-red-700 rounded bg-white hover:bg-red-50">
                <Trash2 className="w-4 h-4" /> Excluir
              </button>
            )}
            {calculando && <Loader2 className="w-4 h-4 animate-spin" />}
            {msg && <span className="text-sm">{msg}</span>}
            {erro && <span className="text-sm text-red-700">{erro}</span>}
          </div>
        </div>

        {totais && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Cartao rotulo="Total de juros" valor={moeda(totais.juros)} detalhe={`${pct(totais.juros / (numBR(form.valor) || 1))} do valor liberado`} />
            <Cartao rotulo="Total amortizado" valor={moeda(totais.amortizacao)} />
            <Cartao rotulo="Total pago (parcelas)" valor={moeda(totais.parcelas)} destaque />
          </div>
        )}

        <div className="bg-white rounded-lg shadow-md p-4">
          <h2 className="text-sm font-bold text-brand-dark mb-2">Contrato — cronograma {modalidade}</h2>
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-gray-100 z-10">
                <tr className="text-xs">
                  <th className="px-2 py-2 text-right">#</th>
                  <th className="px-2 py-2 text-left">Data</th>
                  <th className="px-2 py-2 text-right">Dias corridos</th>
                  <th className="px-2 py-2 text-left">Dia da semana</th>
                  <th className="px-2 py-2 text-right">Saldo - base</th>
                  <th className="px-2 py-2 text-right">Juros (R$)</th>
                  <th className="px-2 py-2 text-right">Amortização</th>
                  <th className="px-2 py-2 text-right">Parcela</th>
                  <th className="px-2 py-2 text-right">Saldo devedor</th>
                  {lancado.length > 0 && <th className="px-2 py-2 text-right">Lançado (a pagar)</th>}
                  {lancado.length > 0 && <th className="px-2 py-2 text-right">Dif.</th>}
                </tr>
              </thead>
              <tbody>
                {cron.map((l) => {
                  const passada = l.vencimento <= hoje;
                  const lc = lancadoPorLinha[l.n];
                  const lancadoTotal = lc ? lc.principal + lc.juros : null;
                  return (
                    <tr key={l.n} className={`border-t border-gray-100 ${passada ? 'bg-gray-50' : ''} ${l.carencia ? 'italic' : ''}`}>
                      <td className="px-2 py-1 text-right">{l.n}</td>
                      <td className="px-2 py-1">{fmtData(l.vencimento)}</td>
                      <td className="px-2 py-1 text-right">{l.dias}</td>
                      <td className="px-2 py-1">{diaSemana(l.vencimento)}</td>
                      <td className="px-2 py-1 text-right">{moeda(l.saldoInicial)}</td>
                      <td className="px-2 py-1 text-right">{moeda(l.juros)}</td>
                      <td className="px-2 py-1 text-right">{moeda(l.amortizacao)}</td>
                      <td className="px-2 py-1 text-right font-semibold">{moeda(l.parcela)}</td>
                      <td className="px-2 py-1 text-right">{moeda(l.saldoDevedor)}</td>
                      {lancado.length > 0 && <td className="px-2 py-1 text-right">{lancadoTotal === null ? '-' : moeda(lancadoTotal)}</td>}
                      {lancado.length > 0 && (
                        <td className={`px-2 py-1 text-right ${lancadoTotal !== null && Math.abs(l.parcela - lancadoTotal) > 1 ? 'text-red-600' : ''}`}>
                          {lancadoTotal === null ? '-' : moeda(l.parcela - lancadoTotal)}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {totais && (
                  <tr className="border-t-2 border-gray-300 font-bold">
                    <td className="px-2 py-2" colSpan={5}>Total</td>
                    <td className="px-2 py-2 text-right">{moeda(totais.juros)}</td>
                    <td className="px-2 py-2 text-right">{moeda(totais.amortizacao)}</td>
                    <td className="px-2 py-2 text-right">{moeda(totais.parcelas)}</td>
                    <td colSpan={lancado.length > 0 ? 3 : 1}></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-2">
            Linhas em cinza já venceram. {modalidade === 'SAC'
              ? 'Na carência (itálico) só há juros, pagos no período informado; depois a amortização é constante (valor ÷ tempo).'
              : 'Juros = saldo × ((1 + taxa dia)^dias − 1); amortização = parcela − juros.'}
            {lancado.length > 0 && ' A coluna "Lançado" traz o que já está no contas a pagar (principal + juros) no mesmo vencimento; diferença em vermelho = confira o contrato.'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Página ─────────────────────────

export default function EndividamentoPage() {
  const [aba, setAba] = useState<Aba>('painel');
  const [contratos, setContratos] = useState<Contrato[]>([]);
  const [painel, setPainel] = useState<Painel | null>(null);
  const [mesDetalhe, setMesDetalhe] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [selecionadoAba, setSelecionadoAba] = useState<number | null>(null);
  const [selic, setSelic] = useState<Selic | null>(null);

  const carregar = useCallback(async (mes?: string) => {
    setErro(null);
    try {
      const [c, p] = await Promise.all([
        chamar<{ contratos: Contrato[] }>('contratos'),
        chamar<Painel>(`painel?meses=36${mes ? `&mesDetalhe=${mes}` : ''}`),
      ]);
      setContratos(c.contratos);
      setPainel(p);
      if (!mes) setMesDetalhe(p.detalheMes.mes ?? '');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao carregar o endividamento');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    chamar<Selic>('selic').then(setSelic).catch(() => setSelic({ disponivel: false, aa: null, mensal: null, data: null, fonte: '' }));
  }, []);

  async function sincronizar(recalibrar: boolean) {
    setSincronizando(true); setAviso(null);
    try {
      const r = await chamar<{ criados: number; recalibrados: number; ajusteRuim: string[] }>(`sincronizar?recalibrar=${recalibrar}`, { method: 'POST' });
      setAviso(`${r.criados} contrato(s) novo(s) importado(s)${recalibrar ? `, ${r.recalibrados} recalibrado(s)` : ''}.${r.ajusteRuim.length ? ` Ajuste fraco (confira a taxa): ${r.ajusteRuim.join('; ')}.` : ''}`);
      await carregar(mesDetalhe || undefined);
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'Erro ao sincronizar');
    } finally {
      setSincronizando(false);
    }
  }

  async function salvarMetas(md: number | null, mc: number | null) {
    await chamar('metas', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metaDivida: md, metaCustoMensal: mc }) });
    await carregar(mesDetalhe || undefined);
  }

  const abas: { chave: Aba; rotulo: string }[] = [
    { chave: 'painel', rotulo: 'M07 - Painel Dívida Geral' },
    { chave: 'sac', rotulo: 'M07 - Modelo - SAC' },
    { chave: 'price', rotulo: 'M07 - Modelo - PRICE' },
  ];

  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-5 text-black">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-blue-100 rounded-lg"><Landmark className="w-6 h-6 text-blue-700" /></div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">Endividamento</h1>
            <p className="text-sm">Cada contrato de empréstimo modelado em SAC ou PRICE (como na planilha PWR) e o consolidado de gestão da dívida.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => sincronizar(false)} disabled={sincronizando} className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50" title="Importa do contas a pagar (despesa 114) os contratos ainda não cadastrados">
            {sincronizando ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Sincronizar com o contas a pagar
          </button>
          <button onClick={() => sincronizar(true)} disabled={sincronizando} className="px-3 py-2 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50" title="Recalibra modalidade e taxa dos contratos importados que ainda não foram confirmados">
            Recalibrar não confirmados
          </button>
        </div>
      </div>

      {aviso && <p className="text-sm px-3 py-2 rounded bg-green-50 border border-green-200">{aviso}</p>}
      {erro && <p className="text-sm px-3 py-2 rounded bg-red-50 border border-red-200 text-red-700">{erro}</p>}

      <div className="flex flex-wrap gap-1 border-b border-gray-300">
        {abas.map((a) => (
          <button
            key={a.chave}
            onClick={() => setAba(a.chave)}
            className={`px-4 py-2 text-sm font-semibold rounded-t-md border border-b-0 ${aba === a.chave ? 'bg-green-500 text-white border-green-600' : 'bg-gray-100 text-black border-gray-300 hover:bg-gray-200'}`}
          >
            {a.rotulo}
          </button>
        ))}
      </div>

      {carregando && (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
      )}

      {!carregando && aba === 'painel' && painel && painel.qtdContratos === 0 && (
        <div className="bg-white rounded-lg shadow-md p-8 text-center text-sm">
          Nenhum contrato cadastrado ainda. Clique em <strong>Sincronizar com o contas a pagar</strong> para importar os empréstimos em aberto (despesa 114) ou cadastre manualmente nas abas SAC e PRICE.
        </div>
      )}

      {!carregando && aba === 'painel' && painel && painel.qtdContratos > 0 && (
        <PainelDivida
          painel={painel}
          selic={selic}
          mesDetalhe={mesDetalhe}
          setMesDetalhe={(m) => { setMesDetalhe(m); carregar(m); }}
          onAbrir={(c) => { setSelecionadoAba(c.id); setAba(c.modalidade === 'SAC' ? 'sac' : 'price'); }}
          onSalvarMetas={salvarMetas}
        />
      )}

      {!carregando && aba === 'sac' && (
        <ModeloContrato key={`sac-${selecionadoAba}`} modalidade="SAC" contratos={contratos} selecionadoInicial={selecionadoAba} recarregar={() => carregar(mesDetalhe || undefined)} />
      )}
      {!carregando && aba === 'price' && (
        <ModeloContrato key={`price-${selecionadoAba}`} modalidade="PRICE" contratos={contratos} selecionadoInicial={selecionadoAba} recarregar={() => carregar(mesDetalhe || undefined)} />
      )}
    </div>
  );
}
