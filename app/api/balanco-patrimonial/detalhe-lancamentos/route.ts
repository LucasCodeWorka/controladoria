import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;
    const query = new URLSearchParams();
    for (const k of ['conta', 'empresas', 'mesReferencia']) {
      const v = params.get(k);
      if (v) query.set(k, v);
    }
    const response = await fetch(`${PYTHON_API_URL}/api/balanco-patrimonial/detalhe-lancamentos?${query.toString()}`, { method: 'GET', cache: 'no-store' });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar detalhe de lançamentos:', error);
    return NextResponse.json({ error: 'Erro ao buscar detalhe de lançamentos' }, { status: 500 });
  }
}
