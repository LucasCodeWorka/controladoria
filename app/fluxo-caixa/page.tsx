'use client';

import React from 'react';
import { Banknote } from 'lucide-react';

export default function FluxoCaixaPage() {
  return (
    <div className="max-w-[98%] mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-emerald-100 rounded-lg">
            <Banknote className="w-6 h-6 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">Fluxo de Caixa</h1>
            <p className="text-sm text-gray-500">Em construção.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-8 text-center text-gray-500">
        Tela ainda sem conteúdo — aguardando definição do escopo.
      </div>
    </div>
  );
}
