import { NextRequest, NextResponse } from 'next/server';

// Em dev: Python backend local (porta 8000)
// Em prod: Vercel serverless functions
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function POST(request: NextRequest) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/classificacao-despesas-dre/sincronizar-oficial`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao sincronizar classificações DRE:', error);
    return NextResponse.json(
      { error: 'Erro ao sincronizar classificações de despesas DRE' },
      { status: 500 }
    );
  }
}
