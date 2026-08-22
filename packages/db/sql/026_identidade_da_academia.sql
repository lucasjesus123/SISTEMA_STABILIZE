-- =====================================================================
-- A IDENTIDADE DA ACADEMIA
--
-- O relatório em PDF sai sem marca nenhuma: cabeçalho de uma linha,
-- rodapé com "nome · emitido em · página". Entregue ao aluno ou ao
-- contador, não parece documento da academia — parece saída de sistema.
--
-- A causa não está no gerador de PDF. Está aqui: `tenants` guarda nome,
-- slug, CNPJ e fuso, e mais nada. Não existe logo, endereço nem
-- telefone em lugar nenhum do sistema, então não há o que imprimir.
--
-- POR QUE ISTO VEM ANTES DO TIMBRE, e não junto
--
-- O caminho curto seria embutir o logo da Stabilize no gerador e seguir
-- a vida. Num sistema de uma academia só, funcionaria. Neste, no dia em
-- que a segunda entrar, o relatório dela sai com a marca da primeira —
-- e isso não é um defeito de estética, é a identidade de um cliente
-- aparecendo no documento de outro.
--
-- A marca precisa ser DADO da empresa, sob a mesma RLS que protege o
-- resto. É o que estas colunas fazem.
--
-- O QUE ESTAS COLUNAS NÃO SÃO
--
-- Não são configuração de aparência do sistema. Não há cor, fonte nem
-- tema aqui. É só o que um papel timbrado precisa: quem assina, como
-- falar com quem assina, e onde essa pessoa fica.
-- =====================================================================

-- ---------------------------------------------------------------------
-- O logo
--
-- Guardado como CHAVE, não como bytes. O arquivo mora no mesmo
-- armazenamento dos exames — cifrado, em diretório por empresa, com
-- nome opaco que o usuário nunca escolhe. Reusar aquele módulo em vez
-- de gravar `bytea` aqui não é preferência de estilo: é onde já está
-- resolvido o problema de um nome de arquivo virar caminho de disco.
--
-- O MIME é restrito a PNG e JPEG, e a restrição é do BANCO porque a
-- consequência de furá-la é remota do lugar onde ela seria furada: o
-- PDFKit embute apenas estes dois formatos. Um logo WebP passaria pela
-- tela, ficaria salvo, e quebraria o RELATÓRIO — longe do upload, com o
-- admin sem ligar uma coisa à outra. Recusar aqui faz o erro nascer no
-- único lugar onde ele é compreensível.
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS logo_chave uuid,
  ADD COLUMN IF NOT EXISTS logo_mime  text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_logo_mime'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_logo_mime
      CHECK (logo_mime IS NULL OR logo_mime IN ('image/png', 'image/jpeg'));
  END IF;

  -- Chave e tipo andam juntos ou não andam. Uma chave sem tipo faria o
  -- gerador tentar adivinhar o formato pelos bytes; um tipo sem chave
  -- faria procurar um arquivo que não existe. Os dois casos só nascem
  -- de gravação pela metade, e a hora de recusar é agora.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_logo_completo'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_logo_completo
      CHECK ((logo_chave IS NULL) = (logo_mime IS NULL));
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Telefone público da academia
--
-- Diferente de `contato_whatsapp`, que já existe: aquele é o telefone
-- por onde a PLATAFORMA fala com o dono da academia, dado interno de
-- cobrança. Este é o que vai impresso no rodapé, para o aluno ligar.
-- Misturar os dois publicaria o celular pessoal do dono no relatório.
--
-- Mesmo formato E.164 do resto do sistema — o CHECK é copiado de
-- `students_whatsapp_e164` de propósito: dois formatos de telefone no
-- mesmo banco viram duas funções de formatação e uma delas fica para
-- trás.
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS telefone text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_telefone_e164'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_telefone_e164
      CHECK (telefone IS NULL OR telefone ~ '^\+[1-9][0-9]{7,14}$');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Endereço
--
-- ESTRUTURADO, e não uma linha de texto. Uma linha só seria mais simples
-- de gravar e pior em tudo depois: o rodapé precisa quebrar o endereço
-- em duas linhas de tamanhos diferentes, e a busca de CEP que o sistema
-- já tem devolve campo a campo. Guardar tudo junto obrigaria a
-- desmontar de novo, com heurística, no lugar errado.
--
-- Os mesmos nomes de campo do endereço do aluno e do perfil. É o que
-- permite a tela da academia reusar `useBuscaDeCep` sem adaptador.
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cep         text,
  ADD COLUMN IF NOT EXISTS logradouro  text,
  ADD COLUMN IF NOT EXISTS numero      text,
  ADD COLUMN IF NOT EXISTS complemento text,
  ADD COLUMN IF NOT EXISTS bairro      text,
  ADD COLUMN IF NOT EXISTS cidade      text,
  ADD COLUMN IF NOT EXISTS uf          char(2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_cep_oito_digitos'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_cep_oito_digitos
      CHECK (cep IS NULL OR cep ~ '^[0-9]{8}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_uf_valida'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_uf_valida
      CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$');
  END IF;
END $$;

COMMENT ON COLUMN tenants.logo_chave IS
  'Chave opaca no armazenamento de arquivos (mesmo dos exames, cifrado). NULL = academia sem logo, e o relatório sai sem marca d''agua.';
COMMENT ON COLUMN tenants.telefone IS
  'Telefone PUBLICO, impresso no rodape dos relatorios. Nao confundir com contato_whatsapp, que e o canal da plataforma com o dono.';
