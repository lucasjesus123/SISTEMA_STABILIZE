import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { withoutTenantContext } from '../../db/pool.js';
import {
  assinarTokenPlataforma,
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verificarTokenPlataforma,
} from '../../auth/tokens.js';
import { getDummyHash, hashPassword, verifyPassword } from '../../auth/password.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../http/errors.js';
import { cifrar } from '../whatsapp/segredo.js';
import * as repo from './plataforma.repository.js';
import type { Role } from '@stabilize/shared';

/**
 * Painel de quem opera o SaaS.
 *
 * AUTENTICAÇÃO SEPARADA DA DAS ACADEMIAS, e não é preciosismo: o token
 * daqui tem AUDIÊNCIA própria, verificada pela biblioteca de JWT antes
 * de qualquer código nosso rodar. Um token de plataforma não abre rota
 * de academia e um token de academia não abre rota daqui — nem por
 * engano de programação, porque a recusa não depende de um `if` que
 * alguém possa remover.
 *
 * O COOKIE DE REFRESH TAMBÉM É OUTRO. Se fosse o mesmo, entrar no painel
 * derrubaria a sessão da academia no mesmo navegador, e vice-versa —
 * exatamente o que acontece com quem opera o serviço e testa como
 * cliente na mesma aba.
 */

const COOKIE_PLATAFORMA = 'stz_plt';

function opcoesDoCookie(): {
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

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido.'),
  senha: z.string().min(1, 'Informe a senha.').max(128),
});

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

const empresaSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome da academia.').max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/,
      'Use letras minúsculas, números e hífen (ex.: stabilize-centro).',
    ),
  documento: z.string().trim().max(20).nullish().transform((v) => v || null),
  timezone: z.string().trim().max(60).nullish().transform((v) => v || null),
  plano: z.string().trim().max(60).nullish().transform((v) => v || null),
  contatoNome: z.string().trim().max(120).nullish().transform((v) => v || null),
  contatoEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email('E-mail de contato inválido.')
    .or(z.literal(''))
    .nullish()
    .transform((v) => v || null),
  contatoWhatsapp: z.string().trim().max(30).nullish().transform((v) => v || null),
  testeAte: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(''))
    .nullish()
    .transform((v) => v || null),
  donoNome: z.string().trim().min(2, 'Informe o nome do responsável.').max(160),
  donoEmail: z.string().trim().toLowerCase().email('E-mail do responsável inválido.'),
});

/**
 * Senha provisória do primeiro acesso.
 *
 * Gerada aqui e mostrada UMA VEZ a quem cria a conta. Não é guardada em
 * lugar nenhum em claro, e o usuário é obrigado a trocá-la no primeiro
 * login (`must_change_password`).
 *
 * O alfabeto exclui caracteres que se confundem ao ditar por telefone —
 * 0/O, 1/l/I — porque é assim que essa senha costuma viajar.
 */
function senhaProvisoria(): string {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(14);
  return [...bytes].map((b) => alfabeto[b % alfabeto.length]).join('');
}

/** O operador autenticado, ou 401. */
async function operador(request: FastifyRequest): Promise<{ id: string }> {
  const cabecalho = request.headers.authorization;
  if (cabecalho === undefined || !cabecalho.startsWith('Bearer ')) {
    throw unauthorized('Autenticação necessária.');
  }
  const claims = await verificarTokenPlataforma(cabecalho.slice(7).trim());
  return { id: claims.sub };
}

