import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as plt from './api-plataforma.js';
import { Marca } from './Marca.jsx';
import { Carregando, Erro, Vazio } from './ui.jsx';
import { mascararTelefone, telefoneParaE164 } from '@stabilize/shared';

/**
 * Painel de quem opera o SaaS.
 *
 * TELA SEPARADA DO SISTEMA DA ACADEMIA, servida em `/plataforma`. Não é
 * uma aba a mais do menu, e não poderia ser: quem entra aqui não
 * pertence a academia nenhuma, e o token que ele carrega tem audiência
 * própria — não abre uma única rota do sistema das academias.
 *
 * O QUE ESTE PAINEL NÃO MOSTRA: nenhum aluno, nenhuma anamnese, nenhum
 * lançamento financeiro. Ele mostra CONTAGENS por academia, que é o que
 * o faturamento precisa, e não identifica ninguém. Para ver o dado de
 * uma academia existe o botão "Entrar como" — que é registrado no
 * histórico DELA, onde o dono enxerga.
 */

type Secao = 'visao' | 'empresas' | 'whatsapp' | 'historico';

export default function Plataforma(): ReactNode {
  const [operador, setOperador] = useState<plt.Operador | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    /* O painel é escuro, sempre. É a tela de operação do serviço, usada
       de madrugada tanto quanto de dia, e o contraste com o sistema das
       academias — que é claro — é informação: você sabe onde está antes
       de ler qualquer coisa. */
    document.documentElement.setAttribute('data-tema', 'escuro');
    void plt
      .restaurar()
      .then(setOperador)
      .catch(() => undefined)
      .finally(() => setCarregando(false));
  }, []);

  if (carregando) {
    return (
      <div className="plt-carregando">
        <Carregando rotulo="Abrindo o painel" />
      </div>
    );
  }

  if (operador === null) return <Entrada aoEntrar={setOperador} />;
  if (operador.precisaTrocarSenha) {
    return <TrocaObrigatoria aoTrocar={setOperador} />;
  }
  return <Painel operador={operador} aoSair={() => setOperador(null)} />;
}

/* ====================================================================
 * Entrada
 * ================================================================== */

function Entrada({ aoEntrar }: { aoEntrar: (o: plt.Operador) => void }): ReactNode {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      aoEntrar(await plt.entrar(email.trim(), senha));
    } catch (x) {
      setErro(x instanceof plt.ErroPlataforma ? x.message : 'Não foi possível entrar.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="plt-entrada">
      <form className="plt-entrada-caixa" onSubmit={(e) => void enviar(e)} noValidate>
        <Marca variante="horizontal" altura={34} />
        <p className="plt-eyebrow">Painel da plataforma</p>
        <h1>Operação do serviço</h1>
        <p className="plt-sub">
          Aqui se cadastram as academias. Para entrar numa delas, use o sistema normal.
        </p>

        <label className="campo campo-cheia">
          <span className="campo-rotulo">E-mail</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Senha</span>
          <input
            type="password"
            autoComplete="current-password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            required
          />
        </label>

        {erro !== null && (
          <p className="mensagem-erro" role="alert">
            {erro}
          </p>
        )}

        <button type="submit" className="botao-acao" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}

function TrocaObrigatoria({ aoTrocar }: { aoTrocar: (o: plt.Operador) => void }): ReactNode {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [repetida, setRepetida] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    if (nova !== repetida) {
      setErro('As duas senhas não são iguais.');
      return;
    }
    setEnviando(true);
    try {
      /* A troca derruba todas as sessões, esta inclusive — e o servidor
         devolve uma nova na mesma resposta. Antes daqui saía um logout e
         um reload, e o operador caía numa tela de login logo depois de
         escolher a senha, sem ter para onde ir a não ser digitar tudo de
         novo. */
      aoTrocar(await plt.trocarSenha(atual, nova));
    } catch (x) {
      setErro(x instanceof plt.ErroPlataforma ? x.message : 'Não foi possível trocar a senha.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="plt-entrada">
      <form className="plt-entrada-caixa" onSubmit={(e) => void enviar(e)} noValidate>
        <p className="plt-eyebrow">Primeiro acesso</p>
        <h1>Escolha uma senha</h1>
        <p className="plt-sub">
          A senha que você recebeu é provisória e foi mostrada uma única vez. Troque-a agora.
        </p>
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Senha provisória</span>
          <input type="password" value={atual} onChange={(e) => setAtual(e.target.value)} required autoFocus />
        </label>
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Nova senha</span>
          <input type="password" value={nova} onChange={(e) => setNova(e.target.value)} required />
          <span className="campo-dica">Pelo menos 10 caracteres.</span>
        </label>
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Repita a nova senha</span>
          <input
            type="password"
            value={repetida}
            onChange={(e) => setRepetida(e.target.value)}
            required
          />
        </label>
        {erro !== null && (
          <p className="mensagem-erro" role="alert">
            {erro}
          </p>
        )}
        <button type="submit" className="botao-acao" disabled={enviando}>
          {enviando ? 'Salvando…' : 'Trocar senha'}
        </button>
      </form>
    </div>
  );
}

/* ====================================================================
 * Painel
 * ================================================================== */

function Painel({ operador, aoSair }: { operador: plt.Operador; aoSair: () => void }): ReactNode {
  const [secao, setSecao] = useState<Secao>('visao');

  const secoes: { id: Secao; nome: string }[] = [
    { id: 'visao', nome: 'Visão geral' },
    { id: 'empresas', nome: 'Visão da rede' },
    { id: 'whatsapp', nome: 'WhatsApp' },
    { id: 'historico', nome: 'Histórico' },
  ];

  return (
    <div className="plt">
      <aside className="plt-lateral">
        <div className="plt-marca">
          <Marca variante="horizontal" altura={30} />
          <span className="plt-selo">plataforma</span>
        </div>
        <nav className="plt-nav">
          {secoes.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`plt-item ${secao === s.id ? 'ativa' : ''}`}
              aria-current={secao === s.id ? 'page' : undefined}
              onClick={() => setSecao(s.id)}
            >
              {s.nome}
            </button>
          ))}
        </nav>
        <div className="plt-rodape">
          <span className="plt-quem">{operador.nome}</span>
          <a className="plt-link" href="/">
            Ir para o sistema
          </a>
          <button
            type="button"
            className="plt-sair"
            onClick={() => void plt.sair().then(aoSair)}
          >
            Sair
          </button>
        </div>
      </aside>

      <main className="plt-conteudo">
        {secao === 'visao' && <VisaoGeral />}
        {secao === 'empresas' && <Academias />}
        {secao === 'whatsapp' && <Whatsapp />}
        {secao === 'historico' && <Historico />}
      </main>
    </div>
  );
}

/* ====================================================================
 * Visão geral
 * ================================================================== */

