// Persistencia do ultimo filtro usado em cada tela (localStorage) - mesmo
// padrao ja usado no DRE/DFC, extraido pra ser usado em toda tela com
// filtro (nao pode cada uma reimplementar do seu jeito).

export function carregarFiltro<T extends object>(chave: string): Partial<T> | null {
  try {
    const salvo = localStorage.getItem(chave);
    return salvo ? (JSON.parse(salvo) as Partial<T>) : null;
  } catch (error) {
    console.error(`Erro ao carregar filtro salvo (${chave}):`, error);
    return null;
  }
}

export function salvarFiltro<T extends object>(chave: string, valor: T): void {
  try {
    localStorage.setItem(chave, JSON.stringify(valor));
  } catch (error) {
    console.error(`Erro ao salvar filtro (${chave}):`, error);
  }
}
