import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  trocarMinhaSenha,
  buscarAgenda,
  buscarAlunos,
  atualizarAluno,
  buscarFicha,
  buscarIndicadores,
  buscarPrincipal,
  buscarResumo,
  criarAluno,
  definirToken,
  entrar,
  restaurarSessao,
  sair,
  type Aluno,
  type Compromisso,
  type DadosAluno,
  type FichaAluno,
  type IndicadoresGestao,
  type Principal,
  type ResumoFinanceiro,
} from './api.js';
import { Carregando, Erro, GraficoLinha, Indicador, Vazio, reais, type Ponto } from './ui.jsx';
import { baixarRelatorio } from './api.js';
import { Marca } from './Marca.jsx';
import { AbaAnamnese, AbaAnexos, AbaEvolucao } from './Prontuario.jsx';
import { AbaTreino } from './Treino.jsx';
import { AbaMedidas } from './Medidas.jsx';
import { AbaCarteirinha } from './Carteirinha.jsx';
import { Whatsapp } from './Whatsapp.jsx';
import { Aplicativo } from './Aplicativo.jsx';
import { BotaoTema, useTema } from './tema.jsx';
import { Configuracoes } from './Configuracoes.jsx';
import { Academia } from './Academia.jsx';
import { Crm } from './Crm.jsx';
import { Financeiro } from './Financeiro.jsx';
import { Agenda } from './Agenda.jsx';
import { Equipe } from './Equipe.jsx';
import { Recepcao } from './Recepcao.jsx';
import { AbaTriagem } from './Triagem.jsx';
import {
  CadastroConcluido,
  SecaoDoPlano,
  gravarPlano,
  planoVazio,
  useEquipe,
  usePlanoExistente,
  type DadosDoPlano,
} from './PlanoDoAluno.jsx';
import {
  e164ParaMascara,
  mascararCep,
  mascararTelefone,
  telefoneParaE164,
} from '@stabilize/shared';
import { mesclarEndereco, useBuscaDeCep } from './endereco.js';

/**
 * Primeira letra maiúscula, o resto intocado.
 *
 * CSS `text-transform: capitalize` maiúscula TODA palavra e produz
 * "Agosto De 2026" — em português as preposições ficam minúsculas.
 * Erro pequeno que denuncia descuido logo no cabeçalho da tela.
 */
const capitalizar = (texto: string): string =>
  texto.charAt(0).toUpperCase() + texto.slice(1);

/**
 * Primeira letra do primeiro e do último nome.
 *
 * Ignora as partículas — "Ana Beatriz de Souza" vira AS, não AD. Uma
 * inicial "de" não identifica ninguém.
 */
function iniciais(nome: string): string {
  const partes = nome
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 2 || /^[A-ZÀ-Ý]/.test(p[0] ?? ''));
  const primeira = partes[0]?.[0] ?? '?';
  const ultima = partes.length > 1 ? partes[partes.length - 1]?.[0] : '';
  return (primeira + (ultima ?? '')).toUpperCase();
}

/* O mesmo vocabulário de tons do financeiro: a cor entra onde há
   decisão a tomar, e o resto fica neutro. */
const TOM_DO_ALUNO: Record<string, string> = {
  ACTIVE: 'ok',
  LEAD: 'atencao',
  SUSPENDED: 'erro',
  INACTIVE: 'neutra',
};

type Aba =
  | 'painel'
  | 'recepcao'
  | 'alunos'
  | 'agenda'
  | 'financeiro'
  | 'equipe'
  | 'whatsapp'
  | 'academia'
  | 'interessados'
  | 'perfil';

export default function App(): ReactNode {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [carregando, setCarregando] = useState(true);

  const [suporte, setSuporte] = useState(false);

  // Ao abrir a página, tenta restaurar a sessão pelo cookie de refresh.
  // Sem isto, recarregar a aba pediria a senha de novo — o access token
  // vive só em memória, de propósito.
  useEffect(() => {
    void (async () => {
      /* ACESSO DE SUPORTE. O painel da plataforma abre esta página numa
         aba nova com o token no FRAGMENTO da URL (`#suporte=…`).

         O fragmento, e não a query string: ele NÃO é enviado ao
         servidor, então não entra em log de acesso, em Referer nem em
         histórico de proxy. É o mesmo lugar onde o OAuth entrega token
         de fluxo implícito, e pelo mesmo motivo.

         Consumido e apagado do endereço imediatamente: sem isso o token
         fica no histórico do navegador e reaparece a cada recarga. */
      const marca = window.location.hash.match(/(?:^|[#&])suporte=([^&]+)/);
      if (marca?.[1] !== undefined) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
        definirToken(decodeURIComponent(marca[1]));
        try {
          setPrincipal(await buscarPrincipal());
          setSuporte(true);
          setCarregando(false);
          return;
        } catch {
          /* Token de suporte expirado (ele dura 15 minutos e não
             renova): segue para o caminho normal em vez de travar numa
             tela de erro. */
          definirToken(null);
        }
      }

      setPrincipal(await restaurarSessao());
      setCarregando(false);
    })();
  }, []);

  if (carregando) {
    return (
      <div className="tela-centro">
        <Marca altura={104} />
      </div>
    );
  }

  if (principal === null) {
    return <Login aoEntrar={setPrincipal} />;
  }

  /* SENHA PROVISÓRIA BARRA TUDO O MAIS.
     A senha inicial de um aluno é o CPF dele, e CPF não é segredo: se a
     troca fosse um lembrete que dá para adiar, meia academia poderia
     abrir o prontuário de qualquer aluno. A tela de troca vem ANTES da
     escolha entre sistema e aplicativo porque vale para os dois. */
  if (principal.mustChangePassword === true) {
    return <TrocaObrigatoria nome={principal.name} aoTrocar={() => setPrincipal(null)} />;
  }

  /* O ALUNO NÃO ENTRA NO SISTEMA — entra no aplicativo. São dois
     produtos, com posturas diferentes, sobre o mesmo login. Isto é
     conveniência de interface: quem chamar as rotas administrativas
     direto recebe 403 do servidor de qualquer forma. */
  if (principal.role === 'STUDENT') {
    return <Aplicativo nome={principal.name} aoSair={() => setPrincipal(null)} />;
  }

  return (
    <>
      {suporte && (
        /* A faixa existe para que ninguém esqueça em que conta está. Um
           operador com acesso de suporte enxerga exatamente o que o
           cliente enxerga — e é justamente por isso que precisa de um
           lembrete permanente na tela. */
        <div className="faixa-suporte" role="status">
          <span>
            Acesso de suporte como <strong>{principal.name}</strong> · registrado no histórico desta
            academia · a sessão expira em 15 minutos
          </span>
          {/* A SAÍDA FICA NA FAIXA, e não no menu de perfil. Quem entrou
              por aqui não é usuário desta academia: sair pelo "Sair" do
              menu encerraria a sessão de suporte e devolveria a tela de
              login da academia — que é a última coisa que o operador
              quer ver. Um `<a>` de verdade e não um botão: o painel abre
              noutra aba, e quem quiser a de sempre usa o clique do meio.
              O token de suporte vive só em memória; trocar de página o
              descarta sozinho. */}
          <a className="faixa-suporte-voltar" href="/plataforma">
            Voltar ao painel
          </a>
        </div>
      )}
      <Sistema principal={principal} aoSair={() => setPrincipal(null)} />
    </>
  );
}

/* ====================================================================
 * Entrada
 * ================================================================== */

function Login({ aoEntrar }: { aoEntrar: (p: Principal) => void }): ReactNode {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  /* A TELA DE ENTRADA É SEMPRE ESCURA, independente da preferência.

     É a única tela do sistema com identidade fixa: a marca do Stabilize
     é um traço claro sobre fundo escuro, e é assim que ela foi
     desenhada. No tema claro o símbolo perde contraste e a tela deixa
     de parecer a porta de entrada da Stabilize para parecer um
     formulário genérico.

     A preferência do usuário não é ignorada — é adiada. Ao sair desta
     tela o atributo volta ao que estava, e o `useTema` do sistema
     aplica a escolha de quem entrou. Quem trabalha no claro encontra o
     claro do outro lado do login. */
  useEffect(() => {
    const raiz = document.documentElement;
    const anterior = raiz.getAttribute('data-tema');
    raiz.setAttribute('data-tema', 'escuro');
    return () => {
      if (anterior === null) raiz.removeAttribute('data-tema');
      else raiz.setAttribute('data-tema', anterior);
    };
  }, []);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const quem = await entrar(email.trim(), senha);

      /* DONO DO SERVIÇO: o painel é outra aplicação, servida em
         `/plataforma`, com sessão e tema próprios. O servidor já gravou
         o cookie dele no login; ir para lá faz o painel se levantar
         sozinho. Não dá para montá-lo aqui dentro: ele não compartilha
         menu, cabeçalho nem estado com o sistema da academia. */
      if (quem.tipo === 'plataforma') {
        window.location.assign('/plataforma');
        return;
      }

      /* O `/me` logo depois do login, e não o `user` que o login
         devolve. São duas formas quase iguais do mesmo objeto, e a do
         login não traz o fuso da academia — que a agenda precisa para
         conferir horário do mesmo jeito que o servidor confere. Duas
         formas do mesmo dado é como uma delas fica para trás; esta
         chamada extra, uma vez por login, elimina a divergência. */
      aoEntrar(await buscarPrincipal());
    } catch (erroCapturado) {
      /* A mensagem vem do servidor e é deliberadamente igual para
         "e-mail não existe" e "senha errada" — distinguir permitiria
         descobrir quais e-mails têm conta. Não "melhoramos" aqui. */
      setErro(
        erroCapturado instanceof ApiError
          ? erroCapturado.message
          : 'Não foi possível entrar. Verifique sua conexão.',
      );
    } finally {
      setEnviando(false);
    }
  };

  return (
    <main className="entrada">
      {/* A aurora é decoração pura, então some para leitor de tela. São
          três camadas desfocadas que derivam lentamente — não um
          gradiente radial parado, que é o atalho que sempre parece
          adesivo colado no fundo. */}
      <div className="aurora" aria-hidden="true">
        <span className="aurora-faixa aurora-a" />
        <span className="aurora-faixa aurora-b" />
        <span className="aurora-faixa aurora-c" />
      </div>

      <div className="entrada-cartao">
        {/* Aqui havia o seletor de tema. Saiu junto com a decisão de
            fixar esta tela no escuro: um controle que não muda nada do
            que está à vista é pior do que controle nenhum. A escolha de
            aparência vive no cabeçalho do sistema, depois de entrar. */}
        <Marca altura={104} />

        <h1 className="entrada-titulo">Acesso ao sistema</h1>

        <form onSubmit={(e) => void enviar(e)} noValidate>
          {/* O rótulo existe para leitor de tela mesmo com o campo em
              pílula usando placeholder. Placeholder NÃO é rótulo: ele
              some quando a pessoa começa a digitar, e quem usa leitor de
              tela nunca o ouve como nome do campo. */}
          {/* `type="text"` e não `type="email"`: o ALUNO entra pelo
              CPF, e um campo de e-mail rejeitaria "12345678909" na
              validação do próprio navegador — antes de a requisição
              sair. O `inputMode` continua sugerindo o teclado de
              e-mail, que tem a arroba e os números à mão. */}
          <label className="campo-pilula">
            <span className="apenas-leitor-de-tela">E-mail ou CPF</span>
            <input
              type="text"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
              placeholder="E-mail ou CPF"
            />
          </label>

          <label className="campo-pilula">
            <span className="apenas-leitor-de-tela">Senha</span>
            <input
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="Senha"
            />
          </label>

          {erro !== null && (
            <p className="mensagem-erro" role="alert">
              {erro}
            </p>
          )}

          <button type="submit" className="botao-entrar" disabled={enviando}>
            {enviando ? 'entrando…' : 'entrar'}
          </button>
        </form>
      </div>

      {/* A assinatura também AQUI porque a lateral esconde o crédito no
          celular, onde o rodapé é uma fileira de uma linha só. Esta é a
          tela que todo mundo vê, em qualquer tamanho. */}
      <p className="entrada-credito">
        desenvolvido por{' '}
        <a href="https://conexaomkt.com.br" target="_blank" rel="noopener noreferrer">
          Grupo Conexão
        </a>
      </p>
    </main>
  );
}

