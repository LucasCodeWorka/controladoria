'use client';

// Barra de rolagem horizontal acima E abaixo da tabela, sincronizadas
// (padrao de tabelas do design system LIEBE).
import { ReactNode, useEffect, useRef, useState } from 'react';

export default function DualScroll({ children, alturaMax = 'calc(100vh - 260px)' }: { children: ReactNode; alturaMax?: string }) {
  const topo = useRef<HTMLDivElement>(null);
  const corpo = useRef<HTMLDivElement>(null);
  const [largura, setLargura] = useState(0);
  const travado = useRef(false);

  useEffect(() => {
    const el = corpo.current;
    if (!el) return;
    const medir = () => setLargura(el.scrollWidth);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [children]);

  const sync = (de: HTMLDivElement | null, para: HTMLDivElement | null) => {
    if (!de || !para || travado.current) return;
    travado.current = true;
    para.scrollLeft = de.scrollLeft;
    requestAnimationFrame(() => { travado.current = false; });
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
      <div ref={topo} onScroll={() => sync(topo.current, corpo.current)} className="overflow-x-auto overflow-y-hidden border-b border-gray-200" style={{ height: 14 }}>
        <div style={{ width: largura, height: 1 }} />
      </div>
      <div ref={corpo} onScroll={() => sync(corpo.current, topo.current)} className="overflow-auto" style={{ maxHeight: alturaMax }}>
        {children}
      </div>
    </div>
  );
}
