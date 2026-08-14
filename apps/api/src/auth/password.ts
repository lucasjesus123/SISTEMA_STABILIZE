import argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';

/**
 * Senhas.
 *
 * Argon2id, vencedor da Password Hashing Competition. A escolha sobre
 * bcrypt não é moda: bcrypt tem custo fixo de memória, então uma GPU
 * testa bilhões de candidatos em paralelo. Argon2id é *memory-hard* —
 * cada tentativa exige 64 MB, o que derruba o paralelismo de GPU de
 * bilhões para milhares.
 *
 * Os parâmetros abaixo seguem a recomendação do OWASP Password Storage
 * Cheat Sheet (2ª opção: 19 MiB / t=2 / p=1) com folga de memória, e
 * levam ~100ms num servidor modesto. Cem milissegundos são imperceptíveis
 * num login e proibitivos num ataque de dicionário.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

/**
 * Comprimento máximo aceito.
 *
 * Não é limitação de segurança — é defesa contra negação de serviço.
 * Sem teto, alguém envia uma senha de 10 MB e o servidor gasta segundos
 * de CPU e centenas de MB de RAM por tentativa. 128 caracteres acomodam
 * qualquer frase-senha legítima.
 */
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MIN_LENGTH = 10;

export class PasswordError extends Error {
  override readonly name = 'PasswordError';
}

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordError(`A senha precisa de pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  }
  if (plain.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordError(`A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`);
  }
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Confere a senha.
 *
 * Devolve `false` em vez de lançar quando o hash está corrompido ou em
 * formato desconhecido. Lançar aqui produziria um 500 distinguível do
 * 401 normal, e essa diferença de resposta é justamente o que permite
 * enumerar contas.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (plain.length > PASSWORD_MAX_LENGTH) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * O hash precisa ser refeito com parâmetros mais fortes?
 *
 * Permite endurecer o custo ao longo do tempo sem forçar todo mundo a
 * trocar de senha: no próximo login bem-sucedido, o hash é regravado com
 * os parâmetros atuais.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/**
 * Hash falso, usado quando o e-mail não existe.
 *
 * Sem isto, "usuário inexistente" responde em 1ms e "senha errada" em
 * 100ms — e essa diferença de tempo revela quais e-mails estão
 * cadastrados. Gastamos o mesmo tempo nos dois casos.
 *
 * O valor é um hash real de uma senha aleatória descartada, calculado
 * uma vez na subida do processo.
 */
let dummyHash: string | null = null;

export async function getDummyHash(): Promise<string> {
  dummyHash ??= await argon2.hash(
    `${Date.now()}-${Math.random()}-descartado-nunca-usado`,
    ARGON2_OPTIONS,
  );
  return dummyHash;
}

/**
 * Comparação de segredos em tempo constante.
 *
 * `===` sai no primeiro byte diferente, então o tempo de resposta revela
 * quantos caracteres coincidiram, e o valor pode ser descoberto byte a
 * byte. Usado para comparar hashes de refresh token.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual exige mesmo comprimento; comparar o comprimento
  // antes já vaza essa informação, mas o comprimento de um hash é fixo
  // e público, então não há o que proteger aqui.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