/* ====================================================================
 * Sistema
 * ================================================================== */

function Sistema({
  principal,
  aoSair,
}: {
  principal: Principal;
  aoSair: () => void;
}): ReactNode {
  const [aba, setAba] = useState<Aba>('painel');
  const [configAberta, setConfigAberta] = useState(false);
  const { efetivo, definir } = useTema();

  /* O menu é montado a partir das permissões do papel. Isto é
     conveniência de interface, NÃO segurança: esconder um botão não
     protege rota nenhuma. A autorização real acontece no servidor, e
     quem chamar a rota direto recebe 403 de qualquer forma. */
  const pode = (p: string): boolean => principal.permissions.includes(p);

  /* O navegador avisa quando a rede cai e quando volta. É a mesma
     informação que o ponto verde do menu mostra — e ela precisa vir de
     um evento, não de uma requisição que falha: descobrir a queda pelo
     erro no meio de um cadastro é descobrir tarde demais. */
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const ligou = (): void => setOnline(true);
    const caiu = (): void => setOnline(false);
    window.addEventListener('online', ligou);
    window.addEventListener('offline', caiu);
    return () => {
      window.removeEventListener('online', ligou);
      window.removeEventListener('offline', caiu);
    };
  }, []);

  const abas: {
    id: Aba;
    nome: string;
    icone: ReactNode;
    visivel: boolean;
    /* O grupo em que o item aparece no menu. Sete itens numa lista
       corrida é uma lista; separados em operação e administração é um
       mapa — e quem procura "Equipe" sabe, sem ler, que está embaixo. */
    grupo: 'Operação' | 'Administração';
  }[] = [
    {
      id: 'painel',
      nome: 'Painel',
      icone: <IconePainel />,
      visivel: pode('finance:report:read') || pode('commission:read'),
      grupo: 'Operação',
    },
    /* A RECEPÇÃO VEM ANTES DE ALUNOS porque é a tela que fica aberta o
       dia inteiro. Quem opera o balcão não navega: chega de manhã, abre
       aqui e não sai mais — as outras seções são visitadas, esta é
       habitada. */
    {
      id: 'recepcao',
      nome: 'Recepção',
      icone: <IconeRecepcao />,
      visivel: pode('attendance:write'),
      grupo: 'Operação',
    },
    {
      id: 'alunos',
      nome: 'Alunos',
      icone: <IconeAlunos />,
      visivel: pode('student:read'),
      grupo: 'Operação',
    },
    {
      id: 'agenda',
      nome: 'Agenda',
      icone: <IconeAgenda />,
      visivel: pode('schedule:read'),
      grupo: 'Operação',
    },
    /* O PROFISSIONAL TAMBÉM VÊ ESTA ABA, e vê só a parte dele: o
       fechamento da própria comissão. Quem tem `finance:report:read` —
       dono e administrador — encontra o caixa inteiro; quem tem apenas
       `commission:read` cai direto no próprio acerto. É a mesma aba
       porque é a mesma pergunta ("quanto entrou e quanto é meu"), com
       respostas de tamanhos diferentes. */
    {
      id: 'financeiro',
      nome: 'Financeiro',
      icone: <IconeFinanceiro />,
      visivel: pode('finance:report:read') || pode('commission:read'),
      grupo: 'Operação',
    },
    /* A EQUIPE fica depois do financeiro e antes do WhatsApp: é
       administração da academia, não operação do dia. Quem não tem
       `user:read` não vê — recepção e profissional não administram
       quadro de pessoal. */
    {
      id: 'equipe',
      nome: 'Usuários',
      icone: <IconeEquipe />,
      visivel: pode('user:read'),
      grupo: 'Administração',
    },
    {
      id: 'whatsapp',
      nome: 'WhatsApp',
      icone: <IconeWhatsapp />,
      visivel: pode('user:write'),
      grupo: 'Administração',
    },
    /* SEMPRE VISÍVEL, e é a única assim. As outras seções dependem de
       permissão porque são dados da empresa; o perfil é a própria
       pessoa, e não existe papel que não possa editar o próprio nome. */
    {
      id: 'interessados',
      nome: 'Interessados',
      icone: <IconeInteressados />,
      visivel: pode('student:write'),
      grupo: 'Operação',
    },
    {
      id: 'academia',
      nome: 'A academia',
      icone: <IconeAcademia />,
      visivel: pode('user:write'),
      grupo: 'Administração',
    },
    /* SEMPRE VISÍVEL, e é a única assim. As outras seções dependem de
       permissão porque são dados da empresa; esta é a própria pessoa, e
       não existe papel que não possa trocar a própria senha.

       Abre a MESMA janela do crachá, e não uma tela. Duas portas para o
       mesmo lugar é conveniência; duas telas com o mesmo formulário é
       manutenção em dobro e a certeza de que uma delas envelhece. */
    { id: 'perfil', nome: 'Minha conta', icone: <IconePerfil />, visivel: true, grupo: 'Administração' },
  ];
  const visiveis = abas.filter((a) => a.visivel);

  return (
    <div className="sistema">
      <a href="#conteudo" className="pular-para-conteudo">
        Pular para o conteúdo
      </a>

      {/* MENU À ESQUERDA, e não em abas no topo.
          A diferença não é estética: abas no topo competem com o título
          da tela pelo mesmo eixo, e cada seção nova as espreme mais. Na
          coluna, o menu cresce para baixo — que é o lado onde sobra
          espaço — e o olho encontra sempre no mesmo lugar. */}
      <aside className="lateral">
        <div className="lateral-marca">
          <Marca variante="horizontal" altura={36} />
        </div>

        {/* QUEM VOCÊ É, no alto e não no rodapé.
            Num SaaS a mesma tela muda de conteúdo conforme o papel — o
            profissional vê a agenda de todos e edita só a sua, o
            administrador vê o caixa. Quem opera precisa saber com qual
            crachá está olhando ANTES de interpretar o que vê, e o
            rodapé é onde o olho chega por último. */}
        <div className="lateral-crachá">
          <span className="lateral-crachá-icone" aria-hidden="true">
            <IconePerfil />
          </span>
          <span className="lateral-crachá-texto">
            <span className="lateral-crachá-papel">{principal.roleLabel}</span>
            <span className="lateral-crachá-nome" title={principal.name}>
              {principal.name}
            </span>
          </span>
        </div>

        <nav className="lateral-nav" aria-label="Seções do sistema">
          {(['Operação', 'Administração'] as const).map((grupo) => {
            const doGrupo = visiveis.filter((a) => a.grupo === grupo);
            if (doGrupo.length === 0) return null;
            return (
              <Fragment key={grupo}>
                <h2 className="lateral-grupo">{grupo}</h2>
                {doGrupo.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`lateral-item ${aba === a.id ? 'ativa' : ''}`}
                    aria-current={aba === a.id ? 'page' : undefined}
                    onClick={() => (a.id === 'perfil' ? setConfigAberta(true) : setAba(a.id))}
                  >
                    <span className="lateral-icone" aria-hidden="true">
                      {a.icone}
                    </span>
                    <span className="lateral-nome">{a.nome}</span>
                  </button>
                ))}
              </Fragment>
            );
          })}
        </nav>

        <div className="lateral-rodape">
          {/* O PONTO VERDE É INFORMAÇÃO, não decoração: diz que a aba
              está falando com o servidor. Quando cai, a cor muda antes
              de qualquer requisição falhar, e quem está no balcão
              descobre pelo menu em vez de por um erro no meio de um
              cadastro. */}
          <span className={`lateral-estado ${online ? '' : 'offline'}`}>
            <span className="lateral-ponto" aria-hidden="true" />
            {online ? 'conectado' : 'sem conexão'}
          </span>
          <button type="button" className="lateral-sair" onClick={() => void sair().then(aoSair)}>
            Sair
          </button>
          {/* A ASSINATURA DE QUEM FEZ.
              Fica na lateral e não numa faixa própria: a lateral é o
              único elemento presente em TODAS as telas do sistema, e uma
              faixa no fim do conteúdo só apareceria depois de rolar.
              `rel="noopener noreferrer"`: sem isto a página aberta ganha
              referência ao `window` desta aba e pode trocá-la de
              endereço — é a regra para todo link que sai do sistema. */}
          <p className="lateral-credito">
            desenvolvido por{' '}
            <a href="https://conexaomkt.com.br" target="_blank" rel="noopener noreferrer">
              Grupo Conexão
            </a>
          </p>
        </div>
      </aside>

      <div className="painel-direito">
        {/* A BARRA DO TOPO é a mesma em todas as telas: onde você está,
            em que academia, e quem é você. Antes o único elemento fixo
            era o botão de tema flutuando no canto — o resto de cada
            tela recomeçava do zero. */}
        <header className="topo">
          <div className="topo-onde">
            <span className="topo-migalha">
              <span className={`lateral-ponto ${online ? '' : 'offline'}`} aria-hidden="true" />
              {principal.tenantNome ?? 'Academia'}
              <span className="topo-barra">/</span>
              {abas.find((a) => a.id === aba)?.nome ?? ''}
            </span>
          </div>

          <div className="topo-acoes">
            <BotaoTema efetivo={efetivo} definir={definir} />
            {/* O CRACHÁ É O BOTÃO. É para ele que a mão vai quando se
                quer mexer em si mesmo — trocar a senha, corrigir o
                telefone —, e ele estava ali parado, só informando. */}
            <button
              type="button"
              className="topo-quem"
              onClick={() => setConfigAberta(true)}
              title="Configurações da sua conta"
            >
              <span className="topo-quem-texto">
                <span className="topo-quem-nome">{principal.name}</span>
                <span className="topo-quem-papel">{principal.roleLabel}</span>
              </span>
              <span className="topo-quem-inicial" aria-hidden="true">
                {iniciais(principal.name)}
              </span>
            </button>
          </div>
        </header>

      <main id="conteudo" className="conteudo">
        <div className="folha">
        {aba === 'painel' && <Painel principal={principal} />}
        {aba === 'recepcao' && <Recepcao />}
        {aba === 'alunos' && <Alunos principal={principal} />}
        {aba === 'agenda' && <Agenda principal={principal} />}
        {aba === 'financeiro' && <Financeiro principal={principal} />}
        {aba === 'equipe' && <Equipe principal={principal} />}
        {aba === 'whatsapp' && <Whatsapp />}
        {aba === 'interessados' && <Crm podeConverter={pode('student:write')} />}
        {aba === 'academia' && <Academia />}
        </div>
      </main>
      </div>

      {configAberta && (
        <Configuracoes
          principal={principal}
          aoFechar={() => setConfigAberta(false)}
          /* Trocar a senha derruba todas as sessões, esta inclusive. A
             janela avisa e chama isto; sem o `aoSair`, a pessoa ficaria
             clicando numa tela que já não responde. */
          aoPerderSessao={aoSair}
        />
      )}
    </div>
  );
}

