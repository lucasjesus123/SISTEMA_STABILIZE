/**
 * Motor de horários da agenda.
 *
 * Funções PURAS: recebem as regras, os bloqueios e os compromissos já
 * existentes, e devolvem os horários livres. Nenhum acesso a banco,
 * nenhuma dependência de relógio — o "agora" entra como parâmetro.
 *
 * Isso é deliberado. O cálculo de disponibilidade é a lógica mais
 * sujeita a erro de toda a agenda (fuso, virada de dia, sobreposição,
 * intervalo aberto ou fechado), e é justamente a que mais precisa de
 * teste exaustivo. Amarrada ao banco, cada caso de borda exigiria
 * montar dados; pura, roda em milissegundos e cobre centenas de casos.
 *
 * Convenção que vale para o arquivo inteiro: todo intervalo é
 * SEMIABERTO — [início, fim). Encostar não é sobrepor: 9h-10h e
 * 10h-11h convivem. É a mesma convenção do tstzrange '[)' usado nas
 * restrições do banco, e manter as duas iguais evita o caso perverso em
 * que a API oferece um horário que o banco depois recusa.
 */

export interface Intervalo {
  readonly inicio: Date;
  readonly fim: Date;
}

/** Janela recorrente declarada pelo profissional. */
export interface RegraDisponibilidade {
  /** 0 = domingo ... 6 = sábado */
  readonly weekday: number;
  /** "06:00" */
  readonly startTime: string;
  /** "12:00" */
  readonly endTime: string;
  readonly slotMinutes: number;
  readonly roomId?: string | null;
  readonly validFrom?: Date | null;
  readonly validUntil?: Date | null;
}

export interface OpcoesGeracao {
  /** Início do período consultado (inclusive). */
  readonly de: Date;
  /** Fim do período consultado (exclusive). */
  readonly ate: Date;
  readonly regras: readonly RegraDisponibilidade[];
  /** Compromissos e bloqueios que tornam o horário indisponível. */
  readonly ocupacoes: readonly Intervalo[];
  /** Momento atual — horários no passado não são oferecidos. */
  readonly agora: Date;
  /**
   * Antecedência mínima para reservar, em minutos.
   * Sem isto o aluno marca para "daqui a dois minutos" e o profissional
   * descobre em cima da hora.
   */
  readonly antecedenciaMinutos?: number;
  /** Fuso do estabelecimento, ex.: 'America/Sao_Paulo'. */
  readonly timeZone: string;
}

export interface Slot extends Intervalo {
  readonly roomId?: string | null;
}

export class SlotError extends Error {
  override readonly name = 'SlotError';
}

const MS_MINUTO = 60_000;
const MAX_DIAS = 120;

/**
 * `true` se os dois intervalos se sobrepõem.
 * Semiaberto: `a.fim === b.inicio` NÃO é sobreposição.
 */
export function sobrepoe(a: Intervalo, b: Intervalo): boolean {
  return a.inicio < b.fim && b.inicio < a.fim;
}

/** Une intervalos que se tocam ou se sobrepõem, devolvendo o mínimo de blocos. */
export function unir(intervalos: readonly Intervalo[]): Intervalo[] {
  if (intervalos.length === 0) return [];

  const ordenados = [...intervalos].sort((x, y) => x.inicio.getTime() - y.inicio.getTime());
  const saida: Intervalo[] = [];
  let atual = { inicio: ordenados[0]!.inicio, fim: ordenados[0]!.fim };

  for (let i = 1; i < ordenados.length; i += 1) {
    const proximo = ordenados[i]!;
    if (proximo.inicio <= atual.fim) {
      // Toca ou sobrepõe: estende o bloco atual.
      if (proximo.fim > atual.fim) atual = { inicio: atual.inicio, fim: proximo.fim };
    } else {
      saida.push(atual);
      atual = { inicio: proximo.inicio, fim: proximo.fim };
    }
  }
  saida.push(atual);
  return saida;
}

/**
 * Componentes de data no fuso informado.
 *
 * O motivo de existir: uma regra "segunda-feira, 06:00" é uma afirmação
 * sobre o RELÓGIO DA PAREDE da academia, não sobre UTC. Em março e em
 * outubro o Brasil já mudou de horário; se o cálculo for feito em UTC,
 * a agenda escorrega uma hora nesses dias. `Intl.DateTimeFormat` com o
 * fuso resolve isso sem tabela de fuso própria.
 */
