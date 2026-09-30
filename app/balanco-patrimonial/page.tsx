'use client';

import React, { useEffect, useState } from 'react';
import { Scale, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { formatarValor } from '../utils/formatters';
import { carregarFiltro, salvarFiltro } from '../utils/persistirFiltro';
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
    }
  }
  return valores;
}

// A API devolve um dict unico (codigos de Ativos e Passivo misturados) -
// filtra so os codigos que pertencem a este plano especifico antes de
// aplicar por cima dos valores zerados.
function filtrarPorPlano(valoresApi: Record<string, number>, plano: ContaBalanco[]): Record<string, number> {
  const codigosDoPlano = new Set(plano.flatMap((grupo) => (grupo.filhos || []).map((f) => f.codigo)));
  const filtrado: Record<string, number> = {};
  for (const [codigo, valor] of Object.entries(valoresApi)) {
    if (codigosDoPlano.has(codigo)) filtrado[codigo] = valor;
  }
  return filtrado;
}

function formatarPercentual(valor: number, total: number): string {
  if (total === 0) return '-';
  return `${((valor / total) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

interface TabelaBalancoProps {
  titulo: string;
  plano: ContaBalanco[];
  valores: Record<string, number>;
  mostrarPercentual: boolean;
  contasExpandidas: Set<string>;
  toggleExpansao: (codigo: string) => void;
}

function TabelaBalanco({ titulo, plano, valores, mostrarPercentual, contasExpandidas, toggleExpansao }: TabelaBalancoProps) {
  const total = totalGeral(plano, valores);

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b-2 border-gray-300">
          <tr>
            <th className="text-left px-4 py-2.5 font-bold text-black">{titulo}</th>
            <th className="text-right px-4 py-2.5 font-bold text-black whitespace-nowrap">R$</th>
            {mostrarPercentual && (
              <th className="text-right px-4 py-2.5 font-bold text-black whitespace-nowrap w-20">%</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {plano.map((grupo) => {
            const expandido = contasExpandidas.has(grupo.codigo);
            const totalDoGrupo = totalGrupo(grupo, valores);
            return (
              <React.Fragment key={grupo.codigo}>
                <tr className="bg-blue-50/60 hover:bg-blue-50 cursor-pointer" onClick={() => toggleExpansao(grupo.codigo)}>
                  <td className="px-4 py-2 font-bold text-black">
                    <div className="flex items-center gap-2">
                      {expandido ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      {grupo.nome}
                    </div>
                  </td>
                  <td className={`px-4 py-2 text-right font-bold whitespace-nowrap ${totalDoGrupo < 0 ? 'text-red-600' : 'text-black'}`}>
                    {formatarValor(totalDoGrupo)}
                  </td>
                  {mostrarPercentual && (
                    <td className="px-4 py-2 text-right font-bold text-black whitespace-nowrap">
                      {totalDoGrupo === 0 ? '-' : '100,00%'}
                    </td>
                  )}
                </tr>
                {expandido &&
                  (grupo.filhos || []).map((conta) => {
                    const valor = valores[conta.codigo] ?? 0;
                    return (
                      <tr key={conta.codigo} className="hover:bg-gray-50">
                        <td className="px-4 py-2 pl-10 text-black">{conta.nome}</td>
                        <td className={`px-4 py-2 text-right whitespace-nowrap ${valor < 0 ? 'text-red-600' : 'text-black'}`}>
                          {formatarValor(valor)}
                        </td>
                        {mostrarPercentual && (
                          <td className="px-4 py-2 text-right text-black whitespace-nowrap">
                            {formatarPercentual(valor, totalDoGrupo)}
                          </td>
                        )}
                      </tr>
                    );
                  })}
              </React.Fragment>
            );
          })}
          <tr className="border-t-2 border-gray-300 bg-gray-50">
            <td className="px-4 py-2.5 font-bold text-black">Total</td>
            <td className={`px-4 py-2.5 text-right font-bold whitespace-nowrap ${total < 0 ? 'text-red-600' : 'text-black'}`}>
              {formatarValor(total)}
            </td>
            {mostrarPercentual && <td />}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function BalancoPatrimonialPage() {
  const [mesReferencia, setMesReferencia] = useState(primeiroDiaMesAtual());
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState<EmpresaOpcao[]>([]);
  const [empresasSelecionadas, setEmpresasSelecionadas] = useState<Set<number>>(new Set());
  const [filtroLojasAberto, setFiltroLojasAberto] = useState(false);
  const [consultaExecutada, setConsultaExecutada] = useState(false);
  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(
    new Set([...PLANO_ATIVOS, ...PLANO_PASSIVO].map((g) => g.codigo))
  );

  // Valores zerados por padrao - linhas com consulta real ja ligada (ex:
  // PC.2) vem do endpoint /api/balanco-patrimonial/dados e sobrescrevem o
  // zero aqui; o resto continua zerado ate ser implementado.
  const [valoresAtivos, setValoresAtivos] = useState<Record<string, number>>(() => valoresZerados(PLANO_ATIVOS));
  const [valoresPassivo, setValoresPassivo] = useState<Record<string, number>>(() => valoresZerados(PLANO_PASSIVO));
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    fetch('/api/cmv-detalhado/empresas', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const lista: EmpresaOpcao[] = data.empresas || [];
        setEmpresasDisponiveis(lista);
        const salvo = carregarFiltro<{ mesReferencia: string; empresas: number[] }>('balanco_patrimonial_filtros');
        const validas = new Set(lista.map((e) => e.cdEmpresa));
        if (salvo) {
          if (salvo.mesReferencia) setMesReferencia(salvo.mesReferencia);
          const empresasValidas = (salvo.empresas || []).filter((cd) => validas.has(cd));
          setEmpresasSelecionadas(new Set(empresasValidas.length > 0 ? empresasValidas : lista.map((e) => e.cdEmpresa)));
        } else {
          setEmpresasSelecionadas(new Set(lista.map((e) => e.cdEmpresa)));
        }
      })
      .catch((error) => console.error('Erro ao buscar empresas:', error));
  }, []);

  useEffect(() => {
    if (empresasDisponiveis.length === 0) return;
    salvarFiltro('balanco_patrimonial_filtros', { mesReferencia, empresas: Array.from(empresasSelecionadas) });
  }, [mesReferencia, empresasSelecionadas, empresasDisponiveis]);

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

  async function consultar() {
    setConsultaExecutada(true);
    setCarregando(true);
    // Reseta pro zerado antes de aplicar o que a API devolver - linhas sem
    // consulta ligada ainda ficam em 0.
    setValoresAtivos(valoresZerados(PLANO_ATIVOS));
    setValoresPassivo(valoresZerados(PLANO_PASSIVO));
    try {
      const params = new URLSearchParams({ mesReferencia });
      const response = await fetch(`/api/balanco-patrimonial/dados?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (response.ok && !data.error && data.valores) {
        setValoresAtivos((prev) => ({ ...prev, ...filtrarPorPlano(data.valores, PLANO_ATIVOS) }));
        setValoresPassivo((prev) => ({ ...prev, ...filtrarPorPlano(data.valores, PLANO_PASSIVO) }));
      }
    } catch (error) {
      console.error('Erro ao buscar balanço patrimonial:', error);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Scale className="w-7 h-7 text-brand-primary" />
        <div>
          <h1 className="text-xl font-bold text-black">Balanço Patrimonial</h1>
          <p className="text-sm text-gray-500">Ativos e Passivo, por empresa e mês de referência.</p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-lg p-5">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-xs font-medium text-black mb-1">Mês de referência</label>
            <input
              type="month"
              value={mesReferencia}
              onChange={(e) => setMesReferencia(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm text-black"
            />
          </div>

          <div className="relative">
            <label className="block text-xs font-medium text-black mb-1">Empresas</label>
            <button
              onClick={() => setFiltroLojasAberto((v) => !v)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm text-black bg-white hover:bg-gray-50 min-w-[160px] text-left"
            >
              Empresas ({empresasSelecionadas.size}/{empresasDisponiveis.length})
            </button>
            {filtroLojasAberto && (
              <div className="absolute z-20 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-lg max-h-72 overflow-y-auto">
                <div className="flex gap-2 p-2 border-b border-gray-100">
                  <button
                    onClick={() => setEmpresasSelecionadas(new Set(empresasDisponiveis.map((e) => e.cdEmpresa)))}
                    className="text-xs text-brand-primary hover:underline"
                  >
                    Selecionar todas
                  </button>
                  <button onClick={() => setEmpresasSelecionadas(new Set())} className="text-xs text-black hover:underline">
                    Limpar
                  </button>
                </div>
                {empresasDisponiveis.map((e) => (
                  <label key={e.cdEmpresa} className="flex items-center gap-2 px-3 py-1.5 text-sm text-black hover:bg-gray-50 cursor-pointer">
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
            onClick={consultar}
            disabled={carregando}
            className="px-4 py-2 bg-brand-primary text-white rounded-md text-sm font-medium hover:opacity-90 flex items-center gap-2 disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
            Consultar
          </button>
        </div>
      </div>

      {!consultaExecutada ? (
        <div className="bg-white rounded-lg shadow-lg p-10 text-center text-sm text-gray-500">
          Escolha o mês e as empresas e clique em Consultar.
        </div>
      ) : (
        <>
          <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-2.5 text-xs text-amber-700">
            Estrutura em construção: só as linhas já ligadas trazem valor real (hoje: Passivo Circulante 2 - Obrigações de
            Compra de MP. e Serv.) - o resto continua zerado até as consultas serem plugadas aqui.
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <TabelaBalanco
              titulo="ATIVOS"
              plano={PLANO_ATIVOS}
              valores={valoresAtivos}
              mostrarPercentual
              contasExpandidas={contasExpandidas}
              toggleExpansao={toggleExpansao}
            />
            <TabelaBalanco
              titulo="PASSIVO"
              plano={PLANO_PASSIVO}
              valores={valoresPassivo}
              mostrarPercentual={false}
              contasExpandidas={contasExpandidas}
              toggleExpansao={toggleExpansao}
            />
          </div>
        </>
      )}
    </div>
  );
}
