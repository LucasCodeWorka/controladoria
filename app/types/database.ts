// Tipos baseados no seu SELECT do banco de dados
export interface DespesaDuplicata {
  cd_empresa: number;
  cd_fornecedor: number;
  nm_fornecedor: string;
  nm_fantasia: string;
  nr_duplicata: number;
  nr_parcela: number;
  nr_portador: number;
  dt_emissao: Date;
  dt_vencimento: Date;
  dt_baixa: Date | null;
  vl_rateio: number;
  cd_ccusto: number | null;
  cd_despesaitem: number;
  ds_despesaitem: string;
}

// Tipos para agrupamento por período
export interface DespesaPorPeriodo {
  periodo: string; // 'YYYY-MM'
  cd_despesaitem: number;
  ds_despesaitem: string;
  total: number;
}

// Tipos para agrupamento por categoria
export interface DespesaPorCategoria {
  cd_despesaitem: number;
  ds_despesaitem: string;
  total_geral: number;
  por_mes: {
    [key: string]: number; // 'YYYY-MM': valor
  };
}
