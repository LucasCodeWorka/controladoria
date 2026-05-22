import { NextRequest, NextResponse } from 'next/server';

// Em dev: Python backend local (porta 8000)
// Em prod: Vercel serverless functions
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dataInicio = searchParams.get('dataInicio') || '2026-01-01';
    const dataFim = searchParams.get('dataFim') || '2026-12-31';

    const response = await fetch(
      `${PYTHON_API_URL}/api/dre?dataInicio=${dataInicio}&dataFim=${dataFim}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Erro ao buscar dados DRE:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar dados da DRE' },
      { status: 500 }
    );
  }
}
