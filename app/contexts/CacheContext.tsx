'use client';

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  key: string;
}

interface CacheContextType {
  getDRECache: (key: string) => any | null;
  setDRECache: (key: string, data: any) => void;
  getCentrosCustoCache: () => any | null;
  setCentrosCustoCache: (data: any) => void;
  clearCache: () => void;
  cacheTTL: number;
  setCacheTTL: (minutes: number) => void;
}

const CacheContext = createContext<CacheContextType | undefined>(undefined);

const DEFAULT_TTL_MINUTES = 5;

export function CacheProvider({ children }: { children: React.ReactNode }) {
  const [cacheTTL, setCacheTTL] = useState(DEFAULT_TTL_MINUTES);

  const dreCache = useRef<Map<string, CacheEntry<any>>>(new Map());
  const centrosCustoCache = useRef<CacheEntry<any> | null>(null);

  const isExpired = useCallback((timestamp: number) => {
    const now = Date.now();
    const ttlMs = cacheTTL * 60 * 1000;
    return (now - timestamp) > ttlMs;
  }, [cacheTTL]);

  const getDRECache = useCallback((key: string) => {
    const entry = dreCache.current.get(key);
    if (entry && !isExpired(entry.timestamp)) {
      return entry.data;
    }
    if (entry) dreCache.current.delete(key);
    return null;
  }, [isExpired]);

  const setDRECache = useCallback((key: string, data: any) => {
    dreCache.current.set(key, { data, timestamp: Date.now(), key });
  }, []);

  const getCentrosCustoCache = useCallback(() => {
    const entry = centrosCustoCache.current;
    if (entry) {
      const ttlMs = 30 * 60 * 1000;
      if ((Date.now() - entry.timestamp) <= ttlMs) return entry.data;
      centrosCustoCache.current = null;
    }
    return null;
  }, []);

  const setCentrosCustoCache = useCallback((data: any) => {
    centrosCustoCache.current = { data, timestamp: Date.now(), key: 'centros-custo' };
  }, []);

  const clearCache = useCallback(() => {
    dreCache.current.clear();
    centrosCustoCache.current = null;
  }, []);

  return (
    <CacheContext.Provider
      value={{
        getDRECache,
        setDRECache,
        getCentrosCustoCache,
        setCentrosCustoCache,
        clearCache,
        cacheTTL,
        setCacheTTL,
      }}
    >
      {children}
    </CacheContext.Provider>
  );
}

export function useCache() {
  const context = useContext(CacheContext);
  if (context === undefined) {
    throw new Error('useCache must be used within a CacheProvider');
  }
  return context;
}

export function generateCacheKey(params: Record<string, any>): string {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}
