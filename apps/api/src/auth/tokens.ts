import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Role } from '@stabilize/shared';
import { env } from '../config/env.js';
import { unauthorized } from '../http/errors.js';

/**
 * Tokens de sessão.
 *
 * Desenho em duas peças, com propósitos opostos:
 *
 *   ACCESS TOKEN  — JWT curto (15 min), enviado em cada request.
 *                   Não é consultado no banco: é isso que o torna barato.
 *                   O preço é não poder revogá-lo antes de expirar, e por
 *                   isso ele dura pouco.
 *
 *   REFRESH TOKEN — opaco (bytes aleatórios), longo (14 dias), guardado
 *                   no banco como HASH e trocado a cada uso.
 *                   Revogável de imediato.
 *
 * O refresh vai em cookie HttpOnly, fora do alcance de JavaScript — um
 * XSS não consegue lê-lo. O access fica em memória no cliente, nunca em
 * localStorage, que é legível por qualquer script da página.
 */

export interface AccessTokenClaims extends JWTPayload {
  /** id do usuário */
  sub: string;
  /** empresa — a claim que decide o isolamento de dados */
  tid: string;
  role: Role;
  /** id do aluno, quando o usuário é um aluno com acesso ao app */
  sid?: string;
}

const ISSUER = 'stabilize';
const AUDIENCE = 'stabilize-api';

function accessKey(): Uint8Array {
  return new TextEncoder().encode(env().JWT_ACCESS_SECRET);
}

export async function signAccessToken(claims: {
  userId: string;
  tenantId: string;
  role: Role;
  studentId?: string | undefined;
}): Promise<{ token: string; expiresIn: number }> {
  const ttl = env().JWT_ACCESS_TTL_SECONDS;

  const jwt = new SignJWT({
    tid: claims.tenantId,
    role: claims.role,
    ...(claims.studentId !== undefined ? { sid: claims.studentId } : {}),
  })
    /* Algoritmo fixado na assinatura E na verificação. Aceitar o
       algoritmo declarado no cabeçalho do próprio token é a
       vulnerabilidade clássica de JWT: o atacante troca para "none" ou
       para HMAC usando a chave pública como segredo. */
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(randomUUID());

  return { token: await jwt.sign(accessKey()), expiresIn: ttl };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'], // lista fixa — ver comentário acima
      clockTolerance: 5,
    });

    /* jose valida assinatura e tempo, mas não sabe o que o nosso
       payload precisa conter. Sem esta checagem, um token válido porém
       sem `tid` chegaria à camada de dados com tenant `undefined`. */
    if (
      typeof payload.sub !== 'string' ||
      typeof payload['tid'] !== 'string' ||
      typeof payload['role'] !== 'string'
    ) {
      throw unauthorized('Sessão inválida.');
    }

    return payload as AccessTokenClaims;
  } catch {
    // Motivo real (expirado, assinatura errada, malformado) fica no log;
    // o cliente recebe sempre a mesma mensagem.
    throw unauthorized('Sessão inválida ou expirada.');
  }
}

/* --------------------------------------------------------------------
 * Refresh token
 * ------------------------------------------------------------------ */

export interface RefreshTokenMaterial {
  /** Valor entregue ao cliente. Nunca é gravado. */
  readonly token: string;
  /** O que vai para o banco. */
  readonly tokenHash: string;
  /** Agrupa a cadeia de rotações, para revogar tudo de uma vez. */
  readonly familyId: string;
  readonly expiresAt: Date;
}

/**
 * Gera um refresh token novo.
 *
 * 32 bytes de aleatoriedade criptográfica — não é JWT porque não
 * precisa carregar informação: ele é só uma chave para uma linha do
 * banco, e essa linha é a fonte da verdade sobre a sessão estar viva.
 */
export function createRefreshToken(familyId?: string): RefreshTokenMaterial {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env().JWT_REFRESH_TTL_SECONDS * 1000);

  return {
    token,
    tokenHash: hashRefreshToken(token),
    familyId: familyId ?? randomUUID(),
    expiresAt,
  };
}

/**
 * Guardamos SHA-256 do token, não o token.
 *
 * Se o banco vazar, os refresh tokens gravados não são reutilizáveis —
 * mesma lógica de senha. Aqui basta SHA-256 (e não Argon2) porque o
 * valor de entrada já tem 256 bits de entropia: não há dicionário que
 * ataque isso, então o custo alto de Argon2 só atrasaria cada request
 * sem ganho.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Nome do cookie do refresh token. */
export const REFRESH_COOKIE = 'stz_rt';

/**
 * Opções do cookie de refresh.
 *
 * `path` restrito às rotas de sessão: o cookie não é enviado em todo
 * request, apenas onde é usado. Reduz a exposição e o tamanho de cada
 * requisição.
 *
 * `sameSite: 'strict'` é a proteção principal contra CSRF nesta API —
 * o navegador não envia o cookie em requisição originada de outro site.
 */
export function refreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  const config = env();
  return {
    httpOnly: true,
    // Em desenvolvimento sobre http://localhost o cookie Secure não é
    // enviado; em produção é obrigatório.
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: config.JWT_REFRESH_TTL_SECONDS,
  };
}

/* --------------------------------------------------------------------
 * Tokens da PLATAFORMA
 *
 * Assinados com a mesma chave, mas com AUDIÊNCIA DIFERENTE. É isso que
 * impede um token de plataforma de abrir uma rota de academia e
 * vice-versa: `jwtVerify` recusa quando a audiência não bate, antes de
 * qualquer código nosso rodar.
 *
 * Poderia ser uma terceira chave secreta. Não é, e a decisão é
 * deliberada: mais uma chave é mais uma coisa a gerar, guardar,
 * rotacionar e esquecer — e a separação por audiência é verificada pela
 * biblioteca, não por um `if` que alguém pode remover.
 *
 * O token da plataforma NÃO TEM `tid`. Não é omissão: ele não pertence a
 * empresa nenhuma, e é justamente por isso que `verifyAccessToken`, que
 * exige `tid`, o recusaria mesmo que a audiência batesse.
 * ------------------------------------------------------------------ */

const AUDIENCIA_PLATAFORMA = 'stabilize-plataforma';

export interface ClaimsPlataforma extends JWTPayload {
  /** id do administrador de plataforma */
  sub: string;
  /** Marca explícita, além da audiência. Cinto e suspensório. */
  tipo: 'plataforma';
}

export async function assinarTokenPlataforma(adminId: string): Promise<{
  token: string;
  expiresIn: number;
}> {
  const ttl = env().JWT_ACCESS_TTL_SECONDS;
  const jwt = new SignJWT({ tipo: 'plataforma' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(adminId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCIA_PLATAFORMA)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(randomUUID());

  return { token: await jwt.sign(accessKey()), expiresIn: ttl };
}

export async function verificarTokenPlataforma(token: string): Promise<ClaimsPlataforma> {
  try {
    const { payload } = await jwtVerify(token, accessKey(), {
      issuer: ISSUER,
      audience: AUDIENCIA_PLATAFORMA,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });

    if (typeof payload.sub !== 'string' || payload['tipo'] !== 'plataforma') {
      throw unauthorized('Sessão inválida.');
    }
    /* Um token de plataforma com `tid` seria um token adulterado ou um
       defeito de emissão. Nos dois casos, recusar. */
    if (payload['tid'] !== undefined) {
      throw unauthorized('Sessão inválida.');
    }

    return payload as ClaimsPlataforma;
  } catch {
    throw unauthorized('Sessão inválida ou expirada.');
  }
}
