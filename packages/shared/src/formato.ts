/**
 * Máscaras de digitação.
 *
 * A REGRA QUE ORGANIZA ESTE ARQUIVO: a máscara é da TELA, o dado é do
 * BANCO. O que a pessoa vê é `(51) 99999-9999`; o que viaja para o
 * servidor é `+5551999999999` no WhatsApp e oito dígitos no CEP. Guardar
 * o número já formatado seria condenar toda consulta futura a adivinhar
 * se aquele registro veio com parênteses, com ponto ou com nada.
 *
 * TODAS AS FUNÇÕES AQUI TOLERAM ENTRADA PELA METADE, e isso não é
 * detalhe: elas rodam a cada tecla. Uma máscara que só funciona com o
 * campo completo faz o cursor pular e o texto sumir enquanto se digita.
 */

/** Só os dígitos, com um teto para o `slice` não depender do que chega. */
function digitos(valor: string, maximo: number): string {
  return valor.replace(/\D/g, '').slice(0, maximo);
}

/**
 * Telefone brasileiro: `(51) 99999-9999` ou `(51) 3333-4444`.
 *
 * Fixo e celular têm contagens diferentes (8 e 9 dígitos depois do DDD),
 * e o hífen muda de lugar. Decidir pelo total digitado acerta os dois
 * sem perguntar nada a quem preenche.
 */
export function mascararTelefone(valor: string): string {
  const d = digitos(valor, 11);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const resto = d.slice(2);
  if (resto.length <= 4) return `(${ddd}) ${resto}`;
  /* Com 11 dígitos o corte é 5+4 (celular); com 10, é 4+4 (fixo). */
  const corte = resto.length > 8 ? 5 : 4;
  return `(${ddd}) ${resto.slice(0, corte)}-${resto.slice(corte)}`;
}

/** CEP: `99999-999`. */
export function mascararCep(valor: string): string {
  const d = digitos(valor, 8);
  return d.length <= 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`;
}

/** Os oito dígitos do CEP, ou `null` enquanto ainda não estão todos. */
export function cepCompleto(valor: string): string | null {
  const d = digitos(valor, 8);
  return d.length === 8 ? d : null;
}

/**
 * O que o servidor exige no WhatsApp: E.164, como `+5551999999999`.
 *
 * Quem digita `(51) 99999-9999` quer o número dele, e o país é o Brasil
 * — completar o `+55` aqui poupa um campo e um erro de validação que
 * ninguém entende na primeira vez.
 *
 * O `+` DIGITADO À MÃO É RESPEITADO: um aluno estrangeiro ou um número
 * de Portugal passa direto, sem ganhar um `+55` na frente. É por isso
 * que a função olha o começo do texto antes de decidir.
 *
 * Devolve `null` quando o campo está vazio (que é "não informado", não
 * "inválido") e devolve o texto como está quando não dá para reconhecer
 * — deixando o servidor recusar e explicar, em vez de esta função
 * inventar um número plausível e errado.
 */
export function telefoneParaE164(valor: string): string | null {
  const limpo = valor.trim();
  if (limpo === '') return null;

  if (limpo.startsWith('+')) {
    const d = limpo.slice(1).replace(/\D/g, '');
    return d === '' ? null : `+${d}`;
  }

  const d = limpo.replace(/\D/g, '');
  if (d === '') return null;
  /* 10 (fixo com DDD) ou 11 (celular com DDD) dígitos: é número
     brasileiro sem o país, o caso de longe mais comum. */
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  /* 12 ou 13 com o 55 na frente: já veio com o país, faltou o `+`. */
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return `+${d}`;
  return `+${d}`;
}

/**
 * O caminho inverso: `+5551999999999` vira `(51) 99999-9999` na tela.
 *
 * Só desmonta número brasileiro. Um `+351...` continua aparecendo como
 * está — mascarar um número português com regra brasileira produziria
 * algo que parece certo e não é, que é pior do que não mascarar.
 */
export function e164ParaMascara(valor: string | null | undefined): string {
  const bruto = (valor ?? '').trim();
  if (bruto === '') return '';
  if (!bruto.startsWith('+')) return mascararTelefone(bruto);

  const d = bruto.slice(1).replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    return mascararTelefone(d.slice(2));
  }
  return bruto;
}
