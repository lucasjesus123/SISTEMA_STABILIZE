import { useId, type CSSProperties, type ReactNode } from 'react';
import { FIGURA, MOLDURA, PALAVRA, TAGLINE, VIEWBOX } from './marca/geometria.js';

/**
 * A marca.
 *
 * A geometria vem do arquivo vetorial original (brand/stabilize.pdf),
 * extraída por brand/extrair.py — não é uma reconstrução tipográfica.
 * Cada curva é a curva do Illustrator. Ver o cabeçalho daquele script
 * para a verificação por diferença de pixel.
 *
 * TRÊS VARIANTES, porque uma marca de proporção 2,5:1 não serve para
 * tudo:
 *
 *   completa    figura + palavra + tagline + fio. A assinatura inteira.
 *               Só onde há espaço e a marca é o assunto: a entrada.
 *   horizontal  figura + palavra. O topo do sistema, onde a tagline
 *               viraria um borrão de 5px e o fio brigaria com a régua
 *               do cabeçalho.
 *   simbolo     só a figura, quadrada. Ícone, favicon, telas estreitas.
 *
 * A PALAVRA HERDA A COR DO TEMA. No arquivo original ela é grafite
 * (#686969), que sobre fundo escuro fica ilegível — a marca sumiria
 * justamente no tema que o sistema usa por padrão. A figura e a tagline
 * mantêm as cores do arquivo: nascem em menta e funcionam nos dois
 * fundos.
 */

type Variante = keyof typeof VIEWBOX;

interface Props {
  variante?: Variante;
  /** Altura em pixels; a largura sai da proporção do arquivo original. */
  altura?: number;
  /** Para quando um texto ao lado já anuncia a marca ao leitor de tela. */
  decorativa?: boolean;
  className?: string;
}

export function Marca({
  variante = 'completa',
  altura = 96,
  decorativa = false,
  className,
}: Props): ReactNode {
  /* Os gradientes são referenciados por id. Duas marcas na mesma página
     com o mesmo id fariam a segunda apontar para o gradiente da
     primeira — hoje inofensivo, porque são idênticos, mas é o tipo de
     coincidência que quebra no dia em que alguém criar uma variante. */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  const caixa = VIEWBOX[variante];
  const [, , largura, alto] = caixa.split(' ').map(Number) as [number, number, number, number];

  const rotulo = 'Stabilize — Clínica do Músculo';
  const acessibilidade = decorativa
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': rotulo } as const);

  return (
    <svg
      className={className === undefined ? 'marca' : `marca ${className}`}
      viewBox={caixa}
      height={altura}
      width={(altura * largura) / alto}
      style={{ '--marca-altura': `${altura}px` } as CSSProperties}
      {...acessibilidade}
    >
      {!decorativa && <title>{rotulo}</title>}
      <defs>
        {FIGURA.map((traco, i) => (
          <linearGradient
            key={i}
            id={`${uid}-f${i}`}
            gradientUnits="userSpaceOnUse"
            x1={traco.x1}
            y1={traco.y1}
            x2={traco.x2}
            y2={traco.y2}
          >
            <stop offset="0" stopColor={traco.de} />
            <stop offset="1" stopColor={traco.para} />
          </linearGradient>
        ))}
      </defs>

      <g className="marca-figura">
        {FIGURA.map((traco, i) => (
          <path key={i} fill={`url(#${uid}-f${i})`} d={traco.d} />
        ))}
      </g>

      {variante !== 'simbolo' && <path className="marca-palavra" fill="currentColor" d={PALAVRA} />}
      {variante === 'completa' && (
        <>
          <path className="marca-tagline" d={TAGLINE} />
          <path className="marca-moldura" d={MOLDURA} />
        </>
      )}
    </svg>
  );
}
