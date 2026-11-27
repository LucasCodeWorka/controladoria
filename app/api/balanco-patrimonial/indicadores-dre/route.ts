import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams;
    const mesReferencia = sp.get('mesReferencia') || '';
    const forcar = sp.get('forcar') === 'true' ? '&forcar=true' : '';
    const response = await fetch(
      `${PYTHON_API_URL}/api/balanco-patrimonial/indicadores-dre?mesReferencia=${encodeURIComponent(mesReferencia)}${forcar}`,
      { method: 'GET', cache: 'no-store' }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar indicadores da DRE para o balanço:', error);
    return NextResponse.json({ error: 'Erro ao buscar indicadores da DRE' }, { status: 500 });
  }
}
