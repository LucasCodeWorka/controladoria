import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

async function repassar(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, { ...init, cache: 'no-store' });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro nas referências enviadas para 70%:', error);
    return NextResponse.json({ error: 'Erro ao processar as referências enviadas para 70%' }, { status: 500 });
  }
}

export async function GET() {
  return repassar(`${PYTHON_API_URL}/api/giro/enviadas-70`, { method: 'GET' });
}

export async function POST(request: NextRequest) {
  return repassar(`${PYTHON_API_URL}/api/giro/enviadas-70`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  });
}

export async function DELETE(request: NextRequest) {
  const { search } = new URL(request.url);
  return repassar(`${PYTHON_API_URL}/api/giro/enviadas-70${search}`, { method: 'DELETE' });
}
