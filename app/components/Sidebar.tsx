'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import {
  LayoutDashboard,
  LogOut,
  User,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  ClipboardList,
  BarChart3,
  Factory,
} from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

export default function Sidebar({ isOpen, setIsOpen }: SidebarProps) {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  const menuItems = [
    {
      name: 'Indicadores',
      href: '/indicadores-controladoria',
      icon: BarChart3,
    },
    {
      name: 'DRE',
      href: '/dre-fabrica',
      icon: Factory,
    },
  ];

  const menuConfigItems = [
    {
      name: 'Config DRE',
      href: '/configuracoes/plano-contas-dre',
      icon: ClipboardList,
    },
  ];

  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-20 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      <aside
        className={`fixed top-0 left-0 h-full bg-brand-dark text-white z-30 transition-all duration-300 ${
          isOpen ? 'w-64' : 'w-20'
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          {isOpen ? (
            <div className="flex flex-col gap-0.5">
              <h2 className="text-base font-bold tracking-wider font-secondary">LIEBE</h2>
              <p className="text-xs font-light tracking-wide text-gray-400 font-secondary">CONTROLADORIA</p>
            </div>
          ) : (
            <div className="w-full flex justify-center">
              <LayoutDashboard className="w-6 h-6" />
            </div>
          )}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="p-2 hover:bg-gray-700 rounded-lg transition-colors ml-auto"
          >
            {isOpen ? (
              <ChevronLeft className="w-5 h-5" />
            ) : (
              <ChevronRight className="w-5 h-5" />
            )}
          </button>
        </div>

        {user && (
          <div className="p-4 border-b border-gray-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-brand-primary rounded-full flex items-center justify-center flex-shrink-0">
                <User className="w-6 h-6" />
              </div>
              {isOpen && (
                <div className="overflow-hidden">
                  <p className="font-semibold text-sm truncate">{user.name}</p>
                  <p className="text-xs text-gray-400 truncate">{user.username}</p>
                </div>
              )}
            </div>
          </div>
        )}

        <nav className="flex-1 p-4">
          <ul className="space-y-2">
            {menuItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                      active
                        ? 'bg-brand-primary text-white'
                        : 'hover:bg-gray-700 text-gray-300'
                    } ${!isOpen && 'justify-center'}`}
                    title={!isOpen ? item.name : undefined}
                  >
                    <Icon className="w-5 h-5 flex-shrink-0" />
                    {isOpen && <span className="font-medium">{item.name}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 pt-4 border-t border-gray-700">
            {isOpen && (
              <p className="px-4 mb-2 text-xs uppercase tracking-wider text-gray-400">
                Configurações
              </p>
            )}
            <ul className="space-y-2">
              {menuConfigItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                        active
                          ? 'bg-brand-primary text-white'
                          : 'hover:bg-gray-700 text-gray-300'
                      } ${!isOpen && 'justify-center'}`}
                      title={!isOpen ? item.name : undefined}
                    >
                      <Icon className="w-5 h-5 flex-shrink-0" />
                      {isOpen && <span className="font-medium">{item.name}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </nav>

        <div className="p-4 border-t border-gray-700">
          <button
            onClick={logout}
            className={`flex items-center gap-3 px-4 py-3 w-full rounded-lg hover:bg-brand-secondary transition-colors text-gray-300 hover:text-white ${
              !isOpen && 'justify-center'
            }`}
            title={!isOpen ? 'Sair' : undefined}
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            {isOpen && <span className="font-medium">Sair</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
