import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consultarCepParaTeste,
  estadoDoDisjuntorDeCep,
  interpretarViaCep,
  limparCacheDeCep,
} from './cep.routes.js';

/**
 * A tradução da resposta do serviço externo.
 *
 * Testada sem rede, e é isso que dá valor ao teste: o que quebra numa
 * integração assim não é o `fetch`, é a resposta que chega com status
 * 200 e não é o que se esperava. Todos os casos abaixo saíram do
 * comportamento real do ViaCEP.
 */

describe('interpretarViaCep', () => {
  it('traduz uma resposta completa', () => {
    expect(
      interpretarViaCep('95900000', {
        cep: '95900-000',
        logradouro: 'Rua Maranhão',
        bairro: 'Universitário',
        localidade: 'Lajeado',
        uf: 'RS',
      }),
    ).toEqual({
      cep: '95900000',
      logradouro: 'Rua Maranhão',
      bairro: 'Universitário',
      cidade: 'Lajeado',
      uf: 'RS',
    });
  });

  it('trata o CEP inexistente, que vem com status 200 e {"erro": true}', () => {
    /* Este é o caso que derruba integração ingênua: o status é 200, e
       quem só olha `resposta.ok` acha que encontrou. */
    expect(interpretarViaCep('99999999', { erro: true })).toBeNull();
    // A mesma API já devolveu a string; as duas formas contam.
    expect(interpretarViaCep('99999999', { erro: 'true' })).toBeNull();
  });

  it('campo em branco é não preenchido, não string vazia', () => {
    /* CEP de faixa (cidade inteira) vem sem logradouro nem bairro — mas
       com cidade e UF, que já poupam dois campos de digitação. */
    const r = interpretarViaCep('95900970', {
      logradouro: '',
      bairro: '',
      localidade: 'Lajeado',
      uf: 'RS',
    });
    expect(r).not.toBeNull();
    expect(r?.logradouro).toBeNull();
    expect(r?.bairro).toBeNull();
    expect(r?.cidade).toBe('Lajeado');
  });

  it('resposta vazia com status 200 não vira endereço em branco', () => {
    /* Sem esta guarda, a tela mostraria "encontrei" e preencheria nada —
       pior que dizer que não encontrou, porque a pessoa fica esperando. */
    expect(interpretarViaCep('95900000', {})).toBeNull();
    expect(interpretarViaCep('95900000', { uf: 'RS' })).toBeNull();
  });

  it('recusa UF fora do formato que o banco aceita', () => {
    /* `address_state` é char(2). Uma UF de três letras estouraria o
       INSERT lá na frente, longe daqui, com uma mensagem do driver. */
    const r = interpretarViaCep('95900000', { localidade: 'Lajeado', uf: 'RSX' });
    expect(r?.uf).toBeNull();
    expect(r?.cidade).toBe('Lajeado');
  });

  it('normaliza a UF para maiúscula', () => {
    expect(interpretarViaCep('95900000', { localidade: 'Lajeado', uf: 'rs' })?.uf).toBe('RS');
  });

  it('não quebra com corpo que não é objeto', () => {
    /* Serviço fora do ar às vezes devolve HTML de erro com status 200, e
       o `.json()` do lado de lá vira `null` ou uma string. */
    expect(interpretarViaCep('95900000', null)).toBeNull();
    expect(interpretarViaCep('95900000', 'Service Unavailable')).toBeNull();
    expect(interpretarViaCep('95900000', 42)).toBeNull();
  });

  it('devolve o CEP que PEDIMOS, não o que o serviço mandou de volta', () => {
    /* O serviço devolve com máscara ('95900-000'); o banco guarda oito
       dígitos. Confiar no eco do terceiro deixaria o formato do nosso
       dado nas mãos dele. */
    const r = interpretarViaCep('95900000', {
      cep: '95900-000',
      localidade: 'Lajeado',
      uf: 'RS',
    });
    expect(r?.cep).toBe('95900000');
  });
});

/**
 * O disjuntor — o comportamento quando os Correios estão fora do ar.
 *
 * Testado trocando o `fetch` global, e não a internet: o que importa
 * provar é que depois de algumas falhas o sistema PARA DE SAIR para a
 * rede, e que ele volta sozinho quando o serviço volta. Contar as
 * chamadas ao `fetch` é a única forma de ver isso — pela resposta, a
 * consulta bloqueada e a consulta que falhou são idênticas.
 */
describe('disjuntor de CEP', () => {
  const fetchOriginal = globalThis.fetch;
  const log = { warn: () => undefined };

  /** Instala um `fetch` falso e conta quantas vezes foi chamado. */
  function comFetch(impl: () => Promise<Response>): { chamadas: () => number } {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      return impl();
    }) as typeof globalThis.fetch;
    return { chamadas: () => n };
  }

  const ok = (corpo: unknown): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));

  beforeEach(() => limparCacheDeCep());
  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    limparCacheDeCep();
  });

  it('depois de três falhas seguidas, para de sair para a rede', async () => {
    const espiao = comFetch(() => Promise.reject(new Error('sem rede')));

    /* CEPs diferentes de propósito: o cache não pode ser o que segura a
       quarta consulta — indisponibilidade não entra no cache. */
    for (const cep of ['95900001', '95900002', '95900003']) {
      expect(await consultarCepParaTeste(cep, log)).toBe('indisponivel');
    }
    expect(espiao.chamadas()).toBe(3);
    expect(estadoDoDisjuntorDeCep().aberto).toBe(true);

    // A quarta responde na hora, sem tocar na rede.
    expect(await consultarCepParaTeste('95900004', log)).toBe('indisponivel');
    expect(espiao.chamadas(), 'não devia ter saído para a rede').toBe(3);
  });

  it('duas falhas não abrem o circuito — instabilidade curta não conta', async () => {
    const espiao = comFetch(() => Promise.reject(new Error('piscou')));
    await consultarCepParaTeste('95900001', log);
    await consultarCepParaTeste('95900002', log);
    expect(estadoDoDisjuntorDeCep().aberto).toBe(false);
    expect(espiao.chamadas()).toBe(2);
  });

  it('uma resposta boa zera o contador', async () => {
    comFetch(() => Promise.reject(new Error('sem rede')));
    await consultarCepParaTeste('95900001', log);
    await consultarCepParaTeste('95900002', log);
    expect(estadoDoDisjuntorDeCep().falhasSeguidas).toBe(2);

    comFetch(() => ok({ localidade: 'Lajeado', uf: 'RS' }));
    await consultarCepParaTeste('95900003', log);
    expect(estadoDoDisjuntorDeCep().falhasSeguidas).toBe(0);
    expect(estadoDoDisjuntorDeCep().aberto).toBe(false);
  });

  it('CEP inexistente NÃO conta como falha do serviço', async () => {
    /* "Este CEP não existe" é uma resposta. Contá-la como falha abriria
       o circuito para quem digitou três CEPs errados em sequência — e aí
       o CEP certo do quarto aluno não seria nem consultado. */
    comFetch(() => ok({ erro: true }));
    for (const cep of ['99999991', '99999992', '99999993']) {
      expect(await consultarCepParaTeste(cep, log)).toBeNull();
    }
    expect(estadoDoDisjuntorDeCep().aberto).toBe(false);
  });

  it('erro 5xx do serviço conta como falha', async () => {
    comFetch(() => Promise.resolve(new Response('', { status: 502 })));
    for (const cep of ['95900001', '95900002', '95900003']) {
      expect(await consultarCepParaTeste(cep, log)).toBe('indisponivel');
    }
    expect(estadoDoDisjuntorDeCep().aberto).toBe(true);
  });
});
