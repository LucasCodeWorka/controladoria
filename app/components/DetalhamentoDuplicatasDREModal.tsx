'use client';

import React, { useEffect, useState } from 'react';
import { X, Calendar, FileText } from 'lucide-react';

interface DuplicataDRE {
  nr_duplicata: string;
  ds_despesaitem: string;
  dt_emissao: string;
  vl_rateio: number;
  cd_despesaitem?: number;
  origem_tabela?: string;
  tipo_documento?: number;
  nm_fornecedor?: string;
  nm_fantasia?: string;
}

interface DetalhamentoDuplicatasDREModalProps {
  isOpen: boolean;
  onClose: () => void;
  conta: string;
  periodo: string; // YYYY-MM
  valor: number;
}

export default function DetalhamentoDuplicatasDREModal({
  isOpen,
  onClose,
  conta,
  periodo,
  valor,
}: DetalhamentoDuplicatasDREModalProps) {
  const [loading, setLoading] = useState(false);
  const [duplicatas, setDuplicatas] = useState<DuplicataDRE[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && conta && periodo) {
      fetchDuplicatas();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, conta, periodo]);

  const fetchDuplicatas = async () => {
    try {
      setLoading(true);
      setError(null);

      const url = `/api/dre/duplicatas?conta=${encodeURIComponent(conta)}&periodo=${periodo}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Erro ao buscar duplicatas: ${response.statusText}`);
      }

      const json = await response.json();
      setDuplicatas(json.duplicatas || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
      console.error('Erro ao buscar duplicatas DRE:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const formatDate = (dateStr: string | null | undefined) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const formatPeriodo = (p: string) => {
    const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const [ano, mes] = p.split('-');
    return `${meses[parseInt(mes, 10) - 1]}/${ano}`;
  };

  const totalDuplicatas = duplicatas.reduce((acc, d) => acc + (Number(d.vl_rateio) || 0), 0);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Duplicatas da conta {conta}</h3>
            <div className="flex items-center gap-2 text-sm text-gray-600 mt-1">
              <Calendar className="w-4 h-4" />
              <span>Período: {formatPeriodo(periodo)}</span>
              <span className="mx-2">•</span>
              <FileText className="w-4 h-4" />
              <span>Valor DRE: {formatCurrency(valor)}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-auto max-h-[70vh]">
          {loading && <p className="text-gray-600">Carregando duplicatas...</p>}
          {error && <p className="text-red-600">{error}</p>}
          {!loading && !error && duplicatas.length === 0 && (
            <p className="text-gray-600">Nenhuma duplicata encontrada para este período.</p>
          )}

          {!loading && !error && duplicatas.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-3 text-sm text-gray-600">
                <span>{duplicatas.length} registros</span>
                <span>Total duplicatas: {formatCurrency(totalDuplicatas)}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="px-3 py-2 text-left">Duplicata</th>
                      <th className="px-3 py-2 text-left">Fornecedor</th>
                      <th className="px-3 py-2 text-left">Despesa</th>
                      <th className="px-3 py-2 text-left">Emissão</th>
                      <th className="px-3 py-2 text-right">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicatas.map((dup, idx) => (
                      <tr key={`${dup.nr_duplicata}-${idx}`} className="border-b hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono text-xs">{dup.nr_duplicata || '-'}</td>
                        <td className="px-3 py-2">{dup.nm_fantasia || dup.nm_fornecedor || '-'}</td>
                        <td className="px-3 py-2">{dup.ds_despesaitem || '-'}</td>
                        <td className="px-3 py-2">{formatDate(dup.dt_emissao)}</td>
                        <td className="px-3 py-2 text-right">{formatCurrency(Number(dup.vl_rateio) || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
