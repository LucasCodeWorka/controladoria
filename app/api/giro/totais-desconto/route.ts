import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mesReferencia = searchParams.get('mesReferencia');
    const empresas = searchParams.get('empresas');
    const giroMinimo = searchParams.get('giroMinimo');
    const status = searchParams.get('status');
    const dimensaoFiltro = searchParams.get('dimensaoFiltro');
    const categoriaFiltro = searchParams.get('categoriaFiltro');
    const oportunidadeDesconto = searchParams.get('oportunidadeDesconto');
    const params = new URLSearchParams();
    if (mesReferencia) params.set('mesReferencia', mesReferencia);
    if (empresas) params.set('empresas', empresas);
    if (giroMinimo) params.set('giroMinimo', giroMinimo);
    if (status) params.set('status', status);
    if (dimensaoFiltro) params.set('dimensaoFiltro', dimensaoFiltro);
    if (categoriaFiltro) params.set('categoriaFiltro', categoriaFiltro);
    if (oportunidadeDesconto) params.set('oportunidadeDesconto', oportunidadeDesconto);

    const response = await fetch(`${PYTHON_API_URL}/api/giro/totais-desconto?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar totais de desconto do giro:', error);
    return NextResponse.json({ error: 'Erro ao buscar totais de desconto do giro' }, { status: 500 });
  }
}
