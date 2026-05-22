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
