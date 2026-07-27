import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dataInicio = searchParams.get('dataInicio') || '2026-01-01';
    const dataFim = searchParams.get('dataFim') || '2026-12-31';
    const filtro = searchParams.get('filtro') || 'consolidado';

    const params = new URLSearchParams({
      dataInicio,
      dataFim,
      filtro,
      t: String(Date.now()),
    });

    const response = await fetch(
      `${PYTHON_API_URL}/api/dre/unificada/sintetico?${params.toString()}`,
      {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      }
    );

    const data = await response.json();
    return NextResponse.json(data, {
      status: response.status,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    });
  } catch (error) {
    console.error('Erro ao buscar DRE Sintetico:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar DRE Sintetico' },
      { status: 500 }
    );
  }
}
