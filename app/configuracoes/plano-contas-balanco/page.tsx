'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Scale, ChevronDown, ChevronRight, X } from 'lucide-react';
import { PLANO_ATIVOS, PLANO_PASSIVO, type ContaBalanco } from '../../balanco-patrimonial/planoContasBalanco';

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

function SeletorConta({
  value,
  onChange,
  opcoes,
  className,
}: {
  value: string;
  onChange: (valor: string) => void;
  opcoes: { codigo: string; label: string }[];
  className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
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
  );
}

interface ContaConfigCardProps {
  conta: ContaBalanco;
  despesasDaConta: DespesaBalanco[];
  expandido: boolean;
  onToggleExpandir: () => void;
  mesesAtual: number;
  mesesEditando: string;
  onEditarMeses: (valor: string) => void;
  onSalvarJanela: () => void;
  onRemover: (cd_despesaitem: number, ds_despesaitem: string) => void;
}

function ContaConfigCard({
  conta,
  despesasDaConta,
  expandido,
  onToggleExpandir,
  mesesAtual,
  mesesEditando,
  onEditarMeses,
  onSalvarJanela,
  onRemover,
}: ContaConfigCardProps) {
  return (
    <div className="border border-gray-200 rounded-md">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <button onClick={onToggleExpandir} className="flex items-center gap-2 text-sm text-black flex-1 text-left min-w-0">
          {expandido ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
          <span className="truncate" title={conta.nome}>
            {conta.nome}
          </span>
          <span className="text-xs text-gray-400 shrink-0">({despesasDaConta.length})</span>
        </button>
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          <input
            type="number"
            min={1}
            placeholder={String(mesesAtual)}
            value={mesesEditando}
            onChange={(e) => onEditarMeses(e.target.value)}
            className="w-16 px-2 py-1 border border-gray-300 rounded text-sm text-black text-right"
          />
          <button onClick={onSalvarJanela} className="px-2 py-1 bg-brand-primary text-white rounded text-xs hover:opacity-90">
            Salvar
          </button>
        </div>
      </div>
      {expandido && (
        <div className="border-t border-gray-100 px-3 py-2 bg-gray-50 max-h-56 overflow-y-auto">
          {despesasDaConta.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhuma despesa aplicada nessa conta ainda.</p>
          ) : (
            <ul className="space-y-1">
              {despesasDaConta.map((d) => (
                <li key={d.cd_despesaitem} className="flex items-center justify-between gap-2 text-xs text-black">
                  <span className="truncate">
                    {d.ds_despesaitem} <span className="text-gray-400">#{d.cd_despesaitem}</span>
                  </span>
                  <button
                    onClick={() => onRemover(d.cd_despesaitem, d.ds_despesaitem)}
                    className="text-red-500 hover:underline shrink-0 flex items-center gap-0.5"
                    title="Remover dessa conta"
                  >
                    <X className="w-3 h-3" />
                    remover
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function ConfigBalancoPage() {
  const [despesas, setDespesas] = useState<DespesaBalanco[]>([]);
  const [loading, setLoading] = useState(false);
  const [busca, setBusca] = useState('');
  const [apenasSemClassificacao, setApenasSemClassificacao] = useState(false);
  const [mesesJanela, setMesesJanela] = useState<Record<string, number>>({});
  const [mesesJanelaEditando, setMesesJanelaEditando] = useState<Record<string, string>>({});
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [gruposExpandidos, setGruposExpandidos] = useState<Set<string>>(new Set());
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());
  const [ultimoIndiceClicado, setUltimoIndiceClicado] = useState<number | null>(null);
  const [contaLote, setContaLote] = useState('');

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

  async function enviarClassificacoes(itens: { cd_despesaitem: number; ds_despesaitem: string; conta_balanco: string }[]) {
    try {
      await fetch('/api/classificacao-despesas-balanco', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classificacoes: itens, usuario: 'config_balanco' }),
      });
    } catch (error) {
      console.error('Erro ao salvar classificação:', error);
    }
  }

  async function salvarClassificacao(cd_despesaitem: number, ds_despesaitem: string, conta_balanco: string) {
    setDespesas((prev) => prev.map((d) => (d.cd_despesaitem === cd_despesaitem ? { ...d, conta_balanco } : d)));
    await enviarClassificacoes([{ cd_despesaitem, ds_despesaitem, conta_balanco }]);
    mostrarMensagem('Classificação salva.');
  }

  async function aplicarEmLote() {
    if (selecionados.size === 0 || !contaLote) return;
    const itens = despesas
      .filter((d) => selecionados.has(d.cd_despesaitem))
      .map((d) => ({ cd_despesaitem: d.cd_despesaitem, ds_despesaitem: d.ds_despesaitem, conta_balanco: contaLote }));
    setDespesas((prev) => prev.map((d) => (selecionados.has(d.cd_despesaitem) ? { ...d, conta_balanco: contaLote } : d)));
    await enviarClassificacoes(itens);
    mostrarMensagem(`${itens.length} despesas aplicadas.`);
    setSelecionados(new Set());
    setContaLote('');
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

  function toggleExpandirGrupo(codigo: string) {
    setGruposExpandidos((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
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

  const despesasPorConta = useMemo(() => {
    const mapa: Record<string, DespesaBalanco[]> = {};
    for (const d of despesas) {
      if (!d.conta_balanco) continue;
      (mapa[d.conta_balanco] ??= []).push(d);
    }
    return mapa;
  }, [despesas]);

  const todosFiltradosSelecionados =
    despesasFiltradas.length > 0 && despesasFiltradas.every((d) => selecionados.has(d.cd_despesaitem));

  function toggleSelecionarTodosFiltrados() {
    setSelecionados((prev) => {
      const idsFiltrados = despesasFiltradas.map((d) => d.cd_despesaitem);
      if (todosFiltradosSelecionados) {
        const novo = new Set(prev);
        idsFiltrados.forEach((id) => novo.delete(id));
        return novo;
      }
      const novo = new Set(prev);
      idsFiltrados.forEach((id) => novo.add(id));
      return novo;
    });
  }

  function handleCheckboxClick(cd_despesaitem: number, index: number, shiftKey: boolean) {
    setSelecionados((prev) => {
      const novo = new Set(prev);
      if (shiftKey && ultimoIndiceClicado !== null) {
        const [ini, fim] = [ultimoIndiceClicado, index].sort((a, b) => a - b);
        for (let i = ini; i <= fim; i++) {
          novo.add(despesasFiltradas[i].cd_despesaitem);
        }
      } else if (novo.has(cd_despesaitem)) {
        novo.delete(cd_despesaitem);
      } else {
        novo.add(cd_despesaitem);
      }
      return novo;
    });
    setUltimoIndiceClicado(index);
  }

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
        <h2 className="text-base font-semibold text-black mb-1">Contas do Balanço</h2>
        <p className="text-xs text-gray-500 mb-3">
          Janela = quantos meses a partir do 1º dia do mês filtrado na tela do Balanço, usada pra somar duplicatas por
          vencimento (sem configurar, o padrão é 12 - o placeholder do campo mostra o valor atual). Clique no nome da
          conta pra ver quais despesas já estão aplicadas nela.
        </p>
        <div className="space-y-2">
          {todasAsContas.map((conta) => (
            <ContaConfigCard
              key={conta.codigo}
              conta={conta}
              despesasDaConta={despesasPorConta[conta.codigo] || []}
              expandido={gruposExpandidos.has(conta.codigo)}
              onToggleExpandir={() => toggleExpandirGrupo(conta.codigo)}
              mesesAtual={mesesJanela[conta.codigo] ?? 12}
              mesesEditando={mesesJanelaEditando[conta.codigo] ?? ''}
              onEditarMeses={(valor) => setMesesJanelaEditando((prev) => ({ ...prev, [conta.codigo]: valor }))}
              onSalvarJanela={() => salvarJanela(conta.codigo)}
              onRemover={(cd_despesaitem, ds_despesaitem) => salvarClassificacao(cd_despesaitem, ds_despesaitem, '')}
            />
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

        {selecionados.size > 0 && (
          <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-3 flex-wrap">
            <span className="text-sm text-amber-800 font-medium">{selecionados.size} selecionadas</span>
            <SeletorConta
              value={contaLote}
              onChange={setContaLote}
              opcoes={opcoes}
              className="px-2 py-1 border border-amber-300 rounded text-sm text-black min-w-[260px]"
            />
            <button
              onClick={aplicarEmLote}
              disabled={!contaLote}
              className="px-3 py-1.5 bg-brand-primary text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50"
            >
              Aplicar ao grupo
            </button>
            <button onClick={() => setSelecionados(new Set())} className="text-sm text-amber-700 hover:underline">
              Limpar seleção
            </button>
            <span className="text-xs text-amber-600">
              Dica: marque uma despesa, segure Shift e marque outra pra selecionar o intervalo entre as duas.
            </span>
          </div>
        )}

        <div className="overflow-y-auto max-h-[600px]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="px-4 py-2 w-8">
                  <input type="checkbox" checked={todosFiltradosSelecionados} onChange={toggleSelecionarTodosFiltrados} />
                </th>
                <th className="text-left px-4 py-2 font-medium text-black w-24">Código</th>
                <th className="text-left px-4 py-2 font-medium text-black">Descrição</th>
                <th className="text-left px-4 py-2 font-medium text-black w-72">Conta do Balanço</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {despesasFiltradas.map((d, index) => (
                <tr
                  key={d.cd_despesaitem}
                  className={`hover:bg-gray-50 ${selecionados.has(d.cd_despesaitem) ? 'bg-amber-50' : ''}`}
                >
                  <td className="px-4 py-1.5">
                    <input
                      type="checkbox"
                      checked={selecionados.has(d.cd_despesaitem)}
                      onClick={(e) => handleCheckboxClick(d.cd_despesaitem, index, e.shiftKey)}
                      onChange={() => {}}
                    />
                  </td>
                  <td className="px-4 py-1.5 text-black font-mono text-xs">{d.cd_despesaitem}</td>
                  <td className="px-4 py-1.5 text-black">{d.ds_despesaitem}</td>
                  <td className="px-4 py-1.5">
                    <SeletorConta
                      value={d.conta_balanco || ''}
                      onChange={(valor) => salvarClassificacao(d.cd_despesaitem, d.ds_despesaitem, valor)}
                      opcoes={opcoes}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm text-black"
                    />
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
