import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cdEmpresa = searchParams.get('cdEmpresa') || '';
    const nrTransacao = searchParams.get('nrTransacao') || '';
    const params = new URLSearchParams({ cdEmpresa, nrTransacao });

    const response = await fetch(`${PYTHON_API_URL}/api/cmv-detalhado/transacao-itens?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar itens da transação do CMV detalhado:', error);
    return NextResponse.json({ error: 'Erro ao buscar itens da transação do CMV detalhado' }, { status: 500 });
  }
}
