'use client';

import React, { useEffect, useState } from 'react';
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
  Wallet,
  GitCompare,
  Boxes,
  RotateCw,
  Clock,
  Sparkles,
  Scale,
  Banknote,
  TrendingUp,
  Minus,
  Plus,
} from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const CHAVE_FONTE = 'controladoria_font_scale';
const CHAVE_ZOOM = 'controladoria_zoom_scale';

function lerEscala(chave: string, min: number, max: number): number {
  try {
    const v = parseFloat(localStorage.getItem(chave) || '');
    if (v >= min && v <= max) return v;
  } catch { /* segue com o padrao */ }
  return 1;
}

function gravarEscala(chave: string, valor: number) {
  try { localStorage.setItem(chave, String(valor)); } catch { /* segue sem salvar */ }
}

export default function Sidebar({ isOpen, setIsOpen }: SidebarProps) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [fonte, setFonte] = useState(1);
  const [zoom, setZoom] = useState(1);

  // Acessibilidade (padrao LIEBE): fonte 0.90-1.25 e zoom 0.90-1.15, passo .05.
  useEffect(() => {
    setFonte(lerEscala(CHAVE_FONTE, 0.9, 1.25));
    setZoom(lerEscala(CHAVE_ZOOM, 0.9, 1.15));
  }, []);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fonte * 100}%`;
    gravarEscala(CHAVE_FONTE, fonte);
  }, [fonte]);

  useEffect(() => {
    document.body.style.zoom = String(zoom);
    gravarEscala(CHAVE_ZOOM, zoom);
  }, [zoom]);

  const ajustar = (atual: number, passo: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, atual + passo)) * 100) / 100;

  const controle = (rotulo: string, valor: number, set: (v: number) => void, min: number, max: number) => (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-[#e5e7eb] w-12">{rotulo}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => set(ajustar(valor, -0.05, min, max))}
          disabled={valor <= min}
          aria-label={`Diminuir ${rotulo}`}
          className="w-7 h-7 flex items-center justify-center rounded bg-white/10 text-white hover:bg-brand-primary disabled:opacity-40"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <span className="w-11 text-center text-xs font-semibold text-white [font-variant-numeric:tabular-nums]">{Math.round(valor * 100)}%</span>
        <button
          onClick={() => set(ajustar(valor, 0.05, min, max))}
          disabled={valor >= max}
          aria-label={`Aumentar ${rotulo}`}
          className="w-7 h-7 flex items-center justify-center rounded bg-white/10 text-white hover:bg-brand-primary disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

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
    {
      name: 'DRE Projetada',
      href: '/dre-projetada',
      icon: TrendingUp,
    },
    {
      name: 'DFC',
      href: '/dfc',
      icon: Wallet,
    },
    {
      name: 'DRE x DFC',
      href: '/dre-dfc',
      icon: GitCompare,
    },
    {
      name: 'Fluxo de Caixa',
      href: '/fluxo-caixa',
      icon: Banknote,
    },
    {
      name: 'CMV Detalhado',
      href: '/cmv-detalhado',
      icon: Boxes,
    },
    {
      name: 'Giro',
      href: '/giro',
      icon: RotateCw,
    },
    {
      name: 'Estoque por Tempo',
      href: '/estoque-tempo',
      icon: Clock,
    },
    {
      name: 'Analisador DRE',
      href: '/analisador-dre',
      icon: Sparkles,
    },
    {
      name: 'Balanço Patrimonial',
      href: '/balanco-patrimonial',
      icon: Scale,
    },
  ];

  const menuConfigItems = [
    {
      name: 'Config DRE',
      href: '/configuracoes/plano-contas-dre',
      icon: ClipboardList,
    },
    {
      name: 'Config DFC',
      href: '/configuracoes/plano-contas-dfc',
      icon: Wallet,
    },
    {
      name: 'Config Balanço',
      href: '/configuracoes/plano-contas-balanco',
      icon: Scale,
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

        {isOpen && (
          <div className="px-4 pt-4 space-y-2 border-t border-gray-700">
            <div className="text-[11px] font-bold uppercase tracking-[.04em] text-[#e5e7eb]">Acessibilidade</div>
            {controle('Fonte', fonte, setFonte, 0.9, 1.25)}
            {controle('Zoom', zoom, setZoom, 0.9, 1.15)}
          </div>
        )}

        <div className={`p-4 ${isOpen ? '' : 'border-t border-gray-700'}`}>
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
