'use client';

import React, { useState, useMemo, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Package,
  ShoppingCart,
  DollarSign,
  AlertTriangle,
  Target,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2
} from 'lucide-react';
import { useMultipleGiroEstoque } from '../hooks/useIndicadores';

interface CmvData {
  mes_referencia: string;
  cmv_lojas: number;
  cmv_fab: number;
  cmv_total: number;
  fonte: string;
}

// ============================================================================
// DADOS REAIS - Baseados na planilha de Indicadores de Controladoria (DEZ/2025)
// ============================================================================
const MOCK_DATA = {
  // Operações & Projetos
  projetosNoPrazo: { valor: 93.58, meta: 90.00, unidade: '%' },
  satisfacaoCliente: { valor: 88.50, meta: 85.00, unidade: '%' },
  retrabalho: { valor: 3.20, meta: 5.00, unidade: '%', inverso: true },

  // Estoque & Giro - DADOS REAIS (DEZ/2025)
  giroEstoqueMP: { valor: 3.00, meta: 3.20, unidade: 'x' },         // Giro Estoque MP (R$)
  giroPALojas: { valor: 3.51, meta: 3.00, unidade: 'x' },           // Giro PA Lojas (QTD)
  giroPAFabrica: { valor: 2.21, meta: 3.00, unidade: 'x' },         // Giro PA Fábrica (QTD)

  // Faturamento & Crescimento - DADOS REAIS (DEZ/2025)
  crescimentoFaturamento: { valor: 9.20, meta: 10.31, unidade: '%' },  // Crescimento Acum. Faturamento
  crescimentoEcommerce: { valor: -17.64, meta: 10.00, unidade: '%' },   // % Crescimento Ecommerce
  vendasVolumeVarejo: { valor: 12.22, meta: 13.50, unidade: '%' },      // Vendas Volume x Varejo

  // Rentabilidade - DADOS REAIS (DEZ/2025)
  lucroLiquido12M: { valor: 48.05, meta: 100.00, unidade: '%' },       // Lucro Líquido 12M
  cmv: { valor: 38.39, meta: 38.00, unidade: '%', inverso: true },     // % CMV
  dreEcommerce: { valor: 5.79, meta: 5.00, unidade: '%' },             // DRE Ecommerce

  // Ecommerce Performance - DADOS REAIS (DEZ/2025)
  roasGoogleMeta: { valor: 7.76, meta: 6.00, unidade: 'x' },           // ROAS Margem Meta - Média
  taxaConversao: { valor: 0.94, meta: 1.00, unidade: '%' },            // Taxa Conversão Ecommerce
  quebraPedidos: { valor: 3.34, meta: 1.50, unidade: '%', inverso: true }, // % Quebra de Pedidos

  // Inadimplência - DADOS REAIS (DEZ/2025)
  inadimplencia30: { valor: 0.80, meta: 1.50, unidade: '%', inverso: true },   // Inadimplência Até 30 Dias
  inadimplencia90: { valor: 0.59, meta: 1.00, unidade: '%', inverso: true },   // Inadimplência 31 a 90 Dias
  inadimplencia180: { valor: 0.86, meta: 1.00, unidade: '%', inverso: true },  // Inadimplência 91 a 180 Dias

  // Cobrança - DADOS REAIS (DEZ/2025)
  campanhasCobranca: { valor: 0.67, meta: 0.50, unidade: '%' },                 // Campanhas Cobrança
  cobrancaExterna: { valor: 3.39, meta: 3.00, unidade: '%' },                   // % Recebimento Cobrança Externa
};

// ============================================================================
// COMPONENTES
// ============================================================================

type StatusType = 'success' | 'warning' | 'danger';

function getStatus(valor: number, meta: number, inverso: boolean = false): StatusType {
  if (inverso) {
    if (valor <= meta * 0.9) return 'success';
    if (valor <= meta) return 'warning';
    return 'danger';
  }
  if (valor >= meta) return 'success';
  if (valor >= meta * 0.85) return 'warning';
  return 'danger';
}

function StatusIcon({ status }: { status: StatusType }) {
  if (status === 'success') return <CheckCircle2 className="w-4 h-4 text-green-500" />;
  if (status === 'warning') return <AlertCircle className="w-4 h-4 text-amber-500" />;
  return <XCircle className="w-4 h-4 text-red-500" />;
}

// Card compacto de indicador
interface MiniCardProps {
  titulo: string;
  valor: number;
  meta: number;
  unidade: string;
  inverso?: boolean;
}

