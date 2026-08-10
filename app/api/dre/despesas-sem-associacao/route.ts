import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dataInicio = searchParams.get('dataInicio');
    const dataFim = searchParams.get('dataFim');
    const filtro = searchParams.get('filtro') || 'consolidado';

    if (!dataInicio || !dataFim) {
      return NextResponse.json(
        { error: 'Parametros dataInicio e dataFim sao obrigatorios' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${PYTHON_API_URL}/api/dre/despesas-sem-associacao?dataInicio=${dataInicio}&dataFim=${dataFim}&filtro=${filtro}`,
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
    console.error('Erro ao buscar despesas sem associacao:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar despesas sem associação' },
      { status: 500 }
    );
  }
}
