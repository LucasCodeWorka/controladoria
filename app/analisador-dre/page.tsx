'use client';

import React, { useEffect, useState } from 'react';
import {
  Store,
  Calendar,
  Sparkles,
  RefreshCw,
  AlertCircle,
  FileDown,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';

import { PLANO_CONTAS_DRE_FABRICA } from '../dre-fabrica/planoContasDREFabrica';
import AtalhosPeriodo from '../components/filtros/AtalhosPeriodo';
import {
  type PeriodoDRE,
  type ContaDREValores,
  clonarComValores,
  somarFilhos,
  achatarContas,
  calcularLinhasOrdenadas,
} from '../dre-fabrica/dreCalculos';

interface OpcaoFiltro {
  valor: string;
  label: string;
  tipo: string;
}

function formatarDataBR(data: string): string {
  if (!data) return '';
  const [ano, mes, dia] = data.split('-');
  return `${dia}/${mes}/${ano}`;
}

function montarPeriodosPadrao(dataInicio: string, dataFim: string): PeriodoDRE[] {
  const periodos: PeriodoDRE[] = [];
  const [anoIni, mesIni] = dataInicio.split('-').map(Number);
  const [anoFim, mesFim] = dataFim.split('-').map(Number);
  let ano = anoIni;
  let mes = mesIni;
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    const key = `${ano}-${String(mes).padStart(2, '0')}`;
    periodos.push({ key, label: `${String(mes).padStart(2, '0')}/${String(ano).slice(2)}` });
    mes += 1;
    if (mes > 12) {
      mes = 1;
      ano += 1;
    }
  }
  return periodos;
}

