-- =====================================================================
-- CÓDIGO DO ALUNO
--
-- Um número curto, próprio de cada academia, que a recepção usa para
-- achar a pessoa sem soletrar o nome: "o 0042 chegou". O uuid da chave
-- primária não serve para isso — ninguém dita um uuid no balcão nem o
-- escreve numa carteirinha.
--
-- O CONTADOR VIVE EM `tenants`, E NÃO NUMA SEQUENCE. Três caminhos
-- foram considerados:
--
--   1. Uma SEQUENCE global. Simples, e errada: a academia A receberia
--      1, 4, 7 e a B receberia 2, 3, 5, porque a sequência é
--      compartilhada. Cada academia quer a SUA contagem começando em 1,
--      e um código com buracos parece cadastro perdido.
--
--   2. `SELECT MAX(codigo) + 1`. É a resposta óbvia e tem uma corrida
--      clássica: duas recepcionistas cadastrando ao mesmo tempo leem o
--      mesmo máximo e tentam gravar o mesmo número. O índice único
--      recusaria a segunda, e o cadastro morreria com erro de chave
--      duplicada — na frente do aluno.
--
--   3. Um contador por empresa, incrementado com `UPDATE ... RETURNING`
--      dentro da própria transação. O UPDATE trava a linha da empresa
--      pelo tempo do INSERT, então a segunda recepcionista espera alguns
--      milissegundos e recebe o número seguinte. É o que está aqui.
--
-- O contador é do TENANT, então a espera é por academia: o cadastro de
-- uma nunca segura o da outra.
--
-- O NÚMERO É ATRIBUÍDO POR TRIGGER, e não pelo código da aplicação. Não
-- é preferência por trigger: é que existe mais de um caminho que insere
-- aluno (o cadastro, o seed, uma importação futura), e um deles vai
-- esquecer. No banco, não tem como esquecer.
-- =====================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS proximo_codigo_aluno integer NOT NULL DEFAULT 1;

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS codigo integer;

-- Único DENTRO da empresa, como tudo o mais aqui. Duas academias podem
-- ter o aluno 0001 sem colidir.
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_codigo
  ON students (tenant_id, codigo)
  WHERE codigo IS NOT NULL;

-- ---------------------------------------------------------------------
-- Atribuição
--
-- `SECURITY DEFINER` não é necessário: a trigger roda no contexto de
-- quem insere, e a policy de `tenants` já permite ler a própria empresa.
-- O UPDATE em `tenants` passa pela mesma policy — e é bom que passe:
-- uma trigger que ignora a RLS é uma porta lateral para escrever na
-- linha de outra empresa.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION atribuir_codigo_aluno()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Já veio com código (importação, restauração): respeita e sai.
  IF NEW.codigo IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE tenants
     SET proximo_codigo_aluno = proximo_codigo_aluno + 1
   WHERE id = NEW.tenant_id
  RETURNING proximo_codigo_aluno - 1 INTO NEW.codigo;

  -- Sem linha em `tenants` visível: ou a empresa não existe, ou o
  -- contexto de tenant não foi definido e a RLS devolveu zero linhas.
  -- Os dois casos são defeito de programação, e falhar alto aqui é
  -- melhor que gravar um aluno sem código que ninguém nota até a
  -- carteirinha sair em branco.
  IF NEW.codigo IS NULL THEN
    RAISE EXCEPTION 'não foi possível atribuir código: empresa % inalcançável (contexto de tenant definido?)', NEW.tenant_id;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_students_codigo ON students;
CREATE TRIGGER trg_students_codigo
  BEFORE INSERT ON students
  FOR EACH ROW EXECUTE FUNCTION atribuir_codigo_aluno();

-- ---------------------------------------------------------------------
-- Os alunos que já existem
--
-- Numerados por ordem de cadastro, que é a ordem em que teriam recebido
-- o código se ele existisse desde o começo. `created_at, id` como
-- critério: o `id` desempata para o resultado não depender da ordem
-- física das linhas.
--
-- Roda com o contexto de tenant AUSENTE, o que sob RLS FORCE devolveria
-- zero linhas — mas este arquivo é aplicado pelo `stabilize_migrator`,
-- que é o DONO da tabela e ainda assim está sob FORCE. Por isso a
-- desativação temporária logo abaixo, restrita a este bloco.
-- ---------------------------------------------------------------------
-- ATENÇÃO AO `BEGIN` ABAIXO. Sem transação explícita, o psql confirma
-- cada comando isoladamente — e se algo falhasse entre o `NO FORCE` e o
-- `FORCE`, a tabela ficaria com o FORCE DESLIGADO. O sintoma seria o
-- pior possível: o sistema continua funcionando, os testes continuam
-- passando, e a barreira que impede uma empresa de ler a outra some sem
-- ninguém notar. Dentro da transação, qualquer erro devolve tudo ao
-- estado anterior.
BEGIN;  -- protege o NO FORCE
ALTER TABLE students NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants  NO FORCE ROW LEVEL SECURITY;

WITH numerados AS (
  SELECT id,
         tenant_id,
         row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n
    FROM students
   WHERE codigo IS NULL
)
UPDATE students s
   SET codigo = n.n
  FROM numerados n
 WHERE s.id = n.id;

-- O contador de cada empresa passa a apontar para depois do maior
-- código já usado. Sem isto o próximo cadastro tentaria o número 1 e
-- esbarraria no índice único.
UPDATE tenants t
   SET proximo_codigo_aluno = GREATEST(
         t.proximo_codigo_aluno,
         COALESCE((SELECT MAX(s.codigo) + 1 FROM students s WHERE s.tenant_id = t.id), 1)
       );

ALTER TABLE students FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants  FORCE ROW LEVEL SECURITY;
COMMIT;

COMMENT ON COLUMN students.codigo IS
  'Código interno do aluno, sequencial por empresa. Atribuído por trigger; exibido com quatro dígitos (0042).';
