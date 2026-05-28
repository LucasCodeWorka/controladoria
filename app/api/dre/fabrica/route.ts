import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dataInicio = searchParams.get('dataInicio') || '2026-01-01';
    const dataFim = searchParams.get('dataFim') || '2026-12-31';

    const response = await fetch(
      `${PYTHON_API_URL}/api/dre/fabrica?dataInicio=${dataInicio}&dataFim=${dataFim}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar dados DRE Fabrica:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar dados da DRE Fabrica' },
      { status: 500 }
    );
  }
}
