'use client';

import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { ChevronRight, ChevronDown, Save, RotateCcw, Settings, Zap, Plus, X, Tag, Search, Check } from 'lucide-react';
import { PLANO_CONTAS_DRE, type ContaDRE } from './planoContasDRE';

interface Despesa {
  cd_despesaitem: number;
  ds_despesaitem: string;
  categoria_dfc: string;
  conta_dre: string;
  dt_atualizacao?: string;
  usuario_alteracao?: string;
}

type FiltroDFC =
  | 'TODAS'
  | 'Atividades Operacionais'
  | 'Investimentos'
  | 'Atividades de Financiamento'
  | 'Custos de Matéria Prima'
  | 'Folha de Pagamento';

function normalizarCategoriaDFC(categoria: string | undefined): FiltroDFC | 'OUTRAS' {
  const valor = (categoria || '').trim().toLowerCase();
  if (valor === 'operacionais') return 'Atividades Operacionais';
  if (valor === 'investimentos') return 'Investimentos';
  if (valor === 'financiamento') return 'Atividades de Financiamento';
  if (valor === 'materia_prima') return 'Custos de Matéria Prima';
  if (valor === 'folha_pagamento') return 'Folha de Pagamento';
  if (valor.includes('operacion')) return 'Atividades Operacionais';
  if (valor.includes('invest')) return 'Investimentos';
  if (valor.includes('financi')) return 'Atividades de Financiamento';
  if (valor.includes('mat') && valor.includes('prima')) return 'Custos de Matéria Prima';
  if (valor.includes('folha')) return 'Folha de Pagamento';
  return 'OUTRAS';
}

// Cores por nível
const CORES_NIVEL: Record<number, string> = {
  1: 'bg-blue-100 border-blue-300 text-blue-800',
  2: 'bg-green-100 border-green-300 text-green-800',
  3: 'bg-yellow-100 border-yellow-300 text-yellow-800',
  4: 'bg-purple-100 border-purple-300 text-purple-800',
};

// Função auxiliar para achatar o plano de contas
function achatarPlanoContas(contas: ContaDRE[], resultado: ContaDRE[] = []): ContaDRE[] {
  for (const conta of contas) {
    resultado.push(conta);
    if (conta.filhos) {
      achatarPlanoContas(conta.filhos, resultado);
    }
  }
  return resultado;
}

function coletarCodigosExpansiveis(contas: ContaDRE[], resultado: string[] = []): string[] {
  for (const conta of contas) {
    if (conta.filhos && conta.filhos.length > 0) {
      resultado.push(conta.codigo);
      coletarCodigosExpansiveis(conta.filhos, resultado);
    }
  }
  return resultado;
}

// Regras padrão para classificação automática
interface RegraClassificacaoDRE {
  palavraChave: string;
  contaDre: string;
}

