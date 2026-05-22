import { useState, useEffect } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface GiroEstoqueData {
  tipo: string;
  mes_referencia: string;
  primeiro_dia_mes: string;
  periodo_vendas: {
    data_inicio: string;
    data_fim: string;
    meses: number;
  };
  vendas_12m: {
    venda: number;
    devolucao: number;
    liquido: number;
    media_mensal: number;
  };
  estoque_total: number;
  giro: number;
}

interface UseGiroEstoqueOptions {
  mesReferencia: string; // YYYY-MM
  tipo: 'fabrica' | 'lojas' | 'ecommerce';
  enabled?: boolean;
}

export function useGiroEstoque({ mesReferencia, tipo, enabled = true }: UseGiroEstoqueOptions) {
  const [data, setData] = useState<GiroEstoqueData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const fetchGiroEstoque = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          mesReferencia,
          tipo,
        });

        const response = await fetch(`${API_BASE_URL}/api/indicadores/giro-estoque?${params}`);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Erro ao buscar giro de estoque'));
        console.error('Erro ao buscar giro de estoque:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchGiroEstoque();
  }, [mesReferencia, tipo, enabled]);

  return { data, loading, error };
}

// Hook para buscar múltiplos giros de estoque em paralelo
export function useMultipleGiroEstoque(mesReferencia: string) {
  const giroFabrica = useGiroEstoque({ mesReferencia, tipo: 'fabrica' });
  const giroLojas = useGiroEstoque({ mesReferencia, tipo: 'lojas' });
  const giroEcommerce = useGiroEstoque({ mesReferencia, tipo: 'ecommerce' });

  return {
    fabrica: giroFabrica,
    lojas: giroLojas,
    ecommerce: giroEcommerce,
    loading: giroFabrica.loading || giroLojas.loading || giroEcommerce.loading,
    error: giroFabrica.error || giroLojas.error || giroEcommerce.error,
  };
}
