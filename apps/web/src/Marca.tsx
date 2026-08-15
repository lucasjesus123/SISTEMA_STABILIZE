import type { ReactNode } from 'react';

/**
 * A marca.
 *
 * O logotipo original tem duas partes: o logotipo "stabilize" em
 * grafite e, abaixo, "Clínica do Músculo" em menta, separados por um
 * fio fino que corre à direita. É essa estrutura que reproduzimos —
 * tipografia e um fio, não uma imagem.
 *
 * Deliberadamente NÃO redesenhamos a figura anatômica do logo em SVG.
 * Uma figura humana desenhada com formas primitivas fica com cara de
 * clip-art e desvaloriza a marca; melhor a palavra bem composta do que
 * o desenho mal reproduzido. Quando houver o arquivo vetorial oficial,
 * ele entra aqui.
 */
export function Marca({ tamanho = 32 }: { tamanho?: number }): ReactNode {
  return (
    <div className="marca" style={{ '--marca-tamanho': `${tamanho}px` } as React.CSSProperties}>
      <span className="marca-nome">stabilize</span>
      <span className="marca-fio" aria-hidden="true" />
      <span className="marca-tagline">Clínica do Músculo</span>
    </div>
  );
}
