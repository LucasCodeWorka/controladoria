import { NextRequest, NextResponse } from 'next/server';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const conta = searchParams.get('conta') || '';
    const periodo = searchParams.get('periodo') || '';
    const filtro = searchParams.get('filtro') || 'consolidado';

    if (!conta || !periodo) {
      return NextResponse.json(
        { error: 'Parametros conta e periodo sao obrigatorios' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${PYTHON_API_URL}/api/dre/unificada/duplicatas?conta=${conta}&periodo=${periodo}&filtro=${filtro}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar duplicatas DRE Unificada:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar duplicatas' },
      { status: 500 }
    );
  }
}
