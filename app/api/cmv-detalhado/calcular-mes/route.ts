import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const anoMes = searchParams.get('anoMes');
    if (!anoMes) {
      return NextResponse.json({ error: 'anoMes obrigatório' }, { status: 400 });
    }
    const params = new URLSearchParams({ anoMes });

    const response = await fetch(`${PYTHON_API_URL}/api/cmv-detalhado/calcular-mes?${params.toString()}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao calcular cache do CMV detalhado:', error);
    return NextResponse.json({ error: 'Erro ao calcular cache do CMV detalhado' }, { status: 500 });
  }
}