function partesNoFuso(data: Date, timeZone: string): {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const partes = Object.fromEntries(
    fmt.formatToParts(data).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const mapaDia: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    ano: Number(partes['year']),
    mes: Number(partes['month']),
    dia: Number(partes['day']),
    // 24h pode vir como "24" à meia-noite em algumas plataformas.
    hora: Number(partes['hour']) % 24,
    minuto: Number(partes['minute']),
    weekday: mapaDia[partes['weekday'] ?? 'Sun'] ?? 0,
  };
}

/**
 * Converte "data local + hora local" no fuso para o instante absoluto.
 *
 * Faz duas passadas porque o deslocamento do fuso depende da própria
 * data (horário de verão): a primeira estimativa dá o deslocamento
 * aproximado, a segunda corrige. Duas passadas bastam para qualquer
 * fuso real, incluindo os de meia hora.
 */
function instanteDe(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  timeZone: string,
): Date {
  const palpite = Date.UTC(ano, mes - 1, dia, hora, minuto, 0, 0);
  let resultado = new Date(palpite);

  for (let passada = 0; passada < 2; passada += 1) {
    const p = partesNoFuso(resultado, timeZone);
    const obtido = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, 0, 0);
    const desejado = Date.UTC(ano, mes - 1, dia, hora, minuto, 0, 0);
    const erro = desejado - obtido;
    if (erro === 0) break;
    resultado = new Date(resultado.getTime() + erro);
  }

  return resultado;
}

function parseHora(texto: string): { hora: number; minuto: number } {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(texto.trim());
  if (m === null) throw new SlotError(`horário inválido: "${texto}"`);
  const hora = Number(m[1]);
  const minuto = Number(m[2]);
  if (hora > 24 || minuto > 59) throw new SlotError(`horário fora do intervalo: "${texto}"`);
  return { hora, minuto };
}

/**
 * Gera os horários livres do período.
 *
 * A ordem das operações importa e é sempre esta:
 *   1. materializa as janelas das regras, dia a dia, no fuso local;
 *   2. fatia cada janela em slots do tamanho declarado;
 *   3. descarta o que está no passado ou dentro da antecedência mínima;
 *   4. descarta o que colide com ocupação.
 *
 * Fazer (4) antes de (2) seria mais rápido e estaria errado: um
 * compromisso de 30 minutos no meio de uma janela não invalida a janela
 * inteira, apenas os slots que ele toca.
 */
