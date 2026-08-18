import { describe, expect, it } from 'vitest';
import {
  cepCompleto,
  e164ParaMascara,
  mascararCep,
  mascararTelefone,
  telefoneParaE164,
} from './formato.js';

/**
 * Estas funções rodam A CADA TECLA, e é isso que faz os casos pela
 * metade valerem tanto teste quanto os completos: uma máscara que só
 * acerta o campo cheio faz o cursor pular e o texto sumir enquanto a
 * pessoa digita — e o defeito não aparece em nenhuma tela de revisão,
 * porque quem revisa cola o número inteiro de uma vez.
 */

describe('mascararTelefone', () => {
  it('monta o celular dígito a dígito, sem estado intermediário quebrado', () => {
    const esperado = [
      ['5', '(5'],
      ['51', '(51'],
      ['519', '(51) 9'],
      ['5199', '(51) 99'],
      ['51992', '(51) 992'],
      ['519926', '(51) 9926'],
      ['5199266', '(51) 9926-6'],
      ['51992668', '(51) 9926-68'],
      ['519926680', '(51) 9926-680'],
      ['5199266809', '(51) 9926-6809'],
      ['51992668095', '(51) 99266-8095'],
    ] as const;
    for (const [entrada, saida] of esperado) {
      expect(mascararTelefone(entrada)).toBe(saida);
    }
  });

  it('usa 4+4 no fixo e 5+4 no celular', () => {
    expect(mascararTelefone('5133334444')).toBe('(51) 3333-4444');
    expect(mascararTelefone('51993334444')).toBe('(51) 99333-4444');
  });

  it('ignora o que não é dígito e não passa de 11', () => {
    expect(mascararTelefone('(51) 99266-8095')).toBe('(51) 99266-8095');
    expect(mascararTelefone('51 9 9266 8095 99999')).toBe('(51) 99266-8095');
    expect(mascararTelefone('abc')).toBe('');
    expect(mascararTelefone('')).toBe('');
  });

  it('apagar tudo devolve campo vazio, e não um parêntese solto', () => {
    /* Sem isto, apagar o último dígito deixava "(" na tela e o campo
       nunca voltava a parecer vazio. */
    expect(mascararTelefone('(')).toBe('');
  });
});

describe('mascararCep e cepCompleto', () => {
  it('põe o hífen só a partir do sexto dígito', () => {
    expect(mascararCep('9')).toBe('9');
    expect(mascararCep('91910')).toBe('91910');
    expect(mascararCep('919100')).toBe('91910-0');
    expect(mascararCep('91910000')).toBe('91910-000');
    expect(mascararCep('91910-000')).toBe('91910-000');
    expect(mascararCep('919100001234')).toBe('91910-000');
  });

  it('só considera completo com oito dígitos', () => {
    expect(cepCompleto('91910-00')).toBeNull();
    expect(cepCompleto('91910-000')).toBe('91910000');
    expect(cepCompleto('')).toBeNull();
  });
});

describe('telefoneParaE164', () => {
  it('completa o país no número brasileiro digitado com máscara', () => {
    expect(telefoneParaE164('(51) 99266-8095')).toBe('+5551992668095');
    expect(telefoneParaE164('(51) 3333-4444')).toBe('+555133334444');
  });

  it('não duplica o país quando ele já veio', () => {
    expect(telefoneParaE164('5551992668095')).toBe('+5551992668095');
    expect(telefoneParaE164('+55 51 99266-8095')).toBe('+5551992668095');
  });

  it('respeita o número estrangeiro digitado com +', () => {
    /* O aluno português não pode ganhar um +55 na frente por causa de
       uma regra pensada para o Brasil. */
    expect(telefoneParaE164('+351 912 345 678')).toBe('+351912345678');
  });

  it('vazio é ausente, não inválido', () => {
    expect(telefoneParaE164('')).toBeNull();
    expect(telefoneParaE164('   ')).toBeNull();
    expect(telefoneParaE164('+')).toBeNull();
  });

  it('deixa o servidor recusar o que não dá para reconhecer', () => {
    /* Devolve algo verificável em vez de inventar um número plausível:
       o CHECK do banco e o schema da rota é que dizem não. */
    expect(telefoneParaE164('123')).toBe('+123');
  });
});

describe('e164ParaMascara', () => {
  it('desmonta o número brasileiro para a tela', () => {
    expect(e164ParaMascara('+5551992668095')).toBe('(51) 99266-8095');
    expect(e164ParaMascara('+555133334444')).toBe('(51) 3333-4444');
  });

  it('devolve o estrangeiro como está', () => {
    expect(e164ParaMascara('+351912345678')).toBe('+351912345678');
  });

  it('aceita nulo e indefinido, que é como o banco entrega o não preenchido', () => {
    expect(e164ParaMascara(null)).toBe('');
    expect(e164ParaMascara(undefined)).toBe('');
    expect(e164ParaMascara('')).toBe('');
  });

  it('ida e volta preserva o número brasileiro', () => {
    for (const n of ['(51) 99266-8095', '(11) 3333-4444', '(85) 98888-7777']) {
      const guardado = telefoneParaE164(n);
      expect(guardado).not.toBeNull();
      expect(e164ParaMascara(guardado)).toBe(n);
    }
  });
});
