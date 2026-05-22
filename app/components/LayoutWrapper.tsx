'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Sidebar from './Sidebar';
import { Menu } from 'lucide-react';

export default function LayoutWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && !isAuthenticated && pathname !== '/login') {
      router.push('/login');
    }
  }, [isAuthenticated, pathname, router, mounted]);

  // Não renderizar nada até que o componente esteja montado (evita hidratação incorreta)
  if (!mounted) {
    return null;
  }

  // Página de login não tem sidebar
  if (pathname === '/login') {
    return <>{children}</>;
  }

  // Se não autenticado, não renderizar conteúdo protegido
  if (!isAuthenticated) {
    return null;
  }

  // Layout com sidebar para páginas autenticadas
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isOpen={sidebarOpen} setIsOpen={setSidebarOpen} />

      <div
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${
          sidebarOpen ? 'ml-64' : 'ml-20'
        }`}
      >
        {/* Header com botão de menu para mobile */}
        <header className="bg-brand-primary shadow-sm z-10">
          <div className="px-4 py-3 flex items-center">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="lg:hidden p-2 rounded-lg hover:bg-brand-secondary text-white"
            >
              <Menu className="w-6 h-6" />
            </button>
          </div>
        </header>

        {/* Conteúdo principal */}
        <main className="flex-1 overflow-auto bg-gray-50">
          {children}
        </main>
      </div>
    </div>
  );
}