const REGRAS_PADRAO_DRE: RegraClassificacaoDRE[] = [
  // === 08.01 - OCUPAÇÃO ===
  { palavraChave: 'CONDOMINIO', contaDre: '08.01.01' },
  { palavraChave: 'ALUGUEL', contaDre: '08.01.02' },
  { palavraChave: 'FUNDO DE PROMOCAO', contaDre: '08.01.03' },
  { palavraChave: 'ENERGIA', contaDre: '08.01.04' },
  { palavraChave: 'AR CONDICIONADO', contaDre: '08.01.05' },
  { palavraChave: 'IPTU', contaDre: '08.01.06' },
  { palavraChave: 'TAXAS E EMOLUMENTO', contaDre: '08.01.07' },
  { palavraChave: 'AGUA E ESGOTO', contaDre: '08.01.09' },

  // === 08.02 - ADMINISTRATIVAS ===
  { palavraChave: 'ASSESSORIA JURIDICA', contaDre: '08.02.01' },
  { palavraChave: 'ASSESSORIA CONTABIL', contaDre: '08.02.02' },
  { palavraChave: 'SEGURANCA', contaDre: '08.02.03' },
  { palavraChave: 'MONITORAMENTO', contaDre: '08.02.03' },
  { palavraChave: 'ASSOCIACAO', contaDre: '08.02.04' },
  { palavraChave: 'MATERIAL DE LIMPEZA', contaDre: '08.02.05' },
  { palavraChave: 'MAT DE CONSUMO', contaDre: '08.02.06' },
  { palavraChave: 'AGUA MINERAL', contaDre: '08.02.07' },
  { palavraChave: 'TELEFONIA FIXA', contaDre: '08.02.09' },
  { palavraChave: 'TELEFONIA MOVEL', contaDre: '08.02.16' },
  { palavraChave: 'TELEFONE', contaDre: '08.02.09' },
  { palavraChave: 'INTERNET', contaDre: '08.02.17' },
  { palavraChave: 'CORREIOS', contaDre: '08.02.18' },
  { palavraChave: 'MALOTE', contaDre: '08.02.18' },
  { palavraChave: 'MATERIAL DE ESCRITORIO', contaDre: '08.02.19' },
  { palavraChave: 'SOFTWARE', contaDre: '08.02.20' },
  { palavraChave: 'ANUIDADE', contaDre: '08.02.21' },
  { palavraChave: 'CONTRIBUICAO', contaDre: '08.02.21' },
  { palavraChave: 'CONSULTORIA', contaDre: '08.02.10' },
  { palavraChave: 'DEDETIZACAO', contaDre: '08.02.15' },
  { palavraChave: 'CARTORIO', contaDre: '08.02.14' },
  { palavraChave: 'ALVARA', contaDre: '08.02.28' },
  { palavraChave: 'CONFRATERNIZACAO', contaDre: '08.02.29' },

  // === 08.03 - MANUTENÇÃO ===
  { palavraChave: 'MANUTENCAO INSTALACOES', contaDre: '08.03.01' },
  { palavraChave: 'MANUTENCAO EDIFICACOES', contaDre: '08.03.02' },
  { palavraChave: 'MANUTENCAO EQP INFORMATICA', contaDre: '08.03.03' },
  { palavraChave: 'MANUTENCAO MAQ', contaDre: '08.03.04' },
  { palavraChave: 'MANUTENCAO AR', contaDre: '08.03.05' },
  { palavraChave: 'MANUT', contaDre: '08.03.01' },

  // === 08.04 - PESSOAL ===
  { palavraChave: 'SALARIO', contaDre: '08.04.22' },
  { palavraChave: 'FERIAS', contaDre: '08.04.26' },
  { palavraChave: '13 SALARIO', contaDre: '08.04.28' },
  { palavraChave: 'DECIMO TERCEIRO', contaDre: '08.04.28' },
  { palavraChave: 'FGTS', contaDre: '08.04.21' },
  { palavraChave: 'INSS', contaDre: '08.04.04' },
  { palavraChave: 'RESCISAO', contaDre: '08.04.03' },
  { palavraChave: 'VALE TRANSPORTE', contaDre: '08.04.07' },
  { palavraChave: 'VALE ALIMENTACAO', contaDre: '08.04.25' },
  { palavraChave: 'VALE COMBUSTIVEL', contaDre: '08.04.27' },
  { palavraChave: 'ALIMENTACAO', contaDre: '08.04.02' },
  { palavraChave: 'PREMIACAO', contaDre: '08.04.01' },
  { palavraChave: 'HORAS EXTRAS', contaDre: '08.04.10' },
  { palavraChave: 'FARDAMENTO', contaDre: '08.04.12' },
  { palavraChave: 'PLANO ODONTOLOGICO', contaDre: '08.04.14' },
  { palavraChave: 'IRRF SOBRE SALARIO', contaDre: '08.04.16' },
  { palavraChave: 'MULTA RESCISORIA', contaDre: '08.04.18' },
  { palavraChave: 'ASSIST MEDICA', contaDre: '08.04.29' },
  { palavraChave: 'EXAMES MEDICOS', contaDre: '08.04.06' },
  { palavraChave: 'ESTAGIO', contaDre: '08.04.08' },
  { palavraChave: 'TREINAMENTO', contaDre: '08.04.08' },
  { palavraChave: 'SINDICAL', contaDre: '08.04.05' },
  { palavraChave: 'FARMACIA', contaDre: '08.04.11' },

  // === 08.05 - MARKETING ===
  { palavraChave: 'MKT', contaDre: '08.05.05' },
  { palavraChave: 'MARKETING', contaDre: '08.05.05' },
  { palavraChave: 'PROPAGANDA', contaDre: '08.05.01' },
  { palavraChave: 'MIDIA', contaDre: '08.05.01' },
  { palavraChave: 'GRAFICA', contaDre: '08.05.05' },
  { palavraChave: 'CATALOGO', contaDre: '08.05.08' },
  { palavraChave: 'EVENTO', contaDre: '08.05.07' },
  { palavraChave: 'BUFFET', contaDre: '08.05.07' },
  { palavraChave: 'AMBIENTACAO', contaDre: '08.05.03' },
  { palavraChave: 'ENDOMARKETING', contaDre: '08.02.23' },

  // === 08.06 - COMERCIAIS ===
  { palavraChave: 'CAMPANHA', contaDre: '08.06.01' },
  { palavraChave: 'BRINDE', contaDre: '08.06.02' },
  { palavraChave: 'AJUDA DE CUSTO', contaDre: '08.06.04' },

  // === 08.07 - BANCÁRIAS ===
  { palavraChave: 'TARIFA DOC', contaDre: '08.07.01' },
  { palavraChave: 'TARIFA TED', contaDre: '08.07.01' },
  { palavraChave: 'TARIFA NEGATIVACAO', contaDre: '08.07.03' },
  { palavraChave: 'TARIFA MANUT', contaDre: '08.07.04' },
  { palavraChave: 'TARIFA BAIXA', contaDre: '08.07.06' },
  { palavraChave: 'TARIFA', contaDre: '08.07.09' },

  // === 08.08 - DIRETORIA ===
  { palavraChave: 'PROLABORE', contaDre: '08.08.02' },
  { palavraChave: 'RETIRADA', contaDre: '17.01.09' },

  // === 08.10 - VENDAS ===
  { palavraChave: 'FRETE', contaDre: '08.10.01' },
  { palavraChave: 'COMISSAO GERENTE', contaDre: '08.10.02' },
  { palavraChave: 'COMISSAO REPRESENTANTE', contaDre: '08.10.03' },
  { palavraChave: 'COMISSAO VENDEDOR', contaDre: '08.10.07' },
  { palavraChave: 'COMISSAO CORRETOR', contaDre: '08.10.08' },
  { palavraChave: 'COMISSAO COORDENADOR', contaDre: '08.10.09' },
  { palavraChave: 'COMISSAO SUPERVISOR', contaDre: '08.10.12' },
  { palavraChave: 'COMISSAO', contaDre: '08.10.03' },
  { palavraChave: 'TAXAS CARTAO', contaDre: '08.10.05' },

  // === 08.11 - CRÉDITO E COBRANÇA ===
  { palavraChave: 'CONSULTA CADASTRAL', contaDre: '08.11.01' },

  // === 08.12 - VEÍCULOS ===
  { palavraChave: 'COMBUSTIVEL', contaDre: '08.12.01' },
  { palavraChave: 'LUBRIFICANTE', contaDre: '08.12.01' },
  { palavraChave: 'MANUTENCAO DE VEICULO', contaDre: '08.12.02' },
  { palavraChave: 'SEGURO VEICULO', contaDre: '08.12.03' },
  { palavraChave: 'DETRAN', contaDre: '08.12.05' },
  { palavraChave: 'IPVA', contaDre: '08.12.05' },
  { palavraChave: 'ESTACIONAMENTO', contaDre: '08.12.06' },

  // === 10.03 - FINANCEIRAS ===
  { palavraChave: 'JUROS', contaDre: '10.03.01' },
  { palavraChave: 'MULTA', contaDre: '10.03.01' },
  { palavraChave: 'IOF', contaDre: '10.03.02' },
  { palavraChave: 'ANTECIPACAO', contaDre: '10.03.05' },
  { palavraChave: 'SEGURO EMPRESTIMO', contaDre: '10.03.06' },

  // === 13.01 - TRIBUTÁRIAS ===
  { palavraChave: 'CSLL', contaDre: '13.01.01' },
  { palavraChave: 'IRPJ', contaDre: '13.01.02' },

  // === 02.02 - IMPOSTOS SOBRE VENDAS ===
  { palavraChave: 'ICMS SOBRE VENDA', contaDre: '02.02.01' },
  { palavraChave: 'ICMS ANTECIPADO', contaDre: '04.01.01' },
  { palavraChave: 'ICMS SUBSTITUICAO', contaDre: '04.01.02' },
  { palavraChave: 'ICMS', contaDre: '02.02.01' },
  { palavraChave: 'PIS SOBRE RECEITA', contaDre: '02.02.02' },
  { palavraChave: 'PIS', contaDre: '02.02.02' },
  { palavraChave: 'COFINS', contaDre: '02.02.03' },
  { palavraChave: 'DIFAL', contaDre: '02.02.05' },
  { palavraChave: 'GNRE', contaDre: '02.02.05' },

  // === 17.01 - INVESTIMENTOS ===
  { palavraChave: 'INV. COMPUTADOR', contaDre: '17.01.01' },
  { palavraChave: 'INV. MAQUINA', contaDre: '17.01.03' },
  { palavraChave: 'INV. MOVEIS', contaDre: '17.01.04' },
  { palavraChave: 'INV. REFORMA', contaDre: '17.01.06' },
  { palavraChave: 'INV. SOFTWARE', contaDre: '17.01.07' },
  { palavraChave: 'INV.', contaDre: '17.01.06' },
  { palavraChave: 'INVESTIMENTO', contaDre: '17.01.06' },

  // === 18 - AMORTIZAÇÃO E DÍVIDAS ===
  { palavraChave: 'EMPRESTIMO PRINCIPAL', contaDre: '18.02' },
  { palavraChave: 'EMPRESTIMO MUTUO', contaDre: '18.04' },
  { palavraChave: 'EMPRESTIMO', contaDre: '18.02' },
  { palavraChave: 'PARCELAMENTO', contaDre: '18.05' },
  { palavraChave: 'MULTA SEFAZ', contaDre: '18.07' },
];

// Cache para mapa de contas (evita recalcular a cada render)
const contasMapCache = new Map<string, ContaDRE>();