export default function AnalisadorDrePage() {
  const [opcoesLojas, setOpcoesLojas] = useState<OpcaoFiltro[]>([]);
  const [lojaSelecionada, setLojaSelecionada] = useState<string>('');

  const [dataInicio, setDataInicio] = useState(() => {
    const hoje = new Date();
    const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    return `${inicioMesAnterior.getFullYear()}-${String(inicioMesAnterior.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [dataFim, setDataFim] = useState(() => {
    const hoje = new Date();
    const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    return `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`;
  });

  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [analisadoPara, setAnalisadoPara] = useState<{ loja: string; dataInicio: string; dataFim: string } | null>(null);

  useEffect(() => {
    async function carregarLojas() {
      try {
        const response = await fetch('/api/dre/centros-custo');
        const data = await response.json();
        const lojas: OpcaoFiltro[] = (data.opcoes || []).filter((o: OpcaoFiltro) => o.tipo === 'loja');
        setOpcoesLojas(lojas);
        if (lojas.length > 0) setLojaSelecionada((atual) => atual || lojas[0].valor);
      } catch (error) {
        console.error('Erro ao carregar lojas:', error);
        setErro('Não foi possível carregar a lista de lojas.');
      }
    }
    carregarLojas();
  }, []);

  function aplicarPeriodo(periodo: { dataInicio: string; dataFim: string }) {
    setDataInicio(periodo.dataInicio);
    setDataFim(periodo.dataFim);
  }

  async function analisar() {
    if (!lojaSelecionada) {
      setErro('Selecione uma loja para analisar.');
      return;
    }

    setLoading(true);
    setErro(null);
    setTexto('');
    setAnalisadoPara(null);

    try {
      const params = new URLSearchParams({ dataInicio, dataFim, filtro: lojaSelecionada });
      const response = await fetch(`/api/dre/unificada?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();

      if (data.error) {
        setErro(`Erro do backend: ${data.error}`);
        return;
      }

      const periodosAtuais: PeriodoDRE[] = data.periodos || montarPeriodosPadrao(dataInicio, dataFim);
      const valoresAPI = data.valores || {};

      const dadosProcessados = JSON.parse(JSON.stringify(clonarComValores(PLANO_CONTAS_DRE_FABRICA))) as ContaDREValores[];

      const encontrarConta = (contas: ContaDREValores[], codigo: string): ContaDREValores | null => {
        for (const conta of contas) {
          if (conta.codigo === codigo) return conta;
          if (conta.filhos) {
            const encontrada = encontrarConta(conta.filhos, codigo);
            if (encontrada) return encontrada;
          }
        }
        return null;
      };

      const contasTotalizadoras: Record<string, ContaDREValores> = {};

      for (const codigoConta of Object.keys(valoresAPI)) {
        const conta = encontrarConta(dadosProcessados, codigoConta);
        const valoresConta = valoresAPI[codigoConta];

        if (!conta) {
          if (['03', '05', '07', '09', '11', '14'].includes(codigoConta)) {
            contasTotalizadoras[codigoConta] = {
              codigo: codigoConta,
              nome: '',
              nivel: 1,
              tipo: 'resultado',
              valores: {},
              total: valoresConta.total || 0,
              valoresApi: true,
            };
            for (const periodo of periodosAtuais) {
              contasTotalizadoras[codigoConta].valores[periodo.key] = valoresConta[periodo.key] || 0;
            }
          }
          continue;
        }
        conta.valores = {};
        for (const periodo of periodosAtuais) {
          conta.valores[periodo.key] = valoresConta[periodo.key] || 0;
        }
        conta.total = valoresConta.total || 0;
        conta.valoresApi = true;
      }

      somarFilhos(dadosProcessados, periodosAtuais);
      const dadosOrdenados = calcularLinhasOrdenadas(dadosProcessados, periodosAtuais, contasTotalizadoras);
      const contasAchatadas = achatarContas(dadosOrdenados, periodosAtuais);

      const lojaLabel = opcoesLojas.find((o) => o.valor === lojaSelecionada)?.label || lojaSelecionada;

      const payload = {
        loja: { codigo: lojaSelecionada, nome: lojaLabel },
        periodo: {
          dataInicio,
          dataFim,
          periodos: periodosAtuais.map((p) => p.label),
        },
        contas: contasAchatadas,
      };

      const respIniciar = await fetch('/api/dre/analisador-loja/iniciar', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const dataIniciar = await respIniciar.json();

      if (!respIniciar.ok) {
        setErro(dataIniciar.detail || dataIniciar.error || 'Erro ao iniciar a análise da loja.');
        setLoading(false);
        return;
      }

      await aguardarResultado(dataIniciar.jobId, lojaLabel);
    } catch (error) {
      console.error('Erro ao analisar loja:', error);
      setErro('Erro ao analisar a loja.');
      setLoading(false);
    }
  }

  async function aguardarResultado(jobId: string, lojaLabel: string) {
    // A analise leva de 1 a alguns minutos (a IA gera as 10 etapas com
    // thinking) - faz polling em vez de segurar uma unica requisicao aberta,
    // que estoura timeout de proxy em varios ambientes de deploy antes da
    // API da Anthropic terminar.
    const POLL_INTERVALO_MS = 5000;
    // Na pratica a maioria das analises fica pronta em poucos minutos, mas
    // ja observamos casos passando de 30min (thinking com effort alto varia
    // bastante de duracao) - a janela e generosa pra nao desistir com o
    // backend ainda processando (o job continua rodando de qualquer forma,
    // so o frontend teria descartado o resultado).
    const POLL_MAX_TENTATIVAS = 420; // ~35 minutos de polling

    for (let tentativa = 0; tentativa < POLL_MAX_TENTATIVAS; tentativa++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVALO_MS));
      try {
        const resp = await fetch(`/api/dre/analisador-loja/status/${jobId}`, { cache: 'no-store' });
        const data = await resp.json();

        if (!resp.ok) {
          if (resp.status === 404) {
            setErro('O servidor reiniciou enquanto a análise estava em andamento e perdeu o progresso. Clique em "Analisar" novamente.');
          } else {
            setErro(data.detail || data.error || 'Erro ao consultar o status da análise.');
          }
          setLoading(false);
          return;
        }

        if (data.status === 'concluido') {
          setTexto(data.analise || '');
          setAnalisadoPara({ loja: lojaLabel, dataInicio, dataFim });
          setLoading(false);
          return;
        }

        if (data.status === 'erro') {
          setErro(data.erro || 'Erro ao gerar a análise da loja.');
          setLoading(false);
          return;
        }
        // status 'processando' -> continua aguardando
      } catch (error) {
        console.error('Erro ao consultar status da analise:', error);
        setErro('Erro ao consultar o status da análise.');
        setLoading(false);
        return;
      }
    }

    setErro('A análise demorou mais do que o esperado. Tente novamente em instantes.');
    setLoading(false);
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-1 print:hidden">
        <Sparkles className="w-7 h-7 text-indigo-600" />
        <h1 className="text-2xl font-bold text-gray-800">Analisador de DRE por Empresa</h1>
      </div>
      <p className="text-sm text-gray-500 mb-6 print:hidden">
        Análise de Controller/CFO com IA para uma loja física: rentabilidade, eficiência, materialidade,
        oportunidades e plano de ação.
      </p>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 mb-6 print:hidden">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
              <Store className="w-3.5 h-3.5" /> Loja
            </label>
            <select
              value={lojaSelecionada}
              onChange={(e) => setLojaSelecionada(e.target.value)}
              className="min-w-[260px] px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              {opcoesLojas.length === 0 && <option value="">Carregando lojas...</option>}
              {opcoesLojas.map((opcao) => (
                <option key={opcao.valor} value={opcao.valor}>
                  {opcao.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Data início
            </label>
            <input
              type="date"
              value={dataInicio}
              onChange={(e) => setDataInicio(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Data fim
            </label>
            <input
              type="date"
              value={dataFim}
              onChange={(e) => setDataFim(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <button
            onClick={analisar}
            disabled={loading || !lojaSelecionada}
            className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded-lg transition-colors font-medium"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {loading ? 'Analisando...' : 'Analisar'}
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-gray-100">
          <AtalhosPeriodo onSelecionar={aplicarPeriodo} />
        </div>
      </div>

      {erro && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6 print:hidden">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <span>{erro}</span>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-500 gap-3 print:hidden">
          <RefreshCw className="w-8 h-8 animate-spin text-indigo-600" />
          <span>Gerando análise da loja (10 etapas) — geralmente leva poucos minutos, mas em alguns casos pode passar de 20-30 minutos. Não feche esta aba.</span>
        </div>
      )}

      {!loading && texto && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 print:border-none print:shadow-none print:p-0">
          <div className="hidden print:block mb-4 pb-4 border-b border-gray-300">
            <h1 className="text-xl font-bold text-gray-900">Analisador de DRE por Empresa</h1>
          </div>

          <div className="flex items-center justify-between gap-4 mb-4 pb-4 border-b border-gray-100 print:border-gray-300">
            {analisadoPara && (
              <p className="text-xs text-gray-500">
                Loja: <span className="font-semibold text-gray-700">{analisadoPara.loja}</span> · Período:{' '}
                {formatarDataBR(analisadoPara.dataInicio)} a {formatarDataBR(analisadoPara.dataFim)}
              </p>
            )}
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg transition-colors font-medium text-sm print:hidden"
            >
              <FileDown className="w-4 h-4" />
              Baixar PDF
            </button>
          </div>

          <div className="prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-900 prose-table:text-xs">
            <ReactMarkdown>{texto}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
