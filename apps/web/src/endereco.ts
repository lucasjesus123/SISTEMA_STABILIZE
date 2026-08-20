import { useEffect, useRef, useState } from 'react';
import { cepCompleto } from '@stabilize/shared';
import { buscarCep, type EnderecoDeCep } from './api.js';

/**
 * Busca o endereço assim que o CEP fica completo.
 *
 * TRÊS COISAS QUE PARECEM DETALHE E SÃO O RECURSO INTEIRO:
 *
 * 1. DISPARA SOZINHO, no oitavo dígito. Não espera sair do campo, e não
 *    tem botão "buscar": quem digita CEP está justamente evitando digitar
 *    o resto, e um passo a mais devolve o trabalho que o recurso existe
 *    para tirar.
 *
 * 2. NÃO REESCREVE O QUE JÁ FOI PREENCHIDO À MÃO. Quem corrigiu o nome da
 *    rua — porque o CEP é de faixa e veio genérico — não pode perder a
 *    correção ao digitar o último dígito. O `aoEncontrar` recebe o
 *    endereço e quem chama decide campo a campo.
 *
 * 3. IGNORA RESPOSTA VELHA. Digitar rápido dispara mais de uma busca, e
 *    elas voltam fora de ordem: sem o contador, a resposta do CEP
 *    anterior chega depois e sobrescreve o endereço certo com o errado.
 *    É o defeito clássico de campo com busca automática, e é silencioso —
 *    só aparece com rede lenta, que é justamente a do celular do aluno.
 */
export function useBuscaDeCep(
  cepDigitado: string,
  aoEncontrar: (endereco: EnderecoDeCep) => void,
): { buscando: boolean; naoEncontrado: boolean; indisponivel: boolean } {
  const [buscando, setBuscando] = useState(false);
  const [naoEncontrado, setNaoEncontrado] = useState(false);
  /* Separado de `naoEncontrado` de propósito: um manda conferir o CEP, o
     outro manda digitar o endereço e seguir a vida. */
  const [indisponivel, setIndisponivel] = useState(false);

  /* Em ref, e não em estado: mudar de identidade não pode reexecutar a
     busca. Quem chama passa uma função nova a cada renderização — é o
     normal em React — e sem isto o efeito rodaria em laço. */
  const callback = useRef(aoEncontrar);
  callback.current = aoEncontrar;

  const ultimaBusca = useRef(0);
  /* Guarda o último CEP JÁ BUSCADO para não repetir a consulta quando a
     pessoa mexe em outro campo do formulário e o componente renderiza de
     novo com o mesmo CEP. */
  const jaBuscado = useRef<string | null>(null);

  const oitoDigitos = cepCompleto(cepDigitado);

  useEffect(() => {
    if (oitoDigitos === null) {
      setNaoEncontrado(false);
      setIndisponivel(false);
      /* Apagou um dígito: o próximo CEP completo deve buscar de novo,
         mesmo que seja o mesmo de antes. */
      jaBuscado.current = null;
      return;
    }
    if (jaBuscado.current === oitoDigitos) return;

    jaBuscado.current = oitoDigitos;
    const daVez = ++ultimaBusca.current;
    setBuscando(true);
    setNaoEncontrado(false);
    setIndisponivel(false);

    void (async () => {
      const endereco = await buscarCep(oitoDigitos);
      // Chegou tarde: já existe uma busca mais nova. Descarta.
      if (daVez !== ultimaBusca.current) return;
      setBuscando(false);
      if (endereco === 'nao-encontrado') setNaoEncontrado(true);
      else if (endereco === 'indisponivel') setIndisponivel(true);
      else callback.current(endereco);
    })();
  }, [oitoDigitos]);

  return { buscando, naoEncontrado, indisponivel };
}

/**
 * Aplica o endereço encontrado SEM apagar o que já estava preenchido.
 *
 * Só escreve em campo vazio. O CEP dos Correios é bom para bairro e
 * cidade e às vezes genérico no logradouro; quem já tinha corrigido a
 * rua mantém a correção, e quem não tinha nada ganha tudo preenchido.
 */
export function mesclarEndereco<T extends object>(
  atual: T,
  achado: EnderecoDeCep,
  chaves: { logradouro: keyof T; bairro: keyof T; cidade: keyof T; uf: keyof T },
): T {
  const vazio = (v: unknown): boolean => v === undefined || v === null || v === '';
  const proximo: T = { ...atual };
  if (vazio(proximo[chaves.logradouro]) && achado.logradouro !== null) {
    proximo[chaves.logradouro] = achado.logradouro as T[keyof T];
  }
  if (vazio(proximo[chaves.bairro]) && achado.bairro !== null) {
    proximo[chaves.bairro] = achado.bairro as T[keyof T];
  }
  if (vazio(proximo[chaves.cidade]) && achado.cidade !== null) {
    proximo[chaves.cidade] = achado.cidade as T[keyof T];
  }
  if (vazio(proximo[chaves.uf]) && achado.uf !== null) {
    proximo[chaves.uf] = achado.uf as T[keyof T];
  }
  return proximo;
}
