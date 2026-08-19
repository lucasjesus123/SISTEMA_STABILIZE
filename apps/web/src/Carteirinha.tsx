import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Marca } from './Marca.jsx';
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
        <Cartao ficha={ficha} foto={foto} />

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
 * Proporção de cartão de crédito (85,6 × 54 mm). Não é capricho: é o
 * tamanho que cabe na carteira, e uma carteirinha que não cabe na
 * carteira fica na gaveta.
 */
export function Cartao({
  ficha,
  foto,
  compacto = false,
}: {
  ficha: Pick<FichaAluno, 'id' | 'nome' | 'codigo' | 'status'> & {
    contrato?: { ciclo: string } | null;
  };
  foto: string | null;
  compacto?: boolean;
}): ReactNode {
  const referencia = useRef<HTMLDivElement>(null);

  return (
    <div ref={referencia} className={`cart-cartao ${compacto ? 'compacto' : ''}`}>
      <div className="cart-cartao-topo">
        <Marca variante="horizontal" altura={22} />
        <span className="cart-cartao-tipo">Aluno</span>
      </div>

      <div className="cart-cartao-corpo">
        {foto === null ? (
          <span className="cart-retrato vazio" aria-hidden="true">
            {iniciaisDe(ficha.nome)}
          </span>
        ) : (
          <img className="cart-retrato" src={foto} alt={`Foto de ${ficha.nome}`} />
        )}

        <div className="cart-cartao-dados">
          <span className="cart-cartao-nome">{ficha.nome}</span>
          {/* O CÓDIGO EM DESTAQUE. É o número que a recepção pede e o
              que identifica o aluno quando o nome se repete — dois
              "Ana Silva" numa academia não é hipótese, é terça-feira. */}
          <span className="cart-cartao-codigo">
            {ficha.codigo === null ? '—' : `Nº ${ficha.codigo}`}
          </span>
        </div>
      </div>

      <div className="cart-cartao-rodape">
        <span>{new Date().getFullYear()}</span>
        <span className="cart-cartao-selo">{ficha.status === 'ACTIVE' ? 'ativo' : 'inativo'}</span>
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
