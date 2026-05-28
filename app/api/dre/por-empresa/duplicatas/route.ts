import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const conta = searchParams.get('conta');
    const dataInicio = searchParams.get('dataInicio') || '2026-01-01';
    const dataFim = searchParams.get('dataFim') || '2026-12-31';
    const cdEmpresa = searchParams.get('cdEmpresa');

    // Validar parametros obrigatorios
    if (!conta || !cdEmpresa) {
      return NextResponse.json(
        { error: 'Parametros obrigatorios: conta, cdEmpresa', duplicatas: [], total: 0 },
        { status: 400 }
      );
    }

    const url = `${PYTHON_API_URL}/api/dre/por-empresa/duplicatas?conta=${encodeURIComponent(conta)}&dataInicio=${dataInicio}&dataFim=${dataFim}&cdEmpresa=${cdEmpresa}`;

    console.log('[API] Buscando duplicatas por empresa:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[API] Erro do backend:', response.status, errorText);
      return NextResponse.json(
        { error: `Erro do backend: ${errorText}`, duplicatas: [], total: 0 },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Erro ao buscar duplicatas por empresa:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar duplicatas por empresa', details: String(error), duplicatas: [], total: 0 },
      { status: 500 }
    );
  }
}
