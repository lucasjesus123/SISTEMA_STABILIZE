-- =====================================================================
-- 037 — O operador da plataforma consegue excluir uma academia
--
-- O DEFEITO, EXATAMENTE COMO APARECIA
--
-- "Excluir academia" no painel da plataforma devolvia **"Recurso não
-- encontrado"** para uma academia que estava ali na tela, com nome e
-- contagem certos. O Super Admin não conseguia excluir nada — e a
-- mensagem mandava procurar no lugar errado.
--
-- A CADEIA COMPLETA, medida:
--
--   1. `plataforma_excluir_empresa` faz `DELETE FROM tenants`.
--   2. O cascade apaga as filhas. Até aqui tudo bem: o PostgreSQL faz o
--      cascade pelo sistema e NÃO exige DELETE nas tabelas filhas —
--      cheguei a suspeitar disso e o teste derrubou a hipótese.
--   3. Mas o cascade DISPARA GATILHOS. Apagar `finance_payments`
--      dispara `recalc_entry_paid()`, que é gatilho comum (não
--      SECURITY DEFINER) e por isso roda com os privilégios de quem
--      está apagando.
--   4. Ele faz `SELECT ... FROM finance_payments`, e
--      `stabilize_plataforma` não tinha privilégio nenhum ali.
--   5. Sai `42501 permission denied for table finance_payments`.
--   6. E `errors.ts` mapeia 42501 para 404 "Recurso não encontrado",
--      de propósito — porque na aplicação um 42501 quase sempre é a RLS
--      barrando acesso entre empresas, e responder "não existe" é o
--      certo ali: dizer "sem permissão" confirmaria que o registro da
--      outra academia existe.
--
-- O mascaramento está CERTO para o caso dele e foi o que escondeu este.
-- A correção é dar ao operador o acesso que o trabalho dele exige, e
-- não afrouxar o mapeamento de erro.
--
-- POR QUE NÃO APARECEU ANTES: uma academia vazia é excluída sem
-- problema — sem pagamento, o gatilho não dispara. O erro só existe com
-- dados de verdade, que é exatamente quando alguém quer excluir.
--
-- O LAÇO, E NÃO UMA LISTA. Uma lista fixa de tabelas envelhece: toda
-- migração que criar tabela nova com `tenant_id` reintroduz o defeito, e
-- ele só vai aparecer no dia em que alguém tentar excluir uma academia
-- que use aquela tabela. O laço percorre quem tem `tenant_id` e cobre as
-- que ainda vão existir. É `_super.sql`, então roda em todo deploy.
-- =====================================================================

DO $$
DECLARE
  t text;
  n int := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
                         AND a.attname = 'tenant_id'
                         AND NOT a.attisdropped
     WHERE c.relkind = 'r' AND ns.nspname = 'public'
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO stabilize_plataforma',
      t
    );
    n := n + 1;
  END LOOP;

  /* `tenants` não tem coluna `tenant_id` — é a própria tabela raiz, e
     ficaria de fora do laço acima. Sem DELETE aqui, nada disto adianta. */
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO stabilize_plataforma;

  RAISE NOTICE 'plataforma: acesso concedido em % tabelas com tenant_id, mais tenants', n;
END
$$;

/* AS SEQUÊNCIAS TAMBÉM. Sem `USAGE`, um INSERT numa tabela com coluna
   serial é recusado — e o operador da plataforma insere ao criar
   academia e gestor. Não é o caso da exclusão, mas é o mesmo tipo de
   buraco esperando o próximo. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE c.relkind = 'S' AND ns.nspname = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO stabilize_plataforma', s);
  END LOOP;
END
$$;
