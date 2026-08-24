'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Search, Save, RefreshCw, Wallet, X, ArrowUp, ArrowDown, Pencil } from 'lucide-react';

interface SubgrupoDFC {
  codigo: string;
  nome: string;
}

interface GrupoDFC {
  codigo: string;
  nome: string;
  subgrupos: SubgrupoDFC[];
}

interface DespesaDFC {
  cd_despesaitem: number;
  ds_despesaitem: string;
  conta_dfc: string | null;
}

const CORES_GRUPO: Record<string, string> = {
  OP: 'bg-purple-50 border-purple-200',
  INV: 'bg-blue-50 border-blue-200',
  FIN: 'bg-amber-50 border-amber-200',
  REC: 'bg-green-50 border-green-200',
};

export default function ConfigDFCPage() {
  const [loading, setLoading] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [despesas, setDespesas] = useState<DespesaDFC[]>([]);
  const [grupos, setGrupos] = useState<GrupoDFC[]>([]);
  const [gruposReceita, setGruposReceita] = useState<GrupoDFC[]>([]);
  const [nomesCustomizados, setNomesCustomizados] = useState<Record<string, string>>({});
  const [nomeEditando, setNomeEditando] = useState<string | null>(null);
  const [nomeEditandoValor, setNomeEditandoValor] = useState('');
  const [tiposCusto, setTiposCusto] = useState<Record<string, 'fixo' | 'variavel'>>({});
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
    campo: 'cd_despesaitem' | 'ds_despesaitem' | 'conta_dfc';
    direcao: 'asc' | 'desc';
  } | null>(null);

  const [gruposExpandidos, setGruposExpandidos] = useState<Set<string>>(new Set(['OP', 'INV', 'FIN', 'REC']));
  const [contaDetalheAberta, setContaDetalheAberta] = useState<string | null>(null);
  const [draggedDespesaId, setDraggedDespesaId] = useState<number | null>(null);
  const [contaHover, setContaHover] = useState<string | null>(null);

  useEffect(() => {
    carregar();
    carregarPlanoContas();
    carregarNomesCustomizados();
    carregarTiposCusto();
  }, []);

  async function carregar() {
    setLoading(true);
    try {
      const response = await fetch('/api/classificacao-despesas-dfc', { cache: 'no-store' });
      const data = await response.json();
      setDespesas(data.data || []);
    } catch (error) {
      console.error('Erro ao carregar classificações DFC:', error);
    } finally {
      setLoading(false);
    }
  }

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

  // Nomes customizados sao salvos na MESMA tabela usada pela Config DRE
  // (chave generica por codigo de conta) - os codigos do DFC (OP, OP.01, REC...)
  // nao colidem com os codigos numericos da DRE, entao dá pra reaproveitar.
  async function carregarNomesCustomizados() {
    try {
      const response = await fetch('/api/plano-contas-dre/nomes', { cache: 'no-store' });
      const data = await response.json();
      setNomesCustomizados(data || {});
    } catch (error) {
      console.error('Erro ao buscar nomes customizados do plano de contas:', error);
    }
  }

  // Fixa/Variável reaproveita a MESMA tabela da Config DRE (chave generica
  // por codigo de conta) - mesmo raciocinio dos nomes customizados.
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
        body: JSON.stringify({ codigo, tipo, usuario: 'config_plano_contas_dfc' }),
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
        body: JSON.stringify({ codigo, nome, usuario: 'config_plano_contas_dfc' }),
      });
    } catch (error) {
      console.error('Erro ao salvar nome customizado do plano de contas:', error);
    }
  }

  const SUBGRUPOS_DISPONIVEIS = useMemo(
    () =>
      grupos.flatMap((g) =>
        g.subgrupos.map((s) => ({
          codigo: s.codigo,
          nome: nomesCustomizados[s.codigo] ?? s.nome,
          grupo: nomesCustomizados[g.codigo] ?? g.nome,
        }))
      ),
    [grupos, nomesCustomizados]
  );

  function nomeSubgrupo(codigo: string): string {
    return SUBGRUPOS_DISPONIVEIS.find((s) => s.codigo === codigo)?.nome || codigo;
  }

  function toggleExpansaoGrupo(codigo: string) {
    setGruposExpandidos((prev) => {
      const novo = new Set(prev);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  function temClassificacao(d: DespesaDFC): boolean {
    const contaPendente = pendentes[d.cd_despesaitem];
    const contaEfetiva = contaPendente !== undefined ? contaPendente : d.conta_dfc;
    return !!contaEfetiva && contaEfetiva !== 'NAO_CLASSIFICADO';
  }

  function contaEfetiva(d: DespesaDFC): string {
    const contaPendente = pendentes[d.cd_despesaitem];
    const conta = contaPendente !== undefined ? contaPendente : d.conta_dfc;
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

  function alternarOrdenacao(campo: 'cd_despesaitem' | 'ds_despesaitem' | 'conta_dfc') {
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
      } else if (campo === 'conta_dfc') {
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

  function renderizarCabecalho(campo: 'cd_despesaitem' | 'ds_despesaitem' | 'conta_dfc', label: string, extraClasses = '') {
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
            <ArrowUp className="w-3 h-3 text-purple-600" strokeWidth={3} />
          ) : direcao === 'desc' ? (
            <ArrowDown className="w-3 h-3 text-purple-600" strokeWidth={3} />
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
      const classificacoes = Object.entries(pendentes).map(([cd, conta_dfc]) => {
        const despesa = despesas.find((d) => d.cd_despesaitem === Number(cd));
        return {
          cd_despesaitem: Number(cd),
          ds_despesaitem: despesa?.ds_despesaitem || '',
          conta_dfc,
        };
      });

      const response = await fetch('/api/classificacao-despesas-dfc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classificacoes, usuario: 'controladoria' }),
      });
      const data = await response.json();
      setMensagem(data.message || 'Salvo com sucesso.');
      setPendentes({});
      await carregar();
    } catch (error) {
      console.error('Erro ao salvar classificações DFC:', error);
      setMensagem('Erro ao salvar. Tente novamente.');
    } finally {
      setSalvando(false);
    }
  }

  const contasFiltradasBusca = useMemo(() => {
    const termo = buscaConta.trim().toLowerCase();
    if (!termo) return SUBGRUPOS_DISPONIVEIS;
    return SUBGRUPOS_DISPONIVEIS.filter(
      (c) => c.codigo.toLowerCase().includes(termo) || c.nome.toLowerCase().includes(termo)
    );
  }, [buscaConta, SUBGRUPOS_DISPONIVEIS]);

  const contasFiltradasBuscaLote = useMemo(() => {
    const termo = buscaContaLote.trim().toLowerCase();
    if (!termo) return SUBGRUPOS_DISPONIVEIS;
    return SUBGRUPOS_DISPONIVEIS.filter(
      (c) => c.codigo.toLowerCase().includes(termo) || c.nome.toLowerCase().includes(termo)
    );
  }, [buscaContaLote, SUBGRUPOS_DISPONIVEIS]);

  const todosVisiveisSelecionados =
    despesasFiltradas.length > 0 && despesasFiltradas.every((d) => selecionados.has(d.cd_despesaitem));

  function despesasNoSubgrupo(codigo: string): DespesaDFC[] {
    return despesas.filter((d) => contaEfetiva(d) === codigo);
  }

  function despesasNoGrupo(grupo: GrupoDFC): number {
    return grupo.subgrupos.reduce((acc, s) => acc + despesasNoSubgrupo(s.codigo).length, 0);
  }

  function renderizarSubgrupoDespesa(sub: SubgrupoDFC, mostrarFixaVariavel: boolean) {
    const despesasDoSub = despesasNoSubgrupo(sub.codigo);
    const estaEmDropHover = contaHover === sub.codigo;
    const detalheAberto = contaDetalheAberta === sub.codigo;
    const nomeSubExibido = nomesCustomizados[sub.codigo] ?? sub.nome;
    const tipoCustoAtual = tiposCusto[sub.codigo];
    return (
      <div key={sub.codigo}>
        <div
          className={`group flex items-center gap-2 p-1.5 rounded-md border bg-white cursor-pointer hover:bg-gray-50 ${
            estaEmDropHover ? 'ring-2 ring-purple-400 ring-offset-2' : ''
          }`}
          onClick={() => setContaDetalheAberta(detalheAberto ? null : sub.codigo)}
          onDragOver={(event) => {
            event.preventDefault();
            setContaHover(sub.codigo);
          }}
          onDragLeave={() => {
            if (contaHover === sub.codigo) setContaHover(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            soltarEmConta(sub.codigo);
          }}
        >
          {detalheAberto ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
          <span className="font-mono text-xs font-bold">{sub.codigo}</span>
          {nomeEditando === sub.codigo ? (
            <input
              type="text"
              value={nomeEditandoValor}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setNomeEditandoValor(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  salvarNomeCustomizado(sub.codigo);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelarEdicaoNome();
                }
              }}
              onBlur={() => salvarNomeCustomizado(sub.codigo)}
              className="flex-1 text-xs leading-tight px-1 py-0.5 rounded border border-purple-400 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400"
            />
          ) : (
            <span className="text-xs flex-1 leading-tight flex items-center gap-1">
              {nomeSubExibido}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  iniciarEdicaoNome(sub.codigo, nomeSubExibido);
                }}
                title="Editar nome do subgrupo"
                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 transition-opacity shrink-0"
              >
                <Pencil className="w-3 h-3" />
              </button>
            </span>
          )}
          {mostrarFixaVariavel && (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => salvarTipoCusto(sub.codigo, 'fixo')}
                className={`px-2 py-0.5 text-[10px] font-semibold rounded ${
                  tipoCustoAtual === 'fixo' ? 'bg-blue-600 text-white' : 'bg-white/70 text-slate-400 hover:bg-blue-100 hover:text-blue-700'
                }`}
              >
                Fixa
              </button>
              <button
                onClick={() => salvarTipoCusto(sub.codigo, 'variavel')}
                className={`px-2 py-0.5 text-[10px] font-semibold rounded ${
                  tipoCustoAtual === 'variavel' ? 'bg-orange-600 text-white' : 'bg-white/70 text-slate-400 hover:bg-orange-100 hover:text-orange-700'
                }`}
              >
                Variável
              </button>
            </div>
          )}
          <span className="text-[11px] bg-gray-100 px-1.5 py-0.5 rounded shrink-0">
            {despesasDoSub.length} itens
          </span>
        </div>

        {detalheAberto && (
          <div className="ml-6 mt-1 mb-2 rounded-md border border-slate-200 bg-white p-2">
            {despesasDoSub.length === 0 ? (
              <div className="text-xs italic text-slate-400">Nenhuma despesa neste subgrupo.</div>
            ) : (
              <div className="divide-y divide-slate-100 max-h-56 overflow-auto">
                {despesasDoSub.map((d) => (
                  <div key={d.cd_despesaitem} className="flex items-center gap-2 py-1 text-xs">
                    <span className="font-mono text-slate-400 w-14 shrink-0">{d.cd_despesaitem}</span>
                    <span className="flex-1 text-slate-700 truncate">{d.ds_despesaitem}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-[1600px] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 bg-purple-100 rounded-lg">
          <Wallet className="w-6 h-6 text-purple-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Config DFC — Classificação de Caixa</h1>
          <p className="text-sm text-gray-500">
            Plano de contas próprio do DFC (Operacionais / Investimentos / Financiamento), definido pela consultoria
            contábil. Toda despesa tem uma classificação direta aqui — sem depender da DRE.
          </p>
        </div>
        <div className="ml-auto">
          <button
            onClick={salvar}
            disabled={salvando || totalPendentes === 0}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            {salvando ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar {totalPendentes > 0 ? `(${totalPendentes})` : ''}
          </button>
        </div>
      </div>

      {mensagem && (
        <div className="px-3 py-2 border rounded-md text-sm bg-purple-50 border-purple-200 text-purple-800">
          {mensagem}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Árvore Grupo > Subgrupo */}
        <div className="bg-white rounded-lg shadow-md p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-3">Plano de contas (arraste despesas até aqui)</h2>
          <div className="max-h-[70vh] overflow-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-8 h-8 animate-spin text-purple-600" />
              </div>
            ) : (
              grupos.map((grupo) => {
                const expandido = gruposExpandidos.has(grupo.codigo);
                const corGrupo = CORES_GRUPO[grupo.codigo] || 'bg-gray-50 border-gray-200';
                const nomeGrupoExibido = nomesCustomizados[grupo.codigo] ?? grupo.nome;
                return (
                  <div key={grupo.codigo} className="mb-2">
                    <div
                      className={`group flex items-center gap-2 p-2 rounded-md border font-bold cursor-pointer hover:opacity-80 ${corGrupo}`}
                      onClick={() => toggleExpansaoGrupo(grupo.codigo)}
                    >
                      {expandido ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <span className="font-mono text-xs">{grupo.codigo}</span>
                      {nomeEditando === grupo.codigo ? (
                        <input
                          type="text"
                          value={nomeEditandoValor}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setNomeEditandoValor(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              salvarNomeCustomizado(grupo.codigo);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelarEdicaoNome();
                            }
                          }}
                          onBlur={() => salvarNomeCustomizado(grupo.codigo)}
                          className="flex-1 text-sm leading-tight px-1 py-0.5 rounded border border-purple-400 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400"
                        />
                      ) : (
                        <span className="text-sm flex-1 flex items-center gap-1">
                          {nomeGrupoExibido}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              iniciarEdicaoNome(grupo.codigo, nomeGrupoExibido);
                            }}
                            title="Editar nome do grupo"
                            className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 transition-opacity shrink-0"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      <span className="text-[11px] bg-white px-1.5 py-0.5 rounded shrink-0">
                        {despesasNoGrupo(grupo)} itens
                      </span>
                    </div>

                    {expandido && (
                      <div className="ml-4 mt-1 space-y-1">
                        {grupo.codigo === 'OP' ? (() => {
                          const subs = grupo.subgrupos;
                          const fixos = subs.filter((s) => tiposCusto[s.codigo] === 'fixo');
                          const variaveis = subs.filter((s) => tiposCusto[s.codigo] === 'variavel');
                          const semClassificacao = subs.filter((s) => !tiposCusto[s.codigo]);

                          const renderizarBloco = (titulo: string, corTexto: string, itens: SubgrupoDFC[]) => {
                            if (itens.length === 0) return null;
                            return (
                              <div key={titulo} className="mb-1">
                                <div className={`px-2 py-1 text-[11px] font-bold tracking-wide ${corTexto}`}>{titulo}</div>
                                {itens.map((sub) => renderizarSubgrupoDespesa(sub, true))}
                              </div>
                            );
                          };

                          return (
                            <>
                              {renderizarBloco('DESPESAS FIXAS', 'text-blue-700', fixos)}
                              {renderizarBloco('DESPESAS VARIÁVEIS', 'text-orange-700', variaveis)}
                              {renderizarBloco('NÃO CLASSIFICADO', 'text-slate-400', semClassificacao)}
                            </>
                          );
                        })() : (
                          grupo.subgrupos.map((sub) => renderizarSubgrupoDespesa(sub, false))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {!loading && (
              <div
                className={`mt-2 flex items-center gap-2 p-2 rounded-md border border-dashed ${
                  contaHover === 'NAO_CLASSIFICADO' ? 'ring-2 ring-purple-400 ring-offset-2' : 'border-gray-300'
                } bg-gray-50 text-gray-500`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setContaHover('NAO_CLASSIFICADO');
                }}
                onDragLeave={() => {
                  if (contaHover === 'NAO_CLASSIFICADO') setContaHover(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  soltarEmConta('NAO_CLASSIFICADO');
                }}
              >
                <span className="text-xs flex-1">NÃO CLASSIFICADO (solte aqui para remover a classificação)</span>
                <span className="text-[11px] bg-white px-1.5 py-0.5 rounded shrink-0">
                  {despesasNoSubgrupo('NAO_CLASSIFICADO').length} itens
                </span>
              </div>
            )}

            {!loading && gruposReceita.length > 0 && (
              <>
                <div className="mt-4 mb-2 border-t border-gray-200 pt-3">
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                    Receita (entradas de caixa — não recebe despesas)
                  </h3>
                </div>
                {gruposReceita.map((grupo) => {
                  const expandido = gruposExpandidos.has(grupo.codigo);
                  const corGrupo = CORES_GRUPO[grupo.codigo] || 'bg-gray-50 border-gray-200';
                  const nomeGrupoExibido = nomesCustomizados[grupo.codigo] ?? grupo.nome;
                  return (
                    <div key={grupo.codigo} className="mb-2">
                      <div
                        className={`group flex items-center gap-2 p-2 rounded-md border font-bold cursor-pointer hover:opacity-80 ${corGrupo}`}
                        onClick={() => toggleExpansaoGrupo(grupo.codigo)}
                      >
                        {expandido ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <span className="font-mono text-xs">{grupo.codigo}</span>
                        {nomeEditando === grupo.codigo ? (
                          <input
                            type="text"
                            value={nomeEditandoValor}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setNomeEditandoValor(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                salvarNomeCustomizado(grupo.codigo);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelarEdicaoNome();
                              }
                            }}
                            onBlur={() => salvarNomeCustomizado(grupo.codigo)}
                            className="flex-1 text-sm leading-tight px-1 py-0.5 rounded border border-purple-400 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400"
                          />
                        ) : (
                          <span className="text-sm flex-1 flex items-center gap-1">
                            {nomeGrupoExibido}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                iniciarEdicaoNome(grupo.codigo, nomeGrupoExibido);
                              }}
                              title="Editar nome do grupo"
                              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 transition-opacity shrink-0"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          </span>
                        )}
                      </div>

                      {expandido && (
                        <div className="ml-4 mt-1 space-y-1">
                          {grupo.subgrupos.map((sub) => {
                            const nomeSubExibido = nomesCustomizados[sub.codigo] ?? sub.nome;
                            return (
                              <div
                                key={sub.codigo}
                                className="group flex items-center gap-2 p-1.5 rounded-md border bg-white"
                              >
                                <div className="w-3.5" />
                                <span className="font-mono text-xs font-bold">{sub.codigo}</span>
                                {nomeEditando === sub.codigo ? (
                                  <input
                                    type="text"
                                    value={nomeEditandoValor}
                                    autoFocus
                                    onChange={(e) => setNomeEditandoValor(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        salvarNomeCustomizado(sub.codigo);
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        cancelarEdicaoNome();
                                      }
                                    }}
                                    onBlur={() => salvarNomeCustomizado(sub.codigo)}
                                    className="flex-1 text-xs leading-tight px-1 py-0.5 rounded border border-purple-400 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400"
                                  />
                                ) : (
                                  <span className="text-xs flex-1 leading-tight flex items-center gap-1">
                                    {nomeSubExibido}
                                    <button
                                      onClick={() => iniciarEdicaoNome(sub.codigo, nomeSubExibido)}
                                      title="Editar nome do subgrupo"
                                      className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 transition-opacity shrink-0"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </button>
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
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
            <div className="flex flex-wrap items-center gap-2 mb-3 px-3 py-2 bg-purple-50 border border-purple-200 rounded-md">
              <span className="text-sm font-medium text-purple-800">
                {selecionados.size} {selecionados.size === 1 ? 'despesa selecionada' : 'despesas selecionadas'}
              </span>
              <div className="relative">
                <button
                  onClick={() => setDropdownLoteAberto(!dropdownLoteAberto)}
                  className="px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors"
                >
                  Escolher subgrupo...
                </button>
                {dropdownLoteAberto && (
                  <div className="absolute z-50 mt-1 w-72 max-h-64 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                    <input
                      autoFocus
                      type="text"
                      value={buscaContaLote}
                      onChange={(e) => setBuscaContaLote(e.target.value)}
                      placeholder="Buscar subgrupo..."
                      className="w-full px-3 py-2 text-sm border-b border-gray-200 outline-none"
                    />
                    {contasFiltradasBuscaLote.map((c) => (
                      <button
                        key={c.codigo}
                        onClick={() => aplicarContaEmLote(c.codigo)}
                        className="block w-full truncate px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-purple-50"
                        title={`${c.codigo} - ${c.nome}`}
                      >
                        {c.codigo} - {c.nome}
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

          <div className="overflow-auto max-h-[55vh] border border-gray-200 rounded-md">
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
                  {renderizarCabecalho('conta_dfc', 'Subgrupo no DFC', 'w-56')}
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
                        alterado ? 'bg-yellow-50' : selecionado ? 'bg-purple-50' : ''
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
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-purple-100 text-purple-800 text-xs">
                            {contaAtual} - {nomeSubgrupo(contaAtual)}
                            <button
                              onClick={() => removerClassificacao(d.cd_despesaitem)}
                              title="Remover classificação"
                              className="hover:text-purple-950"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setDropdownAberto(dropdownAberto === d.cd_despesaitem ? null : d.cd_despesaitem)}
                            className="px-2 py-1 text-xs text-red-500 border border-dashed border-red-300 rounded hover:border-purple-400 hover:text-purple-600"
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
                              placeholder="Buscar subgrupo..."
                              className="w-full px-3 py-2 text-sm border-b border-gray-200 outline-none"
                            />
                            {contasFiltradasBusca.map((c) => (
                              <button
                                key={c.codigo}
                                onClick={() => definirConta(d.cd_despesaitem, c.codigo)}
                                className="block w-full truncate px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-purple-50"
                                title={`${c.codigo} - ${c.nome}`}
                              >
                                {c.codigo} - {c.nome}
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
