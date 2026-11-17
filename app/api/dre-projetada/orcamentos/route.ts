import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET() {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/dre-projetada/orcamentos`, { method: 'GET', cache: 'no-store' });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao listar orçamentos da DRE:', error);
    return NextResponse.json({ error: 'Erro ao listar orçamentos' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const response = await fetch(`${PYTHON_API_URL}/api/dre-projetada/orcamentos`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao salvar orçamento da DRE:', error);
    return NextResponse.json({ error: 'Erro ao salvar orçamento' }, { status: 500 });
  }
}
