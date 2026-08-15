import { describe, expect, it } from 'vitest';
import {
  SlotError,
  gerarSlots,
  horarioEhValido,
  sobrepoe,
  unir,
  type OpcoesGeracao,
  type RegraDisponibilidade,
} from './slots.js';

const TZ = 'America/Sao_Paulo';

/** Constrói um Date a partir de um horário local de São Paulo (UTC-3). */
const sp = (iso: string): Date => new Date(`${iso}-03:00`);

const regraSegunda = (over: Partial<RegraDisponibilidade> = {}): RegraDisponibilidade => ({
  weekday: 1,
  startTime: '06:00',
  endTime: '12:00',
  slotMinutes: 60,
  ...over,
});

function base(over: Partial<OpcoesGeracao> = {}): OpcoesGeracao {
  return {
    de: sp('2026-03-02T00:00:00'),
    ate: sp('2026-03-03T00:00:00'),
    regras: [regraSegunda()],
    ocupacoes: [],
    agora: sp('2026-03-01T00:00:00'),
    timeZone: TZ,
    ...over,
  };
}

describe('sobrepoe — a convenção que evita a agenda recusar horário válido', () => {
  it('encostar NÃO é sobrepor: 9h-10h e 10h-11h convivem', () => {
    expect(
      sobrepoe(
        { inicio: sp('2026-03-02T09:00:00'), fim: sp('2026-03-02T10:00:00') },
        { inicio: sp('2026-03-02T10:00:00'), fim: sp('2026-03-02T11:00:00') },
      ),
    ).toBe(false);
  });

  it('cruzar é sobrepor', () => {
    expect(
      sobrepoe(
        { inicio: sp('2026-03-02T09:00:00'), fim: sp('2026-03-02T10:00:00') },
        { inicio: sp('2026-03-02T09:30:00'), fim: sp('2026-03-02T10:30:00') },
      ),
    ).toBe(true);
  });

  it('conter é sobrepor, nos dois sentidos', () => {
    const grande = { inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T12:00:00') };
    const pequeno = { inicio: sp('2026-03-02T09:00:00'), fim: sp('2026-03-02T10:00:00') };
    expect(sobrepoe(grande, pequeno)).toBe(true);
    expect(sobrepoe(pequeno, grande)).toBe(true);
  });
});

describe('unir', () => {
  it('funde blocos que se tocam ou cruzam', () => {
    const r = unir([
      { inicio: sp('2026-03-02T09:00:00'), fim: sp('2026-03-02T10:00:00') },
      { inicio: sp('2026-03-02T10:00:00'), fim: sp('2026-03-02T11:00:00') },
      { inicio: sp('2026-03-02T10:30:00'), fim: sp('2026-03-02T12:00:00') },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.inicio).toEqual(sp('2026-03-02T09:00:00'));
    expect(r[0]!.fim).toEqual(sp('2026-03-02T12:00:00'));
  });

  it('preserva blocos separados e os devolve ordenados', () => {
    const r = unir([
      { inicio: sp('2026-03-02T14:00:00'), fim: sp('2026-03-02T15:00:00') },
      { inicio: sp('2026-03-02T09:00:00'), fim: sp('2026-03-02T10:00:00') },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]!.inicio).toEqual(sp('2026-03-02T09:00:00'));
  });

  it('lista vazia devolve vazio', () => {
    expect(unir([])).toEqual([]);
  });
});

describe('gerarSlots', () => {
  it('fatia a janela declarada no tamanho do slot', () => {
    // Segunda, 2 de março de 2026, 06:00–12:00, slots de 60 min → 6 slots
    const slots = gerarSlots(base());
    expect(slots).toHaveLength(6);
    expect(slots[0]!.inicio).toEqual(sp('2026-03-02T06:00:00'));
    expect(slots[0]!.fim).toEqual(sp('2026-03-02T07:00:00'));
    expect(slots[5]!.fim).toEqual(sp('2026-03-02T12:00:00'));
  });

  it('não gera slot que ultrapasse o fim da janela', () => {
    // 06:00–12:00 em passos de 50 min: o 8º slot terminaria 12:40.
    const slots = gerarSlots(base({ regras: [regraSegunda({ slotMinutes: 50 })] }));
    expect(slots).toHaveLength(7);
    expect(slots.at(-1)!.fim.getTime()).toBeLessThanOrEqual(sp('2026-03-02T12:00:00').getTime());
  });

  it('só considera regras do dia da semana correspondente', () => {
    // Terça, 3 de março: a regra é de segunda.
    const slots = gerarSlots(
      base({ de: sp('2026-03-03T00:00:00'), ate: sp('2026-03-04T00:00:00') }),
    );
    expect(slots).toHaveLength(0);
  });

  it('remove apenas os slots que a ocupação toca, não a janela inteira', () => {
    const slots = gerarSlots(
      base({
        ocupacoes: [{ inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T09:00:00') }],
      }),
    );
    expect(slots).toHaveLength(5);
    expect(slots.map((s) => s.inicio.getTime())).not.toContain(
      sp('2026-03-02T08:00:00').getTime(),
    );
    // O slot seguinte continua disponível — encostar não é sobrepor.
    expect(slots.map((s) => s.inicio.getTime())).toContain(sp('2026-03-02T09:00:00').getTime());
  });

  it('uma ocupação parcial invalida o slot inteiro', () => {
    // Ninguém consegue atender das 8h30 às 9h num slot de uma hora.
    const slots = gerarSlots(
      base({
        ocupacoes: [{ inicio: sp('2026-03-02T08:30:00'), fim: sp('2026-03-02T09:00:00') }],
      }),
    );
    expect(slots.map((s) => s.inicio.getTime())).not.toContain(
      sp('2026-03-02T08:00:00').getTime(),
    );
  });

  it('não oferece horário no passado', () => {
    const slots = gerarSlots(base({ agora: sp('2026-03-02T09:00:00') }));
    expect(slots).toHaveLength(3); // 09, 10, 11
    expect(slots[0]!.inicio).toEqual(sp('2026-03-02T09:00:00'));
  });

  it('respeita a antecedência mínima', () => {
    const slots = gerarSlots(
      base({ agora: sp('2026-03-02T08:00:00'), antecedenciaMinutos: 120 }),
    );
    // Antes das 10h nada é ofertável.
    expect(slots[0]!.inicio).toEqual(sp('2026-03-02T10:00:00'));
  });

  it('respeita a vigência da regra', () => {
    const fora = gerarSlots(
      base({ regras: [regraSegunda({ validFrom: sp('2026-04-01T00:00:00') })] }),
    );
    expect(fora).toHaveLength(0);

    const expirada = gerarSlots(
      base({ regras: [regraSegunda({ validUntil: sp('2026-02-01T00:00:00') })] }),
    );
    expect(expirada).toHaveLength(0);

    const vigente = gerarSlots(
      base({
        regras: [
          regraSegunda({ validFrom: sp('2026-01-01T00:00:00'), validUntil: sp('2026-12-31T00:00:00') }),
        ],
      }),
    );
    expect(vigente).toHaveLength(6);
  });

  it('não repete o mesmo horário quando duas regras se sobrepõem', () => {
    const slots = gerarSlots(base({ regras: [regraSegunda(), regraSegunda()] }));
    expect(slots).toHaveLength(6);
  });

  it('mantém regras de salas distintas como ofertas distintas', () => {
    const slots = gerarSlots(
      base({
        regras: [
          regraSegunda({ roomId: 'sala-1' }),
          regraSegunda({ roomId: 'sala-2' }),
        ],
      }),
    );
    expect(slots).toHaveLength(12);
  });

  it('devolve os slots em ordem cronológica', () => {
    const slots = gerarSlots(
      base({
        de: sp('2026-03-02T00:00:00'),
        ate: sp('2026-03-17T00:00:00'),
        regras: [regraSegunda(), regraSegunda({ weekday: 3, startTime: '14:00', endTime: '18:00' })],
      }),
    );
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.inicio.getTime()).toBeGreaterThanOrEqual(slots[i - 1]!.inicio.getTime());
    }
  });

  it('recusa período longo demais em vez de gerar centenas de milhares de slots', () => {
    expect(() =>
      gerarSlots(base({ de: sp('2026-01-01T00:00:00'), ate: sp('2030-01-01T00:00:00') })),
    ).toThrow(SlotError);
  });

  it('período invertido ou vazio devolve lista vazia', () => {
    expect(gerarSlots(base({ ate: sp('2026-03-01T00:00:00') }))).toEqual([]);
  });

  it('recusa horário malformado na regra', () => {
    expect(() => gerarSlots(base({ regras: [regraSegunda({ startTime: '25:00' })] }))).toThrow(
      SlotError,
    );
    expect(() => gerarSlots(base({ regras: [regraSegunda({ startTime: 'manhã' })] }))).toThrow(
      SlotError,
    );
  });

  it('ignora regra com fim antes do início', () => {
    const slots = gerarSlots(
      base({ regras: [regraSegunda({ startTime: '12:00', endTime: '06:00' })] }),
    );
    expect(slots).toHaveLength(0);
  });
});

describe('fuso horário — onde agendas erram sem ninguém perceber', () => {
  it('"06:00 de segunda" é o relógio da parede da academia, não UTC', () => {
    const slots = gerarSlots(base());
    // 06:00 em São Paulo (UTC-3) é 09:00 UTC.
    expect(slots[0]!.inicio.toISOString()).toBe('2026-03-02T09:00:00.000Z');
  });

  it('a virada do horário de verão não desloca a janela', () => {
    /* O Brasil não usa mais horário de verão, mas o motor precisa estar
       certo de qualquer forma — a academia pode abrir filial fora, e um
       cálculo feito em UTC escorregaria uma hora justamente nesses dias.
       Nova York vira em 8 de março de 2026 (domingo). Testamos a
       segunda seguinte, já no novo deslocamento. */
    const NY = 'America/New_York';
    const antes = gerarSlots({
      de: new Date('2026-03-02T00:00:00-05:00'),
      ate: new Date('2026-03-03T00:00:00-05:00'),
      regras: [regraSegunda({ startTime: '09:00', endTime: '10:00' })],
      ocupacoes: [],
      agora: new Date('2026-01-01T00:00:00Z'),
      timeZone: NY,
    });
    const depois = gerarSlots({
      de: new Date('2026-03-09T00:00:00-04:00'),
      ate: new Date('2026-03-10T00:00:00-04:00'),
      regras: [regraSegunda({ startTime: '09:00', endTime: '10:00' })],
      ocupacoes: [],
      agora: new Date('2026-01-01T00:00:00Z'),
      timeZone: NY,
    });

    expect(antes).toHaveLength(1);
    expect(depois).toHaveLength(1);
    // Nos dois casos o aluno vê "09:00" no relógio local, ainda que o
    // instante UTC seja diferente (14:00Z antes, 13:00Z depois).
    expect(antes[0]!.inicio.toISOString()).toBe('2026-03-02T14:00:00.000Z');
    expect(depois[0]!.inicio.toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('uma janela no fim do dia local não some por causa da conversão para UTC', () => {
    // 21:00–23:00 em São Paulo cai no dia seguinte em UTC.
    const slots = gerarSlots(
      base({
        regras: [regraSegunda({ startTime: '21:00', endTime: '23:00' })],
        de: sp('2026-03-02T00:00:00'),
        ate: sp('2026-03-03T00:00:00'),
      }),
    );
    expect(slots).toHaveLength(2);
    expect(slots[0]!.inicio.toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });
});

describe('horarioEhValido — a checagem que o POST não pode dispensar', () => {
  it('aceita um horário que casa exatamente com um slot livre', () => {
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T09:00:00') },
      base(),
    );
    expect(r.valido).toBe(true);
  });

  it('recusa horário fora de qualquer janela declarada', () => {
    // A lista de slots é sugestão para a tela; o cliente pode enviar
    // qualquer coisa no POST. Sem esta checagem, marca-se às 3h.
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T03:00:00'), fim: sp('2026-03-02T04:00:00') },
      base(),
    );
    expect(r.valido).toBe(false);
    expect(r.motivo).toBeTruthy();
  });

  it('recusa horário desalinhado com a grade', () => {
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T08:17:00'), fim: sp('2026-03-02T09:17:00') },
      base(),
    );
    expect(r.valido).toBe(false);
  });

  it('recusa duração diferente da declarada', () => {
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T08:30:00') },
      base(),
    );
    expect(r.valido).toBe(false);
  });

  it('recusa horário já ocupado', () => {
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T09:00:00') },
      base({ ocupacoes: [{ inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T09:00:00') }] }),
    );
    expect(r.valido).toBe(false);
  });

  it('recusa horário no passado', () => {
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T09:00:00') },
      base({ agora: sp('2026-03-02T10:00:00') }),
    );
    expect(r.valido).toBe(false);
    expect(r.motivo).toContain('passado');
  });

  it('recusa fim antes do início', () => {
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T09:00:00'), fim: sp('2026-03-02T08:00:00') },
      base(),
    );
    expect(r.valido).toBe(false);
  });

  it('explica a antecedência mínima quando é ela que barra', () => {
    const r = horarioEhValido(
      { inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T09:00:00') },
      base({ agora: sp('2026-03-02T07:30:00'), antecedenciaMinutos: 120 }),
    );
    expect(r.valido).toBe(false);
    expect(r.motivo).toContain('antecedência');
  });
});

describe('coerência entre o que a API oferece e o que o banco aceita', () => {
  it('todo slot gerado passa por horarioEhValido nas mesmas condições', () => {
    /* Se as duas funções discordassem, a API ofereceria na tela um
       horário que o próprio sistema recusaria no POST — o pior tipo de
       bug de agenda, porque parece capricho do sistema. */
    const opcoes = base({
      de: sp('2026-03-02T00:00:00'),
      ate: sp('2026-03-10T00:00:00'),
      regras: [
        regraSegunda(),
        regraSegunda({ weekday: 3, startTime: '14:00', endTime: '18:00', slotMinutes: 45 }),
      ],
      ocupacoes: [{ inicio: sp('2026-03-02T08:00:00'), fim: sp('2026-03-02T09:00:00') }],
    });

    const slots = gerarSlots(opcoes);
    expect(slots.length).toBeGreaterThan(0);

    for (const slot of slots) {
      const r = horarioEhValido({ inicio: slot.inicio, fim: slot.fim }, opcoes);
      expect(r.valido).toBe(true);
    }
  });

  it('nenhum slot gerado colide com uma ocupação', () => {
    const ocupacoes = [
      { inicio: sp('2026-03-02T06:30:00'), fim: sp('2026-03-02T07:30:00') },
      { inicio: sp('2026-03-02T10:00:00'), fim: sp('2026-03-02T11:00:00') },
    ];
    const slots = gerarSlots(base({ ocupacoes }));
    for (const slot of slots) {
      for (const o of ocupacoes) {
        expect(sobrepoe(slot, o)).toBe(false);
      }
    }
  });

  it('nenhum slot gerado se sobrepõe a outro da mesma sala', () => {
    const slots = gerarSlots(base({ regras: [regraSegunda({ roomId: 'sala-1' })] }));
    for (let i = 1; i < slots.length; i += 1) {
      expect(sobrepoe(slots[i - 1]!, slots[i]!)).toBe(false);
    }
  });
});
