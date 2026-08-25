import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Carregando, Erro, Vazio } from './ui.jsx';
import type { Principal } from './api.js';
import {
  AREAS,
  AREA_DESCRICOES,
  AREA_LABELS,
  AREA_PERMISSIONS,
  permissionsOf,
} from '@stabilize/shared';

/**
 * A equipe da academia — cadastrar, editar, desligar.
 *
 * ESTA TELA FALTAVA E ERA A QUE TRAVAVA O RESTO. Até aqui só o painel da
 * plataforma criava gente, e só criava dono e administrador: a academia
 * não tinha como cadastrar um personal nem uma recepcionista, que são
 * exatamente os papéis que ela contrata e demite sozinha. Sem
 * profissional cadastrado não há cor no calendário, não há a quem
 * atribuir aluno e não há comissão a fechar.
 *
 * A COR MORA AQUI, e não numa tela à parte de configuração. É no momento
 * de cadastrar o professor que se decide como ele vai aparecer na
 * agenda; separar as duas coisas garante que metade da equipe fique sem
 * cor até alguém lembrar.
 *
 * O QUE ESTA TELA NÃO DECIDE: quem pode mexer em quem. O servidor recusa
 * um administrador que tente criar um dono, e recusa qualquer um que
 * tente desligar a própria conta. Aqui os botões apenas somem quando a
 * ação seria recusada — se o `disabled` sumisse, nada mudaria do lado de
 * lá.
 */

const PAPEIS: { valor: api.PapelDaEquipe; nome: string; descricao: string }[] = [
  { valor: 'PROFESSIONAL', nome: 'Profissional', descricao: 'Atende alunos, monta treino e prescreve. Vê a agenda de todos e só mexe na própria.' },
  { valor: 'RECEPTION', nome: 'Recepção', descricao: 'Cadastra aluno, marca horário e recebe pagamento. Não vê prontuário nem o caixa.' },
  { valor: 'ADMIN', nome: 'Administrador', descricao: 'Toca a academia inteira: alunos, agenda, financeiro e equipe.' },
  { valor: 'OWNER', nome: 'Dono', descricao: 'Tudo o que o administrador faz, e é quem nomeia outros donos.' },
];

const NOME_DO_PAPEL: Record<string, string> = Object.fromEntries(
  PAPEIS.map((p) => [p.valor, p.nome]),
);

/** A paleta oferecida para a agenda. Tons distinguíveis entre si, inclusive
    para quem não separa vermelho de verde. */
const PALETA = [
  '#2e9aa1',
  '#b2593a',
  '#5b7fb2',
  '#8a6bb2',
  '#3f9e6b',
  '#b23a72',
  '#9a6407',
  '#4a6b8a',
];

