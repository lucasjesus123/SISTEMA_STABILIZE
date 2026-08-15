-- =====================================================================
-- SUPORTE A TAREFAS DE FUNDO
--
-- O PROBLEMA: uma tarefa agendada (aniversários, lembretes) não roda
-- dentro de uma requisição. Não há usuário, não há tenant, e portanto
-- não há `app.tenant_id` — e com RLS FORCE em toda tabela, uma consulta
-- sem contexto enxerga ZERO linhas. O job varreria o banco inteiro e
-- concluiria, todo dia, que não há nada a fazer.
--
-- É o mesmo ovo-e-galinha do login, e a solução é a mesma: uma função
-- SECURITY DEFINER, estreita, com search_path fixo.
--
-- O QUE ESTA FUNÇÃO PODE DEVOLVER, e por que é aceitável: apenas os IDs
-- das empresas ativas. Nenhum dado de aluno, nenhum nome, nenhum
-- telefone. Com a lista de ids em mãos, o job abre UMA transação por
-- empresa, define o contexto, e a partir daí a RLS volta a valer
-- integralmente — inclusive contra o próprio job.
--
-- O buraco é do tamanho exato do problema: quem obtiver execução como
-- `stabilize_app` já podia descobrir a existência de outras empresas por
-- outros caminhos (o slug no login, por exemplo). O que ele continua não
-- podendo é LER qualquer coisa dentro delas.
-- =====================================================================

CREATE OR REPLACE FUNCTION jobs_tenants_ativos()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- search_path fixo: sem isto, um schema plantado antes de `public` no
-- caminho de busca sequestraria a resolução de nomes DENTRO de uma
-- função que roda com os privilégios do dono. É o vetor clássico de
-- escalada em SECURITY DEFINER.
SET search_path = public, pg_temp
AS $$
  SELECT t.id
    FROM tenants t
   WHERE t.is_active
   ORDER BY t.created_at
$$;

COMMENT ON FUNCTION jobs_tenants_ativos() IS
  'Somente IDs de empresas ativas, para tarefas de fundo. Não devolve dado nenhum de dentro delas.';

-- Ninguém além do papel da aplicação. `PUBLIC` inclui todo papel futuro,
-- inclusive os criados por engano.
REVOKE ALL ON FUNCTION jobs_tenants_ativos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_tenants_ativos() TO stabilize_app;
