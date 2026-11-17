import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

type Ctx = { params: { path: string[] } };

// Repassa /api/endividamento/* para o backend (contratos, simulacao, painel, metas, sincronizacao).
async function repassar(request: NextRequest, { params }: Ctx, metodo: string) {
  try {
    const url = new URL(request.url);
    const alvo = `${PYTHON_API_URL}/api/endividamento/${params.path.map(encodeURIComponent).join('/')}${url.search}`;
    const init: RequestInit = { method: metodo, cache: 'no-store' };
    if (metodo === 'POST' || metodo === 'PUT') {
      init.headers = { 'Content-Type': 'application/json' };
      const corpo = await request.text();
      if (corpo) init.body = corpo;
    }
    const response = await fetch(alvo, init);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro no endividamento:', error);
    return NextResponse.json({ error: 'Erro ao processar o endividamento' }, { status: 500 });
  }
}

export const GET = (r: NextRequest, c: Ctx) => repassar(r, c, 'GET');
export const POST = (r: NextRequest, c: Ctx) => repassar(r, c, 'POST');
export const PUT = (r: NextRequest, c: Ctx) => repassar(r, c, 'PUT');
export const DELETE = (r: NextRequest, c: Ctx) => repassar(r, c, 'DELETE');
