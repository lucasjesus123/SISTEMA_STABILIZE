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

export interface PerguntaDaTriagem {
  /** Estável: é a chave gravada nas respostas e a que o gatilho lê. */
  chave: string;
  texto: string;
  /** Um SIM aqui obriga liberação médica antes de treinar. */
  exigeLiberacao: boolean;
  /** De onde a pergunta veio — o padrão do sistema ou a academia. */
  origem: 'PARQ' | 'ACADEMIA';
}

/** Compatibilidade com o nome antigo, quando só existia o PAR-Q. */
export type PerguntaDoParq = PerguntaDaTriagem;

/* AS SETE DO PAR-Q, e todas com `exigeLiberacao: true` — é a regra do
   questionário: um "sim" em qualquer uma manda procurar um médico.

   As chaves são gravadas dentro das respostas e lidas pelo gatilho do
   banco. Renomear uma aqui sem migrar os dados faz aquele "sim" deixar
   de exigir atestado, em silêncio.

   Esta lista é o PADRÃO, e não mais a única possibilidade: cada academia
   pode ajustar a redação, reordenar e acrescentar perguntas próprias.
   O que ela não deve fazer é apagar as do PAR-Q — a tela avisa por quê. */
export const PERGUNTAS_PARQ: PerguntaDaTriagem[] = [
  {
    chave: 'coracao',
    texto:
      'Algum médico já disse que você possui algum problema de coração e que só deveria fazer atividade física supervisionado por profissionais de saúde?',
    exigeLiberacao: true,
    origem: 'PARQ',
  },
  {
    chave: 'dor_no_peito',
    texto: 'Você sente dores no peito quando pratica atividade física?',
    exigeLiberacao: true,
    origem: 'PARQ',
  },
  {
    chave: 'tontura',
    texto:
      'No último mês, você sentiu dores no peito quando praticou atividade física, ou perdeu o equilíbrio por tontura ou desmaiou?',
    exigeLiberacao: true,
    origem: 'PARQ',
  },
  {
    chave: 'osso_articulacao',
    texto:
      'Você tem algum problema ósseo ou articular que poderia ser piorado pela atividade física?',
    exigeLiberacao: true,
    origem: 'PARQ',
  },
  {
    chave: 'remedio_pressao',
    texto:
      'Você toma atualmente algum medicamento para pressão arterial ou problema de coração?',
    exigeLiberacao: true,
    origem: 'PARQ',
  },
  {
    chave: 'outra_razao',
    texto: 'Sabe de alguma outra razão pela qual você não deve praticar atividade física?',
    exigeLiberacao: true,
    origem: 'PARQ',
  },
  {
    chave: 'gravidez',
    texto: 'Você está grávida ou teve bebê nos últimos três meses?',
    exigeLiberacao: true,
    origem: 'PARQ',
  },
];

export const CHAVES_PARQ = new Set(PERGUNTAS_PARQ.map((p) => p.chave));

/**
 * Normaliza um texto em chave estável: "Já treinou antes?" → "ja_treinou_antes".
 *
 * A CHAVE NUNCA MUDA DEPOIS DE CRIADA. Ela é o que amarra a resposta
 * gravada à pergunta; regerá-la a partir do texto editado faria as
 * respostas antigas apontarem para o vazio. Por isso quem edita o texto
 * de uma pergunta existente mantém a chave dela — esta função só serve
 * para batizar pergunta NOVA.
 */
export function chaveDe(texto: string, jaUsadas: Set<string>): string {
  const base =
    texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'pergunta';

  if (!jaUsadas.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const tentativa = `${base}_${i}`;
    if (!jaUsadas.has(tentativa)) return tentativa;
  }
  return `${base}_${Date.now()}`;
}

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
