import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cdFornecedor = searchParams.get('cdFornecedor');
    const cdDespesaItemAtual = searchParams.get('cdDespesaItemAtual');

    if (!cdFornecedor || !cdDespesaItemAtual) {
      return NextResponse.json(
        { error: 'Parametros cdFornecedor e cdDespesaItemAtual sao obrigatorios' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${PYTHON_API_URL}/api/dre/auditoria/fornecedor-despesa?cdFornecedor=${cdFornecedor}&cdDespesaItemAtual=${cdDespesaItemAtual}`,
      {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar auditoria fornecedor-despesa:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar auditoria fornecedor-despesa' },
      { status: 500 }
    );
  }
}
