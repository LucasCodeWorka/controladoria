import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

// Calculo pesado (item a item de uma loja/mes, direto das views de origem) -
// pode levar alguns minutos na primeira vez. Sem timeout curto aqui de
// proposito.
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cdEmpresa = searchParams.get('cdEmpresa') || '';
    const anoMes = searchParams.get('anoMes') || '';
    const params = new URLSearchParams({ cdEmpresa, anoMes });

    const response = await fetch(`${PYTHON_API_URL}/api/cmv-detalhado/calcular?${params.toString()}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao calcular CMV detalhado:', error);
    return NextResponse.json({ error: 'Erro ao calcular CMV detalhado' }, { status: 500 });
  }
}
