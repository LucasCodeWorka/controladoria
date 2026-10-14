import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dtInicio = searchParams.get('dt_inicio');
    const dtFim = searchParams.get('dt_fim');
    const empresas = searchParams.get('empresas');

    const params = new URLSearchParams();
    if (dtInicio) params.set('dt_inicio', dtInicio);
    if (dtFim) params.set('dt_fim', dtFim);
    if (empresas) params.set('empresas', empresas);

    const response = await fetch(`${PYTHON_API_URL}/api/fluxo-caixa/saidas-por-fornecedor?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar saídas por fornecedor:', error);
    return NextResponse.json({ error: 'Erro ao buscar saídas por fornecedor' }, { status: 500 });
  }
}
