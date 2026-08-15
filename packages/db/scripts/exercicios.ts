/**
 * Catálogo inicial de exercícios.
 *
 * Uma academia que abre o sistema e encontra uma biblioteca VAZIA não
 * prescreve treino nenhum: cadastrar setenta exercícios antes de montar
 * o primeiro treino é o tipo de trabalho que faz a pessoa desistir do
 * módulo e voltar para o caderno.
 *
 * O catálogo é copiado para cada empresa na criação, e a partir daí é
 * dela: renomear, ajustar instrução e desativar não afetam ninguém.
 *
 * As instruções são curtas de propósito — o que impede o erro mais
 * comum do movimento, não um manual. Quem lê está com o aluno na
 * frente.
 */

export interface ExercicioSemente {
  nome: string;
  grupo: string;
  equipamento?: string;
  instrucoes?: string;
}

export const CATALOGO: readonly ExercicioSemente[] = [
  // ---- Peito ----
  { nome: 'Supino reto com barra', grupo: 'PEITO', equipamento: 'Barra',
    instrucoes: 'Escápulas retraídas e pés firmes. A barra desce na linha do mamilo, não do pescoço.' },
  { nome: 'Supino inclinado com halteres', grupo: 'PEITO', equipamento: 'Halteres',
    instrucoes: 'Banco a 30–45°. Acima disso o ombro assume o trabalho.' },
  { nome: 'Crucifixo na máquina', grupo: 'PEITO', equipamento: 'Máquina',
    instrucoes: 'Cotovelos levemente flexionados e fixos durante todo o movimento.' },
  { nome: 'Crossover na polia', grupo: 'PEITO', equipamento: 'Polia' },
  { nome: 'Flexão de braço', grupo: 'PEITO', equipamento: 'Peso corporal',
    instrucoes: 'Corpo em prancha. Quadril caindo é sinal de fadiga do core, não do peito.' },

  // ---- Costas ----
  { nome: 'Puxada frontal na polia alta', grupo: 'COSTAS', equipamento: 'Polia',
    instrucoes: 'Puxar com os cotovelos, não com as mãos. Barra à frente, nunca atrás da nuca.' },
  { nome: 'Remada curvada com barra', grupo: 'COSTAS', equipamento: 'Barra',
    instrucoes: 'Coluna neutra e quadril para trás. Se a lombar arredonda, reduza a carga.' },
  { nome: 'Remada baixa sentada', grupo: 'COSTAS', equipamento: 'Polia' },
  { nome: 'Remada unilateral com halter', grupo: 'COSTAS', equipamento: 'Halteres' },
  { nome: 'Barra fixa', grupo: 'COSTAS', equipamento: 'Peso corporal' },
  { nome: 'Pullover na polia', grupo: 'COSTAS', equipamento: 'Polia' },

  // ---- Ombro ----
  { nome: 'Desenvolvimento com halteres', grupo: 'OMBRO', equipamento: 'Halteres',
    instrucoes: 'Não trave o cotovelo no topo. Costelas para baixo para poupar a lombar.' },
  { nome: 'Elevação lateral', grupo: 'OMBRO', equipamento: 'Halteres',
    instrucoes: 'Sobe até a linha do ombro. Acima disso entra trapézio.' },
  { nome: 'Elevação frontal', grupo: 'OMBRO', equipamento: 'Halteres' },
  { nome: 'Crucifixo inverso', grupo: 'OMBRO', equipamento: 'Máquina',
    instrucoes: 'Trabalha o deltoide posterior — o que costuma faltar em quem senta o dia todo.' },
  { nome: 'Remada alta', grupo: 'OMBRO', equipamento: 'Barra' },
  { nome: 'Face pull', grupo: 'OMBRO', equipamento: 'Polia',
    instrucoes: 'Puxar na altura do rosto, cotovelos altos. Excelente para postura.' },

  // ---- Bíceps ----
  { nome: 'Rosca direta com barra', grupo: 'BICEPS', equipamento: 'Barra' },
  { nome: 'Rosca alternada com halteres', grupo: 'BICEPS', equipamento: 'Halteres' },
  { nome: 'Rosca martelo', grupo: 'BICEPS', equipamento: 'Halteres' },
  { nome: 'Rosca scott', grupo: 'BICEPS', equipamento: 'Máquina' },
  { nome: 'Rosca concentrada', grupo: 'BICEPS', equipamento: 'Halteres' },

  // ---- Tríceps ----
  { nome: 'Tríceps na polia com barra', grupo: 'TRICEPS', equipamento: 'Polia',
    instrucoes: 'Cotovelos colados ao tronco. Se abrem, virou supino.' },
  { nome: 'Tríceps francês', grupo: 'TRICEPS', equipamento: 'Halteres' },
  { nome: 'Tríceps corda', grupo: 'TRICEPS', equipamento: 'Polia' },
  { nome: 'Mergulho no banco', grupo: 'TRICEPS', equipamento: 'Peso corporal' },
  { nome: 'Supino fechado', grupo: 'TRICEPS', equipamento: 'Barra' },

  // ---- Antebraço ----
  { nome: 'Rosca de punho', grupo: 'ANTEBRACO', equipamento: 'Halteres' },
  { nome: 'Caminhada do fazendeiro', grupo: 'ANTEBRACO', equipamento: 'Halteres',
    instrucoes: 'Ombros para trás, passos curtos. Mede preensão e core ao mesmo tempo.' },

  // ---- Abdômen e lombar ----
  { nome: 'Prancha isométrica', grupo: 'ABDOMEN', equipamento: 'Peso corporal',
    instrucoes: 'Glúteo contraído e costelas para baixo. Tempo só conta enquanto a forma se mantém.' },
  { nome: 'Prancha lateral', grupo: 'ABDOMEN', equipamento: 'Peso corporal' },
  { nome: 'Abdominal supra no solo', grupo: 'ABDOMEN', equipamento: 'Peso corporal' },
  { nome: 'Elevação de pernas suspenso', grupo: 'ABDOMEN', equipamento: 'Barra fixa' },
  { nome: 'Abdominal na polia (canivete)', grupo: 'ABDOMEN', equipamento: 'Polia' },
  { nome: 'Extensão lombar no banco romano', grupo: 'LOMBAR', equipamento: 'Banco romano',
    instrucoes: 'Subir até a linha do corpo, sem hiperestender.' },
  { nome: 'Bird dog', grupo: 'LOMBAR', equipamento: 'Peso corporal',
    instrucoes: 'Braço e perna opostos. O quadril não pode rodar — é o ponto do exercício.' },

  // ---- Glúteo e posterior ----
  { nome: 'Elevação pélvica com barra', grupo: 'GLUTEO', equipamento: 'Barra',
    instrucoes: 'Queixo para o peito e costelas para baixo. Pausa de 1 s no topo.' },
  { nome: 'Coice na polia', grupo: 'GLUTEO', equipamento: 'Polia' },
  { nome: 'Abdução na máquina', grupo: 'GLUTEO', equipamento: 'Máquina' },
  { nome: 'Levantamento terra romeno', grupo: 'POSTERIOR', equipamento: 'Barra',
    instrucoes: 'Quadril para trás, joelhos quase estendidos. Para quando a lombar quiser arredondar.' },
  { nome: 'Mesa flexora', grupo: 'POSTERIOR', equipamento: 'Máquina' },
  { nome: 'Flexora em pé', grupo: 'POSTERIOR', equipamento: 'Máquina' },
  { nome: 'Bom dia com barra', grupo: 'POSTERIOR', equipamento: 'Barra' },

  // ---- Quadríceps ----
  { nome: 'Agachamento livre', grupo: 'QUADRICEPS', equipamento: 'Barra',
    instrucoes: 'Pés na largura do quadril, joelho acompanha a ponta do pé.' },
  { nome: 'Agachamento na caixa', grupo: 'QUADRICEPS', equipamento: 'Barra',
    instrucoes: 'Boa escolha para quem ainda não controla a profundidade.' },
  { nome: 'Leg press 45°', grupo: 'QUADRICEPS', equipamento: 'Máquina',
    instrucoes: 'Não deixe a lombar descolar do encosto no fundo do movimento.' },
  { nome: 'Cadeira extensora', grupo: 'QUADRICEPS', equipamento: 'Máquina' },
  { nome: 'Afundo com halteres', grupo: 'QUADRICEPS', equipamento: 'Halteres' },
  { nome: 'Búlgaro', grupo: 'QUADRICEPS', equipamento: 'Halteres' },
  { nome: 'Hack machine', grupo: 'QUADRICEPS', equipamento: 'Máquina' },

  // ---- Panturrilha ----
  { nome: 'Panturrilha em pé', grupo: 'PANTURRILHA', equipamento: 'Máquina' },
  { nome: 'Panturrilha sentado', grupo: 'PANTURRILHA', equipamento: 'Máquina' },

  // ---- Corpo inteiro ----
  { nome: 'Levantamento terra convencional', grupo: 'CORPO_INTEIRO', equipamento: 'Barra',
    instrucoes: 'Barra colada à canela. Se a lombar arredonda na saída, a carga está alta.' },
  { nome: 'Kettlebell swing', grupo: 'CORPO_INTEIRO', equipamento: 'Kettlebell',
    instrucoes: 'Movimento de quadril, não de ombro. O kettlebell é jogado, não levantado.' },
  { nome: 'Burpee', grupo: 'CORPO_INTEIRO', equipamento: 'Peso corporal' },
  { nome: 'Thruster', grupo: 'CORPO_INTEIRO', equipamento: 'Halteres' },

  // ---- Mobilidade ----
  { nome: 'Mobilidade de quadril 90/90', grupo: 'MOBILIDADE', equipamento: 'Peso corporal' },
  { nome: 'Gato e camelo', grupo: 'MOBILIDADE', equipamento: 'Peso corporal' },
  { nome: 'Alongamento de peitoral na parede', grupo: 'MOBILIDADE', equipamento: 'Peso corporal' },
  { nome: 'Mobilidade torácica deitado', grupo: 'MOBILIDADE', equipamento: 'Peso corporal' },
  { nome: 'Alongamento de isquiotibiais', grupo: 'MOBILIDADE', equipamento: 'Peso corporal' },

  // ---- Cardio ----
  { nome: 'Esteira — caminhada inclinada', grupo: 'CARDIO', equipamento: 'Esteira' },
  { nome: 'Esteira — corrida contínua', grupo: 'CARDIO', equipamento: 'Esteira' },
  { nome: 'Bicicleta ergométrica', grupo: 'CARDIO', equipamento: 'Bicicleta' },
  { nome: 'Remo ergômetro', grupo: 'CARDIO', equipamento: 'Remo' },
  { nome: 'Corda naval', grupo: 'CARDIO', equipamento: 'Corda' },
  { nome: 'Escada ergométrica', grupo: 'CARDIO', equipamento: 'Escada' },
];

