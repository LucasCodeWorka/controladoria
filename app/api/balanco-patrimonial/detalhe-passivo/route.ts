import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const conta = new URL(request.url).searchParams.get('conta') || '';
    const response = await fetch(
      `${PYTHON_API_URL}/api/balanco-patrimonial/detalhe-passivo?conta=${encodeURIComponent(conta)}`,
      { method: 'GET', cache: 'no-store' }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar detalhe do passivo:', error);
    return NextResponse.json({ error: 'Erro ao buscar detalhe do passivo' }, { status: 500 });
  }
}
