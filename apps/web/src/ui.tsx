import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';

/**
 * Primitivas de interface.
 *
 * O movimento aqui é UM momento autoral, não efeito espalhado: os
 * números do painel são "escritos" na tela e a linha do gráfico é
 * desenhada, ambos uma vez, na entrada. Depois disso a tela fica quieta
 * — é uma ferramenta de trabalho, não uma vitrine, e animação repetida
 * em tela de trabalho cansa em dois dias.
 */

/* ====================================================================
 * Contagem animada
 * ================================================================== */

/**
 * Anima um número até o valor final com desaceleração exponencial.
 *
 * Parte do valor JÁ VISÍVEL (não de zero invisível): se o JavaScript
 * falhar, o número correto continua na tela. Conteúdo que só existe
 * depois da animação é conteúdo que some quando algo dá errado.
 */
export function useContagem(alvo: number, duracaoMs = 900): number {
  const [valor, setValor] = useState(alvo);
  const anterior = useRef(alvo);

  useEffect(() => {
    const inicio = anterior.current;
    const delta = alvo - inicio;
    anterior.current = alvo;

    if (delta === 0) return;

    // Quem pediu menos movimento recebe o valor final, sem transição.
    const menosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (menosMovimento) {
      setValor(alvo);
      return;
    }

    let frame = 0;
    const t0 = performance.now();

    const passo = (agora: number): void => {
      const p = Math.min((agora - t0) / duracaoMs, 1);
      // ease-out-expo: rápido no começo, assenta no fim. Como um objeto
      // real desacelerando — sem quique.
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      setValor(Math.round(inicio + delta * eased));
      if (p < 1) frame = requestAnimationFrame(passo);
    };

    frame = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(frame);
  }, [alvo, duracaoMs]);

  return valor;
}

