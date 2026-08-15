import { useCallback, useEffect, useState, type ReactNode } from 'react';

/**
 * Seleção de tema.
 *
 * Três estados, não dois: claro, escuro e SISTEMA. O terceiro é o
 * padrão, e é ele que importa — quem já configurou o computador em
 * modo escuro não deveria ter que repetir essa decisão em cada
 * aplicação. Só depois de uma escolha explícita o sistema operacional
 * deixa de mandar.
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

export function useTema(): { tema: Tema; definir: (t: Tema) => void } {
  const [tema, setTema] = useState<Tema>(() => {
    const inicial = lerPreferencia();
    aplicar(inicial);
    return inicial;
  });

  const definir = useCallback((novo: Tema) => {
    setTema(novo);
    aplicar(novo);
    if (novo === 'sistema') localStorage.removeItem(CHAVE);
    else localStorage.setItem(CHAVE, novo);
  }, []);

  /* Se o usuário está em "sistema" e muda o modo do computador com a
     aba aberta, a tela acompanha na hora. Sem este ouvinte, ele teria
     que recarregar — e a preferência pareceria não funcionar. */
  useEffect(() => {
    if (tema !== 'sistema') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const aoMudar = (): void => aplicar('sistema');
    mq.addEventListener('change', aoMudar);
    return () => mq.removeEventListener('change', aoMudar);
  }, [tema]);

  return { tema, definir };
}

/**
 * Seletor de três posições.
 *
 * Um interruptor de dois estados não consegue representar "siga o
 * sistema", e é por isso que tantos aplicativos perdem essa opção. Três
 * botões num grupo resolvem, e ainda deixam o estado atual visível sem
 * precisar interpretar um ícone.
 */
export function SeletorTema({
  tema,
  definir,
}: {
  tema: Tema;
  definir: (t: Tema) => void;
}): ReactNode {
  const opcoes: { id: Tema; nome: string; rotulo: string }[] = [
    { id: 'claro', nome: 'Claro', rotulo: 'Usar tema claro' },
    { id: 'sistema', nome: 'Auto', rotulo: 'Seguir a preferência do sistema' },
    { id: 'escuro', nome: 'Escuro', rotulo: 'Usar tema escuro' },
  ];

  return (
    <div className="seletor-tema" role="group" aria-label="Aparência">
      {opcoes.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`seletor-opcao ${tema === o.id ? 'ativa' : ''}`}
          aria-pressed={tema === o.id}
          title={o.rotulo}
          onClick={() => definir(o.id)}
        >
          {o.nome}
        </button>
      ))}
    </div>
  );
}
