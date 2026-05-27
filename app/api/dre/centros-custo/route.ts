import { NextRequest, NextResponse } from 'next/server';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/dre/centros-custo`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar centros de custo:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar centros de custo' },
      { status: 500 }
    );
  }
}
