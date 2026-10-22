import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/fluxo-caixa/cenarios/${encodeURIComponent(params.id)}`, {
      method: 'DELETE',
      cache: 'no-store',
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao excluir cenário do fluxo de caixa:', error);
    return NextResponse.json({ error: 'Erro ao excluir cenário' }, { status: 500 });
  }
}
