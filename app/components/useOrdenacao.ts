'use client';

// Ordenacao por clique no cabecalho (asc -> desc -> sem ordem). Texto com
// localeCompare pt-BR, numero como numero, nulos sempre no fim.
import { useMemo, useState } from 'react';

export type Dir = 'asc' | 'desc';
export type Getters<T> = Record<string, (r: T) => number | string | null | undefined>;

export function useOrdenacao<T>(rows: T[], getters: Getters<T>, inicial: { campo: string; dir: Dir } | null = null) {
  const [ord, setOrd] = useState<{ campo: string; dir: Dir } | null>(inicial);
  const sorted = useMemo(() => {
    if (!ord) return rows;
    const get = getters[ord.campo];
    if (!get) return rows;
    const f = ord.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * f;
      return String(x).localeCompare(String(y), 'pt-BR', { numeric: true }) * f;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ord]);
  const alternar = (campo: string) =>
    setOrd((o) => (o?.campo !== campo ? { campo, dir: 'asc' } : o.dir === 'asc' ? { campo, dir: 'desc' } : null));
  const seta = (campo: string) => (ord?.campo !== campo ? '⇅' : ord.dir === 'asc' ? '▲' : '▼');
  const ariaSort = (campo: string): 'ascending' | 'descending' | 'none' =>
    ord?.campo !== campo ? 'none' : ord.dir === 'asc' ? 'ascending' : 'descending';
  return { sorted, ord, alternar, seta, ariaSort };
}
