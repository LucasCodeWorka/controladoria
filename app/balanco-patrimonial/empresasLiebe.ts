// Empresas consideradas nos indicadores de balanço (tela de Indicadores e
// Comparativo de Mercado): so a Liebe. Mesma selecao da tela do Balanco com
// CB EMP. (110) e CAIRO EIRELLI (100) desmarcadas - as demais (fabrica, lojas,
// ecommerce e CORPO SEXY) ficam marcadas.
export const EMPRESAS_BALANCO_LIEBE = [1, 2, 3, 4, 5, 6, 7, 8, 10, 14, 15, 17, 19, 20, 21, 22, 120, 50];
export const PARAM_EMPRESAS_BALANCO_LIEBE = EMPRESAS_BALANCO_LIEBE.join(',');

// Query string padrao da "visao Liebe" do balanco: empresas acima + as duas
// opcoes "Sem rescisoes de folha" e "Sem rescisoes de shopping" marcadas.
export const QUERY_BALANCO_VISAO_LIEBE = `empresas=${PARAM_EMPRESAS_BALANCO_LIEBE}&semRescisaoFolha=true&semRescisaoShopping=true`;
