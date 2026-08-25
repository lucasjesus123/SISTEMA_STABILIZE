-- ---------------------------------------------------------------------
-- O que cada pessoa enxerga do sistema.
--
-- Até aqui o acesso era só o PAPEL: quem entrava como recepção via o que
-- toda recepção vê, e quem entrava como administrador via tudo. Serve
-- para uma academia pequena e para de servir na primeira contratação
-- específica — a pessoa do financeiro, que não tem por que abrir
-- prontuário de aluno, e o professor que não precisa do caixa.
--
-- A COLUNA GUARDA O QUE A PESSOA FAZ, não o que ela pode. O papel
-- continua sendo o teto: o conjunto efetivo é a INTERSEÇÃO entre os dois
-- (ver `permissionsOf` e `scopeComAreas` em `rbac.ts`). Marcar uma área
-- nunca acrescenta permissão fora do papel — se acrescentasse, a matriz
-- de papéis deixaria de responder "o que este papel enxerga?", e a
-- resposta viraria "depende de quem foi marcado".
--
-- NULO É O PADRÃO E SIGNIFICA "TUDO DO PAPEL". É o que todo usuário que
-- já existe continua tendo depois desta migração: ninguém perde acesso
-- porque uma coluna nova apareceu.
--
-- POR QUE `text[]` E NÃO UMA TABELA. São no máximo oito valores por
-- pessoa, lidos junto com a linha do usuário em todo login e nunca
-- consultados de forma independente ("quem tem acesso ao financeiro?" se
-- responde com um `&&` sobre esta coluna). Uma tabela de ligação
-- acrescentaria um JOIN no caminho mais quente do sistema para resolver
-- um problema que não existe.
-- ---------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS areas text[];

/* A LISTA VÁLIDA MORA NO BANCO TAMBÉM, e não só no TypeScript. Um valor
   escrito errado — "financiero" — não daria erro em lugar nenhum: a
   interseção simplesmente não encontraria a área e a pessoa ficaria sem
   nada, com a tela em branco e sem explicação. Aqui a gravação falha na
   hora, com o nome do campo. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_areas_conhecidas'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_areas_conhecidas CHECK (
      areas IS NULL OR areas <@ ARRAY[
        'recepcao', 'alunos', 'agenda', 'financeiro',
        'interessados', 'equipe', 'whatsapp', 'academia'
      ]::text[]
    );
  END IF;
END $$;

/* Array vazio e NULO significam a mesma coisa para quem lê — "sem
   recorte" —, e deixar os dois estados representarem a mesma coisa é
   como nasce um `if` esquecido. O vazio vira nulo na entrada. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_areas_nao_vazio'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_areas_nao_vazio CHECK (
      areas IS NULL OR cardinality(areas) > 0
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- As áreas de uma pessoa, para o login e o refresh
--
-- FUNÇÃO NOVA em vez de acrescentar uma coluna ao retorno de
-- `auth_lookup_user`. Mudar o tipo de retorno de uma função exige
-- derrubá-la e recriá-la, e aquela é a função do LOGIN: derrubar a porta
-- de entrada durante uma atualização, ainda que por instantes, é risco
-- gratuito para poupar uma consulta que acontece uma vez por sessão.
--
-- Roda sem contexto de tenant porque o login ainda não sabe qual é o
-- tenant — é justamente o que ele está descobrindo. Devolve APENAS as
-- áreas: nome, papel e situação continuam vindo de onde sempre vieram.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_areas_do_usuario(p_user uuid)
RETURNS text[]
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.areas FROM users u WHERE u.id = p_user
$$;

/* O DONO PRECISA SER `stabilize_auth`, e isto não é detalhe de
   arrumação: sob FORCE RLS, uma função SECURITY DEFINER pertencente a
   papel SEM BYPASSRLS devolve ZERO LINHAS para todo mundo. É o defeito
   que o 007 documenta e que impediu qualquer login na primeira
   instalação — aqui ele apareceria como "toda pessoa perdeu todas as
   áreas", que é uma tela em branco sem mensagem de erro.

   Por isso este arquivo tem `_super` no nome: roda com a credencial de
   superusuário, que é quem pode transferir o dono. */
ALTER FUNCTION auth_areas_do_usuario(uuid) OWNER TO stabilize_auth;
REVOKE ALL ON FUNCTION auth_areas_do_usuario(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_areas_do_usuario(uuid) TO stabilize_app;
