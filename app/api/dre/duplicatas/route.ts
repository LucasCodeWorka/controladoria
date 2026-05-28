import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const conta = searchParams.get('conta') || '';
    const periodo = searchParams.get('periodo') || '';

    const response = await fetch(
      `${PYTHON_API_URL}/api/dre/duplicatas?conta=${encodeURIComponent(conta)}&periodo=${periodo}`,
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
    console.error('Erro ao buscar duplicatas DRE:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar duplicatas da DRE' },
      { status: 500 }
    );
  }
}