// Mapeamento pré-definido de despesas para contas DRE
// Baseado no CSV fornecido pelo usuário
const MAPEAMENTO_DESPESA_DRE: Record<number, string> = {
  // 08.01 - DESPESAS COM OCUPAÇÃO
  80: '08.01.07',   // TAXAS E EMOLUMENTO - CO
  85: '08.01.02',   // ALUGUEL MINIMO - CO
  110: '08.01.06',  // IPTU - CO
  145: '08.01.03',  // FUNDO DE PROMOCAO - CO
  40: '08.01.04',   // ENERGIA - CO
  50: '08.01.01',   // CONDOMINIO - CO

  // 08.02 - DESPESAS ADMINISTRATIVAS
  4: '08.02.01',    // ASSESSORIA JURIDICA
  17: '08.02.02',   // ASSESSORIA CONTABIL
  18: '08.02.03',   // MONIT/SEGURANCA
  24: '08.02.04',   // ASSOCIACAO
  31: '08.02.05',   // MATERIAL DE LIMPEZA
  37: '08.02.06',   // MAT DE CONSUMO
  39: '08.02.07',   // AGUA MINERAL
  41: '08.02.09',   // TELEFONIA FIXA
  60: '08.02.16',   // TELEFONIA MOVEL
  63: '08.02.17',   // SERV INTERNET
  70: '08.02.18',   // CORREIOS E MALOTES
  74: '08.02.19',   // MATERIAL DE ESCRITORIO
  76: '08.02.20',   // MANUT DE SOFTWARE
  79: '08.02.21',   // CONTRIB/ANUIDADES
  123: '08.02.25',  // ISS RET FONTE
  159: '08.02.28',  // TAXAS DE ALVARAS
  160: '08.02.29',  // CONFRATERNIZACOES
  161: '08.02.30',  // MARCAS E PATENTES
  167: '08.02.31',  // CUSTAS PROCESSUAIS
  229: '08.02.32',  // ALUGUEL IMOVEIS ADM
  230: '08.02.33',  // IRRF OUTROS SERVICOS 1708
  252: '08.02.34',  // CONDUCOES ADMINISTRATIVA
  259: '08.02.35',  // SERVICOS DE INVENTARIOS
  263: '08.02.36',  // ALUGUEL MAQ E EQUIPAMENTOS
  264: '08.02.37',  // ALUGUEL EQUIP INFORMATICA
  271: '08.02.38',  // MULTAS E TAXAS ADMINISTRATIVAS

  // 08.03 - DESPESAS COM MANUTENCAO
  16: '08.03.01',   // MANUTENCAO INSTALACOES
  38: '08.03.02',   // MANUTENCAO EDIFICACOES
  51: '08.03.03',   // MANUTENCAO EQP INFORMATICA
  82: '08.03.04',   // MANUTENCAO MAQ EQUIPAMENTO
  226: '08.03.05',  // MANUTENCAO AR CONDICIONADO

  // 08.04 - DESPESAS COM PESSOAL ADM E LOJAS
  12: '08.04.04',   // INSS
  15: '08.04.07',   // VALE TRANSPORTE
  71: '08.04.16',   // IRRF SOBRE SALARIO
  134: '08.04.21',  // FGTS
  144: '08.04.22',  // SALARIOS A PAGAR
  7: '08.04.02',    // ALIMENTACAO
  9: '08.04.03',    // RESCISAO
  77: '08.04.18',   // MULTA RESCISORIA FGTS
  188: '08.04.25',  // VALE ALIMENTACAO

  // 08.05 - DESPESAS COM MARKETING
  94: '08.05.05',   // MKT PROD GRAFICA
  95: '08.05.04',   // MKT AGENCIA BV
  96: '08.05.04',   // MKT AG CONTRATO
  98: '08.05.01',   // MKT VEICUL/MIDIA
  102: '08.05.08',  // MKT PROD CATALOGO
  103: '08.05.07',  // MKT EVENTOS
  104: '08.05.07',  // MKT BUFFET/COQUETEL
  105: '08.05.03',  // MKT AMBIENTACAO LOJAS

  // 08.10 - DESPESAS COM VENDAS
  27: '08.10.01',   // FRETES VENDAS
  34: '08.10.07',   // COMISSAO VENDEDOR
  35: '08.10.03',   // COMISSAO REPRESENTANTE
  33: '08.10.02',   // COMISSAO GERENTE
  140: '08.10.12',  // COMISSAO SUPERVISOR
  272: '08.10.09',  // COMISSAO COORDENADOR
  59: '08.10.05',   // TAXAS CARTAO

  // 08.11 - DESPESAS COM CREDITO E COBRANCA
  49: '08.11.01',   // CONSULTA CADASTRAL

  // 08.12 - DESPESAS COM VEICULOS
  22: '08.12.01',   // COMBUSTIVEL/LUBRIFICANTE
  73: '08.12.02',   // MANUTENCAO DE VEICULOS
  83: '08.12.03',   // SEGURO VEICULOS
  87: '08.12.05',   // TX DETRAN/IPVA

  // 10.03 - DESPESAS FINANCEIRAS
  48: '10.03.02',   // IOF
  121: '10.03.02',  // IOF S/ EMPRESTIMO
  25: '10.03.01',   // MULTA/JUROS
  137: '10.03.04',  // JUROS S/EMPREST. E FINANCIAM.
  186: '10.03.05',  // JUROS S/ ANTECIPACAO
  258: '10.03.06',  // SEGURO SOBRE EMPRESTIMOS

  // 13.01 - DESPESAS TRIBUTARIAS
  124: '13.01.01',  // CSLL APURACAO
  125: '13.01.02',  // IRPJ APURACAO
  260: '13.01.01',  // CSLL PROVISAO
  261: '13.01.02',  // IRPJ PROVISAO

  // 17.01 - INVESTIMENTOS - IMOBILIZADOS
  11: '17.01.01',   // INV. COMPUTADORES E PERIFERICOS
  138: '17.01.03',  // INV. MAQUINAS E EQUIPAMENTOS
  139: '17.01.04',  // INV. MOVEIS E UTENSILIOS
  150: '17.01.06',  // INV. REFORMAS E OBRAS
  164: '17.01.07',  // INV. SOFTWARES
  169: '17.01.08',  // INV. CDU - CESSAO DE DIREITOS

  // 18 - AMORTIZAÇÃO E DÍVIDAS
  114: '18.02',     // EMPRESTIMO PRINCIPAL
  148: '18.04',     // EMPRESTIMO MUTUO
};

// Componente de Select com Pesquisa - Otimizado com memo
interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: ContaDRE[];
  optionsMap: Map<string, ContaDRE>;
  placeholder?: string;
  className?: string;
}

