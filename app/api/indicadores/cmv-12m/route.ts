import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const fim = request.nextUrl.searchParams.get('fim') || '';
    const response = await fetch(`${PYTHON_API_URL}/api/indicadores/cmv-12m?fim=${encodeURIComponent(fim)}`, {
      cache: 'no-store',
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar CMV 12m:', error);
    return NextResponse.json({ error: 'Erro ao buscar CMV 12 meses' }, { status: 500 });
  }
}
