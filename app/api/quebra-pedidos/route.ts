import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const params = new URLSearchParams();
    for (const chave of ['dataInicio', 'dataFim', 'somenteQuebra', 'motivos', 'ate10']) {
      const valor = searchParams.get(chave);
      if (valor) params.set(chave, valor);
    }
    const response = await fetch(`${PYTHON_API_URL}/api/quebra-pedidos?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar quebra de pedidos:', error);
    return NextResponse.json({ error: 'Erro ao buscar quebra de pedidos' }, { status: 500 });
  }
}