export function Equipe({ principal }: { principal: Principal }): ReactNode {
  const [lista, setLista] = useState<api.UsuarioDaEquipe[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState<api.UsuarioDaEquipe | 'novo' | null>(null);
  const [senhaNova, setSenhaNova] = useState<{ nome: string; senha: string } | null>(null);
  const [versao, setVersao] = useState(0);

  const recarregar = useCallback(() => setVersao((v) => v + 1), []);

  useEffect(() => {
    let vivo = true;
    api
      .buscarEquipe()
      .then((r) => {
        if (!vivo) return;
        setLista(r.data);
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setLista([]);
        setErro(e instanceof api.ApiError ? e.message : 'Não foi possível carregar a equipe.');
      });
    return () => {
      vivo = false;
    };
  }, [versao]);

  const souDono = principal.role === 'OWNER';

  if (editando !== null) {
    return (
      <Formulario
        usuario={editando === 'novo' ? null : editando}
        souDono={souDono}
        eEuMesmo={editando !== 'novo' && editando.id === principal.id}
        aoSair={() => setEditando(null)}
        aoSalvar={(senha) => {
          setEditando(null);
          if (senha !== null) setSenhaNova(senha);
          recarregar();
        }}
      />
    );
  }

  return (
    <>
      <div className="secao-cabecalho linha-cabecalho">
        <div>
          <h1>Usuários</h1>
          <p>
            {lista === null
              ? 'Quem trabalha na academia e o que cada um alcança.'
              : `${lista.filter((u) => u.ativo).length} ativos de ${lista.length} · o papel é o teto do que cada um pode, e as seções marcadas são o que ele enxerga.`}
          </p>
        </div>
        <button type="button" className="botao-acao" onClick={() => setEditando('novo')}>
          <span aria-hidden="true">+</span> Novo usuário
        </button>
      </div>

      {senhaNova !== null && (
        <SenhaProvisoria
          nome={senhaNova.nome}
          senha={senhaNova.senha}
          aoFechar={() => setSenhaNova(null)}
        />
      )}

      {erro !== null && <Erro mensagem={erro} />}

      {lista === null ? (
        <Carregando rotulo="Carregando a equipe" />
      ) : lista.length === 0 ? (
        <Vazio
          titulo="Ninguém cadastrado ainda."
          descricao="Cadastre os profissionais que atendem: é o que faz a agenda ganhar cor e o que permite atribuir alunos."
        />
      ) : (
        <div className="rolo">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Pessoa</th>
                <th scope="col">Papel</th>
                <th scope="col">Último acesso</th>
                <th scope="col">Situação</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {lista.map((u) => (
                <Linha
                  key={u.id}
                  usuario={u}
                  eEuMesmo={u.id === principal.id}
                  souDono={souDono}
                  aoEditar={() => setEditando(u)}
                  aoMudar={recarregar}
                  aoGerarSenha={(senha) => setSenhaNova({ nome: u.nome, senha })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ==================================================================== */

function Linha({
  usuario: u,
  eEuMesmo,
  souDono,
  aoEditar,
  aoMudar,
  aoGerarSenha,
}: {
  usuario: api.UsuarioDaEquipe;
  eEuMesmo: boolean;
  souDono: boolean;
  aoEditar: () => void;
  aoMudar: () => void;
  aoGerarSenha: (senha: string) => void;
}): ReactNode {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  /* Mexer num dono exige ser dono. É a mesma regra do servidor, repetida
     aqui só para não oferecer o botão que resultaria em 403. */
  const posso = souDono || u.papel !== 'OWNER';

  const agir = async (fn: () => Promise<unknown>): Promise<void> => {
    setErro(null);
    setOcupado(true);
    try {
      await fn();
      aoMudar();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível concluir.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <>
      <tr className={u.ativo ? '' : 'eq-desligado'}>
        <td>
          <span className="aluno-linha">
            {/* O disco usa a COR DA AGENDA da pessoa, não uma cor
                genérica: é o mesmo sinal que ela terá no calendário, e
                ver os dois juntos é o que torna a cor memorizável. */}
            <span
              className="aluno-inicial eq-cor"
              style={u.cor !== null ? { background: u.cor, color: '#fff' } : undefined}
              aria-hidden="true"
            >
              {u.nome.trim().charAt(0).toUpperCase()}
            </span>
            <span className="aluno-nome">
              <span className="celula-forte">{u.nome}</span>
              <span className="celula-apoio">{u.email}</span>
            </span>
          </span>
        </td>
        <td>
          {/* PÍLULA, e não texto solto: o papel é a informação que muda
              o que a pessoa alcança no sistema inteiro, e merece a forma
              que o olho encontra primeiro numa lista. */}
          <span className={`pilula papel-${u.papel.toLowerCase()}`}>
            {NOME_DO_PAPEL[u.papel] ?? u.papel}
          </span>
        </td>
        <td className="tabular">
          {u.ultimoAcesso === null ? (
            <span className="plt-secundario">nunca entrou</span>
          ) : (
            new Date(u.ultimoAcesso).toLocaleDateString('pt-BR')
          )}
        </td>
        <td>
          <span className={`pilula ${u.ativo ? 'viva' : 'apagada'}`}>
            {u.ativo ? 'Ativo' : 'Desligado'}
          </span>
          {u.precisaTrocarSenha && u.ativo && <span className="eq-nota">senha provisória</span>}
        </td>
        <td className="fin-acao">
          {posso && (
            <span className="eq-acoes">
              <button type="button" className="botao-texto" onClick={aoEditar} disabled={ocupado}>
                Editar
              </button>
              <button
                type="button"
                className="botao-texto"
                disabled={ocupado}
                onClick={() => {
                  if (
                    window.confirm(
                      `Gerar uma senha nova para ${u.nome}?\n\nA senha atual deixa de valer na hora e as sessões abertas caem.`,
                    )
                  ) {
                    void agir(() =>
                      api.redefinirSenhaDeUsuario(u.id).then((r) => aoGerarSenha(r.data.senhaProvisoria)),
                    );
                  }
                }}
              >
                Nova senha
              </button>
              {/* Desligar a própria conta deixaria a academia sem quem
                  administra — o servidor recusa, e aqui nem se oferece. */}
              {!eEuMesmo && (
                <button
                  type="button"
                  className={u.ativo ? 'botao-texto-perigo' : 'botao-texto'}
                  disabled={ocupado}
                  onClick={() => {
                    const acao = u.ativo ? 'Desligar' : 'Reativar';
                    if (
                      window.confirm(
                        u.ativo
                          ? `Desligar ${u.nome}?\n\nEla perde o acesso agora e as sessões abertas caem. O histórico continua.`
                          : `Reativar ${u.nome}?`,
                      )
                    ) {
                      void agir(() => api.definirUsuarioAtivo(u.id, !u.ativo));
                    }
                    void acao;
                  }}
                >
                  {u.ativo ? 'Desligar' : 'Reativar'}
                </button>
              )}
            </span>
          )}
        </td>
      </tr>
      {erro !== null && (
        <tr>
          <td colSpan={5}>
            <p className="mensagem-erro" role="alert">
              {erro}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/* ==================================================================== */

function Formulario({
  usuario,
  souDono,
  eEuMesmo,
  aoSair,
  aoSalvar,
}: {
  usuario: api.UsuarioDaEquipe | null;
  souDono: boolean;
  eEuMesmo: boolean;
  aoSair: () => void;
  aoSalvar: (senha: { nome: string; senha: string } | null) => void;
}): ReactNode {
  const novo = usuario === null;
  const [nome, setNome] = useState(usuario?.nome ?? '');
  const [email, setEmail] = useState(usuario?.email ?? '');
  const [papel, setPapel] = useState<api.PapelDaEquipe>(usuario?.papel ?? 'PROFESSIONAL');
  const [telefone, setTelefone] = useState(usuario?.telefone ?? '');
  const [cor, setCor] = useState(usuario?.cor ?? PALETA[0]!);
  /* NULO É "TUDO DO PAPEL", que é o padrão e o que todo mundo que já
     existia tem. A tela guarda os dois estados separados de propósito:
     "não recortei" e "recortei para nenhuma" são coisas diferentes, e a
     segunda é um erro que o formulário impede. */
  const [recortar, setRecortar] = useState(usuario?.areas != null);
  const [areas, setAreas] = useState<string[]>(usuario?.areas ?? []);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  /* As seções que o PAPEL escolhido alcança. Mostrar as outras seria
     oferecer o que o servidor recusaria: a conta é interseção, e marcar
     "Financeiro" para uma recepção não daria financeiro a ninguém —
     daria uma caixa marcada sem efeito, que é pior do que não oferecer. */
  const permitidasDoPapel = permissionsOf(papel);
  const areasDoPapel = AREAS.filter((a) =>
    AREA_PERMISSIONS[a].some((p) => permitidasDoPapel.includes(p)),
  );

  const alternar = (a: string): void =>
    setAreas((atual) => (atual.includes(a) ? atual.filter((x) => x !== a) : [...atual, a]));

  /* Um administrador não vê a opção "Dono" na lista: o servidor recusaria
     e a mensagem de erro depois de preencher o formulário inteiro é uma
     forma pior de dizer a mesma coisa. */
  const opcoes = PAPEIS.filter((p) => p.valor !== 'OWNER' || souDono);
  const escolhido = PAPEIS.find((p) => p.valor === papel);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (recortar && areas.length === 0) {
      setErro('Marque ao menos uma seção — ou deixe "tudo do papel" para não recortar.');
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      const dados = {
        nome,
        papel,
        telefone: telefone || null,
        cor,
        areas: recortar ? areas : null,
      };
      if (novo) {
        const r = await api.criarUsuario({ ...dados, email: email.trim() });
        aoSalvar({ nome, senha: r.data.senhaProvisoria });
      } else {
        await api.salvarUsuario(usuario.id, dados);
        aoSalvar(null);
      }
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível salvar.');
      setEnviando(false);
    }
  };

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Voltar para a equipe
      </button>
      <div className="secao-cabecalho">
        <h1>{novo ? 'Cadastrar pessoa' : `Editar ${usuario.nome}`}</h1>
        <p>
          {novo
            ? 'O acesso é criado com uma senha provisória, mostrada uma única vez ao salvar.'
            : 'O e-mail não muda por aqui — ele é o login, e trocá-lo derrubaria o acesso.'}
        </p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Nome completo</span>
          <input value={nome} onChange={(e) => setNome(e.target.value)} required autoFocus />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">E-mail</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={!novo}
            autoComplete="off"
          />
          {!novo && <span className="campo-dica">É o login. Não muda.</span>}
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Telefone</span>
          <input
            value={telefone}
            onChange={(e) => setTelefone(e.target.value)}
            placeholder="(51) 99999-9999"
          />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Papel</span>
          <select
            value={papel}
            onChange={(e) => setPapel(e.target.value as api.PapelDaEquipe)}
            disabled={eEuMesmo}
          >
            {opcoes.map((p) => (
              <option key={p.valor} value={p.valor}>
                {p.nome}
              </option>
            ))}
          </select>
          {/* O QUE O PAPEL SIGNIFICA, embaixo do seletor. Sem isto, quem
              cadastra escolhe pelo nome e descobre o alcance depois —
              geralmente quando alguém viu o que não devia. */}
          <span className="campo-dica">
            {eEuMesmo ? 'Você não pode trocar o próprio papel.' : escolhido?.descricao}
          </span>
        </label>

        <fieldset className="campo campo-cheia eq-paleta">
          <legend className="campo-rotulo">Cor na agenda</legend>
          <div className="eq-cores">
            {PALETA.map((c) => (
              <label key={c} className={`eq-opcao ${cor === c ? 'ativa' : ''}`}>
                <input
                  type="radio"
                  name="cor"
                  value={c}
                  checked={cor === c}
                  onChange={() => setCor(c)}
                />
                <span style={{ background: c }} aria-hidden="true" />
                <span className="apenas-leitor-de-tela">Cor {c}</span>
              </label>
            ))}
          </div>
          <span className="campo-dica">
            É por ela que os horários desta pessoa são reconhecidos no calendário.
          </span>
        </fieldset>

        {/* ==================================================
            O QUE ESTA PESSOA ENXERGA

            O papel diz o que ela PODE; aqui se diz o que ela FAZ. Quem
            cuida do financeiro não abre prontuário de aluno, e até
            agora a única forma de conseguir isso era não dar acesso
            nenhum.

            A conta é sempre interseção com o papel — marcar uma seção
            nunca dá permissão que o papel não tenha —, e o corte vale no
            servidor, não só no menu: a pessoa não vê e também não
            alcança pela URL.
            ================================================== */}
        <fieldset className="campo campo-cheia eq-acessos">
          <legend className="campo-rotulo">O que esta pessoa enxerga</legend>

          <label className="eq-tudo">
            <input
              type="radio"
              name="recorte"
              checked={!recortar}
              onChange={() => setRecortar(false)}
            />
            <span>
              <strong>Tudo o que o papel permite</strong>
              <span className="campo-dica">
                {escolhido?.descricao ?? 'O alcance completo do papel escolhido.'}
              </span>
            </span>
          </label>

          <label className="eq-tudo">
            <input
              type="radio"
              name="recorte"
              checked={recortar}
              onChange={() => setRecortar(true)}
            />
            <span>
              <strong>Só as seções que eu marcar</strong>
              <span className="campo-dica">
                O resto some do menu e deixa de responder, mesmo pelo endereço direto.
              </span>
            </span>
          </label>

          {recortar && (
            <div className="eq-areas">
              {areasDoPapel.map((a) => (
                <label key={a} className={`eq-area ${areas.includes(a) ? 'ativa' : ''}`}>
                  <input
                    type="checkbox"
                    checked={areas.includes(a)}
                    onChange={() => alternar(a)}
                  />
                  <span>
                    <strong>{AREA_LABELS[a]}</strong>
                    <span className="campo-dica">{AREA_DESCRICOES[a]}</span>
                  </span>
                </label>
              ))}
              {areasDoPapel.length === 0 && (
                <p className="campo-dica">Este papel não tem seções para recortar.</p>
              )}
            </div>
          )}
        </fieldset>

        {erro !== null && (
          <p className="mensagem-erro campo-cheia" role="alert">
            {erro}
          </p>
        )}

        <div className="formulario-acoes campo-cheia">
          <button type="button" className="botao-secundario" onClick={aoSair}>
            Cancelar
          </button>
          <button type="submit" className="botao-acao" disabled={enviando}>
            {enviando ? 'Salvando…' : novo ? 'Cadastrar' : 'Salvar'}
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * A senha provisória, mostrada uma vez.
 *
 * O destaque é grande de propósito: é para ser copiada ou ditada agora,
 * não procurada depois. Ela não existe em claro em lugar nenhum do
 * sistema, e a troca é obrigatória no primeiro acesso.
 */
function SenhaProvisoria({
  nome,
  senha,
  aoFechar,
}: {
  nome: string;
  senha: string;
  aoFechar: () => void;
}): ReactNode {
  return (
    <div className="plt-senha" role="status">
      <p className="plt-senha-linha">
        <span>Senha provisória de {nome}</span>
        <strong className="plt-destaque">{senha}</strong>
      </p>
      <p className="plt-aviso">
        Anote ou envie agora — ela aparece uma única vez e não fica guardada em lugar nenhum. No
        primeiro acesso o sistema exige a troca.
      </p>
      <button type="button" className="botao-secundario" onClick={aoFechar}>
        Já anotei
      </button>
    </div>
  );
}
