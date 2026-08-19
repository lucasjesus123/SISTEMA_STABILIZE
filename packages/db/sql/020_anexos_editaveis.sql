-- =====================================================================
-- ANEXOS: QUEM MEXEU POR ÚLTIMO, E QUANDO
--
-- `uploaded_by` diz quem ENVIOU o arquivo, e isso não muda nunca. Falta
-- a outra pergunta, que é a que aparece numa conferência: quem foi a
-- última pessoa a mexer na descrição, na categoria ou na data do
-- documento — e quando.
--
-- POR QUE A DIFERENÇA IMPORTA. O exame foi enviado pela recepção em
-- março; em julho alguém corrigiu a data do documento e trocou a
-- descrição de "exame" para "hemograma de 12/03". Sem este par de
-- colunas, o prontuário mostra o texto novo com o nome de quem enviou —
-- e quem conferir vai atrás da pessoa errada.
--
-- O aluno também passa a poder ENVIAR exame pelo aplicativo, e aí
-- `uploaded_by` aponta para o usuário dele. `enviado_pelo_aluno` marca
-- isso explicitamente: um anexo que veio de fora precisa ser
-- reconhecível como tal por quem lê o prontuário, sem depender de
-- cruzar o id com a tabela de usuários.
-- =====================================================================

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS editado_por uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS editado_em timestamptz,
  ADD COLUMN IF NOT EXISTS enviado_pelo_aluno boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN attachments.editado_por IS
  'Última pessoa a mexer na descrição, categoria ou data. NULL = nunca editado desde o envio.';
COMMENT ON COLUMN attachments.enviado_pelo_aluno IS
  'Veio pelo aplicativo do próprio aluno. Precisa ser reconhecível na leitura do prontuário.';