/** Centavos → "R$ 1.234,56". Sempre duas casas. */
export function reais(centavos: number, comSimbolo = true): string {
  const s = (Math.abs(centavos) / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sinal = centavos < 0 ? '-' : '';
  return `${sinal}${comSimbolo ? 'R$ ' : ''}${s}`;
}

/* ====================================================================
 * Indicador
 * ================================================================== */

export function Indicador({
  rotulo,
  valorCentavos,
  detalhe,
  tom = 'neutro',
}: {
  rotulo: string;
  valorCentavos: number;
  detalhe?: string;
  tom?: 'neutro' | 'positivo' | 'atencao' | 'negativo';
}): ReactNode {
  const animado = useContagem(valorCentavos);

  return (
    <div className="indicador">
      <div className="indicador-rotulo">{rotulo}</div>
      <div className={`indicador-valor tabular tom-${tom}`}>{reais(animado)}</div>
      {detalhe !== undefined && <div className="indicador-detalhe">{detalhe}</div>}
    </div>
  );
}

/* ====================================================================
 * Gráfico de linha
 *
 * SVG escrito à mão, sem biblioteca. Três motivos: controle total sobre
 * a animação de traçado, nenhuma dependência de terceiro no caminho de
 * dado financeiro, e um pacote menor.
 * ================================================================== */

export interface Ponto {
  readonly rotulo: string;
  readonly valor: number;
}

export function GraficoLinha({
  series,
  altura = 220,
  formatador = (v: number) => reais(v, false),
}: {
  series: { nome: string; cor: string; pontos: readonly Ponto[] }[];
  altura?: number;
  formatador?: (v: number) => string;
}): ReactNode {
  const [ativo, setAtivo] = useState<number | null>(null);
  const [desenhado, forcarDesenho] = useReducer(() => true, false);

  useEffect(() => {
    // Um quadro de atraso para o traçado partir do estado inicial.
    const t = setTimeout(forcarDesenho, 60);
    return () => clearTimeout(t);
  }, []);

  const pontos = series[0]?.pontos ?? [];
  if (pontos.length === 0) {
    return (
      <p className="vazio">Nenhum movimento no período.</p>
    );
  }

  const larg = 720;
  const padL = 64;
  const padR = 16;
  const padT = 16;
  const padB = 34;

  const todos = series.flatMap((s) => s.pontos.map((p) => p.valor));
  const maximo = Math.max(...todos, 1);
  /* A escala parte de ZERO, sempre. Cortar o eixo para "destacar a
     variação" é a forma mais comum de mentir com gráfico: uma oscilação
     de 2% vira um precipício. */
  const escala = (v: number): number =>
    altura - padB - (v / maximo) * (altura - padT - padB);
  const x = (i: number): number =>
    padL + (i / Math.max(pontos.length - 1, 1)) * (larg - padL - padR);

  const linhas = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="grafico">
      <svg
        viewBox={`0 0 ${larg} ${altura}`}
        className="grafico-svg"
        role="img"
        aria-label={`Evolução de ${series.map((s) => s.nome).join(' e ')} por mês`}
      >
        {/* Grade horizontal: fio finíssimo, só para o olho ancorar o
            valor. Grade densa vira ruído e compete com o dado. */}
        {linhas.map((f) => {
          const y = padT + f * (altura - padT - padB);
          const valor = maximo * (1 - f);
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={larg - padR} y2={y} className="grafico-grade" />
              <text x={padL - 10} y={y + 4} className="grafico-eixo tabular" textAnchor="end">
                {formatador(valor)}
              </text>
            </g>
          );
        })}

        {series.map((s) => {
          const d = s.pontos
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${escala(p.valor)}`)
            .join(' ');

          return (
            <g key={s.nome}>
              <path
                d={d}
                fill="none"
                stroke={s.cor}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`grafico-linha ${desenhado ? 'desenhada' : ''}`}
              />
              {s.pontos.map((p, i) => (
                <circle
                  key={p.rotulo}
                  cx={x(i)}
                  cy={escala(p.valor)}
                  r={ativo === i ? 5 : 3}
                  fill={s.cor}
                  className="grafico-ponto"
                />
              ))}
            </g>
          );
        })}

        {/* Faixas invisíveis de captura: alvo de mouse e de teclado
            generoso, sem poluir o desenho. */}
        {pontos.map((p, i) => (
          <rect
            key={p.rotulo}
            x={x(i) - (larg - padL - padR) / (pontos.length * 2)}
            y={padT}
            width={(larg - padL - padR) / pontos.length}
            height={altura - padT - padB}
            fill="transparent"
            onMouseEnter={() => setAtivo(i)}
            onMouseLeave={() => setAtivo(null)}
          />
        ))}

        {pontos.map((p, i) => (
          <text key={p.rotulo} x={x(i)} y={altura - 12} className="grafico-eixo" textAnchor="middle">
            {p.rotulo}
          </text>
        ))}
      </svg>

      {ativo !== null && (
        <div className="grafico-leitura" role="status">
          <strong>{pontos[ativo]!.rotulo}</strong>
          {series.map((s) => (
            <span key={s.nome}>
              <i className="ponto-cor" style={{ background: s.cor }} aria-hidden="true" />
              {s.nome} <b className="tabular">{reais(s.pontos[ativo]?.valor ?? 0)}</b>
            </span>
          ))}
        </div>
      )}

      <div className="legenda">
        {series.map((s) => (
          <span key={s.nome}>
            <i className="ponto-cor" style={{ background: s.cor }} aria-hidden="true" />
            {s.nome}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ====================================================================
 * Estados
 * ================================================================== */

export function Carregando({ rotulo = 'Carregando' }: { rotulo?: string }): ReactNode {
  return (
    <div className="carregando" role="status" aria-live="polite">
      <span className="apenas-leitor-de-tela">{rotulo}</span>
      {/* Esqueleto com as proporções do conteúdo real, para a tela não
          saltar quando o dado chega. */}
      <div className="esqueleto" style={{ width: '38%' }} />
      <div className="esqueleto" style={{ width: '72%' }} />
      <div className="esqueleto" style={{ width: '54%' }} />
    </div>
  );
}

export function Vazio({ titulo, descricao }: { titulo: string; descricao: string }): ReactNode {
  return (
    <div className="estado-vazio">
      <h3>{titulo}</h3>
      <p>{descricao}</p>
    </div>
  );
}

export function Erro({ mensagem, aoTentar }: { mensagem: string; aoTentar?: () => void }): ReactNode {
  return (
    <div className="estado-erro" role="alert">
      <p>{mensagem}</p>
      {aoTentar !== undefined && (
        <button type="button" className="botao-secundario" onClick={aoTentar}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

/* ====================================================================
 * Janela
 * ================================================================== */

/**
 * Uma janela sobre a tela, para o que se resolve sem sair de onde se
 * está: configurações da conta, edição de um registro da lista.
 *
 * JANELA E NÃO PÁGINA quando o contexto importa. Trocar de tela para
 * mudar uma senha faz perder o lugar, e voltar de uma tela de edição
 * sempre deixa a dúvida de se salvou. Quando o assunto é grande o
 * bastante para merecer endereço próprio, aí sim é página.
 */
export function Janela({
  titulo,
  descricao,
  aoFechar,
  children,
}: {
  titulo: string;
  descricao?: string;
  aoFechar: () => void;
  children: ReactNode;
}): ReactNode {
  useEffect(() => {
    /* ESC FECHA — é o reflexo de quem usa teclado, e uma janela que só
       fecha no botão obriga a procurar o botão. */
    const aoTeclar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') aoFechar();
    };
    window.addEventListener('keydown', aoTeclar);

    /* E O FUNDO PARA DE ROLAR enquanto ela está aberta. Sem isto a roda
       do mouse sobre a janela rola a página atrás dela, e ao fechar a
       pessoa não reconhece mais onde estava. */
    const anterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', aoTeclar);
      document.body.style.overflow = anterior;
    };
  }, [aoFechar]);

  return (
    <div className="janela-fundo" onClick={aoFechar} role="presentation">
      <div
        className="janela"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="janela-topo">
          <div>
            <h2>{titulo}</h2>
            {descricao !== undefined && <p className="janela-sub">{descricao}</p>}
          </div>
          <button type="button" className="botao-texto" onClick={aoFechar}>
            Fechar
          </button>
        </div>
        <div className="janela-corpo">{children}</div>
      </div>
    </div>
  );
}
