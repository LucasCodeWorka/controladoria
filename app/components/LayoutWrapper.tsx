'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Sidebar from './Sidebar';
import { Menu, RefreshCw } from 'lucide-react';

interface SyncInfo {
  data: string;
  duracao: number;
}

function fmtDuracao(seg: number) {
  if (seg < 60) return `${seg}s`;
  return `${Math.floor(seg / 60)}m ${seg % 60}s`;
}

function fmtData(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [sincronizando, setSincronizando] = useState(false);
  const [progresso, setProgresso] = useState(0);
  const [total, setTotal] = useState(0);
  const [ultimaSinc, setUltimaSinc] = useState<SyncInfo | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Carrega última sincronização do backend ao montar
  useEffect(() => {
    fetch('/api/indicadores/cache/status')
      .then((r) => r.json())
      .then((d) => {
        if (d.finalizado_em && d.duracao_segundos != null) {
          setUltimaSinc({ data: d.finalizado_em, duracao: d.duracao_segundos });
        }
        if (d.rodando) {
          // Retomado após reload enquanto sync corria
          setSincronizando(true);
          setProgresso(d.progresso ?? 0);
          setTotal(d.total ?? 0);
          iniciarPolling();
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function iniciarPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      fetch('/api/indicadores/cache/status')
        .then((r) => r.json())
        .then((d) => {
          setProgresso(d.progresso ?? 0);
          setTotal(d.total ?? 0);
          if (!d.rodando && d.finalizado_em) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setSincronizando(false);
            const info = { data: d.finalizado_em, duracao: d.duracao_segundos ?? 0 };
            setUltimaSinc(info);
            window.dispatchEvent(new CustomEvent('cache-synced'));
          }
        })
        .catch(() => {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setSincronizando(false);
        });
    }, 3000);
  }

  function sincronizar() {
    if (sincronizando) return;
    setSincronizando(true);
    setProgresso(0);
    setTotal(0);
    fetch('/api/indicadores/cache/sincronizar', { method: 'POST' })
      .then(() => iniciarPolling())
      .catch(() => setSincronizando(false));
  }

  useEffect(() => {
    if (!isLoading && !isAuthenticated && pathname !== '/login') {
      router.push('/login');
    }
  }, [isAuthenticated, isLoading, pathname, router]);

  if (pathname === '/login') return <>{children}</>;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-4 border-brand-primary" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  const pct = total > 0 ? Math.round((progresso / total) * 100) : 0;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isOpen={sidebarOpen} setIsOpen={setSidebarOpen} />

      <div
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${
          sidebarOpen ? 'ml-64' : 'ml-20'
        }`}
      >
        <header className="bg-brand-primary shadow-sm z-10">
          <div className="px-4 py-2 flex items-center justify-between gap-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="lg:hidden p-2 rounded-lg hover:bg-brand-secondary text-white"
            >
              <Menu className="w-6 h-6" />
            </button>

            <div className="ml-auto flex flex-col items-end gap-0.5">
              {/* Botão */}
              <button
                onClick={sincronizar}
                disabled={sincronizando}
                className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 text-white rounded-lg text-sm font-medium transition disabled:opacity-70"
              >
                <RefreshCw className={`w-4 h-4 ${sincronizando ? 'animate-spin' : ''}`} />
                {sincronizando ? `Atualizando... ${pct}%` : 'Atualizar Dados'}
              </button>

              {/* Barra de progresso */}
              {sincronizando && (
                <div className="w-full bg-white/20 rounded-full h-1 mt-1">
                  <div
                    className="bg-white h-1 rounded-full transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}

              {/* Última sincronização */}
              {!sincronizando && ultimaSinc && (
                <span className="text-[11px] text-white/55">
                  Última: {fmtData(ultimaSinc.data)} · {fmtDuracao(ultimaSinc.duracao)}
                </span>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-gray-50">
          {children}
        </main>
      </div>
    </div>
  );
}
