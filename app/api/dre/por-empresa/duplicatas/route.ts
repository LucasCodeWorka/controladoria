import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const conta = searchParams.get('conta') || '';
    const dataInicio = searchParams.get('dataInicio') || '2026-01-01';
    const dataFim = searchParams.get('dataFim') || '2026-12-31';
    const cdEmpresa = searchParams.get('cdEmpresa') || '';

    const url = `${PYTHON_API_URL}/api/dre/por-empresa/duplicatas?conta=${conta}&dataInicio=${dataInicio}&dataFim=${dataFim}&cdEmpresa=${cdEmpresa}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar duplicatas por empresa:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar duplicatas por empresa' },
      { status: 500 }
    );
  }
}
