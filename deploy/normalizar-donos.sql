-- =====================================================================
-- NORMALIZA DONO E PERMISSÕES DEPOIS DE UMA RESTAURAÇÃO
--
-- POR QUE ISTO EXISTE — o defeito que ele conserta:
--
-- `pg_restore --no-owner` faz TODOS os objetos nascerem pertencendo ao
-- papel que restaurou, que é o superusuário. O sistema volta ao ar e
-- funciona: a API entra como `stabilize_app`, as permissões vêm no dump
-- e a RLS continua valendo. Tudo parece certo.
--
-- Até o próximo deploy. Aí `./deploy/atualizar.sh` roda as migrations
-- como `stabilize_migrator` e morre na primeira:
--
--     ERROR:  must be owner of table students
--
-- E aí é o pior momento possível para descobrir: dias ou semanas depois
-- da restauração, quando ninguém liga mais uma coisa à outra, e o
-- sintoma ("não consigo atualizar o sistema") não parece ter nada a ver
-- com o incidente de antes.
--
-- Este arquivo foi escrito depois de fazer uma restauração de verdade e
-- ver esse erro acontecer.
--
-- É IDEMPOTENTE e roda como superusuário. Passar duas vezes não muda
-- nada na segunda.
-- =====================================================================

DO $$
DECLARE
  r record;
BEGIN
  -- Tabelas e sequências voltam para o papel de migração, que é quem
  -- tem — e deve ter — poder de DDL neste banco.
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO stabilize_migrator', r.tablename);
  END LOOP;

  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO stabilize_migrator', r.sequencename);
  END LOOP;

  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO stabilize_migrator', r.viewname);
  END LOOP;

  /* Funções também: `current_tenant_id()` é chamada por toda política de
     RLS do sistema, e uma função que o migrator não possui é uma função
     que ele não consegue substituir na próxima versão. */
  FOR r IN
    SELECT p.oid::regprocedure AS assinatura
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO stabilize_migrator', r.assinatura);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- As permissões da API
--
-- Vêm no dump e quase sempre chegam certas. Reafirmá-las custa nada e
-- cobre o caso em que o dump veio de um banco montado à mão, sem o
-- ALTER DEFAULT PRIVILEGES do 000_roles.sql — situação em que a API
-- volta e responde "permission denied for table students" em toda tela.
--
-- AS TABELAS DA PLATAFORMA FICAM DE FORA. `stabilize_app` é o papel da
-- API de uma academia; dar a ele acesso ao cadastro de empresas e aos
-- administradores da plataforma seria abrir a porta que o 000_roles.sql
-- fecha de propósito.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT IN ('platform_admins', 'platform_audit',
                             'platform_sessions', 'platform_settings')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO stabilize_app', r.tablename);
  END LOOP;

  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO stabilize_app', r.sequencename);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO stabilize_app;
GRANT CREATE, USAGE ON SCHEMA public TO stabilize_migrator;

-- ---------------------------------------------------------------------
-- A CONFERÊNCIA
--
-- Sem ela este arquivo seria só mais uma coisa que roda e ninguém sabe
-- se funcionou. `has_table_privilege` responde a pergunta exata que
-- importa: o migrator consegue mexer na estrutura, e a API consegue ler.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  sem_dono int;
  sem_grant int;
BEGIN
  SELECT count(*) INTO sem_dono
    FROM pg_tables
   WHERE schemaname = 'public' AND tableowner <> 'stabilize_migrator';

  SELECT count(*) INTO sem_grant
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT IN ('platform_admins', 'platform_audit',
                           'platform_sessions', 'platform_settings')
     AND NOT has_table_privilege('stabilize_app', schemaname || '.' || tablename, 'SELECT');

  IF sem_dono > 0 OR sem_grant > 0 THEN
    RAISE EXCEPTION
      'normalização incompleta: % tabela(s) com dono errado, % sem permissão para a API',
      sem_dono, sem_grant;
  END IF;

  RAISE NOTICE 'donos e permissões conferidos: tudo em stabilize_migrator, API com acesso.';
END
$$;
