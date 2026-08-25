import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, lerPerfil, trocarMeuEmail, trocarMinhaSenha, type Principal } from './api.js';
import { Janela } from './ui.jsx';
import { Perfil } from './Perfil.jsx';

/**
 * As configurações da própria conta.
 *
 * UMA JANELA, e chamada do crachá no topo — que é onde a pessoa aponta
 * quando quer mexer em si mesma. Antes disso, o perfil era uma seção do
 * menu no meio das seções da empresa, e não havia lugar nenhum para
 * trocar a senha: a única tela de troca era a do primeiro acesso, que
 * ninguém vê de novo depois de usá-la uma vez.
 *
 * DUAS ABAS porque são duas conversas diferentes. "Meus dados" é
 * cadastro: nome, telefone, endereço — coisas que se corrigem sem
 * cerimônia. "Acesso" é a porta de entrada da conta, e cada mudança lá
 * pede a senha atual e tem consequência sobre as sessões abertas.
 */

type Painel = 'dados' | 'acesso';

export function Configuracoes({
  principal,
  aoFechar,
  aoPerderSessao,
}: {
  principal: Principal;
  aoFechar: () => void;
  /* Trocar a senha derruba TODAS as sessões, inclusive esta. Quem abriu
     a janela precisa saber disso para levar a pessoa de volta ao login em
     vez de deixá-la clicando numa tela que já não responde. */
  aoPerderSessao: () => void;
}): ReactNode {
  const [painel, setPainel] = useState<Painel>('dados');

  return (
    <Janela
      titulo="Configurações"
      descricao={`${principal.name} · ${principal.roleLabel}`}
      aoFechar={aoFechar}
    >
      <div className="janela-abas" role="tablist" aria-label="Configurações">
        {(
          [
            ['dados', 'Meus dados'],
            ['acesso', 'Acesso'],
          ] as const
        ).map(([id, nome]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={painel === id}
            className={`janela-aba ${painel === id ? 'ativa' : ''}`}
            onClick={() => setPainel(id)}
          >
            {nome}
          </button>
        ))}
      </div>

      {painel === 'dados' ? (
        <Perfil principal={principal} semCabecalho />
      ) : (
        <Acesso aoPerderSessao={aoPerderSessao} />
      )}
    </Janela>
  );
}

/* ====================================================================
 * Acesso
 * ================================================================== */

function Acesso({ aoPerderSessao }: { aoPerderSessao: () => void }): ReactNode {
  const [emailAtual, setEmailAtual] = useState<string | null>(null);

  useEffect(() => {
    void lerPerfil()
      .then((r) => setEmailAtual(r.data.email))
      .catch(() => undefined);
  }, []);

  return (
    <div className="cfg-acesso">
      <TrocaDeEmail atual={emailAtual} aoTrocar={setEmailAtual} />
      <TrocaDeSenha aoPerderSessao={aoPerderSessao} />
    </div>
  );
}

/* --------------------------------------------------------------------
 * E-mail
 * ------------------------------------------------------------------ */

