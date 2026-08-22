import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from './api.js';
import type { FichaAluno } from './api.js';

/**
 * A carteirinha do aluno, a foto e o acesso ao aplicativo.
 *
 * AS TRÊS COISAS NA MESMA TELA porque são a mesma conversa. Quem tira a
 * foto do aluno está fazendo a carteirinha; quem faz a carteirinha está
 * entregando o acesso. Separá-las em três lugares é o que faz o aluno
 * sair da academia com cadastro, sem foto, sem carteirinha e sem app.
 *
 * A CARTEIRINHA É HTML, NÃO IMAGEM GERADA NO SERVIDOR. Duas razões: ela
 * precisa aparecer também no aplicativo do aluno, onde não há como
 * baixar um PNG e guardar; e o download sai por impressão do navegador,
 * que já sabe gerar PDF em qualquer sistema — um gerador próprio seria
 * uma segunda fonte da verdade para o mesmo desenho.
 */

const TAMANHO_MAXIMO_MB = 8;

export function AbaCarteirinha({
  ficha,
  podeEscrever,
  aoMudar,
}: {
  ficha: FichaAluno;
  podeEscrever: boolean;
  aoMudar: () => void;
}): ReactNode {
  const [foto, setFoto] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);
  const [acesso, setAcesso] = useState<api.AcessoDoAluno | null>(null);
  const [credencial, setCredencial] = useState<{ login: string; senha: string } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vivo = true;
    let atual: string | null = null;
    void api.baixarFotoDoAluno(ficha.id).then((url) => {
      if (!vivo) {
        if (url !== null) URL.revokeObjectURL(url);
        return;
      }
      atual = url;
      setFoto(url);
    });
    return () => {
      vivo = false;
      if (atual !== null) URL.revokeObjectURL(atual);
    };
  }, [ficha.id, versao]);

  const carregarAcesso = useCallback(() => {
    api
      .buscarAcessoDoAluno(ficha.id)
      .then((r) => setAcesso(r.data))
      .catch(() => undefined);
  }, [ficha.id]);

  useEffect(carregarAcesso, [carregarAcesso]);

  const enviarFoto = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (arquivo === undefined) return;
    if (arquivo.size > TAMANHO_MAXIMO_MB * 1024 * 1024) {
      setErro(`A imagem tem mais de ${TAMANHO_MAXIMO_MB} MB. Envie uma menor.`);
      return;
    }
    setErro(null);
    setOcupado(true);
    try {
      await api.enviarFotoDoAluno(ficha.id, arquivo);
      setVersao((v) => v + 1);
      aoMudar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível enviar a foto.');
    } finally {
      setOcupado(false);
    }
  };

  const liberar = async (): Promise<void> => {
    setErro(null);
    setOcupado(true);
    try {
      const r = await api.liberarAcessoDoAluno(ficha.id);
      setCredencial({ login: r.data.login, senha: r.data.senhaInicial });
      carregarAcesso();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível liberar o acesso.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="cart-tela">
      <div className="cart-coluna">
        <Cartao ficha={ficha} foto={foto} desde={ficha.inicioEm ?? ficha.criadoEm} />

        <div className="cart-acoes">
          {/* IMPRIMIR, e não "baixar PNG". O navegador já sabe gerar PDF
              em qualquer sistema, e a carteirinha impressa em papel é o
              caso real de uso da recepção. */}
          <button type="button" className="botao-acao" onClick={() => window.print()}>
            Imprimir ou salvar em PDF
          </button>
          {podeEscrever && (
            <label className="botao-secundario cart-envio">
              {ocupado ? 'Enviando…' : foto === null ? 'Adicionar foto' : 'Trocar a foto'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => void enviarFoto(e)}
                disabled={ocupado}
              />
            </label>
          )}
        </div>

        {foto === null && (
          <p className="cart-aviso">
            <strong>Sem foto.</strong> A carteirinha funciona sem ela, mas é a foto que faz a
            recepção reconhecer quem está na frente do balcão.
          </p>
        )}
      </div>

      <div className="cart-coluna">
        <section className="cart-bloco">
          <h3>Acesso ao aplicativo</h3>

          {acesso === null ? (
            <p className="cart-nota">Carregando…</p>
          ) : acesso.liberado ? (
            <>
              <p className="cart-estado ok">
                <strong>Liberado.</strong> O aluno entra em{' '}
                <code>{window.location.host}</code> com o login abaixo.
              </p>
              <dl className="cart-credencial">
                <div>
                  <dt>Login</dt>
                  <dd className="dinheiro">{formatarCpf(acesso.login ?? '')}</dd>
                </div>
                <div>
                  <dt>Senha</dt>
                  <dd>
                    {acesso.usouSenhaInicial ? (
                      'o próprio CPF — troca obrigatória na primeira entrada'
                    ) : (
                      <span className="cart-secundario">definida pelo aluno</span>
                    )}
                  </dd>
                </div>
              </dl>
              {podeEscrever && (
                <div className="cart-acoes-linha">
                  <button
                    type="button"
                    className="botao-texto"
                    disabled={ocupado}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Voltar a senha de ${ficha.nome} para o CPF?\n\nÉ o caminho de "esqueci a senha": a senha atual deixa de valer e ele precisa trocar de novo ao entrar.`,
                        )
                      ) {
                        void liberar();
                      }
                    }}
                  >
                    Esqueceu a senha
                  </button>
                  <button
                    type="button"
                    className="botao-texto-perigo"
                    disabled={ocupado}
                    onClick={() => {
                      if (window.confirm(`Bloquear o acesso de ${ficha.nome} ao aplicativo?`)) {
                        void api
                          .bloquearAcessoDoAluno(ficha.id)
                          .then(carregarAcesso)
                          .catch(() => undefined);
                      }
                    }}
                  >
                    Bloquear acesso
                  </button>
                </div>
              )}
            </>
          ) : !acesso.temCpf ? (
            /* Dizer O QUE FALTA, e não só que não dá. "Preencha o CPF"
               resolve em trinta segundos; um botão desabilitado sem
               explicação vira um chamado para o suporte. */
            <p className="cart-estado atencao">
              <strong>Falta o CPF.</strong> Ele é o login do aplicativo. Preencha o CPF na aba
              Cadastro e volte aqui.
            </p>
          ) : (
            <>
              <p className="cart-nota">
                O aluno entra com o <strong>CPF no login e o CPF na senha</strong>, e o sistema
                exige a troca na primeira entrada.
              </p>
              {podeEscrever && (
                <button
                  type="button"
                  className="botao-acao"
                  disabled={ocupado}
                  onClick={() => void liberar()}
                >
                  {ocupado ? 'Liberando…' : 'Liberar acesso ao app'}
                </button>
              )}
            </>
          )}

          {credencial !== null && (
            <div className="plt-senha">
              <p className="plt-senha-linha">
                <span>Login e senha inicial</span>
                <strong className="plt-destaque">{formatarCpf(credencial.login)}</strong>
              </p>
              <p className="plt-aviso">
                Os dois são o CPF. Na primeira entrada o sistema obriga a trocar a senha — o CPF de
                alguém não é segredo, então ele vale só até a primeira vez.
              </p>
            </div>
          )}

          {erro !== null && (
            <p className="mensagem-erro" role="alert">
              {erro}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/* ====================================================================
 * O cartão
 * ================================================================== */

/**
 * A carteirinha em si.
 *
 * DIREÇÃO
 *
 * TESE — esta é a única peça do sistema que SAI DA TELA. Ela vai para
 * uma carteira, ao lado do RG e do cartão do banco, e é estendida por
 * cima de um balcão. O desenho anterior era o default de todo cartão
 * gerado por computador: retângulo escuro, cantos arredondados, um
 * brilho radial no canto superior direito. Bonito na tela e mentiroso no
 * papel — fundo escuro imprime encardido, come tinta e não se parece com
 * o que estava na tela.
 *
 * CENA — recepção às seis da manhã, luz fluorescente, a pessoa estende o
 * cartão ou o celular. É essa cena que decide CLARO: todo documento que
 * vive numa carteira é claro, e o que a recepção precisa ler de longe é
 * o rosto e o número.
 *
 * MUNDO — credencial de atleta. Papel de segurança com guilhoché (a
 * trama fina que o olho lê como "documento"), um campo de cor cheia
 * carregando o retrato, e os dados em campos rotulados como num
 * documento de identidade — rótulo miúdo em versal, valor grande.
 *
 * TEMA ÚNICO, de propósito. O cartão é um objeto físico: ele não inverte
 * quando o sistema está no escuro, pela mesma razão que uma carteira de
 * motorista não muda de cor à noite.
 *
 * Proporção de cartão de crédito (85,6 × 54 mm) — o tamanho que cabe na
 * carteira, e carteirinha que não cabe na carteira fica na gaveta.
 */
export function Cartao({
  ficha,
  foto,
  academia,
  logo,
  desde,
  compacto = false,
}: {
  ficha: Pick<FichaAluno, 'id' | 'nome' | 'codigo' | 'status'> & {
    contrato?: { ciclo: string } | null;
  };
  foto: string | null;
  /** O nome da academia, quando quem chama souber. */
  academia?: string | undefined;
  /**
   * O logo da academia — endereço de blob, como a foto.
   *
   * QUANDO NÃO EXISTE, O CARTÃO NÃO CAI NA MARCA DA STABILIZE. Cair
   * nela era o comportamento anterior, e num sistema multi-empresa isso
   * significa a carteirinha de uma academia carimbada com a marca de
   * outra. O recuo é o NOME da academia, escrito.
   */
  logo?: string | null | undefined;
  /** Data de entrada em ISO; vira o ano do campo "membro desde". */
  desde?: string | null | undefined;
  compacto?: boolean;
}): ReactNode {
  const ativo = ficha.status === 'ACTIVE';

  return (
    <div className={`cart-cartao ${compacto ? 'compacto' : ''} ${ativo ? '' : 'inativo'}`}>
      {/* O CAMPO DE COR É O RETRATO. A cor ocupa um terço da superfície e
          tem função — é o fundo do rosto — em vez de ser um filete
          decorativo na borda. */}
      <div className="cart-retrato-campo">
        {foto === null ? (
          <span className="cart-retrato-vazio" aria-hidden="true">
            {iniciaisDe(ficha.nome)}
          </span>
        ) : (
          <img className="cart-retrato" src={foto} alt={`Foto de ${ficha.nome}`} />
        )}
        <span className={`cart-selo ${ativo ? '' : 'inativo'}`}>
          {ativo ? 'Ativo' : 'Inativo'}
        </span>
      </div>

      <div className="cart-face">
        {/* A MARCA DO ALTO É A DA ACADEMIA, e não a do sistema.
            Antes era `<Marca>` — o logotipo da Stabilize, fixo. Num
            sistema de uma academia só, correto. Neste, a carteirinha de
            toda empresa saía carimbada com a marca da primeira: o mesmo
            defeito que estava nos relatórios, num cartão que o aluno
            leva na carteira. */}
        <div className="cart-face-topo">
          {logo === null || logo === undefined ? (
            <span className="cart-marca-nome">{academia ?? ''}</span>
          ) : (
            <img className="cart-marca" src={logo} alt={academia ?? 'Logo da academia'} />
          )}
          <span className="cart-classe">Carteirinha de aluno</span>
        </div>

        <span className="cart-nome" title={ficha.nome}>
          {ficha.nome}
        </span>

        {/* CAMPOS ROTULADOS, como em documento: o rótulo miúdo em versal
            e o valor grande. É o que faz o olho encontrar a matrícula sem
            ler o cartão inteiro. */}
        <dl className="cart-campos">
          <div>
            <dt>Matrícula</dt>
            <dd className="cart-numero">{ficha.codigo === null ? '—' : ficha.codigo}</dd>
          </div>
          <div>
            <dt>Membro desde</dt>
            <dd>{desde === null || desde === undefined ? '—' : desde.slice(0, 4)}</dd>
          </div>
        </dl>

        {/* O RODAPÉ REPETE O NOME SÓ QUANDO O ALTO MOSTRA UMA IMAGEM.
            Sem logo, o nome já está lá em cima escrito — e repetir a
            mesma palavra duas vezes num cartão de 85 mm desperdiça a
            única linha que sobrou. */}
        {logo !== null && logo !== undefined && academia !== undefined && academia !== '' && (
          <span className="cart-rodape">{academia}</span>
        )}
      </div>
    </div>
  );
}

function iniciaisDe(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter((p) => p.length > 2);
  return ((partes[0]?.[0] ?? '?') + (partes.length > 1 ? (partes[partes.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

/** 12345678909 → 123.456.789-09. O aluno reconhece o próprio CPF assim. */
function formatarCpf(v: string): string {
  const d = v.replace(/\D/g, '');
  if (d.length !== 11) return v;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