function MiniCard({ titulo, valor, meta, unidade, inverso = false }: MiniCardProps) {
  // Validação: garantir que valor e meta sejam números
  const valorNum = typeof valor === 'number' && !isNaN(valor) ? valor : 0;
  const metaNum = typeof meta === 'number' && !isNaN(meta) ? meta : 0;

  const status = getStatus(valorNum, metaNum, inverso);
  const variacao = metaNum !== 0 ? ((valorNum - metaNum) / Math.abs(metaNum) * 100) : 0;

  return (
    <div className={`p-3 rounded-lg border ${
      status === 'success' ? 'bg-green-50 border-green-200' :
      status === 'warning' ? 'bg-amber-50 border-amber-200' :
      'bg-red-50 border-red-200'
    }`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-600 truncate pr-2">{titulo}</span>
        <StatusIcon status={status} />
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-xl font-bold ${
          status === 'success' ? 'text-green-700' :
          status === 'warning' ? 'text-amber-700' :
          'text-red-700'
        }`}>
          {valorNum.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        <span className="text-sm text-gray-500">{unidade}</span>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-xs text-gray-400">Meta: {metaNum}{unidade}</span>
        <span className={`text-xs font-medium ${
          (inverso ? variacao <= 0 : variacao >= 0) ? 'text-green-600' : 'text-red-600'
        }`}>
          {variacao >= 0 ? '+' : ''}{variacao.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// Linha de indicador ultra compacta
interface LinhaIndicadorProps {
  titulo: string;
  valor: number;
  meta: number;
  unidade: string;
  inverso?: boolean;
}

function LinhaIndicador({ titulo, valor, meta, unidade, inverso = false }: LinhaIndicadorProps) {
  // Validação: garantir que valor e meta sejam números
  const valorNum = typeof valor === 'number' && !isNaN(valor) ? valor : 0;
  const metaNum = typeof meta === 'number' && !isNaN(meta) ? meta : 0;

  const status = getStatus(valorNum, metaNum, inverso);
  const porcentagem = inverso
    ? Math.max(0, Math.min(100, metaNum !== 0 ? (1 - valorNum / metaNum) * 100 + 50 : 0))
    : Math.min(100, metaNum !== 0 ? (valorNum / metaNum) * 100 : 0);

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
      <StatusIcon status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm text-gray-700 truncate">{titulo}</span>
          <span className={`text-sm font-bold ${
            status === 'success' ? 'text-green-600' :
            status === 'warning' ? 'text-amber-600' :
            'text-red-600'
          }`}>
            {valorNum.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}{unidade}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${
                status === 'success' ? 'bg-green-500' :
                status === 'warning' ? 'bg-amber-500' :
                'bg-red-500'
              }`}
              style={{ width: `${porcentagem}%` }}
            />
          </div>
          <span className="text-xs text-gray-400 w-16 text-right">Meta: {metaNum}{unidade}</span>
        </div>
      </div>
    </div>
  );
}

// Seção agrupadora
interface SecaoProps {
  titulo: string;
  icone: React.ReactNode;
  children: React.ReactNode;
  cor?: string;
}

function Secao({ titulo, icone, children, cor = 'brand-primary' }: SecaoProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className={`px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2`}>
        {icone}
        <h3 className="font-semibold text-gray-800">{titulo}</h3>
      </div>
      <div className="p-4">
        {children}
      </div>
    </div>
  );
}

