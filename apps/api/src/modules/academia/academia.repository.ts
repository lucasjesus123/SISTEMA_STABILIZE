import type { TenantClient } from '../../db/pool.js';

/**
 * A identidade da academia — quem assina o que o sistema imprime.
 *
 * ESTE MÓDULO É A FONTE ÚNICA. O papel timbrado, a carteirinha, o termo
 * do PAR-Q e a mensagem de WhatsApp leem daqui, e nenhum deles guarda
 * cópia. Uma segunda cópia da marca é uma marca que fica desatualizada
 * em algum lugar sem ninguém notar — e o lugar que fica para trás é
 * sempre o que só é visto de vez em quando, tipo o relatório anual.
 *
 * POR QUE NÃO ENTROU NO MÓDULO DE PERFIL. `perfil` é a pessoa que está
 * usando o sistema; isto é a empresa. Os dois têm nome, telefone e
 * endereço, e é justamente por parecerem iguais que precisam ficar
 * separados: um formulário que edita "telefone" sem deixar claro de quem
 * é o telefone acaba publicando o celular do dono no rodapé do
 * relatório de todo mundo.
 */

export interface IdentidadeDaAcademia {
  nome: string;
  documento: string | null;
  telefone: string | null;
  temLogo: boolean;
  endereco: {
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
  };
}

interface LinhaDaAcademia {
  nome: string;
  documento: string | null;
  telefone: string | null;
  logo_chave: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}

/* Sem `WHERE tenant_id = ...` de propósito, e isso não é esquecimento: a
   política `tenant_self` da RLS já reduz `tenants` à própria empresa.
   Acrescentar o filtro à mão daria a impressão de que é ELE que protege
   — e no dia em que alguém copiasse a query sem o filtro, o engano
   passaria por revisão. Aqui a proteção é do banco, e só. */
const CAMPOS = `
  SELECT name AS nome, document AS documento, telefone, logo_chave,
         cep, logradouro, numero, complemento, bairro, cidade, uf
    FROM tenants`;

export async function identidade(client: TenantClient): Promise<IdentidadeDaAcademia> {
  const { rows } = await client.query<LinhaDaAcademia>(CAMPOS);
  const l = rows[0];
  /* A empresa do token sempre existe — o login não emitiria um token
     para um tenant apagado. Se sumir, é falha de integridade e o erro
     precisa ser barulhento, não um objeto vazio que a tela desenha como
     "academia sem nome". */
  if (l === undefined) throw new Error('tenant do token não encontrado');

  return {
    nome: l.nome,
    documento: l.documento,
    telefone: l.telefone,
    temLogo: l.logo_chave !== null,
    endereco: {
      cep: l.cep,
      logradouro: l.logradouro,
      numero: l.numero,
      complemento: l.complemento,
      bairro: l.bairro,
      cidade: l.cidade,
      uf: l.uf,
    },
  };
}

export interface DadosParaGravar {
  nome: string;
  documento: string | null;
  telefone: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}

export async function gravar(
  client: TenantClient,
  dados: DadosParaGravar,
): Promise<IdentidadeDaAcademia> {
  await client.query(
    `UPDATE tenants
        SET name = $1, document = $2, telefone = $3, cep = $4,
            logradouro = $5, numero = $6, complemento = $7,
            bairro = $8, cidade = $9, uf = $10`,
    [
      dados.nome,
      dados.documento,
      dados.telefone,
      dados.cep,
      dados.logradouro,
      dados.numero,
      dados.complemento,
      dados.bairro,
      dados.cidade,
      dados.uf,
    ],
  );
  return identidade(client);
}

/** A chave do logo no armazenamento, ou `null` se a academia não subiu. */
export async function chaveDoLogo(
  client: TenantClient,
): Promise<{ chave: string; mime: string } | null> {
  const { rows } = await client.query<{ logo_chave: string | null; logo_mime: string | null }>(
    'SELECT logo_chave, logo_mime FROM tenants',
  );
  const l = rows[0];
  if (l === undefined || l.logo_chave === null || l.logo_mime === null) return null;
  return { chave: l.logo_chave, mime: l.logo_mime };
}

/**
 * Aponta a academia para um logo novo.
 *
 * NÃO devolve a chave anterior, e a ausência é deliberada. A primeira
 * versão fazia isso num `UPDATE ... RETURNING (SELECT logo_chave ...)`,
 * o que parece elegante e depende de qual snapshot o PostgreSQL usa
 * dentro do RETURNING — sutileza demais para a decisão que esse valor
 * governa, que é APAGAR UM ARQUIVO. Errar o snapshot apagaria o logo
 * recém-enviado em vez do antigo.
 *
 * Quem chama lê a chave velha com `chaveDoLogo` ANTES de gravar. São
 * duas instruções na mesma transação — o `inTenant` envolve tudo em
 * BEGIN/COMMIT —, então não há janela entre uma e outra.
 */
export async function definirLogo(
  client: TenantClient,
  chave: string,
  mime: string,
): Promise<void> {
  await client.query('UPDATE tenants SET logo_chave = $1, logo_mime = $2', [chave, mime]);
}

export async function removerLogo(client: TenantClient): Promise<void> {
  await client.query('UPDATE tenants SET logo_chave = NULL, logo_mime = NULL');
}
