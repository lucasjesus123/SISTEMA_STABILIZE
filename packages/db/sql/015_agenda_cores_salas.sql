-- =====================================================================
-- COR DO PROFISSIONAL E AMBIENTE COMPARTILHADO
--
-- Duas mudanças na agenda, e a segunda muda uma regra do banco.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A COR DE CADA PROFISSIONAL
--
-- Numa grade de semana com seis profissionais e noventa atendimentos, a
-- cor é o que permite ler a tela sem soletrar nome em cada bloco. É
-- atributo do profissional, não do atendimento: dois blocos da mesma
-- pessoa em dias diferentes têm que ser a mesma cor, sempre.
--
-- Guardada como HEX validado por CHECK, e não como nome de cor nem como
-- índice de paleta. Nome ("verde") empurra a tradução para a tela e
-- multiplica por quantas telas existirem; índice de paleta amarra o dado
-- ao CSS de hoje, e trocar a paleta reescreveria o histórico visual da
-- academia.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS cor text;

DO $cores$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_cor_hex') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_cor_hex
      CHECK (cor IS NULL OR cor ~ '^#[0-9A-Fa-f]{6}$')
      NOT VALID;
  END IF;
END
$cores$;

-- Quem já existe recebe uma cor estável, derivada do próprio id. Sem
-- isto a agenda abriria cinza para toda a equipe até alguém editar
-- usuário por usuário — e a cor é justamente o que se quer ver de
-- imediato. A paleta é a mesma da marca: teais, menta, âmbar, coral e
-- roxo, todos legíveis com texto escuro por cima.
DO $atribuir$
DECLARE
  paleta text[] := ARRAY[
    '#2E9AA1', '#5FB3A0', '#7C6BD6', '#D08A2E',
    '#C4566B', '#3F7FBF', '#6FA83C', '#B5567F'
  ];
BEGIN
  ALTER TABLE users NO FORCE ROW LEVEL SECURITY;

  /* Distribuídas por ORDEM dentro da empresa, e não por hash do id. O
     hash parecia elegante e colidiu na primeira execução: com oito cores
     e três profissionais, dois saíram com o mesmo teal — e cor repetida
     numa agenda é pior que cor nenhuma, porque parece informação e não
     é. Por ordem, a paleta só repete a partir do nono profissional. */
  WITH numerados AS (
    SELECT u.id,
           row_number() OVER (PARTITION BY u.tenant_id ORDER BY u.created_at, u.id) AS n
      FROM users u
     WHERE u.cor IS NULL
       AND u.role IN ('OWNER', 'ADMIN', 'PROFESSIONAL')
  )
  UPDATE users u
     SET cor = paleta[1 + ((n.n - 1) % array_length(paleta, 1))]
    FROM numerados n
   WHERE u.id = n.id;

  ALTER TABLE users FORCE ROW LEVEL SECURITY;
END
$atribuir$;

COMMENT ON COLUMN users.cor IS
  'Cor do profissional na agenda, em hex. Atributo da pessoa, não do atendimento.';

-- ---------------------------------------------------------------------
-- 2. AMBIENTE COMPARTILHADO
--
-- O PROBLEMA: `rooms` sempre teve `capacity`, e a restrição de agenda
-- ignorava esse número. `appt_no_room_overlap` é um EXCLUDE que recusa
-- QUALQUER par de atendimentos sobrepostos na mesma sala — o que está
-- certo para uma sala de avaliação e errado para o térreo de uma
-- academia, onde oito pessoas treinam ao mesmo tempo. Com a restrição
-- como estava, marcar o segundo aluno das 7h no salão principal
-- respondia erro de conflito.
--
-- POR QUE NÃO DÁ PARA CONSERTAR O EXCLUDE: um índice de exclusão compara
-- PARES de linhas e recusa quando o predicado casa. Ele não conta. Não
-- existe forma de escrever "recuse a partir da nona sobreposição" em
-- `EXCLUDE USING gist`.
--
-- A TROCA: gatilho que conta os atendimentos sobrepostos e compara com a
-- capacidade. O custo é sair de uma garantia estrutural do banco para
-- uma verificação em código — e é por isso que ela trava a linha da SALA
-- antes de contar. Sem o lock, dois agendamentos simultâneos para a
-- última vaga leem "restam 1" ao mesmo tempo e os dois entram; é a mesma
-- corrida do contador de código do aluno, e a mesma solução.
--
-- As outras duas exclusões CONTINUAM: profissional e aluno seguem sem
-- poder estar em dois lugares ao mesmo tempo, porque ali o limite é
-- sempre um e a garantia estrutural é melhor que qualquer gatilho.
-- ---------------------------------------------------------------------
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appt_no_room_overlap;

CREATE OR REPLACE FUNCTION checar_capacidade_da_sala()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_capacidade integer;
  v_nome       text;
  v_ocupados   integer;
BEGIN
  IF NEW.room_id IS NULL OR NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  /* TRAVA A SALA antes de contar. É isto que faz duas marcações
     simultâneas para a última vaga virarem uma aceita e uma recusada,
     em vez de duas aceitas. */
  SELECT r.capacity, r.name INTO v_capacidade, v_nome
    FROM rooms r
   WHERE r.id = NEW.room_id
     FOR UPDATE;

  IF v_capacidade IS NULL THEN
    RAISE EXCEPTION 'sala inalcançável: %', NEW.room_id;
  END IF;

  SELECT count(*) INTO v_ocupados
    FROM appointments a
   WHERE a.room_id = NEW.room_id
     AND a.status <> 'CANCELLED'
     AND a.period && NEW.period
     AND a.id <> NEW.id;

  IF v_ocupados >= v_capacidade THEN
    /* Mensagem em português e com o número: "conflito de horário" manda
       quem atende adivinhar se o problema é o professor, a sala ou o
       aluno. */
    RAISE EXCEPTION 'A sala % já está com % de % vagas ocupadas neste horário.',
      v_nome, v_ocupados, v_capacidade
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_appt_capacidade ON appointments;
CREATE TRIGGER trg_appt_capacidade
  BEFORE INSERT OR UPDATE OF period, room_id, status ON appointments
  FOR EACH ROW EXECUTE FUNCTION checar_capacidade_da_sala();

/* O índice que o gatilho consulta. Sem ele, cada agendamento varreria a
   tabela inteira de atendimentos da empresa. */
CREATE INDEX IF NOT EXISTS idx_appt_sala_periodo
  ON appointments USING gist (room_id, period)
  WHERE status <> 'CANCELLED' AND room_id IS NOT NULL;

COMMENT ON COLUMN rooms.capacity IS
  'Quantos atendimentos simultâneos o ambiente comporta. 1 = sala exclusiva; maior = espaço compartilhado (térreo, mezanino). Verificado por gatilho, ver 015.';
