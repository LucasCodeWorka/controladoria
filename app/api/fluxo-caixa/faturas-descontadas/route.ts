import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(_request: NextRequest) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/fluxo-caixa/faturas-descontadas`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar faturas descontadas do fluxo de caixa:', error);
    return NextResponse.json({ error: 'Erro ao buscar faturas descontadas do fluxo de caixa' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const response = await fetch(`${PYTHON_API_URL}/api/fluxo-caixa/faturas-descontadas`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao salvar faturas descontadas do fluxo de caixa:', error);
    return NextResponse.json({ error: 'Erro ao salvar faturas descontadas do fluxo de caixa' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/fluxo-caixa/faturas-descontadas`, {
      method: 'DELETE',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao remover faturas descontadas do fluxo de caixa:', error);
    return NextResponse.json({ error: 'Erro ao remover faturas descontadas do fluxo de caixa' }, { status: 500 });
  }
}
