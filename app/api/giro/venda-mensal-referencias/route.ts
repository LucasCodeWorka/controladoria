import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const referencias = searchParams.get('referencias');
    const empresas = searchParams.get('empresas');
    const mesReferencia = searchParams.get('mesReferencia');
    const status = searchParams.get('status');
    const params = new URLSearchParams();
    if (referencias) params.set('referencias', referencias);
    if (empresas) params.set('empresas', empresas);
    if (mesReferencia) params.set('mesReferencia', mesReferencia);
    if (status) params.set('status', status);

    const response = await fetch(`${PYTHON_API_URL}/api/giro/venda-mensal-referencias?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar venda mensal por referência:', error);
    return NextResponse.json({ error: 'Erro ao buscar venda mensal por referência' }, { status: 500 });
  }
}