const SearchableSelect = memo(function SearchableSelect({
  value,
  onChange,
  options,
  optionsMap,
  placeholder = 'Selecione...',
  className = ''
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fechar ao clicar fora - só adiciona listener quando aberto
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Filtrar opções - memoizado
  const filteredOptions = useMemo(() => {
    if (!searchTerm) return options.slice(0, 50); // Limita inicial para performance
    const term = searchTerm.toLowerCase();
    return options.filter(opt =>
      opt.codigo.toLowerCase().includes(term) ||
      opt.nome.toLowerCase().includes(term)
    ).slice(0, 50);
  }, [options, searchTerm]);

  // Encontrar opção selecionada usando o Map (O(1) ao invés de O(n))
  const selectedOption = optionsMap.get(value);

  const handleSelect = useCallback((codigo: string) => {
    onChange(codigo);
    setIsOpen(false);
    setSearchTerm('');
  }, [onChange]);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Campo de exibição/trigger */}
      <div
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setTimeout(() => inputRef.current?.focus(), 50);
          }
        }}
        className="w-full px-3 py-2 text-xs border border-gray-300 rounded cursor-pointer bg-white hover:border-green-400 flex items-center justify-between"
      >
        <span className={`truncate ${!selectedOption ? 'text-gray-400' : ''}`}>
          {selectedOption ? `${selectedOption.codigo} - ${selectedOption.nome}` : placeholder}
        </span>
        <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </div>

      {/* Dropdown - Renderiza apenas quando aberto */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg">
          {/* Campo de pesquisa */}
          <div className="p-2 border-b border-gray-200 sticky top-0 bg-white">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Pesquisar conta..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-xs border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-green-500"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>

          {/* Lista de opções */}
          <div className="max-h-60 overflow-y-auto">
            {/* Opção "Não Classificado" */}
            <div
              onClick={() => handleSelect('NAO_CLASSIFICADO')}
              className={`px-3 py-2 text-xs cursor-pointer hover:bg-gray-100 flex items-center gap-2 ${
                value === 'NAO_CLASSIFICADO' ? 'bg-green-50 text-green-700' : ''
              }`}
            >
              {value === 'NAO_CLASSIFICADO' && <Check className="w-3 h-3" />}
              <span className={value === 'NAO_CLASSIFICADO' ? '' : 'ml-5'}>-- Não Classificado --</span>
            </div>

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-xs text-gray-500 text-center">
                Nenhuma conta encontrada
              </div>
            ) : (
              filteredOptions.map(opt => (
                <div
                  key={opt.codigo}
                  onClick={() => handleSelect(opt.codigo)}
                  className={`px-3 py-2 text-xs cursor-pointer hover:bg-gray-100 flex items-center gap-2 ${
                    value === opt.codigo ? 'bg-green-50 text-green-700' : ''
                  }`}
                >
                  {value === opt.codigo && <Check className="w-3 h-3" />}
                  <span className={value === opt.codigo ? '' : 'ml-5'}>
                    <span className="font-mono font-semibold">{opt.codigo}</span>
                    <span className="text-gray-600"> - {opt.nome}</span>
                  </span>
                </div>
              ))
            )}
            {filteredOptions.length === 50 && !searchTerm && (
              <div className="px-3 py-2 text-xs text-gray-400 text-center border-t">
                Digite para pesquisar mais opções...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// Componente de item de despesa memoizado
interface DespesaItemProps {
  despesa: Despesa;
  isSelected: boolean;
  onToggleSelecao: (id: number) => void;
  onMoverDespesa: (id: number, conta: string) => void;
  contasAchatadas: ContaDRE[];
  contasMap: Map<string, ContaDRE>;
  modoVisual: boolean;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
}

const DespesaItem = memo(function DespesaItem({
  despesa,
  isSelected,
  onToggleSelecao,
  onMoverDespesa,
  contasAchatadas,
  contasMap,
  modoVisual,
  onDragStart,
  onDragEnd
}: DespesaItemProps) {
  const handleChange = useCallback((value: string) => {
    onMoverDespesa(despesa.cd_despesaitem, value);
  }, [despesa.cd_despesaitem, onMoverDespesa]);

  const handleToggle = useCallback(() => {
    onToggleSelecao(despesa.cd_despesaitem);
  }, [despesa.cd_despesaitem, onToggleSelecao]);

  const contaAtual = contasMap.get(despesa.conta_dre);

  return (
    <div
      draggable={modoVisual}
      onDragStart={() => onDragStart(despesa.cd_despesaitem)}
      onDragEnd={onDragEnd}
      className={`px-4 py-2.5 hover:bg-gray-50 transition-colors ${
        isSelected ? 'bg-blue-50 border-l-4 border-blue-500' : ''
      }`}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={handleToggle}
          className="mt-1 w-4 h-4"
        />
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-gray-800 truncate">
            {despesa.ds_despesaitem}
          </p>
          <p className="text-[11px] text-gray-500">
            Código: #{despesa.cd_despesaitem}
          </p>
          <div className="mt-1">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {normalizarCategoriaDFC(despesa.categoria_dfc) === 'OUTRAS'
                ? (despesa.categoria_dfc || 'SEM CATEGORIA')
                : normalizarCategoriaDFC(despesa.categoria_dfc)}
            </span>
          </div>
          {modoVisual && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-500">
                Arraste para uma conta
              </span>
              <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                despesa.conta_dre === 'NAO_CLASSIFICADO'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-emerald-100 text-emerald-800'
              }`}>
                {contaAtual ? contaAtual.codigo : 'Sem conta'}
              </span>
            </div>
          )}
          {!modoVisual && (
            <SearchableSelect
            value={despesa.conta_dre}
            onChange={handleChange}
            options={contasAchatadas}
            optionsMap={contasMap}
            placeholder="-- Não Classificado --"
            className="mt-2"
            />
          )}
        </div>
      </div>
    </div>
  );
});

export default function PlanoContasDREPage() {
  const [despesas, setDespesas] = useState<Despesa[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filtro, setFiltro] = useState('');
  const [filtroPlanoContas, setFiltroPlanoContas] = useState('');
  const [filtroCategoriaDFC, setFiltroCategoriaDFC] = useState<FiltroDFC>('TODAS');
  const [alteracoesPendentes, setAlteracoesPendentes] = useState(false);
  const [contasExpandidas, setContasExpandidas] = useState<Set<string>>(new Set(['08']));
  const [despesasSelecionadas, setDespesasSelecionadas] = useState<Set<number>>(new Set());

  // Estados para classificação em lote
  const [mostrarRegras, setMostrarRegras] = useState(false);
  const [regras, setRegras] = useState<RegraClassificacaoDRE[]>(REGRAS_PADRAO_DRE);
  const [novaPalavra, setNovaPalavra] = useState('');
  const [novaConta, setNovaConta] = useState('08.02.01');


  // Estado para preview
  const [mostrarPreview, setMostrarPreview] = useState(false);
  const [despesasOriginais, setDespesasOriginais] = useState<Despesa[]>([]);
  const modoVisual = true;
  const [draggedDespesaId, setDraggedDespesaId] = useState<number | null>(null);
  const [contaHover, setContaHover] = useState<string | null>(null);

  // Lista achatada de contas para o dropdown - MEMOIZADO
  const contasAchatadas = useMemo(() =>
    achatarPlanoContas(PLANO_CONTAS_DRE).filter(c => c.tipo === 'conta'),
    []
  );

  // Mapa de contas para busca O(1) - MEMOIZADO
  const contasMap = useMemo(() => {
    const map = new Map<string, ContaDRE>();
    contasAchatadas.forEach(c => map.set(c.codigo, c));
    return map;
  }, [contasAchatadas]);

  const codigosExpansiveis = useMemo(() => coletarCodigosExpansiveis(PLANO_CONTAS_DRE), []);

  const categoriasDFC = useMemo<FiltroDFC[]>(() => ([
    'TODAS',
    'Atividades Operacionais',
    'Investimentos',
    'Atividades de Financiamento',
    'Custos de Matéria Prima',
    'Folha de Pagamento',
  ]), []);

  const contagemCategoriasDFC = useMemo(() => {
    const base: Record<FiltroDFC, number> = {
      'TODAS': 0, // Será calculado excluindo MP
      'Atividades Operacionais': 0,
      'Investimentos': 0,
      'Atividades de Financiamento': 0,
      'Custos de Matéria Prima': 0,
      'Folha de Pagamento': 0,
    };

    despesas.forEach(despesa => {
      const grupo = normalizarCategoriaDFC(despesa.categoria_dfc);
      if (grupo !== 'OUTRAS') {
        base[grupo] += 1;
        // "TODAS" conta tudo EXCETO Matéria Prima
        if (grupo !== 'Custos de Matéria Prima') {
          base['TODAS'] += 1;
        }
      }
    });

    return base;
  }, [despesas]);

  // Buscar despesas
  useEffect(() => {
    buscarDespesas();
  }, []);

  const buscarDespesas = useCallback(async () => {
    try {
      setLoading(true);
      // Buscar tanto as despesas com categorias DFC quanto as classificações DRE
      const [resDFC, resDRE] = await Promise.all([
        fetch('/api/classificacao-despesas'),
        fetch('/api/classificacao-despesas-dre'),
      ]);
      const dataDFC = await resDFC.json();
      const dataDRE = await resDRE.json();

      // Criar mapa de classificações DRE existentes
      const mapaDRE = new Map<number, string>();
      (dataDRE.data || []).forEach((d: any) => {
        if (d.conta_dre && d.conta_dre !== 'NAO_CLASSIFICADO') {
          mapaDRE.set(d.cd_despesaitem, d.conta_dre);
        }
      });

      // Mesclar dados: despesas DFC + classificações DRE salvas
      const despesasCarregadas = (dataDFC.data || []).map((d: any) => ({
        ...d,
        categoria_dfc: d.categoria || d.categoria_dfc || 'OPERACIONAIS',
        // Prioridade: 1) conta_dre já salva no banco DRE, 2) mapeamento pré-definido, 3) NAO_CLASSIFICADO
        conta_dre: mapaDRE.get(d.cd_despesaitem) || MAPEAMENTO_DESPESA_DRE[d.cd_despesaitem] || 'NAO_CLASSIFICADO',
      }));
      setDespesas(despesasCarregadas);
      setDespesasOriginais(JSON.parse(JSON.stringify(despesasCarregadas)));
    } catch (error) {
      console.error('Erro ao buscar despesas:', error);
      alert('Erro ao carregar despesas. Verifique o console.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Filtrar despesas - MEMOIZADO
  // NOTA: Matéria Prima é excluída do "TODAS" pois é tratada separadamente no CMV
  const despesasFiltradas = useMemo(() => {
    const termo = filtro.toLowerCase();
    return despesas.filter(d => {
      const bateTexto = !filtro || d.ds_despesaitem.toLowerCase().includes(termo);
      const categoriaAtual = normalizarCategoriaDFC(d.categoria_dfc);

      // Se estiver em "TODAS", excluir Matéria Prima (tratado no CMV)
      if (filtroCategoriaDFC === 'TODAS') {
        const naoEhMateriaPrima = categoriaAtual !== 'Custos de Matéria Prima';
        return bateTexto && naoEhMateriaPrima;
      }

      const bateCategoria = categoriaAtual === filtroCategoriaDFC;
      return bateTexto && bateCategoria;
    });
  }, [despesas, filtro, filtroCategoriaDFC]);

  const despesasOrdenadas = useMemo(() => {
    return [...despesasFiltradas].sort((a, b) => {
      const pesoA = a.conta_dre === 'NAO_CLASSIFICADO' ? 0 : 1;
      const pesoB = b.conta_dre === 'NAO_CLASSIFICADO' ? 0 : 1;
      if (pesoA !== pesoB) return pesoA - pesoB;
      return a.ds_despesaitem.localeCompare(b.ds_despesaitem);
    });
  }, [despesasFiltradas]);

  // Estatísticas de classificação (excluindo Matéria Prima)
  const estatisticasClassificacao = useMemo(() => {
    // Filtrar despesas que NÃO são de Matéria Prima
    const despesasSemMP = despesas.filter(d => {
      const categoria = normalizarCategoriaDFC(d.categoria_dfc);
      return categoria !== 'Custos de Matéria Prima';
    });

    const total = despesasSemMP.length;
    const classificadas = despesasSemMP.filter(d => d.conta_dre && d.conta_dre !== 'NAO_CLASSIFICADO').length;
    const naoClassificadas = total - classificadas;
    const percentual = total > 0 ? Math.round((classificadas / total) * 100) : 0;

    return { total, classificadas, naoClassificadas, percentual };
  }, [despesas]);

  // Mover despesa para outra conta DRE - CALLBACK
  const moverDespesasPorIds = useCallback((ids: number[], novaConta: string) => {
    setDespesas(prev =>
      prev.map(d =>
        ids.includes(d.cd_despesaitem)
          ? { ...d, conta_dre: novaConta }
          : d
      )
    );
    setAlteracoesPendentes(true);
  }, []);

  const moverDespesa = useCallback((cd_despesaitem: number, novaConta: string) => {
    moverDespesasPorIds([cd_despesaitem], novaConta);
  }, [moverDespesasPorIds]);

  // Toggle expansão de conta
  function toggleExpansao(codigo: string) {
    setContasExpandidas(prev => {
      const novo = new Set(prev);
      if (novo.has(codigo)) {
        novo.delete(codigo);
      } else {
        novo.add(codigo);
      }
      return novo;
    });
  }

  function expandirTodasContas() {
    setContasExpandidas(new Set(codigosExpansiveis));
  }

  function recolherTodasContas() {
    setContasExpandidas(new Set());
  }

  // Selecionar/Desselecionar despesa - CALLBACK
  const toggleSelecao = useCallback((cd_despesaitem: number) => {
    setDespesasSelecionadas(prev => {
      const novoSet = new Set(prev);
      if (novoSet.has(cd_despesaitem)) {
        novoSet.delete(cd_despesaitem);
      } else {
        novoSet.add(cd_despesaitem);
      }
      return novoSet;
    });
  }, []);

  // Mover múltiplas despesas - CALLBACK
  const moverSelecionadas = useCallback((novaConta: string) => {
    moverDespesasPorIds(Array.from(despesasSelecionadas), novaConta);
    setDespesasSelecionadas(new Set());
    setAlteracoesPendentes(true);
  }, [despesasSelecionadas, moverDespesasPorIds]);

  const iniciarDrag = useCallback((id: number) => {
    setDraggedDespesaId(id);
  }, []);

  const finalizarDrag = useCallback(() => {
    setDraggedDespesaId(null);
    setContaHover(null);
  }, []);

  const soltarEmConta = useCallback((codigoConta: string) => {
    if (!draggedDespesaId) return;
    const ids = despesasSelecionadas.has(draggedDespesaId)
      ? Array.from(despesasSelecionadas)
      : [draggedDespesaId];
    moverDespesasPorIds(ids, codigoConta);
    setDespesasSelecionadas(new Set());
    finalizarDrag();
  }, [draggedDespesaId, despesasSelecionadas, moverDespesasPorIds, finalizarDrag]);

  // Salvar alterações
  async function salvarAlteracoes() {
    try {
      setSaving(true);

      // Calcular apenas as alterações reais (despesas que foram modificadas)
      const alteracoes = calcularAlteracoes();

      if (alteracoes.length === 0) {
        alert('Nenhuma alteração para salvar.');
        setSaving(false);
        return;
      }

      // Enviar apenas as despesas que foram alteradas
      const classificacoes = alteracoes.map(a => ({
        cd_despesaitem: a.despesa.cd_despesaitem,
        ds_despesaitem: a.despesa.ds_despesaitem,
        categoria: a.despesa.categoria_dfc,
        conta_dre: a.despesa.conta_dre,
      }));

      console.log(`[SALVAR] Enviando ${classificacoes.length} classificações alteradas:`, classificacoes);

      const response = await fetch('/api/classificacao-despesas-dre', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classificacoes,
          usuario: 'admin',
        }),
      });

      const data = await response.json();
      console.log('[SALVAR] Resposta do servidor:', data);

      if (response.ok && data.success) {
        alert(`${data.salvos} classificações salvas com sucesso!`);
        setAlteracoesPendentes(false);
        // Atualizar despesas originais para refletir o novo estado
        setDespesasOriginais([...despesas]);
      } else {
        const mensagemErro = data?.message || data?.detail || data?.error || 'Erro desconhecido ao salvar';
        alert('Erro ao salvar: ' + mensagemErro);
      }
    } catch (error) {
      console.error('Erro ao salvar:', error);
      alert('Erro ao salvar classificações');
    } finally {
      setSaving(false);
    }
  }

  // Resetar alterações
  function resetarAlteracoes() {
    if (confirm('Descartar todas as alterações não salvas?')) {
      buscarDespesas();
      setAlteracoesPendentes(false);
      setDespesasSelecionadas(new Set());
    }
  }

  // Adicionar nova regra
  function adicionarRegra() {
    if (!novaPalavra.trim()) return;

    if (regras.some(r => r.palavraChave.toUpperCase() === novaPalavra.toUpperCase())) {
      alert('Esta palavra-chave já existe!');
      return;
    }

    setRegras(prev => [...prev, {
      palavraChave: novaPalavra.toUpperCase().trim(),
      contaDre: novaConta
    }]);
    setNovaPalavra('');
  }

  // Remover regra
  function removerRegra(palavraChave: string) {
    setRegras(prev => prev.filter(r => r.palavraChave !== palavraChave));
  }

  // Aplicar UMA regra específica
  function aplicarRegra(regra: RegraClassificacaoDRE) {
    const count = despesas.filter(d =>
      d.ds_despesaitem.toUpperCase().includes(regra.palavraChave.toUpperCase())
    ).length;

    if (count === 0) {
      alert(`Nenhuma despesa encontrada com "${regra.palavraChave}"`);
      return;
    }

    setDespesas(prev =>
      prev.map(d => {
        if (d.ds_despesaitem.toUpperCase().includes(regra.palavraChave.toUpperCase())) {
          return { ...d, conta_dre: regra.contaDre };
        }
        return d;
      })
    );

    setAlteracoesPendentes(true);
    const conta = contasAchatadas.find(c => c.codigo === regra.contaDre);
    alert(`${count} despesa(s) classificada(s) como "${conta?.codigo} - ${conta?.nome}"`);
  }

  // Aplicar TODAS as regras de uma vez
  function aplicarTodasRegras() {
    if (!confirm('Aplicar todas as regras? Isso vai reclassificar várias despesas de uma vez.')) return;

    let totalAlteradas = 0;

    const novasDespesas = despesas.map(d => {
      for (const regra of regras) {
        if (d.ds_despesaitem.toUpperCase().includes(regra.palavraChave.toUpperCase())) {
          if (d.conta_dre !== regra.contaDre) {
            totalAlteradas++;
          }
          return { ...d, conta_dre: regra.contaDre };
        }
      }
      return d;
    });

    if (totalAlteradas > 0) {
      setDespesas(novasDespesas);
      setAlteracoesPendentes(true);
      alert(`${totalAlteradas} despesa(s) reclassificada(s)!`);
    } else {
      alert('Nenhuma despesa foi alterada.');
    }
  }

  // Classificação AUTOMÁTICA via Backend Python (mais inteligente)
  async function classificarAutomaticoBackend() {
    if (!confirm('Executar classificação automática inteligente?\n\nIsso vai analisar TODAS as despesas e classificar automaticamente usando regras do backend Python.\n\nAs classificações serão salvas diretamente no banco de dados.')) return;

    try {
      setSaving(true);
      const response = await fetch('/api/classificacao-despesas-dre/automatica', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sobrescrever: false, // Não sobrescreve já classificadas
          usuario: 'admin_auto'
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        const stats = data.estatisticas;
        alert(
          `Classificação Automática Concluída!\n\n` +
          `Total de despesas: ${stats.total}\n` +
          `Classificadas agora: ${stats.classificadas}\n` +
          `Já tinham classificação: ${stats.ja_tinham}\n` +
          `Não foi possível classificar: ${stats.nao_classificadas}\n` +
          (stats.ignoradas_mp ? `Ignoradas (Matéria Prima/CMV): ${stats.ignoradas_mp}` : '')
        );
        // Recarregar despesas para ver as mudanças
        buscarDespesas();
      } else {
        alert('Erro: ' + (data?.detail || data?.message || 'Erro desconhecido'));
      }
    } catch (error) {
      console.error('Erro na classificação automática:', error);
      alert('Erro ao executar classificação automática');
    } finally {
      setSaving(false);
    }
  }

  // Sincronização com MAPEAMENTO OFICIAL (corrige classificações erradas)
  async function sincronizarComOficial() {
    if (!confirm('Sincronizar com Mapeamento Oficial?\n\nIsso vai:\n1. Analisar TODAS as despesas\n2. Corrigir as que estão classificadas errado\n3. Inserir as que ainda não têm classificação\n\nBaseado no mapeamento oficial usado na DRE.\n\nAs classificações serão salvas diretamente no banco.')) return;

    try {
      setSaving(true);
      const response = await fetch('/api/classificacao-despesas-dre/sincronizar-oficial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (response.ok && data.success) {
        const stats = data.estatisticas;
        let mensagem = `Sincronização Concluída!\n\n`;
        mensagem += `Já estavam corretas: ${stats.ja_corretas}\n`;
        mensagem += `Corrigidas: ${stats.corrigidas}\n`;
        mensagem += `Inseridas (novas): ${stats.inseridas}\n`;
        mensagem += `Sem mapeamento oficial: ${stats.sem_mapeamento}\n`;

        if (data.corrigidas && data.corrigidas.length > 0) {
          mensagem += `\nAlgumas correções:\n`;
          data.corrigidas.slice(0, 5).forEach((c: any) => {
            mensagem += `• ${c.nome}: ${c.de} → ${c.para}\n`;
          });
        }

        alert(mensagem);
        // Recarregar despesas para ver as mudanças
        buscarDespesas();
      } else {
        alert('Erro: ' + (data?.detail || data?.message || 'Erro desconhecido'));
      }
    } catch (error) {
      console.error('Erro na sincronização:', error);
      alert('Erro ao sincronizar classificações');
    } finally {
      setSaving(false);
    }
  }

  // Contar quantas despesas seriam afetadas por uma regra
  function contarAfetadas(palavraChave: string): number {
    return despesas.filter(d =>
      d.ds_despesaitem.toUpperCase().includes(palavraChave.toUpperCase())
    ).length;
  }

  // Calcular alterações pendentes
  function calcularAlteracoes(): { despesa: Despesa; contaAnterior: string }[] {
    const alteracoes: { despesa: Despesa; contaAnterior: string }[] = [];

    despesas.forEach(d => {
      const original = despesasOriginais.find(o => o.cd_despesaitem === d.cd_despesaitem);
      if (original && original.conta_dre !== d.conta_dre) {
        alteracoes.push({
          despesa: d,
          contaAnterior: original.conta_dre
        });
      }
    });

    return alteracoes;
  }

  const alteracoesPendentesLista = alteracoesPendentes ? calcularAlteracoes() : [];

  function contaCorrespondeFiltro(conta: ContaDRE, termo: string): boolean {
    const termoNormalizado = termo.trim().toLowerCase();
    if (!termoNormalizado) return true;

    const atualCorresponde =
      conta.codigo.toLowerCase().includes(termoNormalizado) ||
      conta.nome.toLowerCase().includes(termoNormalizado);

    if (atualCorresponde) return true;

    return Boolean(conta.filhos?.some(filho => contaCorrespondeFiltro(filho, termo)));
  }

  // Renderizar árvore de contas
  function renderizarContaTree(contas: ContaDRE[], nivel: number = 0): React.ReactNode {
    return contas.map(conta => {
      if (!contaCorrespondeFiltro(conta, filtroPlanoContas)) {
        return null;
      }
      const despesasDaConta = despesasFiltradas.filter(d => d.conta_dre === conta.codigo);
      const temFilhos = conta.filhos && conta.filhos.length > 0;
      const expandida = filtroPlanoContas ? true : contasExpandidas.has(conta.codigo);
      const corNivel = CORES_NIVEL[conta.nivel] || 'bg-gray-100';
      const podeReceberDrop = conta.tipo === 'conta';
      const estaEmDropHover = contaHover === conta.codigo;

      return (
        <div key={conta.codigo} className="mb-1">
          {/* Linha da Conta */}
          <div
            className={`flex items-center gap-2 p-1.5 rounded-md border ${corNivel} ${
              temFilhos ? 'cursor-pointer hover:opacity-80' : ''
            } ${podeReceberDrop && modoVisual ? 'transition-all' : ''} ${
              estaEmDropHover ? 'ring-2 ring-sky-400 ring-offset-2' : ''
            }`}
            style={{ marginLeft: `${nivel * 14}px` }}
            onClick={() => temFilhos && toggleExpansao(conta.codigo)}
            onDragOver={(event) => {
              if (!podeReceberDrop || !modoVisual) return;
              event.preventDefault();
              setContaHover(conta.codigo);
            }}
            onDragLeave={() => {
              if (contaHover === conta.codigo) {
                setContaHover(null);
              }
            }}
            onDrop={(event) => {
              if (!podeReceberDrop || !modoVisual) return;
              event.preventDefault();
              soltarEmConta(conta.codigo);
            }}
          >
            {temFilhos ? (
              expandida ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <div className="w-3.5" />
            )}
            <span className="font-mono text-xs font-bold">{conta.codigo}</span>
            <span className="text-xs flex-1 leading-tight">{conta.nome}</span>
            {conta.tipo === 'conta' && (
              <div className="flex items-center gap-2">
                {modoVisual && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    estaEmDropHover ? 'bg-sky-600 text-white' : 'bg-white/80 text-slate-700'
                  }`}>
                    {estaEmDropHover ? 'Solte aqui' : 'Área de drop'}
                  </span>
                )}
                <span className="text-[11px] bg-white px-1.5 py-0.5 rounded">
                  {despesasDaConta.length} itens
                </span>
              </div>
            )}
          </div>

          {/* Filhos expandidos */}
          {temFilhos && expandida && conta.filhos && (
            <div className="ml-4">
              {renderizarContaTree(conta.filhos, nivel + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Carregando despesas...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-6 pt-4 pb-3">
      {/* Header */}
      <div className="max-w-7xl mx-auto mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings className="w-8 h-8 text-green-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-800">
                Configuração do Plano de Contas - DRE
              </h1>
              <p className="text-sm text-gray-600">
                Classifique suas despesas nas contas da DRE
              </p>
            </div>
          </div>

          {/* Estatísticas de Classificação */}
          <div className="flex items-center gap-4">
            <div className="bg-white border rounded-lg px-4 py-2 shadow-sm">
              <div className="flex items-center gap-6">
                <div className="text-center">
                  <p className="text-2xl font-bold text-gray-800">{estatisticasClassificacao.total}</p>
                  <p className="text-xs text-gray-500">Total</p>
                </div>
                <div className="h-10 w-px bg-gray-200"></div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-green-600">{estatisticasClassificacao.classificadas}</p>
                  <p className="text-xs text-gray-500">Classificadas</p>
                </div>
                <div className="h-10 w-px bg-gray-200"></div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-red-500">{estatisticasClassificacao.naoClassificadas}</p>
                  <p className="text-xs text-gray-500">Pendentes</p>
                </div>
                <div className="h-10 w-px bg-gray-200"></div>
                <div className="text-center">
                  <div className="relative w-12 h-12">
                    <svg className="w-12 h-12 transform -rotate-90">
                      <circle cx="24" cy="24" r="20" fill="none" stroke="#e5e7eb" strokeWidth="4" />
                      <circle
                        cx="24" cy="24" r="20" fill="none" stroke="#22c55e" strokeWidth="4"
                        strokeDasharray={`${estatisticasClassificacao.percentual * 1.26} 126`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-700">
                      {estatisticasClassificacao.percentual}%
                    </span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-1 text-center">* Excluindo Matéria Prima (tratado no CMV)</p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={resetarAlteracoes}
                disabled={!alteracoesPendentes || saving}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Resetar
              </button>
              <button
                onClick={salvarAlteracoes}
                disabled={!alteracoesPendentes || saving}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Salvando...' : 'Salvar Layout'}
              </button>
            </div>
          </div>
        </div>

        {alteracoesPendentes && (
          <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-yellow-800">
                <span>Você tem <strong>{alteracoesPendentesLista.length}</strong> alterações não salvas.</span>
              </div>
              <button
                onClick={() => setMostrarPreview(!mostrarPreview)}
                className="text-sm text-yellow-700 hover:text-yellow-900 underline"
              >
                {mostrarPreview ? 'Ocultar Preview' : 'Ver Preview'}
              </button>
            </div>

            {mostrarPreview && alteracoesPendentesLista.length > 0 && (
              <div className="mt-4 bg-white rounded border border-yellow-300 p-4 max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="text-left p-2">Despesa</th>
                      <th className="text-left p-2">De</th>
                      <th className="text-left p-2">Para</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alteracoesPendentesLista.slice(0, 50).map(a => (
                      <tr key={a.despesa.cd_despesaitem} className="border-b">
                        <td className="p-2 truncate max-w-xs">{a.despesa.ds_despesaitem}</td>
                        <td className="p-2 font-mono text-xs">{a.contaAnterior}</td>
                        <td className="p-2 font-mono text-xs">{a.despesa.conta_dre}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Botão para classificação em lote */}
        <div className="mt-4">
          <button
            onClick={() => setMostrarRegras(!mostrarRegras)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition"
          >
            <Zap className="w-4 h-4" />
            {mostrarRegras ? 'Ocultar' : 'Classificação em Lote'}
            <span className="bg-purple-500 px-2 py-0.5 rounded text-xs">{regras.length} regras</span>
          </button>
        </div>

        {/* Painel de Regras */}
        {mostrarRegras && (
          <div className="mt-4 bg-purple-50 border-2 border-purple-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-purple-600" />
                <h3 className="font-semibold text-purple-800">Classificação Rápida por Palavra-Chave</h3>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={sincronizarComOficial}
                  disabled={saving}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                  title="Sincroniza com o mapeamento oficial - corrige classificações erradas e insere as que faltam"
                >
                  <RotateCcw className="w-4 h-4" />
                  Sincronizar c/ Oficial
                </button>
                <button
                  onClick={classificarAutomaticoBackend}
                  disabled={saving}
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                  title="Classificação inteligente via Python - analisa todos os nomes e classifica automaticamente"
                >
                  <Zap className="w-4 h-4" />
                  Classificar Automático
                </button>
                <button
                  onClick={aplicarTodasRegras}
                  className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 flex items-center gap-2"
                >
                  <Zap className="w-4 h-4" />
                  Aplicar Regras
                </button>
              </div>
            </div>

            {/* Adicionar nova regra */}
            <div className="flex gap-2 mb-4 p-3 bg-white rounded border border-purple-200 items-end">
              <div className="flex-1">
                <label className="block text-xs text-gray-600 mb-1">Palavra-chave</label>
                <input
                  type="text"
                  placeholder="Digite a palavra-chave"
                  value={novaPalavra}
                  onChange={(e) => setNovaPalavra(e.target.value.toUpperCase())}
                  onKeyPress={(e) => e.key === 'Enter' && adicionarRegra()}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div className="min-w-[350px]">
                <label className="block text-xs text-gray-600 mb-1">Conta DRE</label>
                <SearchableSelect
                  value={novaConta}
                  onChange={(value) => setNovaConta(value)}
                  options={contasAchatadas}
                  optionsMap={contasMap}
                  placeholder="Selecione uma conta..."
                />
              </div>
              <button
                onClick={adicionarRegra}
                disabled={!novaPalavra.trim()}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                Adicionar
              </button>
            </div>

            {/* Lista de regras */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
              {regras.map(regra => {
                const conta = contasAchatadas.find(c => c.codigo === regra.contaDre);
                const afetadas = contarAfetadas(regra.palavraChave);

                return (
                  <div
                    key={regra.palavraChave}
                    className="flex items-center justify-between p-2 rounded border bg-white group"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="font-mono font-bold text-sm">{regra.palavraChave}</span>
                      <span className="text-xs text-gray-500 ml-2">({afetadas})</span>
                      <span className="text-xs text-gray-600 block truncate">{conta?.codigo} - {conta?.nome}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => aplicarRegra(regra)}
                        className="px-2 py-1 text-xs bg-purple-100 rounded hover:bg-purple-200 border"
                      >
                        Aplicar
                      </button>
                      <button
                        onClick={() => removerRegra(regra.palavraChave)}
                        className="p-1 text-red-500 hover:bg-red-100 rounded opacity-0 group-hover:opacity-100 transition"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Filtro */}
        <div className="mt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Filtrar despesas por nome..."
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
            className="w-full pl-10 pr-4 py-3 text-base border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {categoriasDFC.map(categoria => {
            const ehMateriaPrima = categoria === 'Custos de Matéria Prima';
            return (
              <button
                key={categoria}
                onClick={() => setFiltroCategoriaDFC(categoria)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  filtroCategoriaDFC === categoria
                    ? ehMateriaPrima ? 'bg-orange-500 text-white' : 'bg-sky-600 text-white'
                    : ehMateriaPrima
                      ? 'bg-orange-50 border border-orange-300 text-orange-600 hover:border-orange-400'
                      : 'bg-white border border-gray-300 text-gray-700 hover:border-sky-300 hover:text-sky-700'
                }`}
                title={ehMateriaPrima ? 'Matéria Prima - tratado separadamente no CMV' : ''}
              >
                {categoria === 'TODAS'
                  ? `Todas ${contagemCategoriasDFC.TODAS}`
                  : ehMateriaPrima
                    ? `MP (CMV) ${contagemCategoriasDFC[categoria]}`
                    : `${categoria}${contagemCategoriasDFC[categoria]}`}
              </button>
            );
          })}
        </div>
        {filtro && (
          <p className="text-sm text-gray-600 mt-2">
            Mostrando {despesasFiltradas.length} de {despesas.length} despesas
          </p>
        )}
        {filtroCategoriaDFC !== 'TODAS' && (
          <p className="text-sm text-gray-600 mt-2">
            Filtro DFC ativo: <strong>{filtroCategoriaDFC}</strong>
          </p>
        )}
          {modoVisual && (
            <p className="text-sm text-slate-600 mt-2">
              Arraste uma despesa da lista e solte em uma conta final do plano. Se houver itens selecionados, o drop move o lote.
            </p>
          )}
        </div>

        {/* Seleção em massa */}
        {despesasSelecionadas.size > 0 && (
          <div className="mt-4 bg-blue-50 border border-blue-200 rounded p-4">
            <p className="text-sm font-medium text-blue-800 mb-2">
              {despesasSelecionadas.size} despesa(s) selecionada(s). Mover para:
            </p>
            <SearchableSelect
              value=""
              onChange={(value) => {
                if (value && value !== 'NAO_CLASSIFICADO') {
                  moverSelecionadas(value);
                }
              }}
              options={contasAchatadas}
              optionsMap={contasMap}
              placeholder="Selecione uma conta..."
              className="w-full"
            />
          </div>
        )}
      </div>



      {/* Layout principal */}
      <div className="max-w-[1900px] mx-auto grid grid-cols-1 xl:grid-cols-[1fr_1.55fr] gap-5">
        {/* Coluna da Esquerda - Plano de Contas */}
        <div className="bg-white rounded-xl shadow-lg border-2 border-gray-200 p-5">
          <div className="mb-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="text-lg font-semibold text-gray-800">
                Plano de Contas DRE
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={expandirTodasContas}
                  className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:border-sky-300 hover:text-sky-700"
                >
                  Expandir Tudo
                </button>
                <button
                  onClick={recolherTodasContas}
                  className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:border-sky-300 hover:text-sky-700"
                >
                  Recolher Tudo
                </button>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Pesquisar conta ou cÃ³digo..."
                value={filtroPlanoContas}
                onChange={(e) => setFiltroPlanoContas(e.target.value)}
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-green-500 focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
            {renderizarContaTree(PLANO_CONTAS_DRE)}
          </div>
        </div>

        {/* Coluna da Direita - Lista de Despesas */}
        <div className="bg-white rounded-xl shadow-lg border-2 border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
            <h2 className="text-lg font-semibold text-gray-800">
              Despesas ({despesasFiltradas.length})
            </h2>
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
            {despesasFiltradas.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-gray-500">Nenhuma despesa encontrada</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {despesasOrdenadas.map(despesa => (
                  <DespesaItem
                    key={despesa.cd_despesaitem}
                    despesa={despesa}
                    isSelected={despesasSelecionadas.has(despesa.cd_despesaitem)}
                    onToggleSelecao={toggleSelecao}
                    onMoverDespesa={moverDespesa}
                    contasAchatadas={contasAchatadas}
                    contasMap={contasMap}
                    modoVisual={modoVisual}
                    onDragStart={iniciarDrag}
                    onDragEnd={finalizarDrag}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// export { PLANO_CONTAS_DRE }; // Commented out - não pode exportar em Next.js pages
