import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { nrFat: string; nrParcela: string } }
) {
  try {
    const response = await fetch(
      `${PYTHON_API_URL}/api/fluxo-caixa/faturas-descontadas/${params.nrFat}/${params.nrParcela}`,
      { method: 'DELETE', cache: 'no-store', headers: { 'Content-Type': 'application/json' } }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao remover fatura descontada do fluxo de caixa:', error);
    return NextResponse.json({ error: 'Erro ao remover fatura descontada do fluxo de caixa' }, { status: 500 });
  }
}
