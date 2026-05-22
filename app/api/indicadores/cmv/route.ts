import { NextRequest, NextResponse } from 'next/server';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mesReferencia = searchParams.get('mesReferencia') || '';

    const response = await fetch(
      `${PYTHON_API_URL}/api/indicadores/cmv?mesReferencia=${mesReferencia}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } }
    );

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Erro ao buscar CMV:', error);
    return NextResponse.json({ error: 'Erro ao buscar dados de CMV' }, { status: 500 });
  }
}