function VisaoGeral(): ReactNode {
  const [m, setM] = useState<plt.Metricas | null>(null);
  const [erros, setErros] = useState<plt.Ocorrencia[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [a, b] = await Promise.all([plt.buscarMetricas(), plt.buscarErros(12)]);
      setM(a.data);
      setErros(b.data);
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (erro !== null) return <Erro mensagem={erro} aoTentar={() => void carregar()} />;
  if (m === null) return <Carregando rotulo="Carregando as métricas" />;

  return (
    <>
      <div className="secao-cabecalho">
        <h1>Visão geral</h1>
        <p>Os números do serviço inteiro. Nenhum dado de aluno aparece aqui.</p>
      </div>

      <div className="plt-cartoes">
        <Cartao rotulo="Academias" valor={m.empresas} nota={`${m.empresasAtivas} ativas`} />
        <Cartao
          rotulo="Suspensas"
          valor={m.empresasSuspensas}
          nota={m.empresasSuspensas > 0 ? 'sem acesso ao sistema' : 'nenhuma'}
          tom={m.empresasSuspensas > 0 ? 'atencao' : undefined}
        />
        <Cartao rotulo="Usuários" valor={m.usuarios} nota="contas ativas" />
        <Cartao rotulo="Alunos" valor={m.alunos} nota={`${m.alunosAtivos} ativos`} />
        <Cartao rotulo="Agendamentos" valor={m.agendamentos30d} nota="últimos 30 dias" />
        <Cartao rotulo="Entradas" valor={m.logins24h} nota="nas últimas 24 h" />
        <Cartao
          rotulo="Entradas recusadas"
          valor={m.loginsFalhos24h}
          nota="nas últimas 24 h"
          tom={m.loginsFalhos24h > 20 ? 'atencao' : undefined}
        />
        <Cartao
          rotulo="WhatsApp na fila"
          valor={m.mensagensPendentes}
          nota={m.mensagensFalhas > 0 ? `${m.mensagensFalhas} falharam` : 'nenhuma falha'}
          tom={m.mensagensFalhas > 0 ? 'erro' : undefined}
        />
      </div>

      <h2 className="plt-titulo">Recusas e erros recentes</h2>
      <p className="plt-sub">
        Acesso negado e erro em qualquer academia. É onde um problema aparece antes de o cliente
        ligar.
      </p>

      {erros.length === 0 ? (
        <Vazio titulo="Nada registrado." descricao="Nenhuma recusa nem erro recente." />
      ) : (
        <div className="rolo">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Academia</th>
                <th scope="col">Ação</th>
                <th scope="col">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {erros.map((o, i) => (
                <tr key={`${o.quando}-${i}`}>
                  <td className="tabular">{quando(o.quando)}</td>
                  <td>{o.empresa}</td>
                  <td className="mono">{o.acao}</td>
                  <td>
                    <span className={`plt-pilula ${o.resultado === 'DENIED' ? 'atencao' : 'erro'}`}>
                      {o.resultado === 'DENIED' ? 'negado' : 'erro'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Cartao({
  rotulo,
  valor,
  nota,
  tom,
}: {
  rotulo: string;
  valor: number;
  nota: string;
  /* `| undefined` explícito porque o projeto compila com
     `exactOptionalPropertyTypes`: ali, `tom?: T` recusa receber
     `undefined` de propósito, e a expressão condicional que decide o
     tom produz exatamente isso. */
  tom?: 'atencao' | 'erro' | undefined;
}): ReactNode {
  return (
    <div className={`plt-cartao ${tom ?? ''}`}>
      <span className="plt-cartao-rotulo">{rotulo}</span>
      <strong className="plt-cartao-valor tabular">{valor.toLocaleString('pt-BR')}</strong>
      <span className="plt-cartao-nota">{nota}</span>
    </div>
  );
}

function quando(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ====================================================================
 * Academias
 * ================================================================== */

function Academias(): ReactNode {
  const [rede, setRede] = useState<plt.NaRede[] | null>(null);
  const [cadastros, setCadastros] = useState<plt.Empresa[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [aberta, setAberta] = useState<plt.Empresa | null>(null);
  const [editando, setEditando] = useState<plt.Empresa | null>(null);
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<'todas' | 'online' | 'paradas' | 'suspensas'>('todas');
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);

  /* O QUE CONTA COMO "AGORA". Cinco minutos é o que separa "tem gente na
     tela" de "alguém passou por aqui hoje": o carimbo de presença é
     escrito no máximo a cada três minutos por pessoa, então uma janela
     menor devolveria vermelho para quem está usando o sistema neste
     instante. */
  const JANELA = 5;

  const carregar = useCallback(async (comCadastros: boolean) => {
    try {
      const [r, c] = await Promise.all([
        plt.lerRede(JANELA),
        comCadastros ? plt.listarEmpresas() : Promise.resolve(null),
      ]);
      setRede(r.data);
      if (c !== null) setCadastros(c.data);
      setAtualizadoEm(new Date());
      setErro(null);
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar(true);
  }, [carregar]);

  /* SOZINHO, DE MEIO EM MEIO MINUTO. Um painel de "quem está online
     agora" que só atualiza quando alguém aperta F5 mostra o passado com
     cara de presente — e é pior do que não mostrar nada, porque parece
     confiável. */
  useEffect(() => {
    if (aberta !== null || criando) return undefined;
    const t = setInterval(() => void carregar(false), 30_000);
    return () => clearInterval(t);
  }, [carregar, aberta, criando]);

  if (erro !== null && rede === null) {
    return <Erro mensagem={erro} aoTentar={() => void carregar(true)} />;
  }
  if (rede === null) return <Carregando rotulo="Carregando a rede" />;

  const cadastroDe = (id: string): plt.Empresa | null => cadastros.find((c) => c.id === id) ?? null;

  if (criando) {
    return (
      <NovaAcademia
        aoSair={() => setCriando(false)}
        aoCriar={() => {
          setCriando(false);
          void carregar(true);
        }}
      />
    );
  }

  if (aberta !== null) {
    return (
      <DetalheAcademia
        empresa={aberta}
        aoSair={() => setAberta(null)}
        aoMudar={() => void carregar(true)}
      />
    );
  }

  const termo = busca.trim().toLowerCase();
  const visiveis = rede
    .filter((e) => {
      if (filtro === 'online') return e.ativa && e.onlineAgora > 0;
      if (filtro === 'paradas') return e.ativa && e.onlineAgora === 0;
      if (filtro === 'suspensas') return !e.ativa;
      return true;
    })
    .filter(
      (e) =>
        termo === '' ||
        e.nome.toLowerCase().includes(termo) ||
        e.slug.toLowerCase().includes(termo) ||
        (e.documento ?? '').includes(termo),
    );

  const ativas = rede.filter((e) => e.ativa);
  const operando = ativas.filter((e) => e.onlineAgora > 0);
  const gente = rede.reduce((n, e) => n + e.onlineAgora, 0);

  return (
    <>
      <div className="secao-cabecalho plt-cabecalho-acao">
        <div>
          <h1>Visão da rede</h1>
          <p>
            Cada academia e o que ela está fazendo agora. Atualiza sozinha a cada 30 segundos.
          </p>
        </div>
        <button type="button" className="botao-acao" onClick={() => setCriando(true)}>
          Cadastrar academia
        </button>
      </div>

      <div className="rede-resumo">
        <ResumoDaRede rotulo="Academias" valor={rede.length} />
        <ResumoDaRede rotulo="Ativas" valor={ativas.length} />
        <ResumoDaRede
          rotulo="Operando agora"
          valor={operando.length}
          tom={operando.length > 0 ? 'viva' : 'parada'}
        />
        <ResumoDaRede rotulo="Pessoas na tela" valor={gente} tom={gente > 0 ? 'viva' : 'parada'} />
      </div>

      <div className="rede-controles">
        <label className="campo campo-busca">
          <span className="campo-rotulo">Buscar</span>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Nome, identificador ou CNPJ"
          />
        </label>

        <div className="rede-filtros" role="group" aria-label="Filtrar academias">
          {(
            [
              ['todas', `Todas · ${rede.length}`],
              ['online', `Com gente · ${operando.length}`],
              ['paradas', `Sem ninguém · ${ativas.length - operando.length}`],
              ['suspensas', `Suspensas · ${rede.length - ativas.length}`],
            ] as const
          ).map(([id, nome]) => (
            <button
              key={id}
              type="button"
              className={`rede-filtro ${filtro === id ? 'ativa' : ''}`}
              aria-pressed={filtro === id}
              onClick={() => setFiltro(id)}
            >
              {nome}
            </button>
          ))}
        </div>
      </div>

      {erro !== null && (
        <p className="mensagem-erro" role="alert">
          {erro} — mostrando o último resultado que chegou.
        </p>
      )}

      {visiveis.length === 0 ? (
        <Vazio
          titulo="Nenhuma academia aqui."
          descricao="Ajuste a busca ou o filtro. Se a rede está vazia, cadastre a primeira."
        />
      ) : (
        <div className="rede-grade">
          {visiveis.map((e) => (
            <CartaoDaRede
              key={e.id}
              e={e}
              aoAbrir={() => {
                const c = cadastroDe(e.id);
                if (c !== null) setAberta(c);
              }}
              aoEditar={() => {
                const c = cadastroDe(e.id);
                if (c !== null) setEditando(c);
              }}
            />
          ))}
        </div>
      )}

      {atualizadoEm !== null && (
        <p className="rede-carimbo" role="status" aria-live="polite">
          Atualizado às {HORA.format(atualizadoEm)}
        </p>
      )}

      {editando !== null && (
        <EditarEmpresa
          empresa={editando}
          aoFechar={() => setEditando(null)}
          aoSalvar={() => {
            setEditando(null);
            void carregar(true);
          }}
        />
      )}
    </>
  );
}

const HORA = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function ResumoDaRede({
  rotulo,
  valor,
  tom,
}: {
  rotulo: string;
  valor: number;
  tom?: 'viva' | 'parada';
}): ReactNode {
  return (
    <div className={`rede-resumo-item ${tom ?? ''}`}>
      <span className="rede-resumo-rotulo">{rotulo}</span>
      <strong className="rede-resumo-valor tabular">{valor}</strong>
    </div>
  );
}

/* --------------------------------------------------------------------
 * O cartão
 *
 * VERDE quando tem gente usando o sistema neste momento, VERMELHO quando
 * não tem. Suspensa é um terceiro estado e aparece como tal: dizer
 * "vermelho, ninguém online" de uma academia que está fora do ar seria
 * verdade e informação errada — o motivo de não ter ninguém é outro, e a
 * ação também.
 * ------------------------------------------------------------------ */

function CartaoDaRede({
  e,
  aoAbrir,
  aoEditar,
}: {
  e: plt.NaRede;
  aoAbrir: () => void;
  aoEditar: () => void;
}): ReactNode {
  const estado = !e.ativa ? 'suspensa' : e.onlineAgora > 0 ? 'viva' : 'parada';

  return (
    <article className={`rede-cartao ${estado}`}>
      <button
        type="button"
        className="rede-cartao-corpo"
        onClick={aoAbrir}
        aria-label={`Abrir ${e.nome}`}
      >
        <span className="rede-cartao-topo">
          <span className="rede-selo">
            {/* O PONTO PULSA SÓ QUANDO ESTÁ VIVO. Animação em todos os
                estados seria decoração; aqui ela é o próprio dado. */}
            <span className="rede-ponto" aria-hidden="true" />
            {estado === 'suspensa' ? 'Suspensa' : estado === 'viva' ? 'Com gente' : 'Sem ninguém'}
          </span>
          {e.plano !== null && <span className="rede-plano">{e.plano}</span>}
        </span>

        <span className="rede-nome">{e.nome}</span>
        <span className="rede-slug mono">
          {e.slug}
          {e.documento !== null && ` · ${e.documento}`}
        </span>

        <span className="rede-numeros">
          <Numero rotulo="Na tela" valor={e.onlineAgora} destaque={e.onlineAgora > 0} />
          <Numero rotulo="Alunos" valor={e.alunosAtivos} />
          <Numero rotulo="Equipe" valor={e.usuarios} />
          <Numero rotulo="Entradas hoje" valor={e.entradasHoje} />
        </span>

        <span className="rede-rodape">
          {estado === 'suspensa'
            ? e.suspensaMotivo ?? 'Fora do ar.'
            : e.onlineAgora > 0
              ? `${e.onlineAgora} pessoa${e.onlineAgora === 1 ? '' : 's'} usando o sistema`
              : `Última vez: ${desdeQuando(e.ultimaAtividade)}`}
        </span>
      </button>

      <div className="rede-acoes">
        <button type="button" className="botao-texto" onClick={aoAbrir}>
          Detalhes
        </button>
        <button type="button" className="botao-texto" onClick={aoEditar}>
          Editar
        </button>
      </div>
    </article>
  );
}

function Numero({
  rotulo,
  valor,
  destaque = false,
}: {
  rotulo: string;
  valor: number;
  destaque?: boolean;
}): ReactNode {
  return (
    <span className={`rede-numero ${destaque ? 'destaque' : ''}`}>
      <span className="rede-numero-valor tabular">{valor}</span>
      <span className="rede-numero-rotulo">{rotulo}</span>
    </span>
  );
}

/**
 * "Há 3 minutos", "ontem", "nunca".
 *
 * Data absoluta responde à pergunta errada. Quem olha um painel de rede
 * quer saber se a academia está viva, e "14/08 às 09:12" obriga a fazer
 * a conta de cabeça para descobrir isso.
 */
function desdeQuando(iso: string | null): string {
  if (iso === null) return 'nunca usou';
  const minutos = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutos < 1) return 'agora mesmo';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias === 1) return 'ontem';
  if (dias < 30) return `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? 'há um mês' : `há ${meses} meses`;
}

/* ====================================================================
 * Cadastro de academia
 * ================================================================== */

/** Sugere o identificador a partir do nome, sem impedir a edição. */
function sugerirSlug(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function NovaAcademia({
  aoSair,
  aoCriar,
}: {
  aoSair: () => void;
  aoCriar: () => void;
}): ReactNode {
  const [f, setF] = useState({
    nome: '',
    slug: '',
    slugTocado: false,
    documento: '',
    plano: '',
    contatoNome: '',
    contatoEmail: '',
    contatoWhatsapp: '',
    testeAte: '',
    donoNome: '',
    donoEmail: '',
  });
  const [erro, setErro] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<{ campo: string; problema: string }[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState<{ email: string; senha: string } | null>(null);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setDetalhes([]);
    setEnviando(true);
    try {
      const r = await plt.criarEmpresa({
        nome: f.nome.trim(),
        slug: (f.slugTocado ? f.slug : sugerirSlug(f.nome)).trim(),
        documento: f.documento.replace(/\D/g, '') || null,
        timezone: null,
        plano: f.plano.trim() || null,
        contatoNome: f.contatoNome.trim() || null,
        contatoEmail: f.contatoEmail.trim() || null,
        contatoWhatsapp: telefoneParaE164(f.contatoWhatsapp),
        testeAte: f.testeAte || null,
        donoNome: f.donoNome.trim(),
        donoEmail: f.donoEmail.trim(),
      });
      setPronto({ email: r.data.dono.email, senha: r.data.dono.senhaProvisoria });
    } catch (x) {
      if (x instanceof plt.ErroPlataforma) {
        setErro(x.message);
        setDetalhes(x.campos);
      } else {
        setErro('Não foi possível cadastrar.');
      }
    } finally {
      setEnviando(false);
    }
  };

  if (pronto !== null) {
    return (
      <>
        <div className="secao-cabecalho">
          <h1>Academia cadastrada</h1>
          <p>Ela já nasce com a biblioteca de exercícios pronta.</p>
        </div>
        <div className="plt-senha">
          <p className="plt-eyebrow">Acesso do responsável</p>
          <p className="plt-senha-linha">
            <span>E-mail</span>
            <strong className="mono">{pronto.email}</strong>
          </p>
          <p className="plt-senha-linha">
            <span>Senha provisória</span>
            <strong className="mono plt-destaque">{pronto.senha}</strong>
          </p>
          <p className="plt-aviso">
            Esta senha aparece <b>uma única vez</b> e não fica guardada em lugar nenhum. Copie
            agora e envie ao responsável — o sistema exige a troca no primeiro acesso.
          </p>
        </div>
        <div className="formulario-acoes campo-cheia">
          <button type="button" className="botao-acao" onClick={aoCriar}>
            Concluir
          </button>
        </div>
      </>
    );
  }

  const slugFinal = f.slugTocado ? f.slug : sugerirSlug(f.nome);

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Cancelar
      </button>
      <div className="secao-cabecalho">
        <h1>Cadastrar academia</h1>
        <p>O responsável recebe uma senha provisória e troca no primeiro acesso.</p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <h2 className="formulario-secao campo-cheia">A academia</h2>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Nome</span>
          <input
            value={f.nome}
            onChange={(e) => setF({ ...f, nome: e.target.value })}
            required
            autoFocus
          />
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Identificador</span>
          <input
            className="mono"
            value={slugFinal}
            onChange={(e) => setF({ ...f, slug: e.target.value, slugTocado: true })}
          />
          {/* Sugerido a partir do nome e editável. Não muda depois de
              criado: ele aparece em endereço, integração e auditoria, e
              trocá-lo quebra referência que ninguém lembra que existe. */}
          <span className="campo-dica">Só letras minúsculas, números e hífen. Não muda depois.</span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">CNPJ</span>
          <input
            inputMode="numeric"
            value={f.documento}
            onChange={(e) => setF({ ...f, documento: e.target.value })}
          />
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Plano</span>
          <input
            value={f.plano}
            onChange={(e) => setF({ ...f, plano: e.target.value })}
            placeholder="Essencial, Profissional…"
          />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Teste até</span>
          <input
            type="date"
            value={f.testeAte}
            onChange={(e) => setF({ ...f, testeAte: e.target.value })}
          />
          <span className="campo-dica">Deixe em branco se não houver prazo.</span>
        </label>

        <h2 className="formulario-secao campo-cheia">Contato comercial</h2>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Nome</span>
          <input
            value={f.contatoNome}
            onChange={(e) => setF({ ...f, contatoNome: e.target.value })}
          />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">E-mail</span>
          <input
            type="email"
            value={f.contatoEmail}
            onChange={(e) => setF({ ...f, contatoEmail: e.target.value })}
          />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">WhatsApp</span>
          <input
            inputMode="tel"
            placeholder="(51) 99999-9999"
            value={f.contatoWhatsapp}
            onChange={(e) => setF({ ...f, contatoWhatsapp: mascararTelefone(e.target.value) })}
          />
        </label>

        <h2 className="formulario-secao campo-cheia">Responsável pela academia</h2>
        <p className="plt-sub campo-cheia">
          Esta conta nasce como proprietária e enxerga tudo dentro da academia. Ela não tem acesso
          a este painel.
        </p>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Nome completo</span>
          <input
            value={f.donoNome}
            onChange={(e) => setF({ ...f, donoNome: e.target.value })}
            required
          />
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">E-mail de acesso</span>
          <input
            type="email"
            value={f.donoEmail}
            onChange={(e) => setF({ ...f, donoEmail: e.target.value })}
            required
          />
        </label>

        {erro !== null && (
          <div className="mensagem-erro campo-cheia" role="alert">
            <p>{erro}</p>
            {detalhes.length > 0 && (
              <ul className="lista-erros">
                {detalhes.map((d) => (
                  <li key={d.campo}>
                    <b>{d.campo}:</b> {d.problema}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="formulario-acoes campo-cheia">
          <button type="button" className="botao-secundario" onClick={aoSair}>
            Cancelar
          </button>
          <button type="submit" className="botao-acao" disabled={enviando}>
            {enviando ? 'Cadastrando…' : 'Cadastrar'}
          </button>
        </div>
      </form>
    </>
  );
}

/* ====================================================================
 * Janela de edição
 *
 * Uma janela e não uma página: quem edita está olhando para a lista de
 * usuários da academia e precisa continuar vendo onde estava. Trocar de
 * tela para mudar um e-mail faz perder o lugar, e voltar de uma tela de
 * edição sempre deixa a dúvida de se salvou.
 * ================================================================== */

function Janela({
  titulo,
  descricao,
  aoFechar,
  children,
}: {
  titulo: string;
  descricao?: string;
  aoFechar: () => void;
  children: ReactNode;
}): ReactNode {
  /* ESC FECHA. É o reflexo de quem usa teclado, e uma janela que só
     fecha no botão obriga a procurar o botão. */
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') aoFechar();
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [aoFechar]);

  return (
    <div className="plt-janela-fundo" onClick={aoFechar} role="presentation">
      <div
        className="plt-janela"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="plt-janela-topo">
          <div>
            <h2>{titulo}</h2>
            {descricao !== undefined && <p className="plt-sub">{descricao}</p>}
          </div>
          <button type="button" className="botao-texto" onClick={aoFechar}>
            Fechar
          </button>
        </div>
        <div className="plt-janela-corpo">{children}</div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------
 * Editar o cadastro da academia
 * ------------------------------------------------------------------ */

function EditarEmpresa({
  empresa,
  aoFechar,
  aoSalvar,
}: {
  empresa: plt.Empresa;
  aoFechar: () => void;
  aoSalvar: () => void;
}): ReactNode {
  const [f, setF] = useState({
    nome: empresa.nome,
    documento: empresa.documento ?? '',
    timezone: empresa.timezone,
    plano: empresa.plano ?? '',
    contatoNome: empresa.contatoNome ?? '',
    contatoEmail: empresa.contatoEmail ?? '',
    contatoWhatsapp: mascararTelefone(empresa.contatoWhatsapp ?? ''),
    observacoes: empresa.observacoes ?? '',
    testeAte: empresa.testeAte ?? '',
  });
  const [erro, setErro] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<{ campo: string; problema: string }[]>([]);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setDetalhes([]);
    setEnviando(true);
    try {
      await plt.salvarEmpresa(empresa.id, {
        nome: f.nome.trim(),
        documento: f.documento.replace(/\D/g, '') || null,
        timezone: f.timezone.trim() || null,
        plano: f.plano.trim() || null,
        contatoNome: f.contatoNome.trim() || null,
        contatoEmail: f.contatoEmail.trim() || null,
        contatoWhatsapp: telefoneParaE164(f.contatoWhatsapp),
        observacoes: f.observacoes.trim() || null,
        testeAte: f.testeAte || null,
      });
      aoSalvar();
    } catch (x) {
      if (x instanceof plt.ErroPlataforma) {
        setErro(x.message);
        setDetalhes(x.campos);
      } else {
        setErro('Não foi possível salvar.');
      }
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Janela
      titulo="Editar academia"
      descricao="Vale para cobrança e contato. O que a academia mostra nos relatórios dela é configurado lá dentro."
      aoFechar={aoFechar}
    >
      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Nome</span>
          <input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} required autoFocus />
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Identificador</span>
          <input className="mono" value={empresa.slug} readOnly disabled />
          {/* NÃO É EDITÁVEL, e o campo aparece assim mesmo: ele responde
              a pergunta "qual é o slug desta academia?", que é o que se
              digita para confirmar uma exclusão. Esconder o campo faria
              procurar. */}
          <span className="campo-dica">Não muda: aparece em endereço, integração e auditoria.</span>
        </label>

        <label className="campo campo-terco">
          <span className="campo-rotulo">CNPJ</span>
          <input
            inputMode="numeric"
            value={f.documento}
            onChange={(e) => setF({ ...f, documento: e.target.value })}
          />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Plano</span>
          <input
            value={f.plano}
            onChange={(e) => setF({ ...f, plano: e.target.value })}
            placeholder="Essencial, Profissional…"
          />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Teste até</span>
          <input type="date" value={f.testeAte} onChange={(e) => setF({ ...f, testeAte: e.target.value })} />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Fuso horário</span>
          <input
            className="mono"
            value={f.timezone}
            onChange={(e) => setF({ ...f, timezone: e.target.value })}
            placeholder="America/Sao_Paulo"
          />
          {/* O FUSO DECIDE QUE DIA É HOJE para esta academia: check-in,
              vencimento, agenda e relatório contam a partir dele. Errar
              aqui move a virada do dia da academia inteira. */}
          <span className="campo-dica">Decide o que é "hoje" para esta academia.</span>
        </label>

        <h2 className="formulario-secao campo-cheia">Contato comercial</h2>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Nome</span>
          <input value={f.contatoNome} onChange={(e) => setF({ ...f, contatoNome: e.target.value })} />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">E-mail</span>
          <input
            type="email"
            value={f.contatoEmail}
            onChange={(e) => setF({ ...f, contatoEmail: e.target.value })}
          />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">WhatsApp</span>
          <input
            inputMode="tel"
            placeholder="(51) 99999-9999"
            value={f.contatoWhatsapp}
            onChange={(e) => setF({ ...f, contatoWhatsapp: mascararTelefone(e.target.value) })}
          />
        </label>

        <label className="campo campo-cheia">
          <span className="campo-rotulo">Observações</span>
          <textarea
            rows={3}
            value={f.observacoes}
            onChange={(e) => setF({ ...f, observacoes: e.target.value })}
            placeholder="Combinado de preço, contato alternativo, o que ficou de fazer…"
          />
          <span className="campo-dica">Só você lê. A academia não enxerga este campo.</span>
        </label>

        {erro !== null && (
          <div className="mensagem-erro campo-cheia" role="alert">
            <p>{erro}</p>
            {detalhes.length > 0 && (
              <ul className="lista-erros">
                {detalhes.map((d) => (
                  <li key={d.campo}>
                    <b>{d.campo}:</b> {d.problema}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="formulario-acoes campo-cheia">
          <button type="button" className="botao-secundario" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" className="botao-acao" disabled={enviando}>
            {enviando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </Janela>
  );
}

/* --------------------------------------------------------------------
 * Editar o usuário
 * ------------------------------------------------------------------ */

function EditarUsuario({
  usuario,
  aoFechar,
  aoSalvar,
  aoRedefinir,
}: {
  usuario: plt.UsuarioDaEmpresa;
  aoFechar: () => void;
  aoSalvar: () => void;
  aoRedefinir: (u: plt.UsuarioDaEmpresa) => void;
}): ReactNode {
  const [nome, setNome] = useState(usuario.nome);
  const [email, setEmail] = useState(usuario.email);
  const [papel, setPapel] = useState<'OWNER' | 'ADMIN'>(
    usuario.papel === 'OWNER' ? 'OWNER' : 'ADMIN',
  );
  const [ativo, setAtivo] = useState(usuario.ativo);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const trocouEmail = email.trim().toLowerCase() !== usuario.email.toLowerCase();

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await plt.salvarUsuario(usuario.id, { nome: nome.trim(), email: email.trim(), papel });
      /* A situação é outra rota porque é outra decisão: uma desativa a
         conta, a outra corrige o cadastro. Salvar as duas juntas aqui é
         conveniência da tela, não mistura de conceito. */
      if (ativo !== usuario.ativo) await plt.definirUsuarioAtivo(usuario.id, ativo);
      aoSalvar();
    } catch (x) {
      setErro(x instanceof plt.ErroPlataforma ? x.message : 'Não foi possível salvar.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Janela titulo="Editar usuário" descricao={usuario.email} aoFechar={aoFechar}>
      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Nome completo</span>
          <input value={nome} onChange={(e) => setNome(e.target.value)} required autoFocus />
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">E-mail de acesso</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {trocouEmail && (
            /* Avisado ANTES de salvar, não depois: trocar o e-mail é
               trocar a identidade de login, e as sessões abertas caem.
               Quem não sabia disso descobriria pelo telefone do cliente. */
            <span className="campo-dica plt-atencao">
              Ao salvar, esta pessoa entra pelo e-mail novo e as sessões abertas dela caem. A senha
              continua a mesma.
            </span>
          )}
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Papel</span>
          <select value={papel} onChange={(e) => setPapel(e.target.value as 'OWNER' | 'ADMIN')}>
            <option value="ADMIN">Administrador</option>
            <option value="OWNER">Proprietário</option>
          </select>
          <span className="campo-dica">
            Os dois enxergam tudo dentro da academia. Nenhum dos dois enxerga este painel.
          </span>
        </label>

        <label className="campo campo-meia campo-caixa">
          <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
          <span>
            Conta ativa
            <span className="campo-dica">
              Desativada, ela não entra e as sessões abertas são encerradas. O histórico fica.
            </span>
          </span>
        </label>

        {erro !== null && (
          <p className="mensagem-erro campo-cheia" role="alert">
            {erro}
          </p>
        )}

        <div className="formulario-acoes campo-cheia">
          <button
            type="button"
            className="botao-texto"
            onClick={() => aoRedefinir(usuario)}
            disabled={enviando}
          >
            Gerar senha provisória
          </button>
          <span className="plt-espaco" />
          <button type="button" className="botao-secundario" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" className="botao-acao" disabled={enviando}>
            {enviando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </Janela>
  );
}

/* --------------------------------------------------------------------
 * Excluir a academia
 * ------------------------------------------------------------------ */

function ExcluirAcademia({
  empresa,
  aoFechar,
  aoExcluir,
}: {
  empresa: plt.Empresa;
  aoFechar: () => void;
  aoExcluir: () => void;
}): ReactNode {
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const bate = confirmacao.trim().toLowerCase() === empresa.slug;

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await plt.excluirEmpresa(empresa.id, confirmacao.trim().toLowerCase());
      aoExcluir();
    } catch (x) {
      setErro(x instanceof plt.ErroPlataforma ? x.message : 'Não foi possível excluir.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Janela titulo="Excluir academia" aoFechar={aoFechar}>
      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <div className="plt-perigo-aviso campo-cheia">
          <p>
            Isto apaga <strong>{empresa.nome}</strong> e tudo o que é dela: {empresa.alunos} aluno
            {empresa.alunos === 1 ? '' : 's'}, {empresa.usuarios} usuário
            {empresa.usuarios === 1 ? '' : 's'}, prontuário, anamnese, financeiro, treino e anexo.
          </p>
          {/* O QUE SE PERDE, EM VOZ ALTA. Um "tem certeza?" genérico é
              respondido no reflexo; a conta do que vai embora é lida. */}
          <p>
            <strong>Não há como desfazer.</strong> A única volta é o backup da noite anterior.
          </p>
        </div>

        {empresa.ativa && (
          <p className="mensagem-erro campo-cheia" role="alert">
            Esta academia ainda está no ar. Suspenda primeiro — suspender é reversível e tira o
            cliente do ar na hora. Se ninguém reclamar, volte aqui.
          </p>
        )}

        <label className="campo campo-cheia">
          <span className="campo-rotulo">
            Digite <span className="mono plt-destaque">{empresa.slug}</span> para confirmar
          </span>
          <input
            className="mono"
            value={confirmacao}
            onChange={(e) => setConfirmacao(e.target.value)}
            autoComplete="off"
            autoFocus
            disabled={empresa.ativa}
          />
        </label>

        {erro !== null && (
          <p className="mensagem-erro campo-cheia" role="alert">
            {erro}
          </p>
        )}

        <div className="formulario-acoes campo-cheia">
          <button type="button" className="botao-secundario" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" className="botao-perigo" disabled={enviando || !bate || empresa.ativa}>
            {enviando ? 'Excluindo…' : 'Excluir para sempre'}
          </button>
        </div>
      </form>
    </Janela>
  );
}

/* ====================================================================
 * Detalhe da academia
 * ================================================================== */

function DetalheAcademia({
  empresa,
  aoSair,
  aoMudar,
}: {
  empresa: plt.Empresa;
  aoSair: () => void;
  aoMudar: () => void;
}): ReactNode {
  const [usuarios, setUsuarios] = useState<plt.UsuarioDaEmpresa[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [senhaGerada, setSenhaGerada] = useState<{ email: string; senha: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [novoGestor, setNovoGestor] = useState(false);

  /* Uma janela de cada vez, num estado só: duas booleanas independentes
     deixam abrir "editar" por cima de "excluir". */
  type Janela = { tipo: 'empresa' } | { tipo: 'excluir' } | { tipo: 'usuario'; u: plt.UsuarioDaEmpresa };
  const [janela, setJanela] = useState<Janela | null>(null);

  const carregar = useCallback(async () => {
    try {
      setUsuarios((await plt.listarUsuarios(empresa.id)).data);
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível carregar.');
    }
  }, [empresa.id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const alternarSituacao = async (): Promise<void> => {
    const motivo = empresa.ativa
      ? window.prompt('Por que esta academia está sendo suspensa?')
      : null;
    /* Cancelar o prompt não pode suspender: `prompt` devolve `null` no
       cancelar e string vazia quando se confirma em branco, e os dois
       precisam abortar. */
    if (empresa.ativa && (motivo === null || motivo.trim() === '')) return;

    setOcupado(true);
    try {
      await plt.definirSituacao(empresa.id, !empresa.ativa, motivo);
      aoMudar();
      aoSair();
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível mudar a situação.');
    } finally {
      setOcupado(false);
    }
  };

  const entrarComo = async (u: plt.UsuarioDaEmpresa): Promise<void> => {
    if (
      !window.confirm(
        `Entrar no sistema como ${u.nome}?\n\nEste acesso fica registrado no histórico da academia, e o dono dela consegue ver.`,
      )
    ) {
      return;
    }
    setOcupado(true);
    try {
      const { data } = await plt.entrarComoUsuario(u.id);
      /* O token vai pela URL numa aba nova. É o único jeito de entregá-lo
         a outra página sem gravá-lo em localStorage — que é legível por
         qualquer script — e a aba de destino o consome e limpa o
         endereço imediatamente. Ele vale 15 minutos e não renova. */
      const destino = new URL('/', window.location.origin);
      destino.hash = `suporte=${encodeURIComponent(data.accessToken)}`;
      window.open(destino.toString(), '_blank', 'noopener');
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível entrar.');
    } finally {
      setOcupado(false);
    }
  };

  const redefinir = async (u: plt.UsuarioDaEmpresa): Promise<void> => {
    if (!window.confirm(`Gerar uma senha provisória para ${u.nome}?`)) return;
    setOcupado(true);
    try {
      const { data } = await plt.redefinirSenha(u.id);
      setJanela(null);
      setSenhaGerada({ email: u.email, senha: data.senhaProvisoria });
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível redefinir.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Todas as academias
      </button>

      <div className="secao-cabecalho plt-cabecalho-acao">
        <div>
          <h1>{empresa.nome}</h1>
          <p>
            <span className="mono">{empresa.slug}</span>
            {empresa.plano !== null && <> · {empresa.plano}</>}
            {' · '}
            {empresa.alunosAtivos} aluno{empresa.alunosAtivos === 1 ? '' : 's'} ativo
            {empresa.alunosAtivos === 1 ? '' : 's'}
          </p>
        </div>
        <div className="plt-acoes-topo">
          <button
            type="button"
            className="botao-secundario"
            onClick={() => setJanela({ tipo: 'empresa' })}
          >
            Editar academia
          </button>
          <button
            type="button"
            className={empresa.ativa ? 'botao-secundario' : 'botao-acao'}
            onClick={() => void alternarSituacao()}
            disabled={ocupado}
          >
            {empresa.ativa ? 'Suspender' : 'Reativar'}
          </button>
        </div>
      </div>

      {janela?.tipo === 'empresa' && (
        <EditarEmpresa
          empresa={empresa}
          aoFechar={() => setJanela(null)}
          aoSalvar={() => {
            setJanela(null);
            aoMudar();
          }}
        />
      )}
      {janela?.tipo === 'usuario' && (
        <EditarUsuario
          usuario={janela.u}
          aoFechar={() => setJanela(null)}
          aoRedefinir={(u) => void redefinir(u)}
          aoSalvar={() => {
            setJanela(null);
            void carregar();
            aoMudar();
          }}
        />
      )}
      {janela?.tipo === 'excluir' && (
        <ExcluirAcademia
          empresa={empresa}
          aoFechar={() => setJanela(null)}
          aoExcluir={() => {
            setJanela(null);
            aoMudar();
            aoSair();
          }}
        />
      )}

      {!empresa.ativa && (
        <div className="plt-suspensa" role="status">
          <strong>Suspensa</strong>
          {empresa.suspensaMotivo !== null && <> — {empresa.suspensaMotivo}</>}
          <span className="plt-secundario">
            {' '}
            Ninguém desta academia consegue entrar no sistema. Os dados continuam intactos.
          </span>
        </div>
      )}

      {erro !== null && (
        <p className="mensagem-erro" role="alert">
          {erro}
        </p>
      )}

      {senhaGerada !== null && (
        <div className="plt-senha">
          <p className="plt-eyebrow">Senha provisória gerada</p>
          <p className="plt-senha-linha">
            <span>{senhaGerada.email}</span>
            <strong className="mono plt-destaque">{senhaGerada.senha}</strong>
          </p>
          <p className="plt-aviso">
            Aparece uma única vez. As sessões abertas dessa pessoa foram encerradas, e ela precisa
            trocar a senha no primeiro acesso.
          </p>
          <button type="button" className="botao-secundario" onClick={() => setSenhaGerada(null)}>
            Entendi
          </button>
        </div>
      )}

      <div className="plt-cabecalho-acao">
        <h2 className="plt-titulo">Usuários</h2>
        <button type="button" className="botao-secundario" onClick={() => setNovoGestor(true)}>
          Novo gestor
        </button>
      </div>

      {novoGestor && (
        <NovoGestor
          empresaId={empresa.id}
          aoSair={() => setNovoGestor(false)}
          aoCriar={(email, senha) => {
            setNovoGestor(false);
            setSenhaGerada({ email, senha });
            void carregar();
            aoMudar();
          }}
        />
      )}

      {usuarios === null ? (
        <Carregando rotulo="Carregando usuários" />
      ) : (
        <div className="rolo">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Papel</th>
                <th scope="col">Último acesso</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.nome}</strong>
                    <span className="plt-slug mono">{u.email}</span>
                  </td>
                  <td>
                    <span className={`plt-pilula ${u.ativo ? 'neutra' : 'erro'}`}>
                      {rotuloPapel(u.papel)}
                      {!u.ativo && ' · inativo'}
                    </span>
                  </td>
                  <td className="tabular">{u.ultimoAcesso === null ? '—' : quando(u.ultimoAcesso)}</td>
                  <td className="plt-acoes">
                    <button
                      type="button"
                      className="botao-texto"
                      onClick={() => setJanela({ tipo: 'usuario', u })}
                      disabled={ocupado || (u.papel !== 'OWNER' && u.papel !== 'ADMIN')}
                      title={
                        u.papel !== 'OWNER' && u.papel !== 'ADMIN'
                          ? 'A plataforma administra só proprietário e administrador. Os demais são responsabilidade da academia.'
                          : undefined
                      }
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="botao-texto"
                      onClick={() => void entrarComo(u)}
                      disabled={ocupado || !u.ativo || !empresa.ativa}
                    >
                      Entrar como
                    </button>
                    <button
                      type="button"
                      className="botao-texto"
                      onClick={() => void redefinir(u)}
                      disabled={ocupado || (u.papel !== 'OWNER' && u.papel !== 'ADMIN')}
                      title={
                        u.papel !== 'OWNER' && u.papel !== 'ADMIN'
                          ? 'A plataforma redefine senha só de proprietário e administrador. Os demais são responsabilidade da academia.'
                          : undefined
                      }
                    >
                      Nova senha
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* NO FIM DA PÁGINA, e separado do resto. Excluir é a única ação
          do sistema que destrói dado de cliente; ela não pode dividir
          espaço com "Suspender" no alto, onde a mão vai por hábito. */}
      <div className="plt-perigo">
        <div>
          <h2 className="plt-titulo">Excluir academia</h2>
          <p className="plt-sub">
            Apaga a academia e tudo o que é dela. Não tem volta e exige que ela esteja suspensa
            antes.
          </p>
        </div>
        <button
          type="button"
          className="botao-perigo"
          onClick={() => setJanela({ tipo: 'excluir' })}
          disabled={ocupado}
        >
          Excluir
        </button>
      </div>
    </>
  );
}

function rotuloPapel(p: string): string {
  switch (p) {
    case 'OWNER':
      return 'proprietário';
    case 'ADMIN':
      return 'administrador';
    case 'PROFESSIONAL':
      return 'profissional';
    case 'RECEPTION':
      return 'recepção';
    case 'STUDENT':
      return 'aluno';
    default:
      return p.toLowerCase();
  }
}

function NovoGestor({
  empresaId,
  aoSair,
  aoCriar,
}: {
  empresaId: string;
  aoSair: () => void;
  aoCriar: (email: string, senha: string) => void;
}): ReactNode {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState<'OWNER' | 'ADMIN'>('ADMIN');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const { data } = await plt.criarGestor(empresaId, {
        nome: nome.trim(),
        email: email.trim(),
        papel,
      });
      aoCriar(email.trim(), data.senhaProvisoria);
    } catch (x) {
      setErro(x instanceof plt.ErroPlataforma ? x.message : 'Não foi possível criar.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form className="formulario plt-caixa" onSubmit={(e) => void enviar(e)} noValidate>
      <label className="campo campo-terco">
        <span className="campo-rotulo">Nome completo</span>
        <input value={nome} onChange={(e) => setNome(e.target.value)} required autoFocus />
      </label>
      <label className="campo campo-terco">
        <span className="campo-rotulo">E-mail</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="campo campo-terco">
        <span className="campo-rotulo">Papel</span>
        <select value={papel} onChange={(e) => setPapel(e.target.value as 'OWNER' | 'ADMIN')}>
          <option value="ADMIN">Administrador</option>
          <option value="OWNER">Proprietário</option>
        </select>
        <span className="campo-dica">Os dois enxergam tudo dentro da academia.</span>
      </label>

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
          {enviando ? 'Criando…' : 'Criar gestor'}
        </button>
      </div>
    </form>
  );
}

/* ====================================================================
 * WhatsApp
 * ================================================================== */

function Whatsapp(): ReactNode {
  const [c, setC] = useState<plt.ConfigWhatsapp | null>(null);
  const [url, setUrl] = useState('');
  const [tokenNovo, setTokenNovo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const { data } = await plt.lerConfig();
      setC(data);
      setUrl(data.uazapiBaseUrl ?? '');
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setSalvo(false);
    setEnviando(true);
    try {
      await plt.salvarConfig(url.trim() || null, tokenNovo.trim() || null);
      setTokenNovo('');
      setSalvo(true);
      await carregar();
    } catch (x) {
      setErro(x instanceof plt.ErroPlataforma ? x.message : 'Não foi possível salvar.');
    } finally {
      setEnviando(false);
    }
  };

  if (c === null) return <Carregando rotulo="Carregando a configuração" />;

  return (
    <>
      <div className="secao-cabecalho">
        <h1>WhatsApp</h1>
        <p>
          O endereço e o token administrativo ficam aqui, na plataforma. Cada academia só lê o QR
          Code e conecta o próprio número.
        </p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Endereço da uazapi</span>
          <input
            className="mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://free.uazapi.com"
          />
        </label>

        <label className="campo campo-cheia">
          <span className="campo-rotulo">Token administrativo</span>
          <input
            type="password"
            className="mono"
            value={tokenNovo}
            onChange={(e) => setTokenNovo(e.target.value)}
            placeholder={c.temToken ? '•••••••• (já configurado)' : 'cole o token aqui'}
            autoComplete="off"
          />
          <span className="campo-dica">
            {c.temToken
              ? 'Já existe um token salvo. Deixe em branco para mantê-lo; preencha só para trocar.'
              : 'Ainda não há token. Sem ele, nenhuma academia consegue conectar o WhatsApp.'}
          </span>
        </label>

        <p className="plt-aviso campo-cheia">
          O token é guardado <b>cifrado</b> e nunca volta para esta tela — nem para você. Ele fala
          em nome de todas as academias, e reexibi-lo espalharia por captura de tela e log de
          navegador um segredo que não deveria sair daqui.
          {c.atualizadoEm !== null && <> Última alteração em {quando(c.atualizadoEm)}.</>}
        </p>

        {erro !== null && (
          <p className="mensagem-erro campo-cheia" role="alert">
            {erro}
          </p>
        )}

        <div className="formulario-acoes campo-cheia">
          <span className="aviso-salvo" role="status" aria-live="polite">
            {salvo ? 'Configuração salva.' : ''}
          </span>
          <button type="submit" className="botao-acao" disabled={enviando}>
            {enviando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </>
  );
}

/* ====================================================================
 * Histórico
 * ================================================================== */

function Historico(): ReactNode {
  const [lista, setLista] = useState<plt.Movimento[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setLista((await plt.buscarHistorico(60)).data);
    } catch (e) {
      setErro(e instanceof plt.ErroPlataforma ? e.message : 'Não foi possível carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (erro !== null) return <Erro mensagem={erro} aoTentar={() => void carregar()} />;
  if (lista === null) return <Carregando rotulo="Carregando o histórico" />;

  return (
    <>
      <div className="secao-cabecalho">
        <h1>Histórico</h1>
        <p>Tudo o que foi feito por este painel, incluindo cada entrada em conta de usuário.</p>
      </div>

      {lista.length === 0 ? (
        <Vazio titulo="Nada ainda." descricao="As ações do painel aparecem aqui." />
      ) : (
        <div className="rolo">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Quem</th>
                <th scope="col">Ação</th>
                <th scope="col">Academia</th>
                <th scope="col">Alvo</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((m, i) => (
                <tr key={`${m.quando}-${i}`}>
                  <td className="tabular">{quando(m.quando)}</td>
                  <td>{m.quem}</td>
                  <td>
                    <span className={`plt-pilula ${m.acao.includes('entrou_como') ? 'atencao' : 'neutra'}`}>
                      {rotuloAcao(m.acao)}
                    </span>
                  </td>
                  <td>{m.empresa}</td>
                  <td className="mono">{m.alvo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function rotuloAcao(a: string): string {
  const mapa: Record<string, string> = {
    'plataforma.login': 'entrou no painel',
    'plataforma.senha_trocada': 'trocou a própria senha',
    'plataforma.empresa_criada': 'cadastrou academia',
    'plataforma.empresa_editada': 'editou academia',
    'plataforma.empresa_suspensa': 'suspendeu academia',
    'plataforma.empresa_reativada': 'reativou academia',
    'plataforma.gestor_criado': 'criou gestor',
    'plataforma.senha_redefinida': 'redefiniu senha',
    'plataforma.empresa_excluida': 'EXCLUIU academia',
    'plataforma.usuario_editado': 'editou usuário',
    'plataforma.usuario_ativado': 'ativou usuário',
    'plataforma.usuario_desativado': 'desativou usuário',
    'plataforma.entrou_como': 'entrou como usuário',
    'plataforma.config_salva': 'salvou configuração',
  };
  return mapa[a] ?? a;
}
