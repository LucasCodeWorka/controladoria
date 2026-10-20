import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const params = new URLSearchParams();
    for (const nome of ['dtInicio', 'dtFim', 'empresas']) {
      const valor = searchParams.get(nome);
      if (valor) params.set(nome, valor);
    }

    const response = await fetch(`${PYTHON_API_URL}/api/fluxo-caixa/boleto-por-banco?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar boletos por banco do fluxo de caixa:', error);
    return NextResponse.json({ error: 'Erro ao buscar boletos por banco' }, { status: 500 });
  }
}
