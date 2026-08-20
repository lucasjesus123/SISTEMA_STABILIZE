-- =====================================================================
-- RESERVA DE ESPAÇO
--
-- A academia tem lugares — mezanino, hall, sala de bike, tatame — e cada
-- um deles é um recurso que se ocupa. Até aqui:
--
--   O CADASTRO DE ESPAÇOS EXISTIA NA API E NÃO TINHA TELA. `rooms` está
--   no schema desde o começo, `GET/POST/PUT /api/cadastros/salas`
--   respondem, e nenhuma tela do sistema chama essas rotas. O resultado
--   é o que se vê em produção: o filtro "Espaço" da agenda não aparece,
--   porque ele só aparece quando existem espaços — e nunca existiu
--   nenhum, porque não havia como cadastrar.
--
--   A RESERVA NÃO EXISTIA DE JEITO NENHUM. `availability_blocks` já
--   tinha `room_id`, `period` e `reason`, e o cálculo de horários livres
--   já a lia — mas NENHUMA rota escrevia nela. Era uma tabela só de
--   leitura de dados que ninguém podia criar.
--
-- O QUE ESTA MIGRAÇÃO ACRESCENTA é o que falta para a reserva ser
-- utilizável de verdade: a noção de SÉRIE.
--
-- POR QUE SÉRIE, E NÃO UMA REGRA DE RECORRÊNCIA
--
-- "Toda segunda e quarta às 19h a sala de bike é da aula de spinning" é
-- uma frase sobre o futuro inteiro. Guardá-la como regra faria a agenda
-- ter que resolver a recorrência a cada consulta, e — pior — deixaria a
-- exceção sem lugar: no feriado não tem aula, e uma regra não sabe disso.
--
-- Materializar cada ocorrência resolve os dois: a grade lê linhas
-- concretas, e cancelar UMA quarta-feira é apagar uma linha. O `serie_id`
-- existe para o outro lado da moeda — cancelar a série inteira quando a
-- aula acaba.
-- =====================================================================

/* Quem pertence à mesma reserva repetida. NULL é reserva avulsa. */
ALTER TABLE availability_blocks
  ADD COLUMN IF NOT EXISTS serie_id uuid;

/* Quem reservou. Numa academia com quatro pessoas no balcão, "quem
   travou o mezanino na sexta à noite" é uma pergunta que se faz. */
ALTER TABLE availability_blocks
  ADD COLUMN IF NOT EXISTS criado_por uuid REFERENCES users(id) ON DELETE SET NULL;

/* A grade lê por período; a série é lida ao cancelar tudo. */
CREATE INDEX IF NOT EXISTS idx_bloqueio_periodo
  ON availability_blocks USING gist (tenant_id, period);

CREATE INDEX IF NOT EXISTS idx_bloqueio_serie
  ON availability_blocks (serie_id) WHERE serie_id IS NOT NULL;

/* DOIS EVENTOS NÃO OCUPAM O MESMO ESPAÇO NA MESMA HORA.
   Sem isto, reservar o mezanino das 19h às 20h duas vezes é possível, e
   a segunda reserva só aparece como problema quando as duas turmas
   chegam na porta. O EXCLUDE é a única forma de garantir isso sob
   concorrência — duas pessoas clicando ao mesmo tempo em dois
   computadores passariam por qualquer verificação feita em SELECT.

   A restrição vale SÓ para bloqueios com espaço definido: um bloqueio de
   profissional (`room_id` nulo) não disputa espaço com ninguém. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bloqueio_espaco_sem_sobreposicao') THEN
    ALTER TABLE availability_blocks
      ADD CONSTRAINT bloqueio_espaco_sem_sobreposicao
      EXCLUDE USING gist (
        room_id WITH =,
        period  WITH &&
      ) WHERE (room_id IS NOT NULL);
  END IF;
END
$$;

COMMENT ON COLUMN availability_blocks.serie_id IS
  'Agrupa as ocorrências de uma reserva que se repete. NULL = reserva avulsa.';
COMMENT ON CONSTRAINT bloqueio_espaco_sem_sobreposicao ON availability_blocks IS
  'Um espaço não é reservado duas vezes no mesmo horário. Vale só quando há espaço definido.';

-- ---------------------------------------------------------------------
-- Um espaço não se repete de nome dentro da mesma academia
--
-- "Sala de bike" e "sala de bike" são o mesmo lugar para quem opera, e
-- dois cadastros do mesmo lugar dividem a agenda dele em duas — que é o
-- oposto do que o cadastro serve.
--
-- O índice é sobre o nome NORMALIZADO e só sobre os ativos: um espaço
-- desativado pode ter o nome reaproveitado.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_espaco_nome_unico
  ON rooms (tenant_id, lower(btrim(name)))
  WHERE is_active;
