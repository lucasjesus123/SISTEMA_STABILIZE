/**
 * As duas conferências do cadastro do aluno.
 *
 * Existem porque as duas falhavam em silêncio e o sintoma aparecia longe
 * da causa: CPF errado virava "o aplicativo não deixa o aluno entrar",
 * semanas depois; nascimento errado virava aniversário que nunca chega e
 * idade negativa na ficha. Medido antes destes testes, `POST
 * /api/students` devolvia 201 para `documento: '11111111111'` e para
 * `dataNascimento: '2099-01-01'`.
 */
import { describe, expect, it } from 'vitest';
import {
  cnpjEhValido,
  cpfEhValido,
  documentoDaEmpresaEhAceitavel,
  documentoEhAceitavel,
  nascimentoEhPlausivel,
} from './documentos.js';

describe('cpfEhValido', () => {
  it('aceita CPFs com dígitos verificadores corretos', () => {
    for (const cpf of ['52998224725', '11144477735', '01234567890']) {
      expect(cpfEhValido(cpf), cpf).toBe(true);
    }
  });

  it('recusa os onze dígitos repetidos', () => {
    /* `11111111111` PASSA na conta do dígito verificador — é o caso que
       um validador ingênuo deixa entrar, e é justamente o que sai de um
       campo preenchido às pressas. */
    for (let d = 0; d <= 9; d += 1) {
      expect(cpfEhValido(String(d).repeat(11)), String(d).repeat(11)).toBe(false);
    }
  });

  it('recusa dígito verificador trocado', () => {
    expect(cpfEhValido('52998224726')).toBe(false);
    expect(cpfEhValido('52998224715')).toBe(false);
  });

  it('recusa tamanho errado', () => {
    expect(cpfEhValido('5299822472')).toBe(false);
    expect(cpfEhValido('529982247250')).toBe(false);
    expect(cpfEhValido('')).toBe(false);
  });
});

describe('documentoEhAceitavel', () => {
  it('exige CPF válido quando são onze dígitos', () => {
    expect(documentoEhAceitavel('52998224725')).toBe(true);
    expect(documentoEhAceitavel('529.982.247-25')).toBe(true);
    expect(documentoEhAceitavel('11111111111')).toBe(false);
    expect(documentoEhAceitavel('529.982.247-26')).toBe(false);
  });

  it('deixa passar o que não é tentativa de CPF', () => {
    /* O campo aceita mais que CPF — carteirinha, RG, passaporte de aluno
       estrangeiro. Onze dígitos é o que caracteriza a intenção; em
       qualquer outro formato o dígito verificador não se aplica, e
       recusar seria inventar uma regra que a academia não pediu. */
    expect(documentoEhAceitavel('123456789')).toBe(true);
    expect(documentoEhAceitavel('AB123456')).toBe(true);
    expect(documentoEhAceitavel('')).toBe(true);
    expect(documentoEhAceitavel('MG-12.345.678')).toBe(true);
  });
});

describe('nascimentoEhPlausivel', () => {
  it('aceita uma data comum', () => {
    expect(nascimentoEhPlausivel('1990-05-20')).toBe(true);
  });

  it('aceita quem nasceu hoje', () => {
    expect(nascimentoEhPlausivel(new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it('recusa o futuro', () => {
    expect(nascimentoEhPlausivel('2099-01-01')).toBe(false);
    const ano = new Date().getFullYear() + 1;
    expect(nascimentoEhPlausivel(`${ano}-01-01`)).toBe(false);
  });

  it('recusa mais de cento e vinte anos', () => {
    expect(nascimentoEhPlausivel('1800-01-01')).toBe(false);
  });

  it('recusa data que não existe', () => {
    expect(nascimentoEhPlausivel('2020-02-31')).toBe(false);
    expect(nascimentoEhPlausivel('não é data')).toBe(false);
  });
});

describe('cnpjEhValido', () => {
  it('aceita CNPJs conhecidos', () => {
    /* Dois CNPJs públicos, escolhidos por serem fáceis de conferir à
       mão se alguém duvidar da conta dos pesos. */
    expect(cnpjEhValido('11222333000181')).toBe(true);
    expect(cnpjEhValido('04252011000110')).toBe(true);
  });

  it('recusa os quatorze dígitos repetidos', () => {
    expect(cnpjEhValido('11111111111111')).toBe(false);
    expect(cnpjEhValido('00000000000000')).toBe(false);
  });

  it('recusa dígito trocado e tamanho errado', () => {
    expect(cnpjEhValido('11222333000182')).toBe(false);
    expect(cnpjEhValido('1122233300018')).toBe(false);
  });
});

describe('documentoDaEmpresaEhAceitavel', () => {
  it('aceita CNPJ e também CPF — a academia pode ser MEI', () => {
    expect(documentoDaEmpresaEhAceitavel('11.222.333/0001-81')).toBe(true);
    expect(documentoDaEmpresaEhAceitavel('529.982.247-25')).toBe(true);
  });

  it('recusa os inválidos dos dois formatos', () => {
    expect(documentoDaEmpresaEhAceitavel('11111111111111')).toBe(false);
    expect(documentoDaEmpresaEhAceitavel('11111111111')).toBe(false);
  });

  it('deixa passar o que não é nem um nem outro', () => {
    expect(documentoDaEmpresaEhAceitavel('')).toBe(true);
    expect(documentoDaEmpresaEhAceitavel('inscricao-municipal-42')).toBe(true);
  });
});
