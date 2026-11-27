import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';
const ACOES = new Set(['status', 'opcoes', 'resumo', 'balancos', 'produtos-criticos', 'itens', 'sincronizar']);

async function repassar(request: NextRequest, acao: string, metodo: 'GET' | 'POST') {
  if (!ACOES.has(acao)) return NextResponse.json({ error: 'Ação inválida' }, { status: 404 });
  try {
    const query = request.nextUrl.search;
    const response = await fetch(`${PYTHON_API_URL}/api/balanco-lojas/${acao}${query}`, {
      method: metodo,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error(`Erro em balanco-lojas/${acao}:`, error);
    return NextResponse.json({ error: 'Erro ao consultar os balanços das lojas' }, { status: 500 });
  }
}

export async function GET(request: NextRequest, { params }: { params: { acao: string } }) {
  return repassar(request, params.acao, 'GET');
}

export async function POST(request: NextRequest, { params }: { params: { acao: string } }) {
  return repassar(request, params.acao, 'POST');
}
