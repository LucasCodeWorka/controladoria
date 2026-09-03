import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cdEmpresa = searchParams.get('cdEmpresa') || '';
    const dataInicio = searchParams.get('dataInicio') || '';
    const dataFim = searchParams.get('dataFim') || '';
    const params = new URLSearchParams({ cdEmpresa, dataInicio, dataFim });

    const response = await fetch(`${PYTHON_API_URL}/api/cmv-detalhado/transacoes-resumo?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar transacoes-resumo do CMV detalhado:', error);
    return NextResponse.json({ error: 'Erro ao buscar transacoes-resumo do CMV detalhado' }, { status: 500 });
  }
}
