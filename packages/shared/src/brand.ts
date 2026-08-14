/**
 * Identidade visual da Stabilize — Clínica do Músculo.
 * Cores extraídas diretamente do arquivo original da marca (LOGO.pdf).
 *
 * Fonte única da verdade: o front consome estes tokens em CSS custom
 * properties. Nenhum hexadecimal solto nos componentes.
 */

export const BRAND = {
  name: 'Stabilize',
  tagline: 'Clínica do Músculo',

  color: {
    /** Teal do traço da figura humana — cor primária da marca. */
    teal: '#4BC1C8',
    tealDark: '#2E9AA1',
    tealDeep: '#1F7176',
    /** Verde-menta do texto "Clínica do Músculo" — cor de apoio. */
    mint: '#85CEBD',
    mintDark: '#5FB3A0',
    /** Grafite do logotipo "stabilize" — cor de texto principal. */
    graphite: '#686969',
    graphiteDark: '#3F4040',
    ink: '#1C1F22',
  },

  /** Semânticas de estado. Não são cores da marca; são sinal funcional. */
  status: {
    success: '#1F9D6B',
    warning: '#C8860D',
    danger: '#C4453C',
    info: '#2E7BB8',
  },

  /** Gradiente assinatura teal → menta, usado com parcimônia. */
  gradient: 'linear-gradient(135deg, #4BC1C8 0%, #85CEBD 100%)',

  font: {
    /** A logo usa uma geométrica de terminações abertas; Outfit é a mais próxima. */
    display: "'Outfit', 'Segoe UI', system-ui, sans-serif",
    body: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    /** Tabular para colunas de dinheiro — dígitos alinham verticalmente. */
    numeric: "'Inter', system-ui, sans-serif",
  },
} as const;

export type BrandColor = keyof typeof BRAND.color;
