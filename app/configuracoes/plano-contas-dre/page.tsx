'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Search, Save, RefreshCw, Settings, X, Pencil, ArrowUp, ArrowDown } from 'lucide-react';
import { PLANO_CONTAS_DRE, type ContaDRE } from './planoContasDRE';

interface Despesa {
  cd_despesaitem: number;
  ds_despesaitem: string;
  conta_dre: string | null;
}

const CORES_NIVEL: Record<number, string> = {
  1: 'bg-blue-50 border-blue-200',
  2: 'bg-green-50 border-green-200',
  3: 'bg-yellow-50 border-yellow-200',
  4: 'bg-purple-50 border-purple-200',
};

function achatarContas(contas: ContaDRE[], resultado: ContaDRE[] = []): ContaDRE[] {
  for (const conta of contas) {
    if (conta.tipo === 'conta') resultado.push(conta);
    if (conta.filhos) achatarContas(conta.filhos, resultado);
  }
  return resultado;
}

const CONTAS_DISPONIVEIS = achatarContas(PLANO_CONTAS_DRE);

export default function ConfigDREPage() {
  const [loading, setLoading] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [despesas, setDespesas] = useState<Despesa[]>([]);
  const [busca, setBusca] = useState('');
  const [apenasSemClassificacao, setApenasSemClassificacao] = useState(false);
  const [pendentes, setPendentes] = useState<Record<number, string>>({});
  const [dropdownAberto, setDropdownAberto] = useState<number | null>(null);
  const [buscaConta, setBuscaConta] = useState('');
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());
  const [dropdownLoteAberto, setDropdownLoteAberto] = useState(false);
  const [buscaContaLote, setBuscaContaLote] = useState('');
  const [ordenacao, setOrdenacao] = useState<{
    campo: 'cd_despesaitem' | 'ds_despesaitem' | 'conta_dre';
    direcao: 'asc' | 'desc';
  } | null>(null);

  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(new Set(['08']));
  const [filtroArvore, setFiltroArvore] = useState('');
  const [contaDetalheAberta, setContaDetalheAberta] = useState<string | null>(null);
  const [nomesCustomizados, setNomesCustomizados] = useState<Record<string, string>>({});
  const [nomeEditando, setNomeEditando] = useState<string | null>(null);
  const [nomeEditandoValor, setNomeEditandoValor] = useState('');
  const [tiposCusto, setTiposCusto] = useState<Record<string, 'fixo' | 'variavel'>>({});
  const [draggedDespesaId, setDraggedDespesaId] = useState<number | null>(null);
  const [contaHover, setContaHover] = useState<string | null>(null);

  useEffect(() => {
    carregar();
    carregarNomesCustomizados();
    carregarTiposCusto();
  }, []);

  async function carregar() {
    setLoading(true);
    try {
      const response = await fetch('/api/classificacao-despesas-dre', { cache: 'no-store' });
      const data = await response.json();
      setDespesas(data.data || []);
    } catch (error) {
      console.error('Erro ao carregar classificações DRE:', error);
    } finally {
      setLoading(false);
    }
  }

  async function carregarNomesCustomizados() {
    try {
      const response = await fetch('/api/plano-contas-dre/nomes', { cache: 'no-store' });
      const data = await response.json();
      setNomesCustomizados(data || {});
    } catch (error) {
      console.error('Erro ao buscar nomes customizados do plano de contas:', error);
    }
  }

  async function carregarTiposCusto() {
    try {
      const response = await fetch('/api/plano-contas-dre/tipo-custo', { cache: 'no-store' });
      const data = await response.json();
      setTiposCusto(data || {});
    } catch (error) {
      console.error('Erro ao buscar tipo de custo do plano de contas:', error);
    }
  }

  async function salvarTipoCusto(codigo: string, tipo: 'fixo' | 'variavel') {
    setTiposCusto((prev) => ({ ...prev, [codigo]: tipo }));
    try {
      await fetch('/api/plano-contas-dre/tipo-custo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo, tipo, usuario: 'config_plano_contas_dre' }),
      });
    } catch (error) {
      console.error('Erro ao salvar tipo de custo do plano de contas:', error);
    }
  }

  function iniciarEdicaoNome(codigo: string, nomeAtual: string) {
    setNomeEditando(codigo);
    setNomeEditandoValor(nomeAtual);
  }

  function cancelarEdicaoNome() {
    setNomeEditando(null);
    setNomeEditandoValor('');
  }

  async function salvarNomeCustomizado(codigo: string) {
    const nome = nomeEditandoValor.trim();
    if (!nome) {
      cancelarEdicaoNome();
      return;
    }
    setNomeEditando(null);
    setNomesCustomizados((prev) => ({ ...prev, [codigo]: nome }));
    try {
      await fetch('/api/plano-contas-dre/nomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo, nome, usuario: 'config_plano_contas_dre' }),
      });
    } catch (error) {
      console.error('Erro ao salvar nome customizado do plano de contas:', error);
    }
  }

  function nomeConta(codigo: string): string {
    return nomesCustomizados[codigo] ?? (CONTAS_DISPONIVEIS.find((c) => c.codigo === codigo)?.nome || codigo);
  }

  function toggleExpansaoConta(codigo: string) {
    setContasExpandidas((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  function expandirTudo() {
    const todos: string[] = [];
    const coletar = (contas: ContaDRE[]) => {
      for (const c of contas) {
        if (c.filhos?.length) {
          todos.push(c.codigo);
          coletar(c.filhos);
        }
      }
    };
    coletar(PLANO_CONTAS_DRE);
    setContasExpandidas(new Set(todos));
  }

  function recolherTudo() {
    setContasExpandidas(new Set());
  }

  function temClassificacao(d: Despesa): boolean {
    const contaPendente = pendentes[d.cd_despesaitem];
    const contaEfetiva = contaPendente !== undefined ? contaPendente : d.conta_dre;
    return !!contaEfetiva && contaEfetiva !== 'NAO_CLASSIFICADO';
  }

  function contaEfetiva(d: Despesa): string {
    const contaPendente = pendentes[d.cd_despesaitem];
    const conta = contaPendente !== undefined ? contaPendente : d.conta_dre;
    return conta || 'NAO_CLASSIFICADO';
  }

  const despesasFiltradas = useMemo(() => {
    let lista = despesas;
    if (apenasSemClassificacao) {
      lista = lista.filter((d) => !temClassificacao(d));
    }
    const termo = busca.trim().toLowerCase();
    if (!termo) return lista;
    return lista.filter(
      (d) =>
        d.ds_despesaitem?.toLowerCase().includes(termo) ||
        String(d.cd_despesaitem).includes(termo)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [despesas, busca, apenasSemClassificacao, pendentes]);

  function alternarOrdenacao(campo: 'cd_despesaitem' | 'ds_despesaitem' | 'conta_dre') {
    setOrdenacao((atual) => {
      if (atual?.campo === campo) {
        return { campo, direcao: atual.direcao === 'asc' ? 'desc' : 'asc' };
      }
      return { campo, direcao: 'asc' };
    });
  }

  const despesasOrdenadas = useMemo(() => {
    if (!ordenacao) return despesasFiltradas;
    const { campo, direcao } = ordenacao;
    const lista = [...despesasFiltradas].sort((a, b) => {
      let va: string | number;
      let vb: string | number;
      if (campo === 'cd_despesaitem') {
        va = a.cd_despesaitem;
        vb = b.cd_despesaitem;
      } else if (campo === 'conta_dre') {
        va = contaEfetiva(a);
        vb = contaEfetiva(b);
      } else {
        va = (a[campo] as string) || '';
        vb = (b[campo] as string) || '';
      }
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return String(va).localeCompare(String(vb), 'pt-BR');
    });
    if (direcao === 'desc') lista.reverse();
    return lista;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [despesasFiltradas, ordenacao, pendentes]);

  function renderizarCabecalho(campo: 'cd_despesaitem' | 'ds_despesaitem' | 'conta_dre', label: string, extraClasses = '') {
    const ativo = ordenacao?.campo === campo;
    const direcao = ativo ? ordenacao!.direcao : null;
    return (
      <th
        onClick={() => alternarOrdenacao(campo)}
        className={`px-3 py-2 text-left font-semibold text-gray-700 border-b border-gray-300 cursor-pointer select-none hover:bg-gray-200 transition-colors ${extraClasses}`}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {direcao === 'asc' ? (
            <ArrowUp className="w-3 h-3 text-green-600" strokeWidth={3} />
          ) : direcao === 'desc' ? (
            <ArrowDown className="w-3 h-3 text-green-600" strokeWidth={3} />
          ) : (
            <ArrowUp className="w-3 h-3 text-gray-300" strokeWidth={3} />
          )}
        </span>
      </th>
    );
  }

  function definirConta(cd: number, codigo: string) {
    setPendentes((prev) => ({ ...prev, [cd]: codigo }));
    setDropdownAberto(null);
    setBuscaConta('');
  }

  function definirContaEmLote(ids: number[], codigo: string) {
    setPendentes((prev) => {
      const novo = { ...prev };
      ids.forEach((cd) => {
        novo[cd] = codigo;
      });
      return novo;
    });
  }

  function removerClassificacao(cd: number) {
    setPendentes((prev) => ({ ...prev, [cd]: 'NAO_CLASSIFICADO' }));
    setDropdownAberto(null);
  }

  function toggleSelecionado(cd: number) {
    setSelecionados((prev) => {
      const novo = new Set(prev);
      if (novo.has(cd)) novo.delete(cd);
      else novo.add(cd);
      return novo;
    });
  }

  function toggleSelecionarTodosVisiveis() {
    setSelecionados((prev) => {
      const todosVisiveisSelecionados = despesasFiltradas.every((d) => prev.has(d.cd_despesaitem));
      if (todosVisiveisSelecionados) {
        const novo = new Set(prev);
        despesasFiltradas.forEach((d) => novo.delete(d.cd_despesaitem));
        return novo;
      }
      const novo = new Set(prev);
      despesasFiltradas.forEach((d) => novo.add(d.cd_despesaitem));
      return novo;
    });
  }

  function aplicarContaEmLote(codigo: string) {
    definirContaEmLote(Array.from(selecionados), codigo);
    setSelecionados(new Set());
    setDropdownLoteAberto(false);
    setBuscaContaLote('');
  }

  function removerClassificacaoEmLote() {
    aplicarContaEmLote('NAO_CLASSIFICADO');
  }

  function iniciarDrag(id: number) {
    setDraggedDespesaId(id);
  }

  function finalizarDrag() {
    setDraggedDespesaId(null);
    setContaHover(null);
  }

  function soltarEmConta(codigoConta: string) {
    if (!draggedDespesaId) return;
    const ids = selecionados.has(draggedDespesaId) ? Array.from(selecionados) : [draggedDespesaId];
    definirContaEmLote(ids, codigoConta);
    setSelecionados(new Set());
    finalizarDrag();
  }

  const totalPendentes = Object.keys(pendentes).length;

  async function salvar() {
    if (totalPendentes === 0) return;
    setSalvando(true);
    setMensagem(null);
    try {
      const classificacoes = Object.entries(pendentes).map(([cd, conta_dre]) => {
        const despesa = despesas.find((d) => d.cd_despesaitem === Number(cd));
        return {
          cd_despesaitem: Number(cd),
          ds_despesaitem: despesa?.ds_despesaitem || '',
          conta_dre,
        };
      });

      const response = await fetch('/api/classificacao-despesas-dre', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classificacoes, usuario: 'controladoria' }),
      });
      const data = await response.json();
      setMensagem(data.message || `${data.salvos ?? ''} classificações salvas com sucesso.`);
      setPendentes({});
      await carregar();
    } catch (error) {
      console.error('Erro ao salvar classificações DRE:', error);
      setMensagem('Erro ao salvar. Tente novamente.');
    } finally {
      setSalvando(false);
    }
  }

  const contasFiltradasBusca = useMemo(() => {
    const termo = buscaConta.trim().toLowerCase();
    if (!termo) return CONTAS_DISPONIVEIS;
    return CONTAS_DISPONIVEIS.filter(
      (c) => c.codigo.toLowerCase().includes(termo) || nomeConta(c.codigo).toLowerCase().includes(termo)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscaConta, nomesCustomizados]);

  const contasFiltradasBuscaLote = useMemo(() => {
    const termo = buscaContaLote.trim().toLowerCase();
    if (!termo) return CONTAS_DISPONIVEIS;
    return CONTAS_DISPONIVEIS.filter(
      (c) => c.codigo.toLowerCase().includes(termo) || nomeConta(c.codigo).toLowerCase().includes(termo)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscaContaLote, nomesCustomizados]);

  const todosVisiveisSelecionados =
    despesasFiltradas.length > 0 && despesasFiltradas.every((d) => selecionados.has(d.cd_despesaitem));

  function despesasNaConta(codigo: string): Despesa[] {
    return despesas.filter((d) => contaEfetiva(d) === codigo);
  }

  function contaCorrespondeFiltro(conta: ContaDRE, termo: string): boolean {
    const termoNormalizado = termo.trim().toLowerCase();
    if (!termoNormalizado) return true;
    const atualCorresponde =
      conta.codigo.toLowerCase().includes(termoNormalizado) ||
      nomeConta(conta.codigo).toLowerCase().includes(termoNormalizado);
    if (atualCorresponde) return true;
    return Boolean(conta.filhos?.some((filho) => contaCorrespondeFiltro(filho, termo)));
  }

  function renderizarArvore(contas: ContaDRE[], nivel: number = 0): React.ReactNode {
    return contas.map((conta) => {
      if (!contaCorrespondeFiltro(conta, filtroArvore)) return null;

      const despesasDaConta = despesasNaConta(conta.codigo);
      const temFilhos = !!conta.filhos?.length;
      const expandida = filtroArvore ? true : contasExpandidas.has(conta.codigo);
      const corNivel = CORES_NIVEL[conta.nivel] || 'bg-gray-100';
      const podeReceberDrop = conta.tipo === 'conta';
      const estaEmDropHover = contaHover === conta.codigo;
      const podeVerDetalhe = conta.tipo === 'conta';
      const detalheAberto = contaDetalheAberta === conta.codigo;
      const nomeExibido = nomeConta(conta.codigo);
      const ehGrupoDespesaOperacional = /^08\.\d+$/.test(conta.codigo);
      const tipoCustoAtual = tiposCusto[conta.codigo];

      return (
        <div key={conta.codigo} className="mb-1">
          <div
            className={`group flex items-center gap-2 p-1.5 rounded-md border ${corNivel} ${
              temFilhos || podeVerDetalhe ? 'cursor-pointer hover:opacity-80' : ''
            } ${estaEmDropHover ? 'ring-2 ring-green-400 ring-offset-2' : ''}`}
            style={{ marginLeft: `${nivel * 14}px` }}
            onClick={() => {
              if (temFilhos) toggleExpansaoConta(conta.codigo);
              else if (podeVerDetalhe) setContaDetalheAberta(detalheAberto ? null : conta.codigo);
            }}
            onDragOver={(event) => {
              if (!podeReceberDrop) return;
              event.preventDefault();
              setContaHover(conta.codigo);
            }}
            onDragLeave={() => {
              if (contaHover === conta.codigo) setContaHover(null);
            }}
            onDrop={(event) => {
              if (!podeReceberDrop) return;
              event.preventDefault();
              soltarEmConta(conta.codigo);
            }}
          >
            {temFilhos ? (
              expandida ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
            ) : podeVerDetalhe ? (
              detalheAberto ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <div className="w-3.5" />
            )}
            <span className="font-mono text-xs font-bold">{conta.codigo}</span>
            {nomeEditando === conta.codigo ? (
              <input
                type="text"
                value={nomeEditandoValor}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setNomeEditandoValor(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    salvarNomeCustomizado(conta.codigo);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelarEdicaoNome();
                  }
                }}
                onBlur={() => salvarNomeCustomizado(conta.codigo)}
                className="flex-1 text-xs leading-tight px-1 py-0.5 rounded border border-green-400 bg-white focus:outline-none focus:ring-1 focus:ring-green-400"
              />
            ) : (
              <span className="text-xs flex-1 leading-tight flex items-center gap-1">
                {nomeExibido}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    iniciarEdicaoNome(conta.codigo, nomeExibido);
                  }}
                  title="Editar nome"
                  className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 transition-opacity shrink-0"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </span>
            )}
            {ehGrupoDespesaOperacional && (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => salvarTipoCusto(conta.codigo, 'fixo')}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded ${
                    tipoCustoAtual === 'fixo' ? 'bg-blue-600 text-white' : 'bg-white/70 text-slate-400 hover:bg-blue-100 hover:text-blue-700'
                  }`}
                >
                  Fixa
                </button>
                <button
                  onClick={() => salvarTipoCusto(conta.codigo, 'variavel')}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded ${
                    tipoCustoAtual === 'variavel' ? 'bg-orange-600 text-white' : 'bg-white/70 text-slate-400 hover:bg-orange-100 hover:text-orange-700'
                  }`}
                >
                  Variável
                </button>
              </div>
            )}
            {conta.tipo === 'conta' && (
              <span className="text-[11px] bg-white px-1.5 py-0.5 rounded shrink-0">
                {despesasDaConta.length} itens
              </span>
            )}
          </div>

          {podeVerDetalhe && detalheAberto && (
            <div className="ml-6 mt-1 mb-2 rounded-md border border-slate-200 bg-white p-2" style={{ marginLeft: `${nivel * 14 + 22}px` }}>
              {despesasDaConta.length === 0 ? (
                <div className="text-xs italic text-slate-400">Nenhuma despesa nesta conta.</div>
              ) : (
                <div className="divide-y divide-slate-100 max-h-56 overflow-auto">
                  {despesasDaConta.map((d) => (
                    <div key={d.cd_despesaitem} className="flex items-center gap-2 py-1 text-xs">
                      <span className="font-mono text-slate-400 w-14 shrink-0">{d.cd_despesaitem}</span>
                      <span className="flex-1 text-slate-700 truncate">{d.ds_despesaitem}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {temFilhos && expandida && conta.filhos && (
            <div className="ml-4">
              {conta.codigo === '08' ? (() => {
                const filhos = conta.filhos!;
                const filhosFixos = filhos.filter((f) => tiposCusto[f.codigo] === 'fixo');
                const filhosVariaveis = filhos.filter((f) => tiposCusto[f.codigo] === 'variavel');
                const filhosSemClassificacao = filhos.filter((f) => !tiposCusto[f.codigo]);

                const renderizarSubgrupo = (titulo: string, corTexto: string, itens: ContaDRE[]) => {
                  if (itens.length === 0) return null;
                  return (
                    <div key={titulo} className="mb-1">
                      <div className={`px-2 py-1 text-[11px] font-bold tracking-wide ${corTexto}`}>{titulo}</div>
                      {renderizarArvore(itens, nivel + 1)}
                    </div>
                  );
                };

                return (
                  <>
                    {renderizarSubgrupo('DESPESAS FIXAS', 'text-blue-700', filhosFixos)}
                    {renderizarSubgrupo('DESPESAS VARIÁVEIS', 'text-orange-700', filhosVariaveis)}
                    {renderizarSubgrupo('NÃO CLASSIFICADO', 'text-slate-400', filhosSemClassificacao)}
                  </>
                );
              })() : (
                renderizarArvore(conta.filhos, nivel + 1)
              )}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="max-w-[1600px] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 bg-green-100 rounded-lg">
          <Settings className="w-6 h-6 text-green-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Config DRE — Plano de Contas</h1>
          <p className="text-sm text-gray-500">
            Classifique cada despesa numa conta da DRE. Arraste, selecione em lote ou escolha item a item.
          </p>
        </div>
        <div className="ml-auto">
          <button
            onClick={salvar}
            disabled={salvando || totalPendentes === 0}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {salvando ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar {totalPendentes > 0 ? `(${totalPendentes})` : ''}
          </button>
        </div>
      </div>

      {mensagem && (
        <div className="px-3 py-2 border rounded-md text-sm bg-green-50 border-green-200 text-green-800">
          {mensagem}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Árvore do plano de contas */}
        <div className="bg-white rounded-lg shadow-md p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-bold text-slate-700">Plano de contas (arraste despesas até aqui)</h2>
            <div className="flex items-center gap-2">
              <button onClick={expandirTudo} className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:border-green-300 hover:text-green-700">
                Expandir tudo
              </button>
              <button onClick={recolherTudo} className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:border-green-300 hover:text-green-700">
                Recolher tudo
              </button>
            </div>
          </div>
          <div className="relative mb-3">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filtroArvore}
              onChange={(e) => setFiltroArvore(e.target.value)}
              placeholder="Buscar conta ou código..."
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div className="max-h-[70vh] overflow-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-8 h-8 animate-spin text-green-600" />
              </div>
            ) : (
              renderizarArvore(PLANO_CONTAS_DRE)
            )}
          </div>
        </div>

        {/* Painel de despesas */}
        <div className="bg-white rounded-lg shadow-md p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar despesa..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            <button
              onClick={carregar}
              disabled={loading}
              className="p-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
              title="Recarregar"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <label className="flex items-center gap-2 text-xs text-red-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={apenasSemClassificacao}
                onChange={(e) => setApenasSemClassificacao(e.target.checked)}
              />
              Sem classificação
            </label>
          </div>

          {selecionados.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-3 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
              <span className="text-sm font-medium text-green-800">
                {selecionados.size} {selecionados.size === 1 ? 'despesa selecionada' : 'despesas selecionadas'}
              </span>
              <div className="relative">
                <button
                  onClick={() => setDropdownLoteAberto(!dropdownLoteAberto)}
                  className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors"
                >
                  Escolher conta...
                </button>
                {dropdownLoteAberto && (
                  <div className="absolute z-50 mt-1 w-72 max-h-64 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                    <input
                      autoFocus
                      type="text"
                      value={buscaContaLote}
                      onChange={(e) => setBuscaContaLote(e.target.value)}
                      placeholder="Buscar conta..."
                      className="w-full px-3 py-2 text-sm border-b border-gray-200 outline-none"
                    />
                    {contasFiltradasBuscaLote.map((c) => (
                      <button
                        key={c.codigo}
                        onClick={() => aplicarContaEmLote(c.codigo)}
                        className="block w-full truncate px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-green-50"
                        title={`${c.codigo} - ${nomeConta(c.codigo)}`}
                      >
                        {c.codigo} - {nomeConta(c.codigo)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={removerClassificacaoEmLote}
                className="px-3 py-1.5 text-sm bg-white border border-gray-300 text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
              >
                Remover classificação
              </button>
              <button
                onClick={() => setSelecionados(new Set())}
                className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Limpar seleção
              </button>
            </div>
          )}

          <div className="overflow-auto max-h-[62vh] border border-gray-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-100 z-10">
                <tr>
                  <th className="px-3 py-2 text-left border-b border-gray-300 w-10">
                    <input
                      type="checkbox"
                      checked={todosVisiveisSelecionados}
                      onChange={toggleSelecionarTodosVisiveis}
                      title="Selecionar todas as despesas visíveis"
                    />
                  </th>
                  {renderizarCabecalho('cd_despesaitem', 'Cód.', 'w-16')}
                  {renderizarCabecalho('ds_despesaitem', 'Despesa')}
                  {renderizarCabecalho('conta_dre', 'Conta na DRE', 'w-56')}
                </tr>
              </thead>
              <tbody>
                {despesasOrdenadas.map((d) => {
                  const contaAtual = contaEfetiva(d);
                  const temOverride = temClassificacao(d);
                  const alterado = pendentes[d.cd_despesaitem] !== undefined;
                  const selecionado = selecionados.has(d.cd_despesaitem);
                  return (
                    <tr
                      key={d.cd_despesaitem}
                      draggable
                      onDragStart={() => iniciarDrag(d.cd_despesaitem)}
                      onDragEnd={finalizarDrag}
                      className={`border-b border-gray-100 hover:bg-gray-50 cursor-grab active:cursor-grabbing ${
                        alterado ? 'bg-yellow-50' : selecionado ? 'bg-green-50' : ''
                      }`}
                    >
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selecionado} onChange={() => toggleSelecionado(d.cd_despesaitem)} />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{d.cd_despesaitem}</td>
                      <td className="px-3 py-2 text-gray-700">
                        <div className="truncate max-w-[220px]" title={d.ds_despesaitem}>{d.ds_despesaitem}</div>
                      </td>
                      <td className="px-3 py-2 relative">
                        {temOverride ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-100 text-green-800 text-xs">
                            {contaAtual} - {nomeConta(contaAtual)}
                            <button
                              onClick={() => removerClassificacao(d.cd_despesaitem)}
                              title="Remover classificação"
                              className="hover:text-green-950"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setDropdownAberto(dropdownAberto === d.cd_despesaitem ? null : d.cd_despesaitem)}
                            className="px-2 py-1 text-xs text-red-500 border border-dashed border-red-300 rounded hover:border-green-400 hover:text-green-600"
                          >
                            não classificado
                          </button>
                        )}

                        {dropdownAberto === d.cd_despesaitem && (
                          <div className="absolute z-50 right-0 mt-1 w-72 max-h-64 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                            <input
                              autoFocus
                              type="text"
                              value={buscaConta}
                              onChange={(e) => setBuscaConta(e.target.value)}
                              placeholder="Buscar conta..."
                              className="w-full px-3 py-2 text-sm border-b border-gray-200 outline-none"
                            />
                            {contasFiltradasBusca.map((c) => (
                              <button
                                key={c.codigo}
                                onClick={() => definirConta(d.cd_despesaitem, c.codigo)}
                                className="block w-full truncate px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-green-50"
                                title={`${c.codigo} - ${nomeConta(c.codigo)}`}
                              >
                                {c.codigo} - {nomeConta(c.codigo)}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
