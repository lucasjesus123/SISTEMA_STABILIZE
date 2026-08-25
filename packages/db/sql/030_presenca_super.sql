-- ---------------------------------------------------------------------
-- Quem está usando o sistema AGORA.
--
-- O painel da plataforma sabia quantas academias existem e quantos
-- usuários cada uma tem. Não sabia a única coisa que o dono do serviço
-- olha primeiro: quais estão VIVAS neste momento. Um cliente que parou
-- de usar continua contando como "6 usuários" até o dia em que cancela.
--
-- POR QUE UMA COLUNA NOVA, e não uma conta sobre o que já existe:
--
--   `last_login_at` é o login, não o uso. Quem entrou de manhã e ficou o
--   dia inteiro tem o mesmo carimbo de quem entrou de manhã e fechou a
--   aba — e é a diferença entre os dois que interessa.
--
--   `user_sessions` dura quatorze dias e só ganha linha nova quando o
--   refresh roda, o que aqui acontece na expiração do access token e não
--   num relógio. Uma sessão "não revogada" não quer dizer ninguém
--   olhando para a tela.
--
--   `audit_log` só registra o que muda alguma coisa. Uma recepcionista
--   que passou a manhã consultando a agenda não aparece nele, e ela é
--   exatamente o caso de "tem gente usando".
--
-- A coluna é escrita no máximo uma vez a cada poucos minutos por pessoa
-- — ver `TOQUE_MINIMO_MS` em `authenticate.ts`. Não é um contador de
-- requisições, é um carimbo de "esta pessoa estava aqui".
-- ---------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

/* A pergunta que este índice responde é sempre a mesma — "quem desta
   academia apareceu nos últimos minutos?" — e é feita uma vez por
   academia a cada atualização do painel. */
CREATE INDEX IF NOT EXISTS idx_users_presenca ON users (tenant_id, last_seen_at DESC);

-- ---------------------------------------------------------------------
-- A rede inteira, numa consulta
--
-- Devolve NÚMEROS por academia, nunca linhas dela — a mesma regra de
-- `plataforma_listar_empresas`, e pelo mesmo motivo: o operador do
-- serviço precisa saber que a academia tem 214 alunos e não precisa
-- saber quem são.
--
-- Existe SEPARADA da listagem antiga em vez de substituí-la porque
-- mudar o tipo de retorno de uma função exige derrubá-la primeiro, e
-- derrubar função que a API em produção está chamando é uma janela de
-- erro 500 em troca de nada.
-- ---------------------------------------------------------------------
/* O 014 deu a `stabilize_plataforma` acesso às tabelas que o painel já
   contava — `tenants`, `users`, `students` — e a nenhuma outra, de
   propósito. A contagem de entradas do dia precisa de `checkins`, e é
   SELECT e só: o painel conta, não lê linha de ninguém. Sem esta linha a
   função morre com "permission denied for table checkins", porque
   BYPASSRLS contorna a política de linha e não a permissão de tabela. */
GRANT SELECT ON checkins TO stabilize_plataforma;

CREATE OR REPLACE FUNCTION plataforma_rede(p_janela_minutos integer)
RETURNS TABLE (
  id                uuid,
  nome              text,
  slug              text,
  documento         text,
  plano             text,
  ativa             boolean,
  suspensa_motivo   text,
  teste_ate         date,
  criada_em         timestamptz,
  alunos            bigint,
  alunos_ativos     bigint,
  usuarios          bigint,
  online_agora      bigint,
  ultima_atividade  timestamptz,
  entradas_hoje     bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    t.id,
    t.name,
    t.slug,
    t.document,
    t.plano,
    t.is_active,
    t.suspensa_motivo,
    t.teste_ate,
    t.created_at,
    (SELECT count(*) FROM students s WHERE s.tenant_id = t.id),
    (SELECT count(*) FROM students s WHERE s.tenant_id = t.id AND s.status = 'ACTIVE'),
    (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active),
    (SELECT count(*) FROM users u
      WHERE u.tenant_id = t.id
        AND u.is_active
        AND u.last_seen_at > now() - make_interval(mins => greatest(coalesce(p_janela_minutos, 5), 1))),
    (SELECT max(u.last_seen_at) FROM users u WHERE u.tenant_id = t.id),
    /* Entradas de aluno HOJE, pelo relógio da academia. `current_date`
       seria o dia do fuso da sessão do banco — UTC no servidor —, e
       entre as 21h e a meia-noite no Brasil os dois discordam: o painel
       zeraria o contador enquanto a academia ainda está aberta. */
    (SELECT count(*) FROM checkins c
      WHERE c.tenant_id = t.id
        AND (c.entrou_em AT TIME ZONE t.timezone)::date
            = (now() AT TIME ZONE t.timezone)::date)
  FROM tenants t
  ORDER BY t.is_active DESC, t.name
$$;

-- ---------------------------------------------------------------------
-- Dono e permissão. Mesmo tratamento de 014 e 029: SECURITY DEFINER só
-- funciona com dono BYPASSRLS, e o migrador comum não pode assumir aquele
-- papel — daí o `_super` no nome do arquivo, que o faz rodar com a
-- credencial de superusuário e a cada atualização.
-- ---------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOR f IN
    SELECT format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'plataforma_rede'
  LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO stabilize_plataforma', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO stabilize_app', f);
  END LOOP;
END $$;
