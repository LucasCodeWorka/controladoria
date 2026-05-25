export const formatCurrency = (value: number): string => {
  const isNegative = value < 0;
  const absValue = Math.abs(value);
  const formatted = absValue.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNegative ? `-${formatted}` : formatted;
};

export const getValueColor = (value: number): string => {
  if (value === 0) return 'text-gray-600';
  return value < 0 ? 'text-red-600' : 'text-gray-900';
};

export const formatarValor = (valor: number): string => {
  if (valor === 0) return '-';
  return valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
};
