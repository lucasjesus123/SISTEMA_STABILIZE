/**
 * Que tinta usar SOBRE uma cor escolhida.
 *
 * A paleta sugerida é escura o bastante para texto branco, e por isso o
 * branco estava fixo no código. No momento em que a pessoa pode escolher
 * QUALQUER cor, isso deixa de valer: amarelo, verde-limão e rosa-claro
 * são escolhas legítimas para identificar alguém na agenda, e nomes em
 * branco sobre eles somem.
 *
 * A conta é a luminância relativa da WCAG — a mesma que decide se um
 * contraste passa —, e o corte em 0,45 é onde branco e preto empatam na
 * prática para blocos pequenos de texto.
 */
export function tintaSobre(fundo: string | null | undefined): string {
  if (fundo === null || fundo === undefined) return 'inherit';

  const hex = fundo.trim().replace('#', '');
  const cheio =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(cheio)) return '#ffffff';

  /* Canal linearizado: a luz não é proporcional ao número do canal, e
     usar o valor cru faria o azul parecer mais claro do que é. */
  const canal = (i: number): number => {
    const v = parseInt(cheio.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };

  const luz = 0.2126 * canal(0) + 0.7152 * canal(2) + 0.0722 * canal(4);
  return luz > 0.45 ? '#12211f' : '#ffffff';
}

/** `#abc` vira `#aabbcc`; qualquer outra coisa vira a cor padrão. */
export function normalizarCor(valor: string, padrao: string): string {
  const hex = valor.trim().replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : padrao;
}