/* Ícones do menu. SVG inline, traço de 1,6 e `currentColor`: seguem a
   cor do item (apagada, acesa quando ativo) sem precisar de uma segunda
   versão do arquivo, e não custam uma requisição a mais. */
const svg = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconePainel(): ReactNode {
  return (
    <svg {...svg}>
      <path d="M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z" />
    </svg>
  );
}

/* Uma porta com alguém passando: é entrada, não "pessoas". O ícone de
   silhueta já é usado por Alunos e por Perfil — repeti-lo aqui faria o
   menu ter três itens com o mesmo desenho. */
function IconeRecepcao(): ReactNode {
  return (
    <svg {...svg}>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8" />
      <path d="M10 12h9m0 0-3-3m3 3-3 3" />
    </svg>
  );
}

function IconeAlunos(): ReactNode {
  return (
    <svg {...svg}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 6.2a3 3 0 0 1 0 5.6M17.5 20a5 5 0 0 0-2.2-4" />
    </svg>
  );
}

function IconeAgenda(): ReactNode {
  return (
    <svg {...svg}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

/* Duas barras e uma seta subindo: é dinheiro que entra ao longo do
   tempo, não um cifrão. O cifrão diz "moeda"; isto diz "movimento". */
function IconeFinanceiro(): ReactNode {
  return (
    <svg {...svg}>
      <path d="M4 20V10M10 20V4M16 20v-7" />
      <path d="M20 20V8m0 0h-3m3 0-5 5" />
    </svg>
  );
}

/* Duas pessoas, uma à frente da outra: é quadro de pessoal, e não o
   perfil de alguém — que já usa a silhueta única logo abaixo. */
function IconeEquipe(): ReactNode {
  return (
    <svg {...svg}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3.2 3.2 0 0 1 0 6.2M17 14.4a5.5 5.5 0 0 1 3.5 5.1" />
    </svg>
  );
}

function IconePerfil(): ReactNode {
  return (
    <svg {...svg}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

/* O prédio da academia — a casa, não a pessoa. É o par visual do
   IconePerfil, que fica logo abaixo no menu: um diz "a empresa", o
   outro diz "você". */
/* Um funil — a forma do CRM, e o que distingue esta seção de "Alunos":
   aqui entra muita gente e sai pouca, e a estreita é o ponto. */
function IconeInteressados(): ReactNode {
  return (
    <svg {...svg}>
      <path d="M4 5h16l-6 7v6l-4 2v-8z" />
    </svg>
  );
}

function IconeAcademia(): ReactNode {
  return (
    <svg {...svg}>
      <path d="M4 20V8.5L12 4l8 4.5V20" />
      <path d="M4 20h16" />
      <path d="M9.5 20v-5h5v5" />
    </svg>
  );
}

function IconeWhatsapp(): ReactNode {
  return (
    <svg {...svg}>
      <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.7-5.2A8.5 8.5 0 1 1 21 11.5z" />
    </svg>
  );
}

/* ====================================================================
 * Painel
 * ================================================================== */

function Painel({ principal }: { principal: Principal }): ReactNode {
  const [resumo, setResumo] = useState<ResumoFinanceiro | null>(null);
  const [historico, setHistorico] = useState<{ recebido: Ponto[]; pago: Ponto[] }>({
    recebido: [],
    pago: [],
  });
  const [gestao, setGestao] = useState<IndicadoresGestao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const podeVerCaixa = principal.permissions.includes('finance:report:read');

  const carregar = useCallback(async (): Promise<void> => {
    if (!podeVerCaixa) {
      setCarregando(false);
      return;
    }
    setCarregando(true);
    setErro(null);
    try {
      const hoje = new Date();
      const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);

      const [atual, indicadores] = await Promise.all([
        buscarResumo(inicioMes, fimMes),
        buscarIndicadores(),
      ]);
      setResumo(atual.data);
      setGestao(indicadores.data);

      // Seis meses de histórico, um pedido por mês. Em volume maior isto
      // viraria um endpoint de série; com seis, a simplicidade ganha.
      const meses: { recebido: Ponto[]; pago: Ponto[] } = { recebido: [], pago: [] };
      for (let i = 5; i >= 0; i -= 1) {
        const ini = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
        const fim = new Date(hoje.getFullYear(), hoje.getMonth() - i + 1, 0);
        const r = await buscarResumo(ini, fim);
        const rotulo = ini.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
        meses.recebido.push({ rotulo, valor: r.data.recebidoCentavos });
        meses.pago.push({ rotulo, valor: r.data.pagoCentavos });
      }
      setHistorico(meses);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o painel.');
    } finally {
      setCarregando(false);
    }
  }, [podeVerCaixa]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (!podeVerCaixa) {
    return (
      <Vazio
        titulo="Painel financeiro restrito"
        descricao="O caixa da empresa é visível apenas para a administração. Suas comissões aparecem na aba correspondente."
      />
    );
  }

  if (carregando) return <Carregando rotulo="Carregando o painel" />;
  if (erro !== null) return <Erro mensagem={erro} aoTentar={() => void carregar()} />;
  if (resumo === null) return <Vazio titulo="Sem dados" descricao="Nenhum movimento registrado." />;

  const saldoPositivo = resumo.saldoRealizadoCentavos >= 0;

  return (
    <>
      <div className="secao-cabecalho">
        <h1>Visão do mês</h1>
        <p>
          {capitalizar(
            new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
          )}
        </p>
      </div>

      {/* O MESMO ARRANJO DO FINANCEIRO: um número grande e quatro de
          apoio. Antes eram quatro indicadores do mesmo tamanho, cada um
          com sua cor — verde, verde, verde, âmbar —, e cor em todos é o
          mesmo que cor em nenhum: o olho aprende a ignorá-la e o único
          número que exigia ação passava despercebido no meio. */}
      <section className="fin-topo" aria-label="Indicadores do mês">
        <div className="fin-hero">
          <span className="fin-hero-rotulo">Saldo realizado</span>
          <strong className={`fin-hero-valor ${saldoPositivo ? '' : 'negativo'}`}>
            {reais(resumo.saldoRealizadoCentavos)}
          </strong>
          <span className="fin-hero-nota">
            <span className="fin-entrou">{reais(resumo.recebidoCentavos)} entrou</span>
            <span className="fin-sep" aria-hidden="true" />
            <span className="fin-saiu">{reais(resumo.pagoCentavos)} saiu</span>
          </span>
        </div>

        <div className="fin-kpis">
          <div className={`fin-kpi ${resumo.inadimplenteCentavos > 0 ? 'erro' : ''}`}>
            <span className="fin-kpi-rotulo">Em atraso</span>
            <strong className="fin-kpi-valor">{reais(resumo.inadimplenteCentavos)}</strong>
            <span className="fin-kpi-nota">
              {resumo.inadimplentesQtd === 1
                ? '1 cobrança vencida'
                : `${resumo.inadimplentesQtd} cobranças vencidas`}
            </span>
          </div>
          <div className="fin-kpi">
            <span className="fin-kpi-rotulo">Vence hoje</span>
            <strong className="fin-kpi-valor">{reais(resumo.venceHojeCentavos)}</strong>
            <span className="fin-kpi-nota">
              {resumo.venceHojeQtd === 0
                ? 'nada para hoje'
                : `${resumo.venceHojeQtd} cobrança${resumo.venceHojeQtd === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="fin-kpi">
            <span className="fin-kpi-rotulo">Previsto a receber</span>
            <strong className="fin-kpi-valor">{reais(resumo.aReceberCentavos)}</strong>
            <span className="fin-kpi-nota">{reais(resumo.recebidoCentavos)} já entrou</span>
          </div>
          <div className="fin-kpi">
            <span className="fin-kpi-rotulo">Previsto a pagar</span>
            <strong className="fin-kpi-valor">{reais(resumo.aPagarCentavos)}</strong>
            <span className="fin-kpi-nota">{reais(resumo.pagoCentavos)} já saiu</span>
          </div>
        </div>
      </section>

      <section className="bloco" aria-labelledby="titulo-fluxo">
        <h2 id="titulo-fluxo">Entradas e saídas</h2>
        <p className="bloco-apoio">
          Valores efetivamente movimentados nos últimos seis meses — não o previsto.
        </p>
        <GraficoLinha
          series={[
            /* Os nomes dos tokens são conferidos contra theme.css. Uma
               variável CSS inexistente não é erro: o navegador
               simplesmente não pinta, e a linha some sem aviso nenhum
               — foi o que aconteceu ao renomear os tokens para o tema
               escuro. */
            { nome: 'Recebido', cor: 'var(--teal-vivo)', pontos: historico.recebido },
            { nome: 'Pago', cor: 'var(--texto-apoio)', pontos: historico.pago },
          ]}
        />
      </section>

      {gestao !== null && <Gestao dados={gestao} />}
    </>
  );
}

/* ====================================================================
 * Indicadores de gestão
 *
 * Os números pelos quais uma academia é realmente administrada, e que
 * não aparecem no extrato. Ficam DEPOIS do caixa de propósito: o dono
 * abre o painel para saber quanto entrou; a leitura estratégica vem em
 * seguida, quando ele já se situou.
 * ================================================================== */

function Gestao({ dados }: { dados: IndicadoresGestao }): ReactNode {
  const churn = dados.churnPercentual;
  const tomChurn =
    churn === null ? 'neutro' : churn < 3 ? 'positivo' : churn <= 5 ? 'neutro' : churn <= 7 ? 'atencao' : 'negativo';

  return (
    <>
      <section className="bloco" aria-labelledby="titulo-gestao">
        <h2 id="titulo-gestao">Indicadores de gestão</h2>
        <p className="bloco-apoio">
          Evasão, valor por aluno e frequência — a leitura que o extrato não dá.
        </p>

        <div className="grade-indicadores">
          <div className="mini">
            <span className="mini-rotulo">Evasão no mês</span>
            <strong className={`mini-valor tabular tom-${tomChurn}`}>
              {churn === null ? '—' : `${churn.toString().replace('.', ',')}%`}
            </strong>
            {/* Sempre a base junto: "8%" sobre 12 alunos é ruído; sobre
                400 é emergência. Só a porcentagem esconde a diferença. */}
            <span className="mini-nota">
              {dados.saidasNoMes} de {dados.churnBase} alunos · {dados.leituraChurn}
            </span>
          </div>

          <div className="mini">
            <span className="mini-rotulo">Ticket médio</span>
            <strong className="mini-valor tabular">{dados.ticketMedioFormatado ?? '—'}</strong>
            <span className="mini-nota">
              {dados.ativos} ativos · {dados.novosNoMes} novos no mês
            </span>
          </div>

          <div className="mini">
            <span className="mini-rotulo">Tempo médio de permanência</span>
            <strong className="mini-valor tabular">
              {dados.tempoMedioVidaMeses === null
                ? '—'
                : `${dados.tempoMedioVidaMeses.toString().replace('.', ',')} meses`}
            </strong>
            <span className="mini-nota">
              Projeção de receita por aluno: {dados.ltvFormatado ?? '—'}
            </span>
          </div>

          <div className="mini">
            <span className="mini-rotulo">Comparecimento</span>
            <strong className="mini-valor tabular">
              {dados.taxaComparecimentoPercentual === null
                ? '—'
                : `${dados.taxaComparecimentoPercentual.toString().replace('.', ',')}%`}
            </strong>
            <span className="mini-nota">
              {dados.frequenciaMediaPorAluno ?? '—'} visitas por aluno no mês
            </span>
          </div>
        </div>
      </section>

      {/* O único indicador que aponta para uma PESSOA em vez de um
          número. Evasão é diagnóstico do que já aconteceu; isto aqui
          ainda dá para reverter com um telefonema. */}
      <section className="bloco" aria-labelledby="titulo-risco">
        <h2 id="titulo-risco">Alunos que pararam de vir</h2>
        <p className="bloco-apoio">
          Tinham frequência estabelecida e sumiram há mais de duas semanas. Quem já
          remarcou aparece sinalizado — marcar não é comparecer.
        </p>

        {dados.emRisco.length === 0 ? (
          <Vazio
            titulo="Ninguém sumido no momento"
            descricao="Todos os alunos com frequência estabelecida vieram nas últimas duas semanas."
          />
        ) : (
          <ol className="lista-risco">
            {dados.emRisco.slice(0, 8).map((a) => (
              <li key={a.id}>
                <div className="risco-corpo">
                  <span className="risco-nome">{a.nome}</span>
                  <span className="risco-detalhe">
                    {a.presencasAnteriores} presenças nos últimos 90 dias
                    {a.profissional !== null && ` · ${a.profissional}`}
                    {a.temHorarioMarcado && ' · já tem horário marcado'}
                  </span>
                </div>
                <span className="risco-dias tabular">
                  {a.diasSemVir} dias
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {dados.aniversariantes.length > 0 && (
        <section className="bloco" aria-labelledby="titulo-aniversario">
          <h2 id="titulo-aniversario">Aniversariantes do mês</h2>
          <p className="bloco-apoio">
            {dados.aniversariantes.length === 1
              ? '1 aluno faz aniversário este mês.'
              : `${dados.aniversariantes.length} alunos fazem aniversário este mês.`}
          </p>
          <ul className="lista-aniversario">
            {dados.aniversariantes.map((a) => (
              <li key={a.id}>
                <span className="aniversario-dia tabular">
                  {String(a.dia).padStart(2, '0')}/{String(a.mes).padStart(2, '0')}
                </span>
                <span>{a.nome}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/* ====================================================================
 * Alunos
 * ================================================================== */

const ROTULO_STATUS: Record<string, string> = {
  ACTIVE: 'Ativo',
  INACTIVE: 'Inativo',
  SUSPENDED: 'Suspenso',
  LEAD: 'Interessado',
};

const ROTULO_CICLO: Record<string, string> = {
  SESSION: 'Por sessão',
  WEEKLY: 'Semanal',
  BIWEEKLY: 'Quinzenal',
  MONTHLY: 'Mensal',
  QUARTERLY: 'Trimestral',
  SEMIANNUAL: 'Semestral',
  ANNUAL: 'Anual',
};

function Alunos({ principal }: { principal: Principal }): ReactNode {
  /* Três telas no mesmo lugar: lista, ficha e formulário. Sem
     roteador por enquanto — o custo de um seria maior que o ganho com
     três destinos, e trocar depois é local. */
  const [vendo, setVendo] = useState<
    | { tela: 'lista' }
    | { tela: 'ficha'; id: string }
    | { tela: 'novo' }
    | { tela: 'editar'; id: string }
    | { tela: 'concluido'; id: string; nome: string; aviso: string | null }
  >({ tela: 'lista' });
  const [lista, setLista] = useState<Aluno[]>([]);
  const [total, setTotal] = useState(0);
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (vendo.tela !== 'lista') return;
    let cancelado = false;
    // Espera o usuário parar de digitar: sem isso, cada tecla dispara
    // uma requisição e as respostas chegam fora de ordem.
    const t = setTimeout(() => {
      void (async () => {
        setCarregando(true);
        setErro(null);
        try {
          const r = await buscarAlunos(1, busca.trim() || undefined);
          if (cancelado) return;
          setLista(r.data);
          setTotal(r.pagination.total);
        } catch (e) {
          if (!cancelado) {
            setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os alunos.');
          }
        } finally {
          if (!cancelado) setCarregando(false);
        }
      })();
    }, 280);

    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [busca, vendo]);

  if (vendo.tela === 'ficha') {
    return <Ficha principal={principal} id={vendo.id} aoVoltar={() => setVendo({ tela: 'lista' })} aoEditar={() => setVendo({ tela: 'editar', id: vendo.id })} />;
  }
  if (vendo.tela === 'novo') {
    return (
      <FormularioAluno
        principal={principal}
        aoSair={() => setVendo({ tela: 'lista' })}
        /* Aluno NOVO cai no fecho do cadastro, não na ficha: o passo
           seguinte de quem acabou de cadastrar alguém é marcar o
           primeiro horário, e a ficha o mandaria procurar outra aba. */
        aoSalvar={(id, nome, aviso) => setVendo({ tela: 'concluido', id, nome, aviso })}
      />
    );
  }
  if (vendo.tela === 'concluido') {
    return (
      <CadastroConcluido
        alunoId={vendo.id}
        nome={vendo.nome}
        principal={principal}
        avisoDoPlano={vendo.aviso}
        aoAbrirFicha={() => setVendo({ tela: 'ficha', id: vendo.id })}
      />
    );
  }
  if (vendo.tela === 'editar') {
    return (
      <FormularioAluno
        id={vendo.id}
        principal={principal}
        aoSair={() => setVendo({ tela: 'ficha', id: vendo.id })}
        aoSalvar={(id) => setVendo({ tela: 'ficha', id })}
      />
    );
  }

  return (
    <>
      <div className="secao-cabecalho linha-cabecalho">
        <div>
          <h1>Alunos</h1>
          <p>{total === 1 ? '1 aluno' : `${total} alunos`} no seu acompanhamento</p>
        </div>
        <button type="button" className="botao-acao" onClick={() => setVendo({ tela: 'novo' })}>
          Cadastrar aluno
        </button>
      </div>

      <label className="campo-busca">
        <span className="apenas-leitor-de-tela">Buscar aluno por nome</span>
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome…"
        />
      </label>

      {erro !== null && <Erro mensagem={erro} />}
      {carregando && <Carregando rotulo="Carregando alunos" />}

      {!carregando && erro === null && lista.length === 0 && (
        <Vazio
          titulo={busca ? 'Nenhum aluno encontrado' : 'Nenhum aluno cadastrado'}
          descricao={
            busca
              ? 'Tente outro termo, ou verifique a grafia do nome.'
              : 'Os alunos vinculados a você aparecerão aqui.'
          }
        />
      )}

      {!carregando && lista.length > 0 && (
        <table className="tabela">
          <caption className="apenas-leitor-de-tela">Lista de alunos</caption>
          <thead>
            <tr>
              <th scope="col">Nome</th>
              <th scope="col">Contato</th>
              <th scope="col">Situação</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((a) => (
              <tr
                key={a.id}
                className="linha-clicavel"
                tabIndex={0}
                role="button"
                aria-label={`Abrir a ficha de ${a.nome}`}
                onClick={() => setVendo({ tela: 'ficha', id: a.id })}
                onKeyDown={(e) => {
                  /* Enter e espaço também abrem: uma linha clicável que
                     só responde ao mouse é inalcançável por teclado. */
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setVendo({ tela: 'ficha', id: a.id });
                  }
                }}
              >
                <td>
                  {/* AS INICIAIS, e não uma foto. A lista traz vinte e
                      cinco alunos e a foto de cada um seria uma
                      requisição por linha; a inicial é grátis, e é o
                      suficiente para o olho reencontrar um nome que já
                      viu no meio da lista. */}
                  <span className="aluno-linha">
                    <span className="aluno-inicial" aria-hidden="true">
                      {iniciais(a.nome)}
                    </span>
                    <span className="aluno-nome">
                      <span className="celula-forte">{a.nome}</span>
                      {a.email !== null && <span className="celula-apoio">{a.email}</span>}
                    </span>
                  </span>
                </td>
                <td className="tabular">{a.telefone ?? a.whatsapp ?? '—'}</td>
                <td>
                  <span className={`fin-selo ${TOM_DO_ALUNO[a.status] ?? 'neutra'}`}>
                    {ROTULO_STATUS[a.status] ?? a.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}


/* ====================================================================
 * Ficha do aluno
 *
 * O centro de gravidade do atendimento. Identidade e situação no topo,
 * o resto em blocos — dados, plano, frequência, financeiro. Quem está
 * no balcão abre aqui e resolve sem navegar.
 * ================================================================== */

function Ficha({
  principal,
  id,
  aoVoltar,
  aoEditar,
}: {
  principal: Principal;
  id: string;
  aoVoltar: () => void;
  aoEditar: () => void;
}): ReactNode {
  const [ficha, setFicha] = useState<FichaAluno | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [secao, setSecao] = useState<
    | 'cadastro'
    | 'carteirinha'
    | 'triagem'
    | 'anamnese'
    | 'evolucao'
    | 'medidas'
    | 'treino'
    | 'anexos'
  >('cadastro');

  const pode = (p: string): boolean => principal.permissions.includes(p);

  /* Recarregável, e não um efeito de mão única: a anamnese é gravada
     por um componente filho, e o resumo aqui em cima depende dela
     ("Sem anamnese", o aviso na aba). Sem esta releitura o profissional
     preenchia a anamnese e a tela continuava dizendo que faltava — o
     tipo de mentira que faz preencher de novo. */
  const recarregar = useCallback(
    async (comEsqueleto: boolean): Promise<void> => {
      if (comEsqueleto) setCarregando(true);
      setErro(null);
      try {
        const r = await buscarFicha(id);
        setFicha(r.data);
      } catch (e) {
        setErro(e instanceof ApiError ? e.message : 'Não foi possível abrir a ficha.');
      } finally {
        if (comEsqueleto) setCarregando(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void recarregar(true);
  }, [recarregar]);

  if (carregando) return <Carregando rotulo="Abrindo a ficha" />;
  if (erro !== null) {
    return (
      <>
        <button type="button" className="botao-voltar" onClick={aoVoltar}>
          ← Voltar para a lista
        </button>
        <Erro mensagem={erro} />
      </>
    );
  }
  if (ficha === null) return null;

  const f = ficha;
  const totalSessoes = f.frequencia.presencas + f.frequencia.faltas;
  const frequencia =
    totalSessoes === 0 ? null : Math.round((f.frequencia.presencas / totalSessoes) * 100);

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoVoltar}>
        ← Voltar para a lista
      </button>

      <header className="ficha-topo">
        <div>
          <h1>{f.nome}</h1>
          {/* O CÓDIGO INTERNO logo abaixo do nome. É por ele que a
              academia chama o aluno no balcão e na carteirinha, e até
              agora ele existia no banco sem aparecer em lugar nenhum. */}
          {f.codigo !== null && <p className="ficha-codigo">Aluno nº {f.codigo}</p>}
          <div className="ficha-selos">
            <span className={`fin-selo ${TOM_DO_ALUNO[f.status] ?? 'neutra'}`}>
              {ROTULO_STATUS[f.status] ?? f.status}
            </span>
            {f.contrato !== null && (
              <span className="selo selo-plano">{ROTULO_CICLO[f.contrato.ciclo] ?? f.contrato.ciclo}</span>
            )}
            {/* Pendência financeira aparece no TOPO, junto da identidade.
                Enterrada num bloco lá embaixo, o atendente atende o
                aluno inteiro sem nunca ver que há conta vencida. */}
            {f.financeiro.vencidasQtd > 0 && (
              <span className="selo selo-alerta">
                {f.financeiro.vencidasQtd === 1
                  ? '1 conta vencida'
                  : `${f.financeiro.vencidasQtd} contas vencidas`}
              </span>
            )}
          </div>
        </div>
        <div className="ficha-botoes">
          {/* O PDF da ficha respeita o mesmo escopo da tela — e o que
              entra nele depende do papel de quem pede, não de quem lê. */}
          <button
            type="button"
            className="botao-secundario"
            onClick={() =>
              void baixarRelatorio(`/api/relatorios/aluno/${f.id}`, `ficha-${f.nome}.pdf`)
            }
          >
            Ficha em PDF
          </button>
          {/* O PROGRESSO É OUTRO DOCUMENTO. A ficha é o cadastro de
              hoje; o progresso é a linha do tempo com os gráficos, e
              cabe a quem acompanha a evolução — por isso depende de
              `evolution:read` e não de `student:read`. */}
          {pode('evolution:read') && (
            <button
              type="button"
              className="botao-secundario"
              onClick={() =>
                void baixarRelatorio(
                  `/api/relatorios/progresso/${f.id}`,
                  `progresso-${f.nome}.pdf`,
                )
              }
            >
              Progresso em PDF
            </button>
          )}
          <button type="button" className="botao-acao" onClick={aoEditar}>
            Editar
          </button>
        </div>
      </header>

      <div className="ficha-resumo">
        <div className="mini">
          <span className="mini-rotulo">Frequência</span>
          <strong className="mini-valor tabular">
            {frequencia === null ? '—' : `${frequencia}%`}
          </strong>
          <span className="mini-nota">
            {f.frequencia.presencas} presenças · {f.frequencia.faltas} faltas
            {f.frequencia.agendados > 0 && ` · ${f.frequencia.agendados} agendados`}
          </span>
        </div>
        <div className="mini">
          <span className="mini-rotulo">Em aberto</span>
          <strong
            className={`mini-valor tabular ${f.financeiro.emAbertoCentavos > 0 ? 'tom-atencao' : ''}`}
          >
            {reais(f.financeiro.emAbertoCentavos)}
          </strong>
          <span className="mini-nota">Pago no ano: {reais(f.financeiro.pagoNoAnoCentavos)}</span>
        </div>
        <div className="mini">
          <span className="mini-rotulo">Plano</span>
          <strong className="mini-valor tabular">
            {f.contrato === null ? '—' : reais(f.contrato.valorCentavos)}
          </strong>
          <span className="mini-nota">
            {f.contrato === null
              ? 'Sem contrato ativo'
              : `${ROTULO_CICLO[f.contrato.ciclo] ?? f.contrato.ciclo}${
                  f.contrato.diaVencimento !== null ? ` · vence dia ${f.contrato.diaVencimento}` : ''
                }`}
          </span>
        </div>
        <div className="mini">
          <span className="mini-rotulo">Profissional</span>
          <strong className="mini-valor mini-valor-texto">
            {f.profissional?.nome ?? '—'}
          </strong>
          <span className="mini-nota">
            {f.temAnamnese ? 'Anamnese registrada' : 'Sem anamnese'}
          </span>
        </div>
      </div>

      {/* A ficha vira um prontuário quando ganha abas: quem atende
          precisa de identidade + situação SEMPRE visíveis (o topo e o
          resumo ficam), e alterna entre cadastro, anamnese e evolução
          embaixo. Empilhar tudo numa página só faria a anamnese começar
          depois de três telas de rolagem. */}
      <nav className="ficha-secoes" aria-label="Seções da ficha">
        {SECOES_FICHA.filter((s) => s.permissao === null || pode(s.permissao)).map((s) => (
          <button
            key={s.id}
            type="button"
            className={`ficha-secao ${secao === s.id ? 'ativa' : ''}`}
            aria-current={secao === s.id ? 'true' : undefined}
            onClick={() => setSecao(s.id)}
          >
            {s.nome}
            {s.id === 'anamnese' && !f.temAnamnese && (
              <span className="ficha-secao-pendente" title="Sem anamnese registrada">
                !
              </span>
            )}
          </button>
        ))}
      </nav>

      {secao === 'triagem' && (
        <AbaTriagem alunoId={f.id} nome={f.nome} podeConfigurar={pode('tenant:settings')} />
      )}
      {secao === 'anamnese' && (
        <AbaAnamnese
          alunoId={f.id}
          podeEscrever={pode('anamnesis:write')}
          /* Sem esqueleto: recarregar em silêncio evita a ficha piscar
             logo depois de salvar. */
          aoGravar={() => void recarregar(false)}
        />
      )}
      {secao === 'evolucao' && (
        <AbaEvolucao alunoId={f.id} podeEscrever={pode('evolution:write')} />
      )}
      {secao === 'carteirinha' && (
        <AbaCarteirinha
          ficha={f}
          podeEscrever={pode('student:write')}
          aoMudar={() => void recarregar(false)}
        />
      )}
      {secao === 'medidas' && (
        <AbaMedidas alunoId={f.id} podeEscrever={pode('evolution:write')} />
      )}
      {secao === 'treino' && (
        <AbaTreino alunoId={f.id} podeEscrever={pode('workout:write')} />
      )}
      {secao === 'anexos' && (
        <AbaAnexos
          alunoId={f.id}
          podeEnviar={pode('attachment:write')}
          podeExcluir={pode('attachment:delete')}
        />
      )}

      {secao === 'cadastro' && (
      <div className="ficha-blocos">
        <section className="ficha-bloco">
          <h2>Contato</h2>
          <Campo rotulo="E-mail" valor={f.email} />
          <Campo rotulo="Telefone" valor={f.telefone} />
          <Campo rotulo="WhatsApp" valor={f.whatsapp} />
          <Campo
            rotulo="Nascimento"
            valor={f.dataNascimento === null ? null : formatarData(f.dataNascimento)}
          />
          <Campo rotulo="Documento" valor={f.documento} />
        </section>

        <section className="ficha-bloco">
          <h2>Endereço</h2>
          <Campo
            rotulo="Logradouro"
            valor={
              f.endereco.logradouro === null
                ? null
                : `${f.endereco.logradouro}${f.endereco.numero !== null ? `, ${f.endereco.numero}` : ''}`
            }
          />
          <Campo rotulo="Complemento" valor={f.endereco.complemento} />
          <Campo rotulo="Bairro" valor={f.endereco.bairro} />
          <Campo
            rotulo="Cidade"
            valor={
              f.endereco.cidade === null
                ? null
                : `${f.endereco.cidade}${f.endereco.uf !== null ? ` / ${f.endereco.uf}` : ''}`
            }
          />
          <Campo rotulo="CEP" valor={f.endereco.cep} />
        </section>

        <section className="ficha-bloco">
          <h2>Emergência</h2>
          <Campo rotulo="Contato" valor={f.emergencia.contato} />
          <Campo rotulo="Telefone" valor={f.emergencia.telefone} />
          <h2 className="titulo-interno">Cadastro</h2>
          <Campo
            rotulo="Aluno desde"
            valor={f.inicioEm === null ? null : formatarData(f.inicioEm)}
          />
          {f.observacoes !== null && <Campo rotulo="Observações" valor={f.observacoes} />}
        </section>
      </div>
      )}
    </>
  );
}

/* A anamnese só aparece para quem pode lê-la. Isto é conveniência de
   interface, não segurança: as rotas exigem a permissão de qualquer
   forma, e quem chamar direto recebe 403. */
const SECOES_FICHA: {
  id:
    | 'cadastro'
    | 'carteirinha'
    | 'triagem'
    | 'anamnese'
    | 'evolucao'
    | 'medidas'
    | 'treino'
    | 'anexos';
  nome: string;
  permissao: string | null;
}[] = [
  { id: 'cadastro', nome: 'Cadastro', permissao: null },
  /* CARTEIRINHA logo depois do cadastro: foto, cartão e acesso ao
     aplicativo são a mesma conversa de quem acabou de cadastrar. */
  { id: 'carteirinha', nome: 'Carteirinha', permissao: null },
  /* TRIAGEM ANTES DE ANAMNESE porque vem antes no tempo: o PAR-Q é
     respondido pelo próprio aluno antes do primeiro treino; a anamnese é
     feita pelo profissional depois, com calma. Invertê-las na tela faria
     a ordem sugerir que a anamnese substitui a triagem — e ela não
     substitui: uma é registro clínico, a outra é declaração assinada. */
  { id: 'triagem', nome: 'Saúde e termo', permissao: 'anamnesis:read' },
  { id: 'anamnese', nome: 'Anamnese', permissao: 'anamnesis:read' },
  { id: 'evolucao', nome: 'Evolução', permissao: 'evolution:read' },
  /* MEDIDAS separada de EVOLUÇÃO, apesar de usarem a mesma permissão.
     São duas leituras diferentes do mesmo acompanhamento: evolução é
     texto no tempo, medida é número comparado. Juntá-las faria a tabela
     de circunferências aparecer no meio de anotações clínicas. */
  { id: 'medidas', nome: 'Medidas', permissao: 'evolution:read' },
  { id: 'treino', nome: 'Treino', permissao: 'workout:read' },
  { id: 'anexos', nome: 'Anexos', permissao: 'attachment:read' },
];

function Campo({ rotulo, valor }: { rotulo: string; valor: string | null }): ReactNode {
  return (
    <div className="campo-leitura">
      <span className="campo-leitura-rotulo">{rotulo}</span>
      {/* Traço, e não vazio: um campo em branco parece bug de carregamento
          e faz o atendente recarregar a página à toa. */}
      <span className="campo-leitura-valor">{valor === null || valor === '' ? '—' : valor}</span>
    </div>
  );
}

function formatarData(iso: string): string {
  const [ano, mes, dia] = iso.slice(0, 10).split('-');
  return `${dia}/${mes}/${ano}`;
}

/* ====================================================================
 * Formulário
 * ================================================================== */

interface CampoForm {
  nome: string;
  rotulo: string;
  tipo?: string;
  dica?: string;
  largura?: 'meia' | 'terco';
  /* Como o que se digita vira o que se vê. `undefined` é texto livre. */
  mascara?: 'telefone' | 'cep' | 'uf';
  maximo?: number;
  autoComplete?: string;
  modoTeclado?: 'tel' | 'numeric';
}

/**
 * O formulário em três blocos, e não numa lista corrida de dezoito
 * campos. Quinze linhas iguais uma atrás da outra não dão ao olho
 * nenhum lugar para descansar, e quem preenche perde o fio no meio.
 *
 * O CEP ABRE O BLOCO DE ENDEREÇO, e a posição é o recurso: preenchê-lo
 * traz rua, bairro, cidade e estado sozinho. Vindo depois do logradouro,
 * a pessoa digitaria à mão justamente o que o campo de cima ia
 * preencher — e a ordem, sozinha, ensina isso sem precisar de aviso.
 */
const SECOES: { titulo: string; campos: CampoForm[] }[] = [
  {
    titulo: 'Dados pessoais',
    campos: [
      { nome: 'nome', rotulo: 'Nome completo', autoComplete: 'name' },
      { nome: 'email', rotulo: 'E-mail', tipo: 'email', largura: 'meia', autoComplete: 'email' },
      {
        nome: 'telefone',
        rotulo: 'Telefone',
        largura: 'meia',
        mascara: 'telefone',
        modoTeclado: 'tel',
        autoComplete: 'tel',
      },
      {
        nome: 'whatsapp',
        rotulo: 'WhatsApp',
        dica: 'É por aqui que a academia manda os lembretes.',
        largura: 'meia',
        mascara: 'telefone',
        modoTeclado: 'tel',
      },
      { nome: 'dataNascimento', rotulo: 'Nascimento', tipo: 'date', largura: 'meia' },
      { nome: 'documento', rotulo: 'CPF', largura: 'meia', modoTeclado: 'numeric' },
    ],
  },
  {
    titulo: 'Endereço',
    campos: [
      {
        nome: 'cep',
        rotulo: 'CEP',
        largura: 'meia',
        mascara: 'cep',
        modoTeclado: 'numeric',
        autoComplete: 'postal-code',
      },
      { nome: 'logradouro', rotulo: 'Logradouro', largura: 'meia', autoComplete: 'address-line1' },
      { nome: 'numero', rotulo: 'Número', largura: 'terco' },
      { nome: 'complemento', rotulo: 'Complemento', largura: 'terco' },
      { nome: 'bairro', rotulo: 'Bairro', largura: 'terco' },
      { nome: 'cidade', rotulo: 'Cidade', largura: 'meia' },
      { nome: 'uf', rotulo: 'Estado', dica: 'Sigla, como RS', largura: 'meia', mascara: 'uf', maximo: 2 },
    ],
  },
  {
    titulo: 'Em caso de emergência',
    campos: [
      { nome: 'contatoEmergencia', rotulo: 'Quem avisar', largura: 'meia' },
      {
        nome: 'telefoneEmergencia',
        rotulo: 'Telefone',
        largura: 'meia',
        mascara: 'telefone',
        modoTeclado: 'tel',
      },
    ],
  },
];

/* Achatado para procurar o rótulo de um campo que o servidor recusou. */
const CAMPOS: CampoForm[] = SECOES.flatMap((s) => s.campos);

function aplicarMascara(campo: CampoForm, valor: string): string {
  switch (campo.mascara) {
    case 'telefone':
      return mascararTelefone(valor);
    case 'cep':
      return mascararCep(valor);
    case 'uf':
      return valor.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    default:
      return valor;
  }
}

/**
 * Desfaz as máscaras antes de enviar.
 *
 * A tela guarda `(51) 99266-8095` porque é isso que a pessoa lê. O
 * servidor exige `+5551992668095` no WhatsApp — é o formato do CHECK no
 * banco — e o CEP em dígitos, para que uma busca por CEP não dependa de
 * quem digitou ter posto o hífen.
 *
 * SEM ISTO O CADASTRO PARARIA DE SALVAR no momento em que a máscara
 * entrou: o campo passaria a mandar parênteses para uma validação que
 * espera `+55`, e a mensagem seria "Use o formato +5531999998888" num
 * campo onde ninguém digitou nada errado.
 */
function semMascara(dados: DadosAluno): DadosAluno {
  const saida: DadosAluno = { ...dados };
  if (dados.whatsapp !== undefined) saida.whatsapp = telefoneParaE164(dados.whatsapp) ?? '';
  if (dados.cep !== undefined) saida.cep = dados.cep.replace(/\D/g, '');
  return saida;
}

function FormularioAluno({
  id,
  principal,
  aoSair,
  aoSalvar,
}: {
  id?: string;
  principal: Principal;
  aoSair: () => void;
  aoSalvar: (id: string, nome: string, aviso: string | null) => void;
}): ReactNode {
  const [dados, setDados] = useState<DadosAluno>({});
  const [plano, setPlano] = useState<DadosDoPlano>(planoVazio);
  const equipe = useEquipe();
  const planoGravado = usePlanoExistente(id);
  /* Só quem administra define preço. O servidor exige `pricing:write`;
     aqui os campos ficam visíveis mas travados, para que a recepção
     saiba que o plano existe e a quem pedir. */
  const planoBloqueado = !principal.permissions.includes('pricing:write');

  useEffect(() => {
    if (planoGravado !== null) setPlano(planoGravado);
  }, [planoGravado]);
  const [erro, setErro] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<{ campo: string; problema: string }[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [carregando, setCarregando] = useState(id !== undefined);

  useEffect(() => {
    if (id === undefined) return;
    void (async () => {
      try {
        const { data: f } = await buscarFicha(id);
        setDados({
          nome: f.nome,
          email: f.email ?? '',
          /* O banco guarda o dado; a tela mostra a máscara. Sem esta
             tradução, editar um aluno já cadastrado exibiria
             "+5551992668095" num campo que promete "(51) 99999-9999". */
          telefone: e164ParaMascara(f.telefone),
          whatsapp: e164ParaMascara(f.whatsapp),
          dataNascimento: f.dataNascimento ?? '',
          documento: f.documento ?? '',
          status: f.status,
          observacoes: f.observacoes ?? '',
          cep: mascararCep(f.endereco.cep ?? ''),
          logradouro: f.endereco.logradouro ?? '',
          numero: f.endereco.numero ?? '',
          complemento: f.endereco.complemento ?? '',
          bairro: f.endereco.bairro ?? '',
          cidade: f.endereco.cidade ?? '',
          uf: f.endereco.uf ?? '',
          contatoEmergencia: f.emergencia.contato ?? '',
          telefoneEmergencia: e164ParaMascara(f.emergencia.telefone),
        });
      } catch (e) {
        setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o cadastro.');
      } finally {
        setCarregando(false);
      }
    })();
  }, [id]);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setDetalhes([]);
    setEnviando(true);
    try {
      const paraEnviar = semMascara(dados);
      const nome = (dados['nome'] ?? '').trim();

      /* O PLANO É GRAVADO DEPOIS, e a falha dele não derruba o cadastro.
         Aluno sem plano é cadastro legítimo — alguém que veio conhecer e
         ainda não fechou. Perder dezoito campos preenchidos porque o
         valor saiu com vírgula errada seria trocar um problema pequeno
         por um grande. A tela seguinte diz o que faltou. */
      const salvarPlano = async (alunoId: string): Promise<string | null> => {
        if (planoBloqueado) return null;
        try {
          await gravarPlano(alunoId, plano);
          return null;
        } catch (x) {
          return x instanceof ApiError ? x.message : 'O valor não foi aceito.';
        }
      };

      if (id === undefined) {
        const r = await criarAluno(paraEnviar);
        aoSalvar(r.data.id, nome, await salvarPlano(r.data.id));
      } else {
        await atualizarAluno(id, paraEnviar);
        const aviso = await salvarPlano(id);
        if (aviso !== null) {
          setErro(`O cadastro foi salvo, mas o plano não: ${aviso}`);
          return;
        }
        aoSalvar(id, nome, null);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setErro(e.message);
        /* O servidor devolve qual campo falhou e por quê. Mostrar isso
           é a diferença entre "dados inválidos" — que obriga a caçar o
           erro entre dezoito campos — e "WhatsApp: use o formato
           +5531999998888". */
        setDetalhes(e.campos);
      } else {
        setErro('Não foi possível salvar. Verifique sua conexão.');
      }
    } finally {
      setEnviando(false);
    }
  };

  /* Assim que o CEP fica completo, o endereço chega sozinho — e só
     preenche o que está em branco, para não apagar a rua que alguém
     corrigiu à mão. Ver `useBuscaDeCep`. */
  const {
    buscando: buscandoCep,
    naoEncontrado: cepNaoEncontrado,
    indisponivel: cepIndisponivel,
  } = useBuscaDeCep(
    dados['cep'] ?? '',
    (achado) => {
      setDados((d) =>
        mesclarEndereco(d, achado, {
          logradouro: 'logradouro',
          bairro: 'bairro',
          cidade: 'cidade',
          uf: 'uf',
        }),
      );
    },
  );

  if (carregando) return <Carregando rotulo="Carregando o cadastro" />;

  const mudar = (campo: string, valor: string): void =>
    setDados((d) => ({ ...d, [campo]: valor }));

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Cancelar
      </button>

      <div className="secao-cabecalho">
        <h1>{id === undefined ? 'Cadastrar aluno' : 'Editar cadastro'}</h1>
        <p>Apenas o nome é obrigatório. O resto pode ser completado depois.</p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        {SECOES.map((secao) => (
          <Fragment key={secao.titulo}>
            <h2 className="formulario-secao campo-cheia">{secao.titulo}</h2>
            {secao.campos.map((c) => (
              <label key={c.nome} className={`campo campo-${c.largura ?? 'cheia'}`}>
                <span className="campo-rotulo">{c.rotulo}</span>
                <input
                  type={c.tipo ?? 'text'}
                  value={dados[c.nome] ?? ''}
                  onChange={(e) => mudar(c.nome, aplicarMascara(c, e.target.value))}
                  required={c.nome === 'nome'}
                  autoFocus={c.nome === 'nome'}
                  {...(c.maximo !== undefined ? { maxLength: c.maximo } : {})}
                  {...(c.modoTeclado !== undefined ? { inputMode: c.modoTeclado } : {})}
                  {...(c.autoComplete !== undefined ? { autoComplete: c.autoComplete } : {})}
                  {...(c.mascara === 'telefone' ? { placeholder: '(51) 99999-9999' } : {})}
                  {...(c.mascara === 'cep' ? { placeholder: '99999-999' } : {})}
                />
                {c.nome === 'cep' ? (
                  /* O estado da busca ocupa o lugar da dica, em vez de
                     abrir uma linha nova: um campo que cresce e encolhe
                     empurra o formulário inteiro a cada tecla. */
                  <span className="campo-dica" aria-live="polite">
                    {buscandoCep
                      ? 'Buscando o endereço…'
                      : cepNaoEncontrado
                        ? 'CEP não encontrado. Preencha o endereço abaixo.'
                        : cepIndisponivel
                          ? 'Não consegui consultar o CEP agora. Preencha o endereço à mão.'
                          : 'Preencha o CEP e o endereço vem sozinho.'}
                  </span>
                ) : (
                  c.dica !== undefined && <span className="campo-dica">{c.dica}</span>
                )}
              </label>
            ))}
          </Fragment>
        ))}

        <SecaoDoPlano
          plano={plano}
          aoMudar={setPlano}
          equipe={equipe}
          bloqueado={planoBloqueado}
        />

        <h2 className="formulario-secao campo-cheia">Situação e observações</h2>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Situação</span>
          <select value={dados['status'] ?? 'ACTIVE'} onChange={(e) => mudar('status', e.target.value)}>
            <option value="ACTIVE">Ativo</option>
            <option value="LEAD">Interessado</option>
            <option value="SUSPENDED">Suspenso</option>
            <option value="INACTIVE">Inativo</option>
          </select>
        </label>

        <label className="campo campo-cheia">
          <span className="campo-rotulo">Observações</span>
          <textarea
            rows={3}
            value={dados['observacoes'] ?? ''}
            onChange={(e) => mudar('observacoes', e.target.value)}
          />
        </label>

        {erro !== null && (
          <div className="mensagem-erro campo-cheia" role="alert">
            <p>{erro}</p>
            {detalhes.length > 0 && (
              <ul className="lista-erros">
                {detalhes.map((d) => (
                  <li key={d.campo}>
                    <b>{CAMPOS.find((c) => c.nome === d.campo)?.rotulo ?? d.campo}:</b>{' '}
                    {d.problema}
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
            {enviando ? 'Salvando…' : id === undefined ? 'Cadastrar' : 'Salvar alterações'}
          </button>
        </div>
      </form>
    </>
  );
}

/* ====================================================================
 * Troca obrigatória de senha
 * ================================================================== */

/**
 * A tela que aparece quando a senha ainda é a provisória.
 *
 * NÃO TEM COMO SAIR DELA a não ser trocando ou saindo do sistema. É de
 * propósito: a senha inicial de um aluno é o próprio CPF, e a de um
 * funcionário novo foi ditada por telefone — as duas são conhecidas por
 * gente demais para valerem uma segunda sessão.
 *
 * Ao trocar, o servidor derruba todas as sessões, inclusive esta. Então
 * a tela avisa e devolve ao login em vez de fingir que continua
 * autenticada e falhar na próxima requisição.
 */
function TrocaObrigatoria({
  nome,
  aoTrocar,
}: {
  nome: string;
  aoTrocar: () => void;
}): ReactNode {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [pronto, setPronto] = useState(false);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    const raiz = document.documentElement;
    const anterior = raiz.getAttribute('data-tema');
    raiz.setAttribute('data-tema', 'escuro');
    return () => {
      if (anterior === null) raiz.removeAttribute('data-tema');
      else raiz.setAttribute('data-tema', anterior);
    };
  }, []);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (nova !== confirma) {
      setErro('As duas senhas novas precisam ser iguais.');
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      await trocarMinhaSenha(atual, nova);
      setPronto(true);
      /* Um respiro antes de voltar ao login: sem ele a tela pisca e a
         pessoa não entende se deu certo. */
      setTimeout(aoTrocar, 1800);
    } catch (x) {
      setErro(x instanceof ApiError ? x.message : 'Não foi possível trocar a senha.');
      setEnviando(false);
    }
  };

  return (
    <main className="entrada">
      <div className="aurora" aria-hidden="true">
        <span className="aurora-faixa aurora-a" />
        <span className="aurora-faixa aurora-b" />
        <span className="aurora-faixa aurora-c" />
      </div>

      <div className="entrada-cartao">
        <Marca altura={88} />

        {pronto ? (
          <p className="troca-pronto" role="status">
            <strong>Senha trocada.</strong> Entre de novo com a senha nova.
          </p>
        ) : (
          <form className="entrada-form" onSubmit={(e) => void enviar(e)} noValidate>
            <h1>Crie sua senha, {nome.split(' ')[0]}</h1>
            <p className="entrada-apoio">
              Você entrou com uma senha provisória. Escolha uma senha só sua antes de continuar.
            </p>

            <label className="campo">
              <span className="campo-rotulo">Senha provisória</span>
              <input
                type="password"
                value={atual}
                onChange={(e) => setAtual(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
              />
            </label>
            <label className="campo">
              <span className="campo-rotulo">Senha nova</span>
              <input
                type="password"
                value={nova}
                onChange={(e) => setNova(e.target.value)}
                required
                autoComplete="new-password"
              />
              {/* A regra do servidor é COMPRIMENTO, não "um maiúsculo e
                  um símbolo" — e dizer a regra certa evita a pessoa
                  inventar uma senha que vai ser recusada. */}
              <span className="campo-dica">Pelo menos 10 caracteres. Uma frase curta serve.</span>
            </label>
            <label className="campo">
              <span className="campo-rotulo">Repita a senha nova</span>
              <input
                type="password"
                value={confirma}
                onChange={(e) => setConfirma(e.target.value)}
                required
                autoComplete="new-password"
              />
            </label>

            {erro !== null && (
              <p className="mensagem-erro" role="alert">
                {erro}
              </p>
            )}

            <button type="submit" className="botao-acao" disabled={enviando}>
              {enviando ? 'Trocando…' : 'Trocar e entrar'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
