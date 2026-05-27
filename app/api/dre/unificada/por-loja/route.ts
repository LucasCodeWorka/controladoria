import { NextRequest, NextResponse } from 'next/server';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dataInicio = searchParams.get('dataInicio') || '2026-01-01';
    const dataFim = searchParams.get('dataFim') || '2026-12-31';
    const lojas = searchParams.get('lojas') || '';

    const url = `${PYTHON_API_URL}/api/dre/unificada/por-loja?dataInicio=${dataInicio}&dataFim=${dataFim}&lojas=${lojas}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar DRE Por Loja:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar DRE Por Loja' },
      { status: 500 }
    );
  }
}
