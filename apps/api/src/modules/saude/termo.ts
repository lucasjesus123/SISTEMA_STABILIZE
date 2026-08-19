/**
 * O PAR-Q e o termo padrão.
 *
 * AS SETE PERGUNTAS SÃO AS DO PAR-Q, e não uma lista inventada. O
 * questionário existe desde 1978, foi revisado por sociedades de
 * medicina do esporte e é o que um perito reconhece. Um formulário
 * caseiro com perguntas parecidas não tem esse peso: numa discussão
 * sobre o que a academia deveria ter perguntado, "usamos o PAR-Q" é uma
 * resposta e "fizemos o nosso" é o começo de outra pergunta.
 *
 * O TEXTO DAS PERGUNTAS TAMBÉM É CONGELADO na assinatura, junto com o
 * termo — pelo mesmo motivo. Se um dia a redação mudar, o que foi
 * respondido continua legível como foi lido.
 */

export interface PerguntaDoParq {
  chave: string;
  texto: string;
}

/* As chaves são as que a coluna gerada `precisa_liberacao_medica`
   verifica no banco. Renomear uma aqui sem mexer na migração faria a
   regra parar de enxergar aquela resposta — e um "sim" deixaria de
   exigir atestado, em silêncio. */
export const PERGUNTAS_PARQ: PerguntaDoParq[] = [
  {
    chave: 'coracao',
    texto:
      'Algum médico já disse que você possui algum problema de coração e que só deveria fazer atividade física supervisionado por profissionais de saúde?',
  },
  {
    chave: 'dor_no_peito',
    texto: 'Você sente dores no peito quando pratica atividade física?',
  },
  {
    chave: 'tontura',
    texto:
      'No último mês, você sentiu dores no peito quando praticou atividade física, ou perdeu o equilíbrio por tontura ou desmaiou?',
  },
  {
    chave: 'osso_articulacao',
    texto:
      'Você tem algum problema ósseo ou articular que poderia ser piorado pela atividade física?',
  },
  {
    chave: 'remedio_pressao',
    texto:
      'Você toma atualmente algum medicamento para pressão arterial ou problema de coração?',
  },
  {
    chave: 'outra_razao',
    texto: 'Sabe de alguma outra razão pela qual você não deve praticar atividade física?',
  },
  {
    chave: 'gravidez',
    texto: 'Você está grávida ou teve bebê nos últimos três meses?',
  },
];

export const CHAVES_PARQ = new Set(PERGUNTAS_PARQ.map((p) => p.chave));

/**
 * O termo padrão, usado quando a academia não escreveu o dela.
 *
 * NÃO É CONSELHO JURÍDICO e o texto diz isso a quem administra, na
 * tela. O que ele faz é cobrir o mínimo que toda academia precisa ter
 * declarado — que a pessoa respondeu com verdade, que foi informada de
 * que precisa de liberação médica se respondeu "sim", e que se
 * compromete a avisar se a saúde mudar.
 *
 * `{{academia}}` é o único marcador. Mais marcadores viram um sistema de
 * modelos, e um sistema de modelos vira um jeito de errar o texto de um
 * documento assinado.
 */
export const TERMO_PADRAO = `TERMO DE RESPONSABILIDADE E CIÊNCIA — {{academia}}

1. Declaro que respondi ao questionário de prontidão para atividade física (PAR-Q) de forma verdadeira e completa, por minha própria conta.

2. Estou ciente de que, tendo respondido SIM a qualquer uma das perguntas, devo procurar um médico e apresentar liberação por escrito antes de iniciar ou retomar a prática de atividade física, e que a {{academia}} pode condicionar o início dos treinos à entrega desse documento.

3. Estou ciente de que a prática de atividade física envolve riscos à saúde, inclusive de lesão, e que esses riscos aumentam quando há condição de saúde não informada.

4. Comprometo-me a informar imediatamente à equipe da {{academia}} qualquer mudança no meu estado de saúde, uso de medicamento, cirurgia, lesão ou gravidez que ocorra depois desta data.

5. Comprometo-me a seguir as orientações dos profissionais que me atendem, a respeitar os limites indicados e a interromper o exercício e comunicar a equipe caso sinta dor, tontura, falta de ar ou mal-estar.

6. Autorizo a {{academia}} a registrar e guardar estas informações de saúde para a finalidade de acompanhar meu treinamento com segurança, nos termos da Lei nº 13.709/2018 (LGPD), e estou ciente de que posso solicitar acesso, correção ou exclusão dos meus dados.

Ao assinar, confirmo que li e compreendi este termo.`;

export function montarTermo(modelo: string | null, academia: string): string {
  return (modelo ?? TERMO_PADRAO).replaceAll('{{academia}}', academia);
}
