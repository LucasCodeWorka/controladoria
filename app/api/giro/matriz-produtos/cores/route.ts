import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const referencia = searchParams.get('referencia');
    const mesReferencia = searchParams.get('mesReferencia');
    const empresas = searchParams.get('empresas');
    const status = searchParams.get('status');
    const giroMinimo = searchParams.get('giroMinimo');
    const mesesFLMinimo = searchParams.get('mesesFLMinimo');
    const oportunidadeDesconto = searchParams.get('oportunidadeDesconto');
    const params = new URLSearchParams();
    if (referencia) params.set('referencia', referencia);
    if (mesReferencia) params.set('mesReferencia', mesReferencia);
    if (empresas) params.set('empresas', empresas);
    if (status) params.set('status', status);
    if (giroMinimo) params.set('giroMinimo', giroMinimo);
    if (mesesFLMinimo) params.set('mesesFLMinimo', mesesFLMinimo);
    if (oportunidadeDesconto) params.set('oportunidadeDesconto', oportunidadeDesconto);

    const response = await fetch(`${PYTHON_API_URL}/api/giro/matriz-produtos/cores?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar matriz de giro por cor:', error);
    return NextResponse.json({ error: 'Erro ao buscar matriz de giro por cor' }, { status: 500 });
  }
}