export function gerarSlots(opcoes: OpcoesGeracao): Slot[] {
  const { de, ate, regras, ocupacoes, agora, timeZone } = opcoes;
  const antecedencia = opcoes.antecedenciaMinutos ?? 0;

  if (!(de instanceof Date) || Number.isNaN(de.getTime())) {
    throw new SlotError('data inicial inválida');
  }
  if (!(ate instanceof Date) || Number.isNaN(ate.getTime())) {
    throw new SlotError('data final inválida');
  }
  if (ate <= de) return [];

  const dias = Math.ceil((ate.getTime() - de.getTime()) / (24 * 60 * MS_MINUTO));
  if (dias > MAX_DIAS) {
    /* Teto de período. Sem ele, uma consulta de "10 anos" gera centenas
       de milhares de slots e vira negação de serviço com um único
       request — e o custo é todo do servidor. */
    throw new SlotError(`período longo demais: máximo de ${MAX_DIAS} dias`);
  }

  const ocupacoesUnidas = unir(ocupacoes);
  const naoDisponivelAntesDe = new Date(agora.getTime() + antecedencia * MS_MINUTO);

  const slots: Slot[] = [];

  // Varre um dia a mais em cada ponta: uma janela pode começar no fim de
  // um dia local e ainda pertencer ao período consultado em UTC.
  const inicioVarredura = new Date(de.getTime() - 24 * 60 * MS_MINUTO);
  const fimVarredura = new Date(ate.getTime() + 24 * 60 * MS_MINUTO);

  for (
    let cursor = inicioVarredura.getTime();
    cursor <= fimVarredura.getTime();
    cursor += 24 * 60 * MS_MINUTO
  ) {
    const dataDoDia = new Date(cursor);
    const p = partesNoFuso(dataDoDia, timeZone);

    for (const regra of regras) {
      if (regra.weekday !== p.weekday) continue;

      const inicioDoDiaLocal = instanteDe(p.ano, p.mes, p.dia, 0, 0, timeZone);
      if (regra.validFrom != null && inicioDoDiaLocal < truncarDia(regra.validFrom)) continue;
      if (regra.validUntil != null && inicioDoDiaLocal > fimDoDia(regra.validUntil)) continue;

      const ini = parseHora(regra.startTime);
      const fim = parseHora(regra.endTime);

      const janelaInicio = instanteDe(p.ano, p.mes, p.dia, ini.hora, ini.minuto, timeZone);
      const janelaFim = instanteDe(p.ano, p.mes, p.dia, fim.hora, fim.minuto, timeZone);

      if (janelaFim <= janelaInicio) continue;
      if (regra.slotMinutes <= 0) throw new SlotError('duração de slot inválida');

      const passo = regra.slotMinutes * MS_MINUTO;

      for (let t = janelaInicio.getTime(); t + passo <= janelaFim.getTime(); t += passo) {
        const slot: Slot = {
          inicio: new Date(t),
          fim: new Date(t + passo),
          roomId: regra.roomId ?? null,
        };

        // Fora do período consultado.
        if (slot.inicio < de || slot.fim > ate) continue;
        // Passado, ou dentro da antecedência mínima.
        if (slot.inicio < naoDisponivelAntesDe) continue;
        // Colide com compromisso ou bloqueio.
        if (ocupacoesUnidas.some((o) => sobrepoe(slot, o))) continue;

        slots.push(slot);
      }
    }
  }

  slots.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  return dedup(slots);
}

/**
 * Remove slots idênticos.
 *
 * Duas regras podem cobrir a mesma faixa — por exemplo, uma janela geral
 * e outra específica de sala. Sem isto o aluno veria o mesmo horário
 * duas vezes na tela.
 */
function dedup(slots: readonly Slot[]): Slot[] {
  const vistos = new Set<string>();
  const saida: Slot[] = [];
  for (const s of slots) {
    const chave = `${s.inicio.getTime()}|${s.fim.getTime()}|${s.roomId ?? ''}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(s);
  }
  return saida;
}

function truncarDia(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function fimDoDia(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/**
 * Confere se um horário pedido cabe exatamente em algum slot livre.
 *
 * Existe porque a lista de slots é apenas uma SUGESTÃO para a tela. O
 * cliente pode enviar qualquer horário no POST, e aceitar o que veio
 * sem conferir permitiria marcar às 3h da manhã, fora de qualquer
 * janela declarada. A restrição do banco impede dupla marcação, mas não
 * sabe nada sobre janelas de atendimento — essa parte é aqui.
 */
export function horarioEhValido(
  pedido: Intervalo,
  opcoes: OpcoesGeracao,
): { valido: boolean; motivo?: string } {
  if (pedido.fim <= pedido.inicio) {
    return { valido: false, motivo: 'O horário final precisa ser depois do inicial.' };
  }

  const antecedencia = opcoes.antecedenciaMinutos ?? 0;
  const limite = new Date(opcoes.agora.getTime() + antecedencia * MS_MINUTO);
  if (pedido.inicio < limite) {
    return {
      valido: false,
      motivo:
        antecedencia > 0
          ? `É preciso agendar com pelo menos ${antecedencia} minutos de antecedência.`
          : 'Não é possível agendar um horário no passado.',
    };
  }

  const disponiveis = gerarSlots({
    ...opcoes,
    de: new Date(pedido.inicio.getTime() - 24 * 60 * MS_MINUTO),
    ate: new Date(pedido.fim.getTime() + 24 * 60 * MS_MINUTO),
  });

  const casa = disponiveis.some(
    (s) => s.inicio.getTime() === pedido.inicio.getTime() && s.fim.getTime() === pedido.fim.getTime(),
  );

  if (!casa) {
    return { valido: false, motivo: 'Este horário não está disponível.' };
  }
  return { valido: true };
}
