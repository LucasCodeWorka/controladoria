import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dimensao = searchParams.get('dimensao');
    const mesReferencia = searchParams.get('mesReferencia');
    const empresas = searchParams.get('empresas');
    const params = new URLSearchParams();
    if (dimensao) params.set('dimensao', dimensao);
    if (mesReferencia) params.set('mesReferencia', mesReferencia);
    if (empresas) params.set('empresas', empresas);

    const response = await fetch(`${PYTHON_API_URL}/api/giro/por-dimensao?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar giro por dimensão:', error);
    return NextResponse.json({ error: 'Erro ao buscar giro por dimensão' }, { status: 500 });
  }
}
