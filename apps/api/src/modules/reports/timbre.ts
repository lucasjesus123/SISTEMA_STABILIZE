import { e164ParaMascara } from '@stabilize/shared';
import type { TenantClient } from '../../db/pool.js';
import { chaveDoLogo, identidade } from '../academia/academia.repository.js';
import { existe, ler } from '../attachments/storage.js';
import type { Timbre } from './documento.js';

/**
 * Monta o timbre de um documento a partir da identidade da academia.
 *
 * ESTE É O ÚNICO PONTO onde relatório e identidade se encontram. O
 * `documento.ts` desenha e não consulta nada; o módulo `academia` guarda
 * e não sabe de PDF. A costura fica aqui, e é uma função só — o que
 * significa que trocar a marca de lugar amanhã custa um arquivo.
 *
 * LÊ O LOGO UMA VEZ POR DOCUMENTO. O arquivo está cifrado em disco:
 * decifrar por página multiplicaria o custo pelo número de folhas, e um
 * relatório de trinta alunos tem muitas. Um `Buffer` na memória serve o
 * cabeçalho e todas as marcas d'água.
 *
 * NUNCA DERRUBA O RELATÓRIO. Toda falha aqui — logo ausente do disco,
 * arquivo corrompido, decifragem que não fecha — devolve um timbre
 * parcial ou vazio. Um relatório que se recusa a sair porque falta um
 * enfeite é pior que um relatório sem enfeite, e a pessoa que pediu
 * queria os dados.
 */
export async function montarTimbre(
  client: TenantClient,
  tenantId: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<{ academia: string; timbre: Timbre }> {
  const dados = await identidade(client);

  const timbre: Timbre = {};

  if (dados.telefone !== null) timbre.telefone = e164ParaMascara(dados.telefone);

  const endereco = montarEndereco(dados.endereco);
  if (endereco !== null) timbre.endereco = endereco;

  const logo = await chaveDoLogo(client);
  if (logo !== null) {
    const bytes = await lerLogo(tenantId, logo.chave, log);
    if (bytes !== null) timbre.logo = bytes;
  }

  /* O NOME SAI DAQUI, e a mudança é maior do que parece. Ele estava
     escrito à mão — `'Stabilize — Clínica do Músculo'` — nos cinco
     relatórios. Num sistema de uma academia só ninguém notaria; neste,
     o relatório de qualquer outra empresa saía com o nome da primeira
     no cabeçalho e no autor do PDF. Devolver o nome junto do timbre é o
     que garante que não sobre um sexto lugar para alguém esquecer. */
  return { academia: dados.nome, timbre };
}

async function lerLogo(
  tenantId: string,
  chave: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<Buffer | null> {
  try {
    if (!(await existe(tenantId, chave))) {
      /* A coluna aponta para um arquivo que não está lá. Vale um aviso
         no log — é inconsistência entre banco e disco, e alguém precisa
         saber —, mas não vale derrubar o relatório de quem só queria o
         financeiro do mês. */
      log.warn({ tenantId }, 'logo da academia ausente em disco ao montar o timbre');
      return null;
    }

    /* `ler` devolve uma Promise de fluxo, e não o fluxo. Sem o await
       aqui, o `for await` iteraria a Promise — que não é iterável. */
    const fluxo = await ler(tenantId, chave);
    const pedacos: Buffer[] = [];
    for await (const pedaco of fluxo) {
      pedacos.push(pedaco as Buffer);
    }
    return Buffer.concat(pedacos);
  } catch (erro) {
    log.warn({ tenantId, erro: String(erro) }, 'não consegui ler o logo da academia');
    return null;
  }
}

/**
 * O endereço em uma linha, para o rodapé.
 *
 * Monta pedaço a pedaço em vez de interpolar tudo: um endereço com
 * bairro em branco viraria "Rua X, 12 -  - Porto Alegre/RS", com o
 * traço solto no meio. Cada parte só entra se existir, e os separadores
 * saem do que sobrou.
 */
export function montarEndereco(e: {
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
}): string | null {
  const rua = [e.logradouro, e.numero].filter(Boolean).join(', ');
  const comRua = [rua, e.complemento].filter((p) => p !== null && p !== '').join(' — ');

  const municipio =
    e.cidade !== null && e.uf !== null
      ? `${e.cidade}/${e.uf}`
      : (e.cidade ?? (e.uf === null ? null : e.uf));

  const cep = e.cep === null ? null : `CEP ${e.cep.slice(0, 5)}-${e.cep.slice(5)}`;

  const partes = [comRua, e.bairro, municipio, cep].filter(
    (p): p is string => p !== null && p !== undefined && p !== '',
  );

  return partes.length === 0 ? null : partes.join(' · ');
}