/**
 * Faixa de carga plausível, em quilos, para os dados de demonstração.
 *
 * Sortear 8–60 kg para tudo produzia "Elevação lateral · 57 kg" na tela
 * — uma carga que ninguém levanta. Número absurdo em dado fictício não
 * é detalhe: quem avalia o sistema é um profissional, e ele para de
 * confiar no módulo inteiro quando a primeira linha que lê está errada.
 *
 * Ausente da lista = sem carga (peso corporal, mobilidade, cardio).
 */
export const CARGA_PLAUSIVEL: Readonly<Record<string, readonly [number, number]>> = {
  'Supino reto com barra': [30, 90],
  'Supino inclinado com halteres': [12, 34],
  'Crucifixo na máquina': [20, 55],
  'Crossover na polia': [10, 30],
  'Puxada frontal na polia alta': [30, 75],
  'Remada curvada com barra': [25, 70],
  'Remada baixa sentada': [30, 75],
  'Remada unilateral com halter': [14, 40],
  'Pullover na polia': [15, 45],
  'Desenvolvimento com halteres': [10, 30],
  'Elevação lateral': [4, 14],
  'Elevação frontal': [4, 14],
  'Crucifixo inverso': [10, 30],
  'Remada alta': [15, 40],
  'Face pull': [10, 30],
  'Rosca direta com barra': [10, 35],
  'Rosca alternada com halteres': [6, 22],
  'Rosca martelo': [8, 22],
  'Rosca scott': [10, 30],
  'Rosca concentrada': [6, 16],
  'Tríceps na polia com barra': [15, 45],
  'Tríceps francês': [8, 25],
  'Tríceps corda': [12, 35],
  'Supino fechado': [25, 70],
  'Rosca de punho': [4, 14],
  'Caminhada do fazendeiro': [16, 40],
  'Abdominal na polia (canivete)': [15, 40],
  'Elevação pélvica com barra': [40, 120],
  'Coice na polia': [8, 25],
  'Abdução na máquina': [20, 60],
  'Levantamento terra romeno': [30, 90],
  'Mesa flexora': [20, 55],
  'Flexora em pé': [10, 30],
  'Bom dia com barra': [20, 50],
  'Agachamento livre': [30, 110],
  'Agachamento na caixa': [25, 80],
  'Leg press 45°': [80, 260],
  'Cadeira extensora': [25, 70],
  'Afundo com halteres': [10, 28],
  'Búlgaro': [8, 24],
  'Hack machine': [40, 140],
  'Panturrilha em pé': [40, 120],
  'Panturrilha sentado': [20, 60],
  'Levantamento terra convencional': [40, 130],
  'Kettlebell swing': [12, 32],
  'Thruster': [10, 30],
};
