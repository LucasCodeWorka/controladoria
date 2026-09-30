'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Scale } from 'lucide-react';
import { PLANO_ATIVOS, PLANO_PASSIVO } from '../../balanco-patrimonial/planoContasBalanco';

interface DespesaBalanco {
  cd_despesaitem: number;
  ds_despesaitem: string;
  conta_balanco: string | null;
}

function opcoesContas(): { codigo: string; label: string }[] {
  const opcoes: { codigo: string; label: string }[] = [];
  for (const grupo of [...PLANO_ATIVOS, ...PLANO_PASSIVO]) {
    for (const conta of grupo.filhos || []) {
      opcoes.push({ codigo: conta.codigo, label: `${conta.codigo} - ${conta.nome}` });
    }
  }
  return opcoes;
}

export default function ConfigBalancoPage() {
  const [despesas, setDespesas] = useState<DespesaBalanco[]>([]);
  const [loading, setLoading] = useState(false);
  const [busca, setBusca] = useState('');
  const [apenasSemClassificacao, setApenasSemClassificacao] = useState(false);
  const [mesesJanela, setMesesJanela] = useState<Record<string, number>>({});
  const [mesesJanelaEditando, setMesesJanelaEditando] = useState<Record<string, string>>({});
  const [mensagem, setMensagem] = useState<string | null>(null);

  const opcoes = useMemo(() => opcoesContas(), []);
  const todasAsContas = useMemo(() => [...PLANO_ATIVOS, ...PLANO_PASSIVO].flatMap((g) => g.filhos || []), []);

  useEffect(() => {
    carregarDespesas();
    carregarJanelas();
  }, []);

  async function carregarDespesas() {
    setLoading(true);
    try {
      const response = await fetch('/api/classificacao-despesas-balanco', { cache: 'no-store' });
      const data = await response.json();
      setDespesas(data.data || []);
    } catch (error) {
      console.error('Erro ao carregar despesas:', error);
    } finally {
      setLoading(false);
    }
  }

  async function carregarJanelas() {
    try {
      const response = await fetch('/api/balanco-patrimonial/configuracao-contas', { cache: 'no-store' });
      const data = await response.json();
      setMesesJanela(data || {});
    } catch (error) {
      console.error('Erro ao carregar janelas:', error);
    }
  }

  function mostrarMensagem(texto: string) {
    setMensagem(texto);
    setTimeout(() => setMensagem(null), 2500);
  }

  async function salvarClassificacao(cd_despesaitem: number, ds_despesaitem: string, conta_balanco: string) {
    setDespesas((prev) => prev.map((d) => (d.cd_despesaitem === cd_despesaitem ? { ...d, conta_balanco } : d)));
    try {
      await fetch('/api/classificacao-despesas-balanco', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classificacoes: [{ cd_despesaitem, ds_despesaitem, conta_balanco }],
          usuario: 'config_balanco',
        }),
      });
      mostrarMensagem('Classificação salva.');
    } catch (error) {
      console.error('Erro ao salvar classificação:', error);
    }
  }

  async function salvarJanela(codigo: string) {
    const valorStr = mesesJanelaEditando[codigo];
    const valor = Number(valorStr);
    if (!valorStr || Number.isNaN(valor) || valor <= 0) return;
    try {
      await fetch('/api/balanco-patrimonial/configuracao-contas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo, mesesJanela: valor, usuario: 'config_balanco' }),
      });
      setMesesJanela((prev) => ({ ...prev, [codigo]: valor }));
      setMesesJanelaEditando((prev) => ({ ...prev, [codigo]: '' }));
      mostrarMensagem(`Janela salva.`);
    } catch (error) {
      console.error('Erro ao salvar janela:', error);
    }
  }

  const despesasFiltradas = useMemo(() => {
    let lista = despesas;
    if (apenasSemClassificacao) lista = lista.filter((d) => !d.conta_balanco);
    if (busca.trim()) {
      const termo = busca.trim().toUpperCase();
      lista = lista.filter(
        (d) => d.ds_despesaitem?.toUpperCase().includes(termo) || String(d.cd_despesaitem).includes(termo)
      );
    }
    return lista;
  }, [despesas, busca, apenasSemClassificacao]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Scale className="w-7 h-7 text-brand-primary" />
        <div>
          <h1 className="text-xl font-bold text-black">Config Balanço Patrimonial</h1>
          <p className="text-sm text-gray-500">
            Escolha quais despesas entram em cada conta do Ativo/Passivo e a janela (em meses) usada no vencimento.
          </p>
        </div>
      </div>

      {mensagem && (
        <div className="bg-green-50 border border-green-200 rounded-md px-4 py-2 text-sm text-green-700">{mensagem}</div>
      )}

      <div className="bg-white rounded-lg shadow-lg p-5">
        <h2 className="text-base font-semibold text-black mb-1">Janela por conta</h2>
        <p className="text-xs text-gray-500 mb-3">
          Quantidade de meses, a partir do 1º dia do mês filtrado na tela do Balanço, usada pra somar duplicatas por
          vencimento. Sem configurar, o padrão é 12 meses (o placeholder do campo mostra o valor atual).
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {todasAsContas.map((conta) => (
            <div key={conta.codigo} className="flex items-center justify-between gap-3 border border-gray-200 rounded-md px-3 py-2">
              <span className="text-sm text-black truncate" title={conta.nome}>
                {conta.nome}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="number"
                  min={1}
                  placeholder={String(mesesJanela[conta.codigo] ?? 12)}
                  value={mesesJanelaEditando[conta.codigo] ?? ''}
                  onChange={(e) => setMesesJanelaEditando((prev) => ({ ...prev, [conta.codigo]: e.target.value }))}
                  className="w-16 px-2 py-1 border border-gray-300 rounded text-sm text-black text-right"
                />
                <button
                  onClick={() => salvarJanela(conta.codigo)}
                  className="px-2 py-1 bg-brand-primary text-white rounded text-xs hover:opacity-90"
                >
                  Salvar
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar despesa por nome ou código..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm text-black"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-black">
            <input
              type="checkbox"
              checked={apenasSemClassificacao}
              onChange={(e) => setApenasSemClassificacao(e.target.checked)}
            />
            Só sem classificação
          </label>
          <button
            onClick={carregarDespesas}
            className="px-3 py-2 text-sm text-black bg-gray-100 rounded-md hover:bg-gray-200 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
          <span className="text-xs text-gray-500">
            {despesasFiltradas.length} de {despesas.length}
          </span>
        </div>

        <div className="overflow-y-auto max-h-[600px]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-black w-24">Código</th>
                <th className="text-left px-4 py-2 font-medium text-black">Descrição</th>
                <th className="text-left px-4 py-2 font-medium text-black w-72">Conta do Balanço</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {despesasFiltradas.map((d) => (
                <tr key={d.cd_despesaitem} className="hover:bg-gray-50">
                  <td className="px-4 py-1.5 text-black font-mono text-xs">{d.cd_despesaitem}</td>
                  <td className="px-4 py-1.5 text-black">{d.ds_despesaitem}</td>
                  <td className="px-4 py-1.5">
                    <select
                      value={d.conta_balanco || ''}
                      onChange={(e) => salvarClassificacao(d.cd_despesaitem, d.ds_despesaitem, e.target.value)}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm text-black"
                    >
                      <option value="">— Não classificado —</option>
                      <optgroup label="Ativos">
                        {opcoes
                          .filter((o) => o.codigo.startsWith('A'))
                          .map((o) => (
                            <option key={o.codigo} value={o.codigo}>
                              {o.label}
                            </option>
                          ))}
                      </optgroup>
                      <optgroup label="Passivo">
                        {opcoes
                          .filter((o) => o.codigo.startsWith('P'))
                          .map((o) => (
                            <option key={o.codigo} value={o.codigo}>
                              {o.label}
                            </option>
                          ))}
                      </optgroup>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
