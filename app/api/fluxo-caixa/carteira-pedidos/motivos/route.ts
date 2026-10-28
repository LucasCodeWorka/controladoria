import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const grupo = new URL(request.url).searchParams.get('grupo') || '';
    const response = await fetch(`${PYTHON_API_URL}/api/fluxo-caixa/carteira-pedidos/motivos?grupo=${encodeURIComponent(grupo)}`, {
      method: 'GET',
      cache: 'no-store',
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar carteira por motivo do fluxo de caixa:', error);
    return NextResponse.json({ error: 'Erro ao buscar carteira por motivo' }, { status: 500 });
  }
}
