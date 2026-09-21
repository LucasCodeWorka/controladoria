import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest, { params }: { params: { jobId: string } }) {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/dre/analisador-loja/status/${params.jobId}`, {
      method: 'GET',
      cache: 'no-store',
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao consultar status da analise do analisador de DRE:', error);
    return NextResponse.json(
      { error: 'Erro ao consultar o status da análise' },
      { status: 500 }
    );
  }
}
