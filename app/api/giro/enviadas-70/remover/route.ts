import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function POST(request: NextRequest) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/giro/enviadas-70/remover`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: await request.text(),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao desmarcar referências enviadas para 70%:', error);
    return NextResponse.json({ error: 'Erro ao desmarcar' }, { status: 500 });
  }
}
