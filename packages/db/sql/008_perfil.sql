-- =====================================================================
-- PERFIL DE QUEM USA O SISTEMA
--
-- A tabela `users` nasceu enxuta de propósito: e-mail, nome, papel,
-- telefone. Era tudo o que o login precisava. Só que agora cada pessoa
-- edita o próprio perfil na tela — WhatsApp, endereço, foto — e as
-- colunas para isso não existiam.
--
-- POR QUE AS MESMAS COLUNAS DE `students`, E NÃO UMA TABELA `profiles`
-- SEPARADA: uma tabela nova significaria mais um LEFT JOIN em toda tela
-- que mostra gente, mais uma policy de RLS para manter em pé e mais um
-- lugar onde esquecer o `tenant_id`. O ganho seria não ter colunas
-- nulas numa linha de recepcionista que nunca preencheu o endereço —
-- e coluna nula é barata. Endereço é atributo da pessoa, não entidade
-- própria: mora junto com a pessoa.
--
-- O FORMATO DO WHATSAPP É O MESMO DE `students`, e a repetição do CHECK
-- é intencional. Poderia ser um DOMAIN compartilhado; o CHECK repetido
-- aparece no `\d` da tabela, onde quem for depurar um envio que falhou
-- vai olhar primeiro. Um domínio esconde a regra num lugar a mais.
--
-- IDEMPOTENTE POR CONSTRUÇÃO: só `ADD COLUMN IF NOT EXISTS`. Ainda
-- assim é registrada em `schema_migrations` como qualquer outra — o
-- migrate.sh só reexecuta sempre os arquivos `*_roles.sql` e
-- `*_super.sql`.
-- =====================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp            text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date          date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_zip         text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_street      text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_number      text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_complement  text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_district    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_city        text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_state       char(2);

-- O CHECK vai separado do ADD COLUMN porque `ADD CONSTRAINT` não tem
-- `IF NOT EXISTS` no PostgreSQL 16. O bloco confere no catálogo antes.
--
-- `NOT VALID` de propósito: a restrição passa a valer para toda escrita
-- NOVA sem varrer a tabela inteira agora, e sem correr o risco de a
-- migração falhar por causa de uma linha antiga fora do formato. Quem
-- quiser validar o histórico depois roda `VALIDATE CONSTRAINT` numa
-- janela tranquila.
DO $perfil$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_whatsapp_e164'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_whatsapp_e164
      CHECK (whatsapp IS NULL OR whatsapp ~ '^\+[1-9][0-9]{7,14}$')
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_birth_sane'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_birth_sane
      CHECK (birth_date IS NULL OR birth_date > '1900-01-01')
      NOT VALID;
  END IF;
END
$perfil$;

-- ---------------------------------------------------------------------
-- A FOTO
--
-- `users.avatar_path` e `students.photo_path` já existiam e continuam
-- guardando a CHAVE do armazenamento — um uuid opaco gerado pelo
-- servidor —, nunca um caminho de arquivo e nunca o nome que a pessoa
-- enviou. Quem monta o caminho em disco é `storage.ts`, que valida o
-- formato da chave antes de qualquer `open()`. Um comentário no banco
-- para que ninguém, daqui a um ano, resolva gravar '/uploads/foto.jpg'
-- aqui achando que ajuda.
-- ---------------------------------------------------------------------
COMMENT ON COLUMN users.avatar_path IS
  'Chave opaca do armazenamento (uuid), não caminho de arquivo. Ver apps/api/src/modules/attachments/storage.ts';
COMMENT ON COLUMN students.photo_path IS
  'Chave opaca do armazenamento (uuid), não caminho de arquivo. Ver apps/api/src/modules/attachments/storage.ts';

-- A RLS de `users` já vale para estas colunas: a policy é da TABELA, não
-- da coluna, e continua sendo `tenant_id = current_tenant_id()`. Nada a
-- acrescentar aqui — e é esse o ponto de toda tabela ter a mesma policy.
--
-- O que a RLS NÃO faz, e por isso está no código: impedir que alguém
-- edite o perfil de OUTRA pessoa da MESMA empresa. Esse recorte é do
-- `WHERE id = $1` em perfil.repository.ts, com o id vindo do token.
