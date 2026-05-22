import { NextRequest, NextResponse } from 'next/server';

// Em dev: Python backend local (porta 8000)
// Em prod: Vercel serverless functions
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/classificacao-despesas-dre`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar classificações DRE:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar classificações de despesas DRE' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await fetch(`${PYTHON_API_URL}/api/classificacao-despesas-dre`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao salvar classificações DRE:', error);
    return NextResponse.json(
      { error: 'Erro ao salvar classificações de despesas DRE' },
      { status: 500 }
    );
  }
}
