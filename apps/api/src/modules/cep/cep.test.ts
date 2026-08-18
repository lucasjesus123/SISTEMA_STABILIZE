import { describe, expect, it } from 'vitest';
import { interpretarViaCep } from './cep.routes.js';

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
