import { assinarTokenPlataforma, createRefreshToken } from '../../auth/tokens.js';
import { getDummyHash, verifyPassword } from '../../auth/password.js';
import { unauthorized } from '../../http/errors.js';
import * as repo from './plataforma.repository.js';

/**
 * A ENTRADA DO OPERADOR, fora da rota.
 *
 * POR QUE ISTO SAIU DE DENTRO DO `POST /plataforma/login`
 *
 * O dono do serviço não quer decorar dois endereços. Ele digita e-mail e
 * senha na tela de sempre e espera o sistema descobrir quem ele é — e
 * está certo: a separação entre painel e academia é decisão nossa, de
 * arquitetura, e não problema de quem usa.
 *
 * Para o login da academia poder tentar esta porta, ela precisava deixar
 * de ser um corpo de rota. É a MESMA lógica de antes, movida — e a rota
 * `/plataforma/login` continua existindo e chamando daqui, para quem já
 * tem o endereço do painel no favorito.
 *
 * O QUE NÃO MUDA, e é o motivo de isto ser uma função e não uma cópia:
 * o token continua com audiência de plataforma, que não abre rota de
 * academia nenhuma; o cookie continua sendo outro; e a tentativa
 * continua sendo registrada em `platform_admins`, longe do contador de
 * bloqueio das contas de academia.
 */
/**
 * O cookie do painel.
 *
 * Mora aqui, e não na rota, porque agora DUAS rotas o emitem: a do
 * painel e a do login unificado. Duplicar o nome ou o caminho em duas
 * telas produziria o dia em que uma delas grava num escopo que a outra
 * não lê, e o sintoma seria "entrei mas ao recarregar caí fora".
 */
export const COOKIE_PLATAFORMA = 'stz_plt';

export function opcoesDoCookiePlataforma(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    /* Escopo estreito: o cookie do painel não acompanha requisição
       nenhuma das rotas de academia. */
    path: '/api/plataforma',
    maxAge: 60 * 60 * 12,
  };
}

export interface SessaoDeOperador {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly admin: { id: string; nome: string; precisaTrocarSenha: boolean };
}

/**
 * Autentica um operador.
 *
 * Devolve `null` quando o e-mail NÃO é de operador — é o sinal de "esta
 * porta não é a dele", e quem chama segue para a porta da academia.
 * Lança 401 quando o e-mail É de operador e a senha está errada: aí a
 * tentativa foi contra esta porta e precisa ser contada como tal.
 */
export async function entrarComoOperador(
  email: string,
  senha: string,
  meta: { ip: string; userAgent?: string | undefined },
): Promise<SessaoDeOperador | null> {
  const admin = await repo.buscarAdmin(email);

  /* NÃO É OPERADOR: devolve `null` sem gastar um `verifyPassword`.
     A comparação contra hash de mentira que a rota fazia aqui existia
     para não enumerar as contas do painel pelo TEMPO da resposta — e
     continua necessária lá, onde a resposta é 401. Aqui não: quem chama
     vai seguir para o login da academia, que faz a própria comparação
     (contra hash real ou de mentira) e devolve o tempo daquela porta.
     Gastar um argon2 a mais aqui só somaria 100 ms a todo login de
     recepcionista, sem esconder nada que a outra porta já não esconda. */
  if (admin === null) return null;

  if (admin.bloqueadoAte !== null && admin.bloqueadoAte > new Date()) {
    throw unauthorized('Conta temporariamente bloqueada. Tente mais tarde.');
  }

  const confere = await verifyPassword(admin.passwordHash, senha);
  if (!confere || !admin.ativo) {
    await repo.registrarTentativa(admin.id, false);
    throw unauthorized('E-mail ou senha incorretos.');
  }

  await repo.registrarTentativa(admin.id, true);
  await repo.registrar(admin.id, 'plataforma.login', null, null, meta.ip);

  return abrirSessaoDeOperador(
    { id: admin.id, nome: admin.nome, precisaTrocarSenha: admin.precisaTrocarSenha },
    meta,
  );
}

/**
 * Emite uma sessão para um operador JÁ AUTENTICADO.
 *
 * Existe separada do login por causa da troca de senha. Trocar a senha
 * derruba todas as sessões — inclusive a de quem está trocando, que é o
 * comportamento certo: se a senha antiga vazou, nenhuma sessão aberta com
 * ela pode sobreviver. Só que quem acabou de digitar a senha antiga E a
 * nova provou mais do que prova um login comum, e mandá-lo de volta para
 * a tela de entrada não acrescenta segurança nenhuma — acrescenta uma
 * tela. As outras sessões continuam derrubadas; esta nasce depois delas.
 */
export async function abrirSessaoDeOperador(
  admin: { id: string; nome: string; precisaTrocarSenha: boolean },
  meta: { ip: string; userAgent?: string | undefined },
): Promise<SessaoDeOperador> {
  const acesso = await assinarTokenPlataforma(admin.id);
  /* O MESMO `createRefreshToken` da rota antiga: o formato do refresh é
     contrato com a tabela de sessões, e reimplementá-lo aqui criaria
     duas verdades sobre o que é um token válido. */
  const refresh = createRefreshToken();
  await repo.criarSessao(
    admin.id,
    refresh.tokenHash,
    refresh.familyId,
    refresh.expiresAt,
    meta.userAgent ?? null,
    meta.ip,
  );

  return {
    accessToken: acesso.token,
    expiresIn: acesso.expiresIn,
    refreshToken: refresh.token,
    admin,
  };
}

/** Só para a rota antiga poder continuar respondendo com o mesmo texto. */
export async function tempoDeRespostaDeContaInexistente(senha: string): Promise<void> {
  await verifyPassword(await getDummyHash(), senha);
}
