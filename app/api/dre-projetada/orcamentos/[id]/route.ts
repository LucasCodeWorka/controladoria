import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

type Ctx = { params: { id: string } };

async function repassar(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, { ...init, cache: 'no-store' });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro no orçamento da DRE:', error);
    return NextResponse.json({ error: 'Erro ao processar o orçamento' }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  return repassar(`${PYTHON_API_URL}/api/dre-projetada/orcamentos/${encodeURIComponent(params.id)}`, { method: 'GET' });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  return repassar(`${PYTHON_API_URL}/api/dre-projetada/orcamentos/${encodeURIComponent(params.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  return repassar(`${PYTHON_API_URL}/api/dre-projetada/orcamentos/${encodeURIComponent(params.id)}`, { method: 'DELETE' });
}
