import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mesReferencia = searchParams.get('mesReferencia');
    const empresas = searchParams.get('empresas');
    const params = new URLSearchParams();
    if (mesReferencia) params.set('mesReferencia', mesReferencia);
    if (empresas) params.set('empresas', empresas);

    const response = await fetch(`${PYTHON_API_URL}/api/giro/recalcular?${params.toString()}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao recalcular giro:', error);
    return NextResponse.json({ error: 'Erro ao recalcular giro' }, { status: 500 });
  }
}
