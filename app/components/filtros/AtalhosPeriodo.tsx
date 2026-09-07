'use client';

// Atalhos de periodo padrao - mesmos 7 botoes, mesma ordem, mesmo estilo em
// TODAS as telas com filtro de data (DRE, DFC, DRE x DFC, CMV Detalhado).
// Antes cada tela reimplementava isso na mao e ia divergindo (cores, ordem,
// atalhos faltando) - agora e um componente so, usado em todo lugar.

export function definirMesAnterior(): { dataInicio: string; dataFim: string } {
  const hoje = new Date();
  const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
  return {
    dataInicio: `${inicioMesAnterior.getFullYear()}-${String(inicioMesAnterior.getMonth() + 1).padStart(2, '0')}-01`,
    dataFim: `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`,
  };
}

export function definirMesAtual(): { dataInicio: string; dataFim: string } {
  const hoje = new Date();
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  return {
    dataInicio: `${inicioMes.getFullYear()}-${String(inicioMes.getMonth() + 1).padStart(2, '0')}-01`,
    dataFim: `${fimMes.getFullYear()}-${String(fimMes.getMonth() + 1).padStart(2, '0')}-${String(fimMes.getDate()).padStart(2, '0')}`,
  };
}

export function definirUltimosMeses(qtdMeses: number): { dataInicio: string; dataFim: string } {
  const hoje = new Date();
  const fimMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
  const inicioIntervalo = new Date(hoje.getFullYear(), hoje.getMonth() - qtdMeses, 1);
  return {
    dataInicio: `${inicioIntervalo.getFullYear()}-${String(inicioIntervalo.getMonth() + 1).padStart(2, '0')}-01`,
    dataFim: `${fimMesAnterior.getFullYear()}-${String(fimMesAnterior.getMonth() + 1).padStart(2, '0')}-${String(fimMesAnterior.getDate()).padStart(2, '0')}`,
  };
}

export function definirAnoAtual(): { dataInicio: string; dataFim: string } {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const fimMesAnterior = new Date(anoAtual, hoje.getMonth(), 0);
  // Em janeiro nao ha mes anterior dentro do ano atual; mostra o mes corrente
  const dataFimAnoAtual =
    fimMesAnterior.getFullYear() === anoAtual ? fimMesAnterior : new Date(anoAtual, hoje.getMonth() + 1, 0);
  return {
    dataInicio: `${anoAtual}-01-01`,
    dataFim: `${dataFimAnoAtual.getFullYear()}-${String(dataFimAnoAtual.getMonth() + 1).padStart(2, '0')}-${String(dataFimAnoAtual.getDate()).padStart(2, '0')}`,
  };
}

export function definirAnoAnterior(): { dataInicio: string; dataFim: string } {
  return { dataInicio: '2025-01-01', dataFim: '2025-12-31' };
}

interface AtalhosPeriodoProps {
  onSelecionar: (periodo: { dataInicio: string; dataFim: string }) => void;
}

export default function AtalhosPeriodo({ onSelecionar }: AtalhosPeriodoProps) {
  const classeBotao = 'px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors';
  return (
    <>
      <button onClick={() => onSelecionar(definirMesAnterior())} className={classeBotao}>
        Mês Anterior
      </button>
      <button onClick={() => onSelecionar(definirMesAtual())} className={classeBotao}>
        Mês Atual
      </button>
      <button onClick={() => onSelecionar(definirUltimosMeses(3))} className={classeBotao}>
        Últimos 3 Meses
      </button>
      <button onClick={() => onSelecionar(definirUltimosMeses(6))} className={classeBotao}>
        Últimos 6 Meses
      </button>
      <button onClick={() => onSelecionar(definirUltimosMeses(12))} className={classeBotao}>
        Últimos 12 Meses
      </button>
      <button onClick={() => onSelecionar(definirAnoAtual())} className={classeBotao}>
        Ano Atual
      </button>
      <button onClick={() => onSelecionar(definirAnoAnterior())} className={classeBotao}>
        2025
      </button>
    </>
  );
}
