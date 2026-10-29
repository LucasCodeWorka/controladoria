// Filtros lembrados por tela (padrao LIEBE): cookie pequeno, 180 dias,
// Path=/; SameSite=Lax. Falha de leitura/gravacao nunca quebra a tela.

export function lerCookie(nome: string): string | null {
  try {
    const prefixo = `${encodeURIComponent(nome)}=`;
    const par = document.cookie.split('; ').find((c) => c.startsWith(prefixo));
    return par ? decodeURIComponent(par.slice(prefixo.length)) : null;
  } catch {
    return null;
  }
}

export function gravarCookie(nome: string, valor: string, dias = 180): void {
  try {
    const seguro = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${encodeURIComponent(nome)}=${encodeURIComponent(valor)}; Max-Age=${dias * 86400}; Path=/; SameSite=Lax${seguro}`;
  } catch {
    /* cookies bloqueados: a tela segue com o padrao */
  }
}

export function apagarCookie(nome: string): void {
  gravarCookie(nome, '', 0);
}

export function carregarFiltroCookie<T extends object>(nome: string): Partial<T> | null {
  try {
    const bruto = lerCookie(nome);
    return bruto ? (JSON.parse(bruto) as Partial<T>) : null;
  } catch {
    return null;
  }
}

export function salvarFiltroCookie<T extends object>(nome: string, valor: T): void {
  const json = JSON.stringify(valor);
  if (json.length < 3000) gravarCookie(nome, json);
}
