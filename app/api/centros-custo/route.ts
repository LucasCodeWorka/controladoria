import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://127.0.0.1:8000';
    const response = await fetch(`${backendUrl}/centros-custo`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[API centros-custo] Backend error:', errorText);
      return NextResponse.json(
        { error: 'Erro ao buscar centros de custo' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('[API centros-custo] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Erro ao buscar centros de custo' },
      { status: 500 }
    );
  }
}
