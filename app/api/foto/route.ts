import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ref = searchParams.get('ref');
    if (!ref) {
      return NextResponse.json({ error: "Parâmetro 'ref' é obrigatório" }, { status: 400 });
    }
    const params = new URLSearchParams({ ref });

    const response = await fetch(`${PYTHON_API_URL}/api/foto?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar foto do produto:', error);
    return NextResponse.json({ error: 'Erro ao buscar foto do produto' }, { status: 500 });
  }
}
