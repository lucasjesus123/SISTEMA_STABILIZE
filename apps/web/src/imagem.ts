/**
 * Preparar imagem ANTES de enviar.
 *
 * POR QUE NO NAVEGADOR, E SEMPRE. O arquivo ia como veio e o servidor só
 * conferia a assinatura do formato — o que deixa passar coisas que ele
 * reconhece e o navegador não desenha: JPEG em CMYK, imagem grande
 * demais para decodificar, arquivo com a extensão certa e o miolo
 * estranho. O sintoma era "não consegui abrir a imagem" DEPOIS do envio,
 * sem nada a fazer a respeito.
 *
 * Aqui a ordem se inverte: a imagem é DECODIFICADA primeiro. Se o
 * navegador não abre, a recusa vem na hora, antes de subir nada. Se
 * abre, o que sobe é o que ele acabou de desenhar — então a imagem que
 * volta do servidor é, por construção, uma que ele sabe mostrar.
 *
 * E resolve o tamanho junto: foto de celular tem 4000 px de largura e
 * alguns megabytes, e o retrato aparece com 120. Diminuir aqui poupa o
 * envio inteiro, não só o armazenamento — e é a diferença entre esperar
 * e não esperar numa conexão de celular.
 */

export interface ComoPreparar {
  /** Maior lado depois de ajustada. */
  lado: number;
  /**
   * Guarda a transparência e sai em PNG.
   *
   * Vale para LOGOTIPO, não para foto: o logo da academia é impresso
   * sobre o papel timbrado e usado como marca d'água, e achatá-lo contra
   * um fundo branco deixaria um retângulo visível em cima do relatório.
   * Foto de gente não tem transparência para preservar, e PNG de
   * fotografia ocupa várias vezes o tamanho do JPEG equivalente.
   */
  transparente?: boolean;
}

const NAO_ABRIU =
  'Não consegui abrir esta imagem. Tente uma foto em JPG ou PNG — se ela veio do iPhone, ' +
  'mande pelo próprio celular ou salve como JPG antes.';

/**
 * Decodifica com a orientação do EXIF, e sem ela quando o navegador não
 * conhece a opção.
 *
 * `imageOrientation: 'from-image'` faz a foto tirada com o celular
 * deitado subir em pé: o navegador corrige na exibição do arquivo
 * original, mas o canvas desenha os pixels crus. O Safari só passou a
 * aceitar esse argumento na 16.4 — e nas versões anteriores a chamada
 * inteira falha, o que transformaria "sua foto vai de lado" em "não
 * consegui abrir a imagem". Duas tentativas: com a opção e sem.
 */
async function decodificar(arquivo: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
  } catch {
    /* Pode ter falhado pela opção OU porque a imagem é ilegível mesmo.
       A segunda tentativa separa os dois casos. */
  }
  try {
    return await createImageBitmap(arquivo);
  } catch {
    throw new Error(NAO_ABRIU);
  }
}

export async function prepararImagem(arquivo: File, como: ComoPreparar): Promise<File> {
  const bitmap = await decodificar(arquivo);

  try {
    const escala = Math.min(1, como.lado / Math.max(bitmap.width, bitmap.height));
    const largura = Math.max(1, Math.round(bitmap.width * escala));
    const altura = Math.max(1, Math.round(bitmap.height * escala));

    const tela = document.createElement('canvas');
    tela.width = largura;
    tela.height = altura;
    const pincel = tela.getContext('2d');
    if (pincel === null) throw new Error('Não foi possível preparar a imagem neste navegador.');

    if (como.transparente !== true) {
      /* FUNDO BRANCO antes de desenhar. JPEG não tem transparência: um
         PNG recortado desenhado direto sairia com o fundo preto, que é o
         resultado mais feio possível para uma foto de rosto. */
      pincel.fillStyle = '#ffffff';
      pincel.fillRect(0, 0, largura, altura);
    }
    pincel.drawImage(bitmap, 0, 0, largura, altura);

    const tipo = como.transparente === true ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolver) =>
      tela.toBlob(resolver, tipo, 0.86),
    );
    if (blob === null) throw new Error('Não foi possível preparar a imagem neste navegador.');

    const nome = como.transparente === true ? 'imagem.png' : 'imagem.jpg';
    return new File([blob], nome, { type: tipo });
  } finally {
    /* O bitmap segura memória de imagem DESCOMPRIMIDA — uma foto de
       celular são dezenas de MB até esta linha rodar. */
    bitmap.close();
  }
}
