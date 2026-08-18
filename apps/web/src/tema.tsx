import { useCallback, useEffect, useState, type ReactNode } from 'react';

/**
 * Seleção de tema.
 *
 * TRÊS ESTADOS POR DENTRO, DOIS BOTÕES POR FORA — e a diferença é
 * deliberada.
 *
 * O estado inicial é `sistema`: quem já pôs o computador em modo escuro
 * não deveria ter que repetir a decisão em cada aplicação, e o
 * navegador nos conta isso de graça pelo `prefers-color-scheme`. Só que
 * "seguir o sistema" não cabe num par de ícones, e a tela não deve
 * ganhar um terceiro botão de texto só para representar um padrão que
 * quase ninguém troca conscientemente.
 *
 * A saída: enquanto ninguém clicou, o modo é `sistema` e o ícone aceso é
 * o que o sistema operacional está pedindo naquele momento — a tela
 * nunca parece "sem seleção". No primeiro clique a escolha vira
 * explícita e passa a mandar. É a mesma coisa que qualquer aplicativo de
 * celular faz, e não custa um controle a mais.
 *
 * A escolha vai para localStorage. É preferência de exibição, não dado
 * sensível: não há problema em ficar legível para script da página, ao
 * contrário do token de sessão, que vive só em memória.
 */

export type Tema = 'claro' | 'escuro' | 'sistema';

const CHAVE = 'stz-tema';

function lerPreferencia(): Tema {
  const salvo = localStorage.getItem(CHAVE);
  return salvo === 'claro' || salvo === 'escuro' ? salvo : 'sistema';
}

function aplicar(tema: Tema): void {
  const raiz = document.documentElement;
  if (tema === 'sistema') {
    // Sem atributo, o CSS cai na consulta de prefers-color-scheme.
    raiz.removeAttribute('data-tema');
  } else {
    raiz.setAttribute('data-tema', tema);
  }
}

/** O que o sistema operacional está pedindo agora. */
function preferenciaDoSistema(): 'claro' | 'escuro' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
}

export function useTema(): {
  tema: Tema;
  /** O tema que está NA TELA — nunca 'sistema'. É o que o botão acende. */
  efetivo: 'claro' | 'escuro';
  definir: (t: Tema) => void;
} {
  const [tema, setTema] = useState<Tema>(() => {
    const inicial = lerPreferencia();
    aplicar(inicial);
    return inicial;
  });

  /* Guardado em estado, e não calculado na renderização: o resultado do
     matchMedia muda sem o React saber, e um valor derivado direto
     deixaria o ícone aceso errado até a próxima renderização por outro
     motivo. */
  const [doSistema, setDoSistema] = useState<'claro' | 'escuro'>(preferenciaDoSistema);

  const definir = useCallback((novo: Tema) => {
    setTema(novo);
    aplicar(novo);
    if (novo === 'sistema') localStorage.removeItem(CHAVE);
    else localStorage.setItem(CHAVE, novo);
  }, []);

  /* Se o usuário está em "sistema" e muda o modo do computador com a aba
     aberta, a tela acompanha na hora. Sem este ouvinte, ele teria que
     recarregar — e a preferência pareceria não funcionar.

     O ouvinte fica montado SEMPRE, mesmo com escolha explícita, porque
     ele também mantém `doSistema` em dia: quem escolheu claro à mão e
     depois volta para o automático precisa que o ícone certo acenda. */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const aoMudar = (): void => {
      setDoSistema(mq.matches ? 'escuro' : 'claro');
      if (lerPreferencia() === 'sistema') aplicar('sistema');
    };
    mq.addEventListener('change', aoMudar);
    return () => mq.removeEventListener('change', aoMudar);
  }, []);

  return { tema, efetivo: tema === 'sistema' ? doSistema : tema, definir };
}

/**
 * Sol e lua.
 *
 * Dois ícones lado a lado, e não um só que alterna. Um botão que troca
 * de ícone obriga a decidir se ele mostra o estado atual ou o resultado
 * do clique — e qualquer que seja a resposta, metade das pessoas lê ao
 * contrário. Com os dois visíveis não há o que interpretar: o aceso é
 * onde você está, o apagado é para onde você vai.
 *
 * `aria-pressed` em cada um, e não `role="switch"`: são duas opções
 * excludentes, que é o que um leitor de tela anuncia corretamente com
 * dois botões alternáveis.
 */
export function BotaoTema({
  efetivo,
  definir,
}: {
  efetivo: 'claro' | 'escuro';
  definir: (t: Tema) => void;
}): ReactNode {
  return (
    <div className="tema-troca" role="group" aria-label="Aparência">
      <button
        type="button"
        className={`tema-icone ${efetivo === 'claro' ? 'ativa' : ''}`}
        aria-pressed={efetivo === 'claro'}
        aria-label="Tema claro"
        title="Tema claro"
        onClick={() => definir('claro')}
      >
        <IconeSol />
      </button>
      <button
        type="button"
        className={`tema-icone ${efetivo === 'escuro' ? 'ativa' : ''}`}
        aria-pressed={efetivo === 'escuro'}
        aria-label="Tema escuro"
        title="Tema escuro"
        onClick={() => definir('escuro')}
      >
        <IconeLua />
      </button>
    </div>
  );
}

/* Traço de 1,6 e `currentColor`, como os ícones do menu: seguem a cor do
   botão (apagada, acesa quando ativo) sem precisar de uma segunda versão
   do arquivo. */
const svg = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function IconeSol(): ReactNode {
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </svg>
  );
}

function IconeLua(): ReactNode {
  return (
    <svg {...svg}>
      {/* Crescente por subtração de arco, não por duas formas sobrepostas:
          sobreposição só funciona quando o fundo é opaco, e este ícone
          vive sobre a coluna escura e sobre o conteúdo claro. */}
      <path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8z" />
    </svg>
  );
}
