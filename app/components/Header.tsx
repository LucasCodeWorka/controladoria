'use client';

import React from 'react';
import { Search, Eye, Settings, HelpCircle, BarChart3, Menu } from 'lucide-react';

const Header: React.FC = () => {
  return (
    <div className="bg-white border-b border-gray-200 shadow-sm">
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>📊 Relatórios Gerenciais</span>
              <span>/</span>
              <span>Fluxo de Caixa</span>
              <span>/</span>
              <span className="font-semibold text-gray-900">Fluxo de Caixa - Gerencial</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <Eye size={20} className="text-gray-600" />
            </button>
            <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <Settings size={20} className="text-gray-600" />
            </button>
            <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <BarChart3 size={20} className="text-gray-600" />
            </button>
            <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <HelpCircle size={20} className="text-gray-600" />
            </button>
            <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <Menu size={20} className="text-gray-600" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Fluxo de Caixa - Gerencial</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="px-3 py-1 bg-blue-100 text-blue-800 text-sm font-medium rounded-full">
                Realizado
              </span>
              <span className="px-3 py-1 bg-gray-100 text-gray-700 text-sm rounded-full">
                BRL
              </span>
            </div>
          </div>

          <div className="relative">
            <input
              type="text"
              placeholder="Procurar..."
              className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-64"
            />
            <Search className="absolute left-3 top-2.5 text-gray-400" size={20} />
          </div>
        </div>
      </div>

      <div className="px-6 py-2 bg-gray-50 border-t border-gray-200">
        <div className="flex gap-4">
          {[1, 2, 3, 4, 5].map((num) => (
            <button
              key={num}
              className="px-4 py-1 text-sm text-gray-600 hover:bg-white hover:shadow-sm rounded transition-all"
            >
              {num}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Header;
