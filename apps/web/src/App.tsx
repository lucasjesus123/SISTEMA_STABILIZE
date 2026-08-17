import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  buscarAgenda,
  buscarAlunos,
  atualizarAluno,
  buscarFicha,
  buscarIndicadores,
  buscarResumo,
  criarAluno,
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
import { Whatsapp } from './Whatsapp.jsx';
import { Aplicativo } from './Aplicativo.jsx';
import { SeletorTema, useTema } from './tema.jsx';

/**
 * Primeira letra maiúscula, o resto intocado.
 *
 * CSS `text-transform: capitalize` maiúscula TODA palavra e produz
 * "Agosto De 2026" — em português as preposições ficam minúsculas.
 * Erro pequeno que denuncia descuido logo no cabeçalho da tela.
 */
const capitalizar = (texto: string): string =>
  texto.charAt(0).toUpperCase() + texto.slice(1);

type Aba = 'painel' | 'alunos' | 'agenda' | 'whatsapp';

export default function App(): ReactNode {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [carregando, setCarregando] = useState(true);

  // Ao abrir a página, tenta restaurar a sessão pelo cookie de refresh.
  // Sem isto, recarregar a aba pediria a senha de novo — o access token
  // vive só em memória, de propósito.
  useEffect(() => {
    void (async () => {
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

  /* O ALUNO NÃO ENTRA NO SISTEMA — entra no aplicativo. São dois
     produtos, com posturas diferentes, sobre o mesmo login. Isto é
     conveniência de interface: quem chamar as rotas administrativas
     direto recebe 403 do servidor de qualquer forma. */
  if (principal.role === 'STUDENT') {
    return <Aplicativo nome={principal.name} aoSair={() => setPrincipal(null)} />;
  }

  return <Sistema principal={principal} aoSair={() => setPrincipal(null)} />;
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
      const r = await entrar(email.trim(), senha);
      aoEntrar(r.user);
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
          <label className="campo-pilula">
            <span className="apenas-leitor-de-tela">E-mail</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
              placeholder="E-mail"
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
  const { tema, definir } = useTema();

  /* O menu é montado a partir das permissões do papel. Isto é
     conveniência de interface, NÃO segurança: esconder um botão não
     protege rota nenhuma. A autorização real acontece no servidor, e
     quem chamar a rota direto recebe 403 de qualquer forma. */
  const pode = (p: string): boolean => principal.permissions.includes(p);

  const abas: { id: Aba; nome: string; visivel: boolean }[] = [
    { id: 'painel', nome: 'Painel', visivel: pode('finance:report:read') || pode('commission:read') },
    { id: 'alunos', nome: 'Alunos', visivel: pode('student:read') },
    { id: 'agenda', nome: 'Agenda', visivel: pode('schedule:read') },
    { id: 'whatsapp', nome: 'WhatsApp', visivel: pode('user:write') },
  ];
  const visiveis = abas.filter((a) => a.visivel);

  return (
    <div className="sistema">
      <a href="#conteudo" className="pular-para-conteudo">
        Pular para o conteúdo
      </a>

      <header className="topo">
        <Marca variante="horizontal" altura={42} />

        <nav className="navegacao" aria-label="Seções do sistema">
          {visiveis.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`aba ${aba === a.id ? 'ativa' : ''}`}
              aria-current={aba === a.id ? 'page' : undefined}
              onClick={() => setAba(a.id)}
            >
              {a.nome}
            </button>
          ))}
        </nav>

        <div className="topo-conta">
          <SeletorTema tema={tema} definir={definir} />
          <span className="conta-papel">{principal.roleLabel}</span>
          <button
            type="button"
            className="botao-texto"
            onClick={() => void sair().then(aoSair)}
          >
            Sair
          </button>
        </div>
      </header>

      <main id="conteudo" className="conteudo">
        {aba === 'painel' && <Painel principal={principal} />}
        {aba === 'alunos' && <Alunos principal={principal} />}
        {aba === 'agenda' && <Agenda />}
        {aba === 'whatsapp' && <Whatsapp />}
      </main>
    </div>
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

      {/* Fileira de indicadores separada por fios, não por cards. Card
          para cada número criaria caixa dentro de caixa e roubaria a
          atenção do dado, que é o que importa aqui. */}
      <section className="indicadores" aria-label="Indicadores do mês">
        <Indicador
          rotulo="Recebido"
          valorCentavos={resumo.recebidoCentavos}
          detalhe={`de ${reais(resumo.aReceberCentavos)} previstos`}
          tom="positivo"
        />
        <Indicador
          rotulo="Pago"
          valorCentavos={resumo.pagoCentavos}
          detalhe={`de ${reais(resumo.aPagarCentavos)} previstos`}
        />
        <Indicador
          rotulo="Saldo realizado"
          valorCentavos={resumo.saldoRealizadoCentavos}
          detalhe="entradas menos saídas efetivadas"
          tom={saldoPositivo ? 'positivo' : 'negativo'}
        />
        <Indicador
          rotulo="Em atraso"
          valorCentavos={resumo.inadimplenteCentavos}
          detalhe={
            resumo.inadimplentesQtd === 1
              ? '1 cobrança vencida'
              : `${resumo.inadimplentesQtd} cobranças vencidas`
          }
          tom={resumo.inadimplenteCentavos > 0 ? 'atencao' : 'neutro'}
        />
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
  const [vendo, setVendo] = useState<{ tela: 'lista' } | { tela: 'ficha'; id: string } | { tela: 'novo' } | { tela: 'editar'; id: string }>({ tela: 'lista' });
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
    return <FormularioAluno aoSair={() => setVendo({ tela: 'lista' })} aoSalvar={(id) => setVendo({ tela: 'ficha', id })} />;
  }
  if (vendo.tela === 'editar') {
    return <FormularioAluno id={vendo.id} aoSair={() => setVendo({ tela: 'ficha', id: vendo.id })} aoSalvar={(id) => setVendo({ tela: 'ficha', id })} />;
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
                  <span className="celula-forte">{a.nome}</span>
                  {a.email !== null && <span className="celula-apoio">{a.email}</span>}
                </td>
                <td className="tabular">{a.telefone ?? a.whatsapp ?? '—'}</td>
                <td>
                  <span className={`selo selo-${a.status.toLowerCase()}`}>
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
 * Agenda
 * ================================================================== */

function Agenda(): ReactNode {
  const [dia, setDia] = useState(() => new Date());
  const [itens, setItens] = useState<Compromisso[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setCarregando(true);
      setErro(null);
      try {
        const ini = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 0, 0);
        const fim = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate() + 1, 0, 0);
        const r = await buscarAgenda(ini, fim);
        setItens(r.data);
      } catch (e) {
        setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a agenda.');
      } finally {
        setCarregando(false);
      }
    })();
  }, [dia]);

  const mover = (dias: number): void => {
    const novo = new Date(dia);
    novo.setDate(novo.getDate() + dias);
    setDia(novo);
  };

  const ehHoje = dia.toDateString() === new Date().toDateString();

  return (
    <>
      <div className="secao-cabecalho">
        <h1>Agenda</h1>
        <p>
          {capitalizar(
            dia.toLocaleDateString('pt-BR', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }),
          )}
          {ehHoje && <span className="marca-hoje">hoje</span>}
        </p>
      </div>

      <div className="agenda-controles">
        <button type="button" className="botao-secundario" onClick={() => mover(-1)}>
          Dia anterior
        </button>
        <button type="button" className="botao-secundario" onClick={() => setDia(new Date())}>
          Hoje
        </button>
        <button type="button" className="botao-secundario" onClick={() => mover(1)}>
          Próximo dia
        </button>
      </div>

      {erro !== null && <Erro mensagem={erro} />}
      {carregando && <Carregando rotulo="Carregando a agenda" />}

      {!carregando && erro === null && itens.length === 0 && (
        <Vazio
          titulo="Nenhum atendimento neste dia"
          descricao="Os horários marcados aparecerão aqui, em ordem cronológica."
        />
      )}

      {!carregando && itens.length > 0 && (
        <ol className="agenda-lista">
          {itens.map((c) => {
            const ini = new Date(c.inicio);
            const fim = new Date(c.fim);
            return (
              <li key={c.id} className={`agenda-item status-${c.status.toLowerCase()}`}>
                <div className="agenda-hora tabular">
                  <strong>
                    {ini.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </strong>
                  <span>
                    {fim.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="agenda-corpo">
                  <span className="agenda-aluno">{c.aluno.nome}</span>
                  <span className="agenda-detalhe">
                    {c.profissional.nome}
                    {c.sala !== null && ` · ${c.sala.nome}`}
                  </span>
                </div>
                <span className={`selo selo-${c.status.toLowerCase()}`}>
                  {c.status === 'ATTENDED'
                    ? 'Compareceu'
                    : c.status === 'NO_SHOW'
                      ? 'Faltou'
                      : c.status === 'CONFIRMED'
                        ? 'Confirmado'
                        : 'Agendado'}
                </span>
              </li>
            );
          })}
        </ol>
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
  const [secao, setSecao] = useState<'cadastro' | 'anamnese' | 'evolucao' | 'treino' | 'anexos'>('cadastro');

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
          <div className="ficha-selos">
            <span className={`selo selo-${f.status.toLowerCase()}`}>
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
  id: 'cadastro' | 'anamnese' | 'evolucao' | 'treino' | 'anexos';
  nome: string;
  permissao: string | null;
}[] = [
  { id: 'cadastro', nome: 'Cadastro', permissao: null },
  { id: 'anamnese', nome: 'Anamnese', permissao: 'anamnesis:read' },
  { id: 'evolucao', nome: 'Evolução', permissao: 'evolution:read' },
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

const CAMPOS: { nome: string; rotulo: string; tipo?: string; dica?: string; largura?: 'meia' | 'terco' }[] = [
  { nome: 'nome', rotulo: 'Nome completo' },
  { nome: 'email', rotulo: 'E-mail', tipo: 'email', largura: 'meia' },
  { nome: 'telefone', rotulo: 'Telefone', largura: 'meia' },
  { nome: 'whatsapp', rotulo: 'WhatsApp', dica: 'Com país e DDD: +5531988887777', largura: 'meia' },
  { nome: 'dataNascimento', rotulo: 'Nascimento', tipo: 'date', largura: 'meia' },
  { nome: 'documento', rotulo: 'CPF', largura: 'meia' },
  { nome: 'cep', rotulo: 'CEP', largura: 'meia' },
  { nome: 'logradouro', rotulo: 'Logradouro' },
  { nome: 'numero', rotulo: 'Número', largura: 'terco' },
  { nome: 'complemento', rotulo: 'Complemento', largura: 'terco' },
  { nome: 'bairro', rotulo: 'Bairro', largura: 'terco' },
  { nome: 'cidade', rotulo: 'Cidade', largura: 'meia' },
  { nome: 'uf', rotulo: 'Estado', dica: 'Sigla, como MG', largura: 'meia' },
  { nome: 'contatoEmergencia', rotulo: 'Contato de emergência', largura: 'meia' },
  { nome: 'telefoneEmergencia', rotulo: 'Telefone de emergência', largura: 'meia' },
];

function FormularioAluno({
  id,
  aoSair,
  aoSalvar,
}: {
  id?: string;
  aoSair: () => void;
  aoSalvar: (id: string) => void;
}): ReactNode {
  const [dados, setDados] = useState<DadosAluno>({});
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
          telefone: f.telefone ?? '',
          whatsapp: f.whatsapp ?? '',
          dataNascimento: f.dataNascimento ?? '',
          documento: f.documento ?? '',
          status: f.status,
          observacoes: f.observacoes ?? '',
          cep: f.endereco.cep ?? '',
          logradouro: f.endereco.logradouro ?? '',
          numero: f.endereco.numero ?? '',
          complemento: f.endereco.complemento ?? '',
          bairro: f.endereco.bairro ?? '',
          cidade: f.endereco.cidade ?? '',
          uf: f.endereco.uf ?? '',
          contatoEmergencia: f.emergencia.contato ?? '',
          telefoneEmergencia: f.emergencia.telefone ?? '',
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
      if (id === undefined) {
        const r = await criarAluno(dados);
        aoSalvar(r.data.id);
      } else {
        await atualizarAluno(id, dados);
        aoSalvar(id);
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
        {CAMPOS.map((c) => (
          <label key={c.nome} className={`campo campo-${c.largura ?? 'cheia'}`}>
            <span className="campo-rotulo">{c.rotulo}</span>
            <input
              type={c.tipo ?? 'text'}
              value={dados[c.nome] ?? ''}
              onChange={(e) => mudar(c.nome, e.target.value)}
              required={c.nome === 'nome'}
              autoFocus={c.nome === 'nome'}
            />
            {c.dica !== undefined && <span className="campo-dica">{c.dica}</span>}
          </label>
        ))}

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