// Card de resumo executivo
function ResumoExecutivo({ mesFormatado }: { mesFormatado: string }) {
  const indicadores = [
    { ...MOCK_DATA.projetosNoPrazo, nome: 'Projetos' },
    { ...MOCK_DATA.giroEstoqueMP, nome: 'Giro MP' },
    { ...MOCK_DATA.crescimentoFaturamento, nome: 'Faturamento' },
    { ...MOCK_DATA.lucroLiquido12M, nome: 'Lucro' },
    { ...MOCK_DATA.cmv, nome: 'CMV', inverso: true },
    { ...MOCK_DATA.inadimplencia30, nome: 'Inadimpl.', inverso: true },
  ];

  const total = indicadores.length;
  const noAlvo = indicadores.filter(i => getStatus(i.valor, i.meta, (i as any).inverso ?? false) === 'success').length;
  const atencao = indicadores.filter(i => getStatus(i.valor, i.meta, (i as any).inverso ?? false) === 'warning').length;
  const critico = indicadores.filter(i => getStatus(i.valor, i.meta, (i as any).inverso ?? false) === 'danger').length;

  return (
    <div className="bg-gradient-to-r from-brand-dark to-brand-primary rounded-xl p-4 text-white mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Resumo Executivo</h2>
          <p className="text-sm text-white/70">{mesFormatado}</p>
        </div>
        <div className="flex gap-6">
          <div className="text-center">
            <div className="text-2xl font-bold text-green-300">{noAlvo}</div>
            <div className="text-xs text-white/70">No Alvo</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-amber-300">{atencao}</div>
            <div className="text-xs text-white/70">Atenção</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-300">{critico}</div>
            <div className="text-xs text-white/70">Crítico</div>
          </div>
          <div className="text-center border-l border-white/20 pl-6">
            <div className="text-2xl font-bold">{Math.round(noAlvo/total*100)}%</div>
            <div className="text-xs text-white/70">Performance</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PÁGINA PRINCIPAL
// ============================================================================

export default function IndicadoresControladoriaPage() {
  // Estado para mês de referência (formato YYYY-MM)
  const [mesReferencia, setMesReferencia] = useState('2026-01');

  // Buscar dados de giro de estoque da API (COMENTADO - usando apenas dados mockados)
  // const { fabrica, lojas, ecommerce, loading, error } = useMultipleGiroEstoque(mesReferencia);
  const loading = false;
  const error = null;

  // CMV - dados reais do banco
  const [cmvData, setCmvData] = useState<CmvData | null>(null);
  const [cmvLoading, setCmvLoading] = useState(false);

  useEffect(() => {
    const fetchCmv = async () => {
      setCmvLoading(true);
      try {
        const response = await fetch(`/api/indicadores/cmv?mesReferencia=${mesReferencia}`);
        if (response.ok) {
          const data = await response.json();
          setCmvData(data);
        } else {
          console.error('[CMV] Erro ao buscar CMV:', response.status);
          setCmvData(null);
        }
      } catch (err) {
        console.error('[CMV] Erro:', err);
        setCmvData(null);
      } finally {
        setCmvLoading(false);
      }
    };
    fetchCmv();
  }, [mesReferencia]);

  // Usar dados mockados diretamente (sem API)
  const dadosCompletos = useMemo(() => {
    return { ...MOCK_DATA };
  }, []);

  // Formatar mês para display
  const mesFormatado = useMemo(() => {
    try {
      const [ano, mes] = mesReferencia.split('-');
      const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
                     'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
      return `${meses[parseInt(mes) - 1]} ${ano}`;
    } catch {
      return 'Dezembro 2024';
    }
  }, [mesReferencia]);

  return (
    <div className="max-w-[98%] mx-auto py-4 px-4">
      {/* Header compacto */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">INDICADORES DE CONTROLADORIA</h1>
          <p className="text-sm text-gray-500">Dashboard Executivo - Reunião Geral</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={mesReferencia}
            onChange={(e) => setMesReferencia(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            <option value="2026-01">Janeiro 2026</option>
            <option value="2025-12">Dezembro 2025</option>
            <option value="2025-11">Novembro 2025</option>
            <option value="2025-10">Outubro 2025</option>
          </select>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-brand-primary" />}
        </div>
      </div>

      {/* Erro ao carregar dados */}
      {/* {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Erro ao carregar dados de giro de estoque. Mostrando dados de demonstração.
        </div>
      )} */}

      {/* Resumo Executivo */}
      <ResumoExecutivo mesFormatado={mesFormatado} />

      {/* Grid de seções 2x2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">

        {/* Operações & Projetos */}
        <Secao titulo="Operações & Projetos" icone={<Target className="w-4 h-4 text-blue-600" />}>
          <div className="space-y-0">
            <LinhaIndicador titulo="Projetos no Prazo" {...dadosCompletos.projetosNoPrazo} />
            <LinhaIndicador titulo="Satisfação Cliente" {...dadosCompletos.satisfacaoCliente} />
            <LinhaIndicador titulo="Retrabalho" {...dadosCompletos.retrabalho} inverso />
          </div>
        </Secao>

        {/* Estoque & Giro */}
        <Secao titulo="Estoque & Giro" icone={<Package className="w-4 h-4 text-purple-600" />}>
          <div className="grid grid-cols-3 gap-2">
            <MiniCard titulo="Giro MP (R$)" {...dadosCompletos.giroEstoqueMP} />
            <MiniCard titulo="Giro PA Lojas" {...dadosCompletos.giroPALojas} />
            <MiniCard titulo="Giro PA Fábrica" {...dadosCompletos.giroPAFabrica} />
          </div>
        </Secao>

        {/* Faturamento & Crescimento */}
        <Secao titulo="Faturamento & Crescimento" icone={<TrendingUp className="w-4 h-4 text-green-600" />}>
          <div className="space-y-0">
            <LinhaIndicador titulo="Faturamento Acumulado" {...dadosCompletos.crescimentoFaturamento} />
            <LinhaIndicador titulo="Crescimento Ecommerce" {...dadosCompletos.crescimentoEcommerce} />
            <LinhaIndicador titulo="Vendas Volume x Varejo" {...dadosCompletos.vendasVolumeVarejo} />
          </div>
        </Secao>

        {/* Rentabilidade */}
        <Secao titulo="Rentabilidade" icone={<DollarSign className="w-4 h-4 text-emerald-600" />}>
          <div className="grid grid-cols-3 gap-2">
            <MiniCard titulo="Lucro Líq. 12M" {...dadosCompletos.lucroLiquido12M} />
            {/* CMV - dados reais do banco */}
            <div className={`p-3 rounded-lg border ${cmvLoading ? 'bg-gray-50 border-gray-200' : 'bg-blue-50 border-blue-200'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-600 truncate pr-2">CMV</span>
                {cmvLoading
                  ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                  : <AlertCircle className="w-4 h-4 text-amber-500" />
                }
              </div>
              {cmvLoading ? (
                <div className="text-sm text-gray-400">Carregando...</div>
              ) : cmvData ? (
                <>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-bold text-blue-700">
                      {(cmvData.cmv_total / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                    </span>
                    <span className="text-sm text-gray-500">K R$</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-400">
                    Lojas: {(cmvData.cmv_lojas / 1000).toFixed(1)}K · Fab: {(cmvData.cmv_fab / 1000).toFixed(1)}K
                  </div>
                </>
              ) : (
                <div className="text-sm text-gray-400">—</div>
              )}
            </div>
            <MiniCard titulo="DRE Ecommerce" {...dadosCompletos.dreEcommerce} />
          </div>
        </Secao>

        {/* Ecommerce Performance */}
        <Secao titulo="Ecommerce Performance" icone={<ShoppingCart className="w-4 h-4 text-pink-600" />}>
          <div className="space-y-0">
            <LinhaIndicador titulo="ROAS Google/Meta" {...dadosCompletos.roasGoogleMeta} />
            <LinhaIndicador titulo="Taxa Conversão" {...dadosCompletos.taxaConversao} />
            <LinhaIndicador titulo="Quebra Pedidos" {...dadosCompletos.quebraPedidos} inverso />
          </div>
        </Secao>

        {/* Inadimplência & Cobrança */}
        <Secao titulo="Inadimplência & Cobrança" icone={<AlertTriangle className="w-4 h-4 text-amber-600" />}>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="col-span-2">
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                <span>Aging:</span>
                <div className="flex-1 flex items-center gap-1">
                  <div className="flex-1 h-2 bg-amber-200 rounded-l" title="Até 30 dias" />
                  <div className="flex-1 h-2 bg-orange-300" title="31-90 dias" />
                  <div className="flex-1 h-2 bg-red-400 rounded-r" title="91-180 dias" />
                </div>
              </div>
            </div>
            <MiniCard titulo="Até 30 dias" {...dadosCompletos.inadimplencia30} inverso />
            <MiniCard titulo="31-90 dias" {...dadosCompletos.inadimplencia90} inverso />
            <MiniCard titulo="91-180 dias" {...dadosCompletos.inadimplencia180} inverso />
            <div className="p-3 rounded-lg border bg-blue-50 border-blue-200">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-600">Cobrança</span>
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              </div>
              <div className="text-xl font-bold text-blue-700">
                {(dadosCompletos.campanhasCobranca.valor + dadosCompletos.cobrancaExterna.valor).toFixed(2)}%
              </div>
              <span className="text-xs text-gray-400">Recuperação total</span>
            </div>
          </div>
        </Secao>

      </div>

      {/* Legenda compacta */}
      <div className="mt-4 flex items-center justify-center gap-6 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3 text-green-500" />
          <span>No alvo (≥ meta)</span>
        </div>
        <div className="flex items-center gap-1">
          <AlertCircle className="w-3 h-3 text-amber-500" />
          <span>Atenção (85-99%)</span>
        </div>
        <div className="flex items-center gap-1">
          <XCircle className="w-3 h-3 text-red-500" />
          <span>Crítico (&lt; 85%)</span>
        </div>
      </div>
    </div>
  );
}
