import { NextResponse } from 'next/server';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET() {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/indicadores/lucro-liq-pct`, { cache: 'no-store' });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Erro ao buscar Lucro Liquido %:', error);
    return NextResponse.json({ error: 'Erro ao buscar Lucro Liquido %' }, { status: 500 });
  }
}