function TrocaDeEmail({
  atual,
  aoTrocar,
}: {
  atual: string | null;
  aoTrocar: (email: string) => void;
}): ReactNode {
  const [abriu, setAbriu] = useState(false);
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [pronto, setPronto] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const { data } = await trocarMeuEmail(senha, email.trim());
      aoTrocar(data.email);
      setPronto(true);
      setAbriu(false);
      setEmail('');
      setSenha('');
    } catch (x) {
      setErro(x instanceof ApiError ? x.message : 'Não foi possível trocar o e-mail.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <section className="cfg-bloco">
      <div className="cfg-bloco-topo">
        <div>
          <h3>E-mail de acesso</h3>
          <p className="cfg-nota">É com ele que você entra no sistema.</p>
        </div>
        {!abriu && (
          <button
            type="button"
            className="botao-secundario"
            onClick={() => {
              setAbriu(true);
              setPronto(false);
              setErro(null);
            }}
          >
            Trocar
          </button>
        )}
      </div>

      <p className="cfg-valor mono">{atual ?? '—'}</p>

      {pronto && (
        <p className="cfg-ok" role="status">
          E-mail trocado. Da próxima vez, entre com o endereço novo.
        </p>
      )}

      {abriu && (
        <form className="formulario cfg-form" onSubmit={(e) => void enviar(e)} noValidate>
          <label className="campo campo-meia">
            <span className="campo-rotulo">Novo e-mail</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="campo campo-meia">
            <span className="campo-rotulo">Sua senha atual</span>
            <input
              type="password"
              autoComplete="current-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
            />
            {/* POR QUE A SENHA. Sem ela, uma sessão esquecida aberta no
                computador da recepção bastaria para trocar o endereço e
                trancar o dono para fora da própria conta — e a
                recuperação, que passa pelo e-mail, não o traria de volta. */}
            <span className="campo-dica">
              Confirma que é você. Sem ela, quem pegasse esta tela aberta trocaria seu acesso.
            </span>
          </label>

          <p className="campo-dica campo-cheia">
            Você continua conectado aqui. As sessões abertas em outros aparelhos são encerradas.
          </p>

          {erro !== null && (
            <p className="mensagem-erro campo-cheia" role="alert">
              {erro}
            </p>
          )}

          <div className="formulario-acoes campo-cheia">
            <button type="button" className="botao-secundario" onClick={() => setAbriu(false)}>
              Cancelar
            </button>
            <button type="submit" className="botao-acao" disabled={enviando}>
              {enviando ? 'Trocando…' : 'Trocar e-mail'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------
 * Senha
 * ------------------------------------------------------------------ */

function TrocaDeSenha({ aoPerderSessao }: { aoPerderSessao: () => void }): ReactNode {
  const [abriu, setAbriu] = useState(false);
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [repetida, setRepetida] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [pronto, setPronto] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (nova !== repetida) {
      setErro('As duas senhas novas precisam ser iguais.');
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      await trocarMinhaSenha(atual, nova);
      setPronto(true);
      /* Um respiro antes do login: sem ele a tela pisca e a pessoa não
         entende se deu certo. */
      setTimeout(aoPerderSessao, 1800);
    } catch (x) {
      setErro(x instanceof ApiError ? x.message : 'Não foi possível trocar a senha.');
      setEnviando(false);
    }
  };

  if (pronto) {
    return (
      <section className="cfg-bloco">
        <h3>Senha alterada</h3>
        <p className="cfg-nota">
          Todas as sessões foram encerradas, inclusive esta. Levando você ao login…
        </p>
      </section>
    );
  }

  return (
    <section className="cfg-bloco">
      <div className="cfg-bloco-topo">
        <div>
          <h3>Senha</h3>
          <p className="cfg-nota">Pelo menos 10 caracteres.</p>
        </div>
        {!abriu && (
          <button type="button" className="botao-secundario" onClick={() => setAbriu(true)}>
            Trocar
          </button>
        )}
      </div>

      {abriu && (
        <form className="formulario cfg-form" onSubmit={(e) => void enviar(e)} noValidate>
          <label className="campo campo-terco">
            <span className="campo-rotulo">Senha atual</span>
            <input
              type="password"
              autoComplete="current-password"
              value={atual}
              onChange={(e) => setAtual(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="campo campo-terco">
            <span className="campo-rotulo">Nova senha</span>
            <input
              type="password"
              autoComplete="new-password"
              value={nova}
              onChange={(e) => setNova(e.target.value)}
              required
            />
          </label>
          <label className="campo campo-terco">
            <span className="campo-rotulo">Repita a nova</span>
            <input
              type="password"
              autoComplete="new-password"
              value={repetida}
              onChange={(e) => setRepetida(e.target.value)}
              required
            />
          </label>

          {/* AVISADO ANTES DE CLICAR. Trocar a senha derruba todas as
              sessões, esta inclusive — e isso é o certo: uma senha
              trocada porque vazou não pode deixar viva a sessão de quem
              a usou. Quem descobre isso depois acha que o sistema caiu. */}
          <p className="campo-dica campo-cheia">
            Ao trocar, todas as sessões são encerradas — esta também. Você entra de novo em seguida.
          </p>

          {erro !== null && (
            <p className="mensagem-erro campo-cheia" role="alert">
              {erro}
            </p>
          )}

          <div className="formulario-acoes campo-cheia">
            <button type="button" className="botao-secundario" onClick={() => setAbriu(false)}>
              Cancelar
            </button>
            <button type="submit" className="botao-acao" disabled={enviando}>
              {enviando ? 'Trocando…' : 'Trocar senha'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
