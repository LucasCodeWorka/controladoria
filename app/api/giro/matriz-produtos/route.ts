import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mesReferencia = searchParams.get('mesReferencia');
    const empresas = searchParams.get('empresas');
    const pagina = searchParams.get('pagina');
    const porPagina = searchParams.get('porPagina');
    const ordenarPor = searchParams.get('ordenarPor');
    const ordem = searchParams.get('ordem');
    const params = new URLSearchParams();
    if (mesReferencia) params.set('mesReferencia', mesReferencia);
    if (empresas) params.set('empresas', empresas);
    if (pagina) params.set('pagina', pagina);
    if (porPagina) params.set('porPagina', porPagina);
    if (ordenarPor) params.set('ordenarPor', ordenarPor);
    if (ordem) params.set('ordem', ordem);

    const response = await fetch(`${PYTHON_API_URL}/api/giro/matriz-produtos?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Erro ao buscar matriz de produtos do giro:', error);
    return NextResponse.json({ error: 'Erro ao buscar matriz de produtos do giro' }, { status: 500 });
  }
}