export async function plataformaRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * POST /api/plataforma/login
   * ---------------------------------------------------------------- */
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { email, senha } = loginSchema.parse(request.body);
      const admin = await repo.buscarAdmin(email);

      /* Compara contra um hash de mentira quando a conta não existe: sem
         isso, "e-mail inexistente" responde em 1 ms e "senha errada" em
         100 ms, e a diferença enumera as contas do painel. */
      if (admin === null) {
        await verifyPassword(await getDummyHash(), senha);
        throw unauthorized('E-mail ou senha incorretos.');
      }

      if (admin.bloqueadoAte !== null && admin.bloqueadoAte > new Date()) {
        throw unauthorized('Conta temporariamente bloqueada. Tente mais tarde.');
      }

      const confere = await verifyPassword(admin.passwordHash, senha);
      if (!confere || !admin.ativo) {
        await repo.registrarTentativa(admin.id, false);
        throw unauthorized('E-mail ou senha incorretos.');
      }

      await repo.registrarTentativa(admin.id, true);

      const acesso = await assinarTokenPlataforma(admin.id);
      const refresh = createRefreshToken();
      await repo.criarSessao(
        admin.id,
        refresh.tokenHash,
        refresh.familyId,
        refresh.expiresAt,
        request.headers['user-agent'] ?? null,
        request.ip,
      );
      await repo.registrar(admin.id, 'plataforma.login', null, null, request.ip);

      void reply.setCookie(COOKIE_PLATAFORMA, refresh.token, opcoesDoCookie());
      return {
        accessToken: acesso.token,
        expiresIn: acesso.expiresIn,
        admin: { id: admin.id, nome: admin.nome, precisaTrocarSenha: admin.precisaTrocarSenha },
      };
    },
  );

  /* ------------------------------------------------------------------
   * POST /api/plataforma/refresh
   * ---------------------------------------------------------------- */
  app.post('/refresh', async (request, reply) => {
    const token = request.cookies[COOKIE_PLATAFORMA];
    if (token === undefined) throw unauthorized('Sessão expirada.');

    const sessao = await repo.buscarSessao(hashRefreshToken(token));
    if (sessao === null) throw unauthorized('Sessão expirada.');

    /* Refresh já usado é sinal de token roubado: quem tem a cópia e quem
       tem o original passam a competir. Derrubar a família inteira é a
       única resposta segura. */
    if (sessao.revogadaEm !== null) {
      await repo.revogarFamilia(sessao.familiaId);
      void reply.clearCookie(COOKIE_PLATAFORMA, opcoesDoCookie());
      throw unauthorized('Sessão encerrada por segurança. Entre novamente.');
    }
    if (sessao.expiraEm < new Date()) {
      void reply.clearCookie(COOKIE_PLATAFORMA, opcoesDoCookie());
      throw unauthorized('Sessão expirada.');
    }

    await repo.revogarFamilia(sessao.familiaId);
    const novo = createRefreshToken(sessao.familiaId);
    await repo.criarSessao(
      sessao.adminId,
      novo.tokenHash,
      novo.familyId,
      novo.expiresAt,
      request.headers['user-agent'] ?? null,
      request.ip,
    );
    const acesso = await assinarTokenPlataforma(sessao.adminId);
    void reply.setCookie(COOKIE_PLATAFORMA, novo.token, opcoesDoCookie());

    /* O `admin` vai junto pelo mesmo motivo que vai no login: recarregar
       a página não pode virar um caminho alternativo. Sem ele a tela não
       sabe quem entrou (mostraria um nome genérico) nem que a senha
       ainda é a provisória — e recarregar passaria por cima da troca
       obrigatória, que é justamente o que ela existe para impedir. */
    const admin = await repo.buscarAdminPorId(sessao.adminId);
    if (admin === null || !admin.ativo) throw unauthorized('Sessão inválida.');

    return {
      accessToken: acesso.token,
      expiresIn: acesso.expiresIn,
      admin: { id: admin.id, nome: admin.nome, precisaTrocarSenha: admin.precisaTrocarSenha },
    };
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[COOKIE_PLATAFORMA];
    if (token !== undefined) {
      const sessao = await repo.buscarSessao(hashRefreshToken(token));
      if (sessao !== null) await repo.revogarFamilia(sessao.familiaId);
    }
    void reply.clearCookie(COOKIE_PLATAFORMA, opcoesDoCookie());
    return { ok: true };
  });

  /* ------------------------------------------------------------------
   * Trocar a própria senha
   * ---------------------------------------------------------------- */
  app.post('/senha', async (request) => {
    const { id } = await operador(request);
    const corpo = z
      .object({
        atual: z.string().min(1).max(128),
        nova: z.string().min(10, 'A senha precisa de pelo menos 10 caracteres.').max(128),
      })
      .parse(request.body);

    const admin = await repo.buscarAdminPorId(id);
    if (admin === null) throw unauthorized('Sessão inválida.');
    if (!(await verifyPassword(admin.passwordHash, corpo.atual))) {
      throw unauthorized('Senha atual incorreta.');
    }

    await repo.trocarSenhaDoAdmin(id, await hashPassword(corpo.nova));
    await repo.registrar(id, 'plataforma.senha_trocada', null, null, request.ip);
    return { ok: true, message: 'Senha alterada. Entre novamente.' };
  });

  /* ------------------------------------------------------------------
   * Métricas e diagnóstico do serviço
   * ---------------------------------------------------------------- */
  app.get('/metricas', async (request) => {
    await operador(request);
    return {
      data: await withoutTenantContext('cron', async (client) => {
        const { rows } = await client.query('SELECT * FROM plataforma_metricas()');
        const m = rows[0] as Record<string, string>;
        const n = (k: string): number => Number(m[k] ?? 0);
        return {
          empresas: n('empresas'),
          empresasAtivas: n('empresas_ativas'),
          empresasSuspensas: n('empresas_suspensas'),
          usuarios: n('usuarios'),
          alunos: n('alunos'),
          alunosAtivos: n('alunos_ativos'),
          agendamentos30d: n('agendamentos_30d'),
          mensagensPendentes: n('mensagens_pendentes'),
          mensagensFalhas: n('mensagens_falhas'),
          logins24h: n('logins_24h'),
          loginsFalhos24h: n('logins_falhos_24h'),
        };
      }),
    };
  });

  app.get('/erros', async (request) => {
    await operador(request);
    const { limite } = z
      .object({ limite: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    return {
      data: await withoutTenantContext('cron', async (client) => {
        const { rows } = await client.query<{
          quando: Date;
          empresa: string;
          acao: string;
          recurso: string;
          resultado: string;
        }>('SELECT * FROM plataforma_erros_recentes($1)', [limite]);
        return rows.map((r) => ({ ...r, quando: r.quando.toISOString() }));
      }),
    };
  });

  app.get('/historico', async (request) => {
    await operador(request);
    const { limite } = z
      .object({ limite: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    return { data: await repo.historico(limite) };
  });

  /* ------------------------------------------------------------------
   * Empresas
   * ---------------------------------------------------------------- */
  app.get('/empresas', async (request) => {
    await operador(request);
    return { data: await repo.listarEmpresas() };
  });

  app.post('/empresas', async (request, reply) => {
    const { id } = await operador(request);
    const dados = empresaSchema.parse(request.body);

    const provisoria = senhaProvisoria();
    let criada: { empresaId: string; donoId: string };
    try {
      criada = await repo.criarEmpresa(dados, await hashPassword(provisoria));
    } catch (erro) {
      /* 23505 é violação de unicidade. O slug é o campo com índice
         único que o operador digita, então a mensagem aponta para ele em
         vez de devolver "erro interno". */
      if ((erro as { code?: string }).code === '23505') {
        throw conflict('Já existe uma academia com este identificador (slug).');
      }
      throw erro;
    }

    await repo.registrar(id, 'plataforma.empresa_criada', criada.empresaId, dados.slug, request.ip, {
      dono: dados.donoEmail,
    });

    void reply.status(201);
    return {
      data: {
        empresaId: criada.empresaId,
        dono: { email: dados.donoEmail, senhaProvisoria: provisoria },
      },
    };
  });

  app.put('/empresas/:id', async (request) => {
    const { id: adminId } = await operador(request);
    const { id } = idParam.parse(request.params);
    const dados = empresaSchema
      .omit({ slug: true, donoNome: true, donoEmail: true })
      .extend({
        observacoes: z.string().trim().max(2000).nullish().transform((v) => v || null),
      })
      .parse(request.body);

    if (!(await repo.atualizarEmpresa(id, dados))) throw notFound('Academia');
    await repo.registrar(adminId, 'plataforma.empresa_editada', id, dados.nome, request.ip);
    return { ok: true };
  });

  app.post('/empresas/:id/situacao', async (request) => {
    const { id: adminId } = await operador(request);
    const { id } = idParam.parse(request.params);
    const { ativa, motivo } = z
      .object({
        ativa: z.boolean(),
        motivo: z.string().trim().max(300).nullish().transform((v) => v || null),
      })
      .parse(request.body);

    if (!ativa && motivo === null) {
      /* Suspender sem motivo gera a pergunta "por que esta academia está
         fora?" seis meses depois, sem resposta. */
      throw badRequest('Informe o motivo da suspensão.');
    }

    if (!(await repo.definirAtiva(id, ativa, motivo))) throw notFound('Academia');
    await repo.registrar(
      adminId,
      ativa ? 'plataforma.empresa_reativada' : 'plataforma.empresa_suspensa',
      id,
      motivo,
      request.ip,
    );
    return { ok: true };
  });

  /* ------------------------------------------------------------------
   * Usuários de cada empresa
   * ---------------------------------------------------------------- */
  app.get('/empresas/:id/usuarios', async (request) => {
    await operador(request);
    const { id } = idParam.parse(request.params);
    return {
      data: await withoutTenantContext('cron', async (client) => {
        const { rows } = await client.query<{
          id: string;
          nome: string;
          email: string;
          papel: string;
          ativo: boolean;
          ultimo_acesso: Date | null;
        }>('SELECT * FROM plataforma_listar_usuarios($1)', [id]);
        return rows.map((u) => ({
          id: u.id,
          nome: u.nome,
          email: u.email,
          papel: u.papel,
          ativo: u.ativo,
          ultimoAcesso: u.ultimo_acesso?.toISOString() ?? null,
        }));
      }),
    };
  });

  app.post('/empresas/:id/gestores', async (request, reply) => {
    const { id: adminId } = await operador(request);
    const { id } = idParam.parse(request.params);
    const dados = z
      .object({
        nome: z.string().trim().min(2).max(160),
        email: z.string().trim().toLowerCase().email('E-mail inválido.'),
        papel: z.enum(['OWNER', 'ADMIN']),
      })
      .parse(request.body);

    const provisoria = senhaProvisoria();
    let novoId: string;
    try {
      novoId = await repo.criarGestor(
        id,
        dados.nome,
        dados.email,
        await hashPassword(provisoria),
        dados.papel,
      );
    } catch (erro) {
      if ((erro as { code?: string }).code === '23505') {
        throw conflict('Já existe um usuário com este e-mail nesta academia.');
      }
      throw erro;
    }

    await repo.registrar(adminId, 'plataforma.gestor_criado', id, dados.email, request.ip);
    void reply.status(201);
    return { data: { id: novoId, senhaProvisoria: provisoria } };
  });

  app.post('/usuarios/:id/senha', async (request) => {
    const { id: adminId } = await operador(request);
    const { id } = idParam.parse(request.params);
    const provisoria = senhaProvisoria();
    if (!(await repo.redefinirSenhaDoGestor(id, await hashPassword(provisoria)))) {
      throw notFound('Usuário');
    }
    await repo.registrar(adminId, 'plataforma.senha_redefinida', null, id, request.ip);
    return { data: { senhaProvisoria: provisoria } };
  });

  app.post('/usuarios/:id/situacao', async (request) => {
    const { id: adminId } = await operador(request);
    const { id } = idParam.parse(request.params);
    const { ativo } = z.object({ ativo: z.boolean() }).parse(request.body);
    if (!(await repo.ativarGestor(id, ativo))) throw notFound('Usuário');
    await repo.registrar(
      adminId,
      ativo ? 'plataforma.usuario_ativado' : 'plataforma.usuario_desativado',
      null,
      id,
      request.ip,
    );
    return { ok: true };
  });

  /* ------------------------------------------------------------------
   * POST /api/plataforma/usuarios/:id/entrar
   *
   * Emite um token NORMAL de usuário para o operador dar suporte vendo
   * o que o cliente vê. É a rota mais poderosa do sistema, e o que a
   * torna aceitável não é limitar o poder — é o rastro: grava no diário
   * da plataforma E no audit_log DA PRÓPRIA ACADEMIA, onde o dono dela
   * enxerga.
   * ---------------------------------------------------------------- */
  app.post('/usuarios/:id/entrar', async (request) => {
    const { id: adminId } = await operador(request);
    const { id } = idParam.parse(request.params);

    const alvo = await withoutTenantContext('cron', async (client) => {
      const { rows } = await client.query<{
        user_id: string;
        tenant_id: string;
        papel: string;
        nome: string;
        email: string;
        empresa: string;
        aluno_id: string | null;
        ativo: boolean;
        empresa_ativa: boolean;
      }>('SELECT * FROM plataforma_usuario_para_acesso($1)', [id]);
      return rows[0] ?? null;
    });

    if (alvo === null) throw notFound('Usuário');
    if (!alvo.ativo) throw forbidden('Este usuário está desativado.');
    if (!alvo.empresa_ativa) throw forbidden('Esta academia está suspensa.');

    /* O registro acontece ANTES de o token existir. Se a gravação
       falhar, o acesso não é concedido — um acesso sem rastro é
       exatamente o que esta rota não pode produzir. */
    await repo.registrar(adminId, 'plataforma.entrou_como', alvo.tenant_id, alvo.email, request.ip, {
      papel: alvo.papel,
    });
    /* Pela FUNÇÃO, não por INSERT direto: a policy de `audit_log` exige
       `tenant_id = current_tenant_id()` e o painel roda sem contexto de
       empresa. O INSERT direto respondia 42501, que vira 404 — o acesso
       de suporte falhava inteiro com "Recurso não encontrado". */
    await withoutTenantContext('cron', (client) =>
      client.query('SELECT plataforma_registrar_acesso_suporte($1, $2, $3, $4, $5)', [
        alvo.tenant_id,
        alvo.user_id,
        alvo.papel,
        request.ip,
        adminId,
      ]),
    );

    const acesso = await signAccessToken({
      userId: alvo.user_id,
      tenantId: alvo.tenant_id,
      role: alvo.papel as Role,
      ...(alvo.aluno_id !== null ? { studentId: alvo.aluno_id } : {}),
    });

    return {
      data: {
        accessToken: acesso.token,
        expiresIn: acesso.expiresIn,
        /* SEM cookie de refresh: a sessão de suporte dura o tempo do
           access token e acaba. Renovar exigiria uma sessão persistente
           na academia, e sessão de suporte que se renova sozinha é
           sessão que fica aberta esquecida. */
        comoUsuario: { nome: alvo.nome, email: alvo.email, papel: alvo.papel },
        empresa: alvo.empresa,
      },
    };
  });

  /* ------------------------------------------------------------------
   * Configuração do WhatsApp
   * ---------------------------------------------------------------- */
  app.get('/config', async (request) => {
    await operador(request);
    const c = await repo.lerConfig();
    return {
      data: {
        uazapiBaseUrl: c.uazapiBaseUrl,
        /* O TOKEN NUNCA VOLTA PARA A TELA. O painel mostra só se existe
           ou não; reexibi-lo seria espalhar por logs de navegador e
           capturas de tela um segredo que fala em nome de todas as
           academias. */
        temToken: c.uazapiAdminCifrado !== null,
        atualizadoEm: c.atualizadoEm,
      },
    };
  });

  app.put('/config', async (request) => {
    const { id } = await operador(request);
    const dados = z
      .object({
        uazapiBaseUrl: z
          .string()
          .trim()
          .url('Endereço inválido. Use https://...')
          .or(z.literal(''))
          .nullish()
          .transform((v) => v || null),
        /* Vazio ou ausente MANTÉM o token que já está lá — o painel não
           o reexibe, então salvar o formulário sem redigitá-lo não pode
           apagar a integração de todas as academias. */
        uazapiAdminToken: z
          .string()
          .trim()
          .max(500)
          .nullish()
          .transform((v) => (v ? v : null)),
      })
      .parse(request.body);

    await repo.gravarConfig(
      dados.uazapiBaseUrl,
      dados.uazapiAdminToken === null ? null : cifrar(dados.uazapiAdminToken),
      id,
    );
    await repo.registrar(id, 'plataforma.config_salva', null, null, request.ip, {
      trocouToken: dados.uazapiAdminToken !== null,
    });
    return { ok: true };
  });
}
