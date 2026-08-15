import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  buscarAgenda,
  buscarAlunos,
  buscarIndicadores,
  buscarResumo,
  entrar,
  restaurarSessao,
  sair,
  type Aluno,
  type Compromisso,
  type IndicadoresGestao,
  type Principal,
  type ResumoFinanceiro,
} from './api.js';
import { Carregando, Erro, GraficoLinha, Indicador, Vazio, reais, type Ponto } from './ui.jsx';
import { Marca } from './Marca.jsx';
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

type Aba = 'painel' | 'alunos' | 'agenda';

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
        <Marca tamanho={44} />
      </div>
    );
  }

  if (principal === null) {
    return <Login aoEntrar={setPrincipal} />;
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
  const { tema, definir } = useTema();

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
        {/* O tema é escolhível ANTES de entrar: quem trabalha no escuro
            não deveria ter que atravessar uma tela clara para chegar lá. */}
        <div className="entrada-tema">
          <SeletorTema tema={tema} definir={definir} />
        </div>

        <Marca tamanho={34} />

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
  ];
  const visiveis = abas.filter((a) => a.visivel);

  return (
    <div className="sistema">
      <a href="#conteudo" className="pular-para-conteudo">
        Pular para o conteúdo
      </a>

      <header className="topo">
        <Marca tamanho={30} />

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
        {aba === 'alunos' && <Alunos />}
        {aba === 'agenda' && <Agenda />}
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
          Tinham frequência estabelecida e sumiram há mais de duas semanas, sem horário
          marcado à frente. É a lista para ligar hoje.
        </p>

        {dados.emRisco.length === 0 ? (
          <Vazio
            titulo="Ninguém sumido no momento"
            descricao="Todos os alunos com frequência estabelecida vieram nas últimas duas semanas ou já têm horário marcado."
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

function Alunos(): ReactNode {
  const [lista, setLista] = useState<Aluno[]>([]);
  const [total, setTotal] = useState(0);
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
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
  }, [busca]);

  return (
    <>
      <div className="secao-cabecalho">
        <h1>Alunos</h1>
        <p>{total === 1 ? '1 aluno' : `${total} alunos`} no seu acompanhamento</p>
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
              <tr key={a.id}>
                <td>
                  <span className="celula-forte">{a.nome}</span>
                  {a.email !== null && <span className="celula-apoio">{a.email}</span>}
                </td>
                <td className="tabular">{a.telefone ?? a.whatsapp ?? '—'}</td>
                <td>
                  <span className={`selo selo-${a.status.toLowerCase()}`}>
                    {a.status === 'ACTIVE'
                      ? 'Ativo'
                      : a.status === 'INACTIVE'
                        ? 'Inativo'
                        : a.status === 'SUSPENDED'
                          ? 'Suspenso'
                          : 'Interessado'}
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
