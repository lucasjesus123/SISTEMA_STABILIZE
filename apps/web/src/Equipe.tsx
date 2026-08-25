import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Carregando, Erro, Vazio } from './ui.jsx';
import type { Principal } from './api.js';
import { normalizarCor, tintaSobre } from './cor.js';
import type { Funcao } from '@stabilize/shared';
import {
  AREAS,
  AREA_DESCRICOES,
  AREA_LABELS,
  AREA_PERMISSIONS,
  FUNCOES,
  funcaoDe,
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

/**
 * Duas listas de áreas dizem a mesma coisa? Ordem não importa, e `null`
 * é o mesmo que lista vazia — os dois significam "tudo o que o papel
 * permite".
 *
 * REPETE A LÓGICA DO PACOTE COMPARTILHADO de propósito: lá ela é privada
 * a `funcaoDe`, que só conhece as funções fixas. Aqui a comparação
 * precisa valer também para as funções que a academia criou, que o
 * pacote não tem como conhecer.
 */
function mesmoRecorte(a: readonly string[] | null, b: readonly string[] | null): boolean {
  const va = a === null || a.length === 0;
  const vb = b === null || b.length === 0;
  if (va || vb) return va && vb;
  if (a!.length !== b!.length) return false;
  const ordenada = [...b!].sort();
  return [...a!].sort().every((v, i) => v === ordenada[i]);
}

/**
 * O nome da função de alguém, considerando também as que a ACADEMIA
 * criou.
 *
 * `funcaoDe` do pacote compartilhado só conhece a lista fixa — usá-lo
 * sozinho escreve "Administrador · acesso personalizado" para quem foi
 * cadastrado como Nutricionista, que é dizer duas coisas erradas de uma
 * vez. As próprias vêm ANTES: um cargo da casa que coincida com uma
 * função pronta ganha o nome que a academia escolheu.
 */
function nomeDaFuncao(
  papel: string,
  areas: readonly string[] | null,
  proprias: readonly api.FuncaoDaAcademia[],
): string | null {
  const propria = proprias.find(
    (f) => f.papel === papel && mesmoRecorte(f.areas, areas ?? null),
  );
  if (propria !== undefined) return propria.nome;
  return funcaoDe(papel as api.PapelDaEquipe, areas ?? null)?.nome ?? null;
}

/** Segunda primeiro: a semana da academia começa quando o aluno volta. */
const DIAS = [
  { valor: 1, nome: 'Segunda' },
  { valor: 2, nome: 'Terça' },
  { valor: 3, nome: 'Quarta' },
  { valor: 4, nome: 'Quinta' },
  { valor: 5, nome: 'Sexta' },
  { valor: 6, nome: 'Sábado' },
  { valor: 0, nome: 'Domingo' },
];

/** Quantas horas há entre dois "HH:MM". */
function horasEntre(inicio: string, fim: string): number {
  const emMinutos = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return Math.max(0, emMinutos(fim) - emMinutos(inicio)) / 60;
}

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
  /* AS FUNÇÕES DA ACADEMIA SÃO CARREGADAS AQUI, e não só no formulário,
     porque a LISTA precisa delas: sem elas a pílula lê o par (papel,
     áreas) contra a lista fixa, não acha, e escreve "Administrador ·
     acesso personalizado" para quem foi cadastrado como Nutricionista.
     O rótulo tem de dizer o cargo que a academia escolheu. */
  const [proprias, setProprias] = useState<api.FuncaoDaAcademia[]>([]);

  const recarregar = useCallback(() => setVersao((v) => v + 1), []);

  const recarregarFuncoes = useCallback(() => {
    void api
      .buscarFuncoesDaAcademia()
      .then((r) => setProprias(r.data))
      .catch(() => undefined);
  }, []);

  useEffect(recarregarFuncoes, [recarregarFuncoes]);

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
        proprias={proprias}
        aoMudarFuncoes={recarregarFuncoes}
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
              : `${lista.filter((u) => u.ativo).length} ativos de ${lista.length} · a função de cada um decide o que ele abre ao entrar.`}
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
                <th scope="col">Função</th>
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
                  proprias={proprias}
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
  proprias,
  eEuMesmo,
  souDono,
  aoEditar,
  aoMudar,
  aoGerarSenha,
}: {
  usuario: api.UsuarioDaEquipe;
  proprias: api.FuncaoDaAcademia[];
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
              /* A TINTA VEM DA COR, e não fixa em branco. Enquanto a
                 paleta era a única fonte, o branco servia para todas —
                 elas foram escolhidas escuras. Com a cor livre, amarelo
                 e verde-limão são escolhas legítimas, e nome branco
                 sobre eles some. */
              style={
                u.cor !== null ? { background: u.cor, color: tintaSobre(u.cor) } : undefined
              }
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
          {/* PÍLULA, e não texto solto: a função é a informação que muda
              o que a pessoa alcança no sistema inteiro, e merece a forma
              que o olho encontra primeiro numa lista.

              O NOME VEM DA FUNÇÃO, e cai no papel quando o recorte é à
              mão. Escrever "Administrador" para quem só abre o
              financeiro seria dizer, na lista inteira, uma coisa que não
              é verdade sobre metade da equipe. */}
          <span className={`pilula papel-${u.papel.toLowerCase()}`}>
            {nomeDaFuncao(u.papel, u.areas, proprias) ?? NOME_DO_PAPEL[u.papel] ?? u.papel}
          </span>
          {nomeDaFuncao(u.papel, u.areas, proprias) === null && u.areas !== null && (
            <span className="eq-nota">acesso personalizado</span>
          )}
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
                      api
                        .redefinirSenhaDeUsuario(u.id)
                        .then((r) => aoGerarSenha(r.data.senhaProvisoria ?? '')),
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
  proprias,
  aoMudarFuncoes,
  eEuMesmo,
  aoSair,
  aoSalvar,
}: {
  usuario: api.UsuarioDaEquipe | null;
  souDono: boolean;
  proprias: api.FuncaoDaAcademia[];
  aoMudarFuncoes: () => void;
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
  /* GERAR OU DIGITAR. A senha gerada tem uma propriedade que a digitada
     não tem — nem quem cadastrou sabe a definitiva, porque a troca é
     obrigatória no primeiro acesso — e é por isso que ela continua sendo
     o padrão. Mas ditar catorze caracteres aleatórios por telefone é ver
     a pessoa errar três vezes, e quem opera precisa poder combinar a
     senha ali mesmo. */
  const [senhaModo, setSenhaModo] = useState<'gerar' | 'definir'>('gerar');
  const [senha, setSenha] = useState('');
  const [recortar, setRecortar] = useState(usuario?.areas != null);
  const [areas, setAreas] = useState<string[]>(usuario?.areas ?? []);
  /* HORÁRIOS DE ATENDIMENTO. As rotas existiam desde o começo e nenhuma
     tela as chamava: a academia não tinha onde dizer que a professora
     atende terça das 8 às 12, e sem isso o calendário não sabe o que é
     horário livre — marcar aluno virava acordo de boca.

     MORAM AQUI, no cadastro da pessoa, e não numa tela à parte. É o
     mesmo motivo da cor: é no momento de cadastrar o professor que se
     sabe quando ele trabalha, e separar as duas coisas garante que
     metade da equipe fique sem horário até alguém lembrar. */
  const [horarios, setHorarios] = useState<api.FaixaDeHorario[]>([]);
  const [salas, setSalas] = useState<api.Sala[]>([]);
  const [horariosMudaram, setHorariosMudaram] = useState(false);
  /* "Eu mesmo monto o acesso." NÃO é derivável do par (papel, áreas):
     quem abre o modo manual e ainda não mexeu em nada continua com uma
     combinação que corresponde a uma função pronta, e fechar o painel
     debaixo da mão de quem acabou de abri-lo seria o pior momento
     possível para fazê-lo. */
  const [manual, setManual] = useState(false);
  /* AS FUNÇÕES QUE A ACADEMIA CRIOU. A lista pronta é a mesma para todo
     mundo; os cargos são de cada casa — estagiário, nutricionista,
     coordenador de turma. Elas entram no MESMO seletor das prontas, e
     não numa lista separada: para quem cadastra, "Nutricionista" e
     "Recepção" são a mesma espécie de escolha. */
  const [criandoFuncao, setCriandoFuncao] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  /* SÓ QUEM ATENDE tem horário de atendimento. Recepção e financeiro
     trabalham em horários também, e o sistema não os usa para nada: o
     calendário só oferece vaga de quem recebe aluno. Um campo que não
     produz efeito é um campo que ensina a desconfiar da tela. */
  const atende = papel === 'PROFESSIONAL';

  useEffect(() => {
    if (!atende) return;
    void api
      .buscarSalas()
      .then((r) => setSalas(r.data))
      .catch(() => undefined);
  }, [atende]);

  useEffect(() => {
    if (usuario === null || !atende) return;
    void api
      .buscarHorarios(usuario.id)
      .then((r) => setHorarios(r.data))
      .catch(() => undefined);
  }, [usuario, atende]);

  const mexerNoHorario = (
    indice: number,
    campos: Partial<api.FaixaDeHorario>,
  ): void => {
    setHorariosMudaram(true);
    setHorarios((atual) => atual.map((f, i) => (i === indice ? { ...f, ...campos } : f)));
  };

  const adicionarFaixa = (dia: number): void => {
    setHorariosMudaram(true);
    setHorarios((atual) => [
      ...atual,
      /* 08:00–12:00 e 60 minutos: é a manhã de quase toda academia, e
         começar com o campo preenchido faz a diferença entre "escolher
         o horário" e "montar um horário do zero". */
      { diaDaSemana: dia, inicio: '08:00', fim: '12:00', duracaoMinutos: 60, salaId: null },
    ]);
  };

  const removerFaixa = (indice: number): void => {
    setHorariosMudaram(true);
    setHorarios((atual) => atual.filter((_, i) => i !== indice));
  };

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

  /* A FUNÇÃO É LIDA do que está preenchido, e não guardada ao lado. Se
     ela fosse um estado próprio, existiria o dia em que ela diz
     "Financeiro" e as áreas dizem outra coisa — e quem lê a tela
     acreditaria no rótulo. Aqui o rótulo não tem como mentir: ou o par
     (papel, áreas) corresponde a uma função pronta, ou a resposta é
     "personalizado". */
  /* AS PRÓPRIAS PRIMEIRO, e as prontas depois. Quem criou "Estagiário"
     criou porque cadastra estagiário toda semana; deixá-lo no fim de uma
     lista de nove é fazer procurar o que se usa mais. */
  const funcoesOferecidas: Funcao[] = [
    ...proprias.map((f) => ({
      id: f.id,
      nome: f.nome,
      descricao: f.descricao ?? 'Função criada por esta academia.',
      papel: f.papel as Funcao['papel'],
      areas: (f.areas ?? null) as Funcao['areas'],
    })),
    ...FUNCOES,
  ].filter((f) => f.papel !== 'OWNER' || souDono);

  /* A FUNÇÃO É LIDA do par (papel, áreas), e agora as próprias entram na
     mesma leitura: uma pessoa cadastrada como "Estagiário" volta a
     aparecer como "Estagiário" na lista da equipe, e não como
     "Personalizado" — que é o que aconteceria se a busca olhasse só a
     lista fixa. `find` para na primeira, e as próprias vêm antes: um
     cargo da casa que coincida com uma função pronta ganha o nome que a
     academia escolheu. */
  const funcaoAtual = manual
    ? null
    : (funcoesOferecidas.find(
        (f) =>
          f.papel === papel &&
          mesmoRecorte(f.areas ?? null, recortar ? areas : null),
      ) ?? null);
  const valorDaFuncao = funcaoAtual?.id ?? 'personalizado';

  /* Escolher a função preenche PAPEL E ÁREAS de uma vez — é o atalho
     inteiro: quem cadastra o financeiro escolhe "Financeiro" e não
     precisa saber que por baixo isso é um administrador com uma seção
     marcada. */
  const escolherFuncao = (id: string): void => {
    if (id === 'nova') {
      setCriandoFuncao(true);
      return;
    }
    if (id === 'personalizado') {
      setManual(true);
      return;
    }
    const f = funcoesOferecidas.find((x) => x.id === id);
    if (f === undefined) return;
    setManual(false);
    setPapel(f.papel as api.PapelDaEquipe);
    setRecortar(f.areas !== null);
    setAreas(f.areas === null ? [] : [...f.areas]);
  };

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (novo && senhaModo === 'definir' && senha.trim().length < 10) {
      setErro('A senha precisa de pelo menos 10 caracteres.');
      return;
    }
    if (atende && horarios.some((f) => f.fim <= f.inicio)) {
      setErro('Há uma faixa de horário com o fim antes do início. Corrija antes de salvar.');
      return;
    }
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
        const r = await api.criarUsuario({
          ...dados,
          email: email.trim(),
          senha: senhaModo === 'definir' ? senha : null,
        });
        /* OS HORÁRIOS SÓ PODEM SER GRAVADOS DEPOIS, porque antes do
           POST a pessoa não tem id. Se esta segunda chamada falhar, o
           usuário existe e a grade não — e é por isso que a falha é
           dita em vez de engolida: o operador precisa saber que falta
           voltar e preencher, e não descobrir na segunda-feira que o
           professor não aparece no calendário. */
        if (atende && horarios.length > 0) {
          try {
            await api.salvarHorarios(r.data.id, horarios);
          } catch {
            setErro(
              `${nome} foi cadastrado, mas os horários não foram salvos. Abra "Editar" e tente de novo.`,
            );
            setEnviando(false);
            return;
          }
        }
        /* A escolhida não volta do servidor — quem cadastrou acabou de
           digitá-la. Só a gerada precisa da tela que mostra uma vez. */
        aoSalvar(r.data.senhaProvisoria === null ? null : { nome, senha: r.data.senhaProvisoria });
      } else {
        await api.salvarUsuario(usuario.id, dados);
        /* SÓ GRAVA SE MEXEU. Um PUT que substitui a semana inteira,
           disparado a cada "Salvar", reescreveria a grade de quem só
           veio trocar o telefone — e se a lista tivesse falhado ao
           carregar, apagaria tudo. */
        if (atende && horariosMudaram) await api.salvarHorarios(usuario.id, horarios);
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
            ? 'Você escolhe a senha ou deixa o sistema gerar uma provisória — e marca o que esta pessoa enxerga.'
            : 'O e-mail não muda por aqui — ele é o login, e trocá-lo derrubaria o acesso.'}
        </p>
      </div>

      {/* O `submit` é BLOQUEADO enquanto o painel de criar função está
          aberto: um Enter no campo do nome da função salvaria o usuário
          pela metade, com a função ainda não criada. */}
      <form
        className="formulario"
        onSubmit={(e) => {
          if (criandoFuncao) {
            e.preventDefault();
            return;
          }
          void enviar(e);
        }}
        noValidate
      >
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

        {/* ==================================================
            FUNÇÃO — o que a pessoa É na academia

            Antes aqui se escolhia o PAPEL, que é vocabulário do sistema
            e não da academia: quem cuida do dinheiro não é "um
            administrador", é o financeiro. Pior, o papel sozinho não
            recortava nada — o financeiro entrava como administrador e
            abria prontuário de aluno, porque a alternativa era não dar
            acesso nenhum.

            A função preenche o par inteiro (papel + seções) de uma vez.
            Não é um conceito novo de permissão: é um nome para a
            combinação comum. Quem precisar de um recorte que não está na
            lista escolhe "Personalizado" e monta à mão — o que era o
            único caminho até aqui, e continua existindo.
            ================================================== */}
        <label className="campo campo-meia">
          <span className="campo-rotulo">Função</span>
          <select
            value={valorDaFuncao}
            onChange={(e) => escolherFuncao(e.target.value)}
            disabled={eEuMesmo}
          >
            {funcoesOferecidas.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
              </option>
            ))}
            <option value="personalizado">Personalizado…</option>
            {/* CRIAR UMA FUNÇÃO A PARTIR DAQUI, e não numa tela de
                configuração. O momento em que se descobre que falta o
                cargo "Estagiário" é exatamente este: com o cadastro do
                estagiário aberto na frente. Mandar a pessoa para outra
                tela é fazê-la perder o que já digitou. */}
            <option value="nova">+ Criar uma função…</option>
          </select>
          {/* O QUE A FUNÇÃO SIGNIFICA, embaixo do seletor. Sem isto, quem
              cadastra escolhe pelo nome e descobre o alcance depois —
              geralmente quando alguém viu o que não devia. */}
          <span className="campo-dica">
            {eEuMesmo
              ? 'Você não pode trocar a própria função.'
              : (funcaoAtual?.descricao ?? 'Você escolhe o papel e as seções logo abaixo.')}
          </span>
          {/* AS SEÇÕES DA FUNÇÃO, escritas por extenso e coladas no
              seletor. "Financeiro" é um nome; o que ele abre é a
              informação — e é o que quem cadastra precisa conferir antes
              de salvar. */}
          {funcaoAtual !== null && funcaoAtual.areas !== null && (
            <span className="campo-dica eq-funcao-abre">
              Abre só: <strong>{funcaoAtual.areas.map((a) => AREA_LABELS[a]).join(', ')}</strong>. O
              resto some do menu e deixa de responder, mesmo pelo endereço direto.
            </span>
          )}
        </label>

        {criandoFuncao && (
          <NovaFuncao
            souDono={souDono}
            aoFechar={() => setCriandoFuncao(false)}
            aoCriar={(f) => {
              setCriandoFuncao(false);
              aoMudarFuncoes();
              /* JÁ ESCOLHIDA. Quem criou a função criou para usá-la
                 agora — obrigar a abrir o seletor de novo e procurá-la
                 seria pedir duas vezes a mesma decisão. */
              setManual(false);
              setPapel(f.papel);
              setRecortar(f.areas !== null);
              setAreas(f.areas === null ? [] : [...f.areas]);
            }}
          />
        )}

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

            {/* QUALQUER COR, ao lado das sugeridas — e não no lugar
                delas. A paleta resolve o caso comum em um clique e já
                vem separada o bastante para não confundir duas pessoas
                no calendário; escolher a dedo é para quando a academia
                tem uma cor própria ou quando as oito acabaram. */}
            <label
              className={`eq-opcao eq-livre ${PALETA.includes(cor) ? '' : 'ativa'}`}
              title="Escolher outra cor"
            >
              <input
                type="color"
                value={normalizarCor(cor, PALETA[0]!)}
                onChange={(e) => setCor(normalizarCor(e.target.value, PALETA[0]!))}
              />
              <span style={{ background: PALETA.includes(cor) ? undefined : cor }} aria-hidden="true">
                {PALETA.includes(cor) ? '+' : ''}
              </span>
              <span className="apenas-leitor-de-tela">Escolher outra cor</span>
            </label>
          </div>

          <p className="eq-cor-previa">
            Aparece assim na agenda:{' '}
            <span className="eq-cor-amostra" style={{ background: cor, color: tintaSobre(cor) }}>
              {nome.trim() === '' ? 'Nome da pessoa' : nome.trim()}
            </span>
          </p>
        </fieldset>

        {novo && (
          <fieldset className="campo campo-cheia eq-acessos">
            <legend className="campo-rotulo">Senha de acesso</legend>

            <label className="eq-tudo">
              <input
                type="radio"
                name="senha-modo"
                checked={senhaModo === 'gerar'}
                onChange={() => setSenhaModo('gerar')}
              />
              <span>
                <strong>Gerar uma provisória</strong>
                <span className="campo-dica">
                  Aparece uma única vez ao salvar, e a pessoa é obrigada a trocá-la no primeiro
                  acesso. Nem você fica sabendo a senha definitiva dela.
                </span>
              </span>
            </label>

            <label className="eq-tudo">
              <input
                type="radio"
                name="senha-modo"
                checked={senhaModo === 'definir'}
                onChange={() => setSenhaModo('definir')}
              />
              <span>
                <strong>Eu defino agora</strong>
                <span className="campo-dica">
                  Para combinar a senha com a pessoa na hora. Ela entra direto, sem tela de troca.
                </span>
              </span>
            </label>

            {senhaModo === 'definir' && (
              <label className="campo eq-senha-campo">
                <span className="campo-rotulo">Senha</span>
                <input
                  type="text"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  autoComplete="off"
                  placeholder="pelo menos 10 caracteres"
                />
                {/* VISÍVEL, e não mascarada: quem digita aqui está
                    combinando a senha com alguém do lado, e um campo de
                    pontinhos faz errar exatamente no momento em que ler o
                    que se escreveu é o ponto. */}
                <span className="campo-dica">
                  Fica visível de propósito — é para você conferir antes de passar adiante.
                </span>
              </label>
            )}
          </fieldset>
        )}

        {/* ==================================================
            HORÁRIOS DE ATENDIMENTO

            É O QUE FAZ A AGENDA EXISTIR. O calendário não inventa vaga:
            ele oferece o que estiver aqui. Sem uma faixa cadastrada, o
            professor não tem horário livre nenhum — e a recepção
            descobre isso na frente do aluno.

            A GRADE É EDITADA INTEIRA e gravada de uma vez. O servidor
            substitui a semana no `PUT`, então tirar a quinta-feira daqui
            realmente tira a quinta-feira: um `PUT` que só acrescentasse
            deixaria a faixa apagada valendo do lado de lá, e o
            profissional continuaria recebendo aluno num dia que ele
            achava que tinha fechado.
            ================================================== */}
        {atende && (
          <fieldset className="campo campo-cheia eq-acessos">
            <legend className="campo-rotulo">Horários de atendimento</legend>

            {horarios.length === 0 ? (
              <p className="campo-dica eq-sem-horario">
                Nenhuma faixa cadastrada — este profissional não tem horário livre nenhum na
                agenda. Adicione ao menos um dia para que a recepção consiga marcar aluno com ele.
              </p>
            ) : (
              <p className="campo-dica eq-sem-horario">
                {(() => {
                  const total = horarios.reduce(
                    (a, f) => a + horasEntre(f.inicio, f.fim),
                    0,
                  );
                  const dias = new Set(horarios.map((f) => f.diaDaSemana)).size;
                  return `${total.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}h por semana, em ${dias} ${dias === 1 ? 'dia' : 'dias'}.`;
                })()}
              </p>
            )}

            <div className="eq-semana">
              {DIAS.map((d) => {
                const doDia = horarios
                  .map((f, i) => ({ f, i }))
                  .filter(({ f }) => f.diaDaSemana === d.valor);

                return (
                  <div key={d.valor} className={`eq-dia ${doDia.length > 0 ? 'tem' : ''}`}>
                    <div className="eq-dia-topo">
                      <strong>{d.nome}</strong>
                      <button
                        type="button"
                        className="botao-texto"
                        onClick={() => adicionarFaixa(d.valor)}
                      >
                        + faixa
                      </button>
                    </div>

                    {doDia.length === 0 ? (
                      <span className="eq-dia-vazio">não atende</span>
                    ) : (
                      doDia.map(({ f, i }) => (
                        <div key={i} className="eq-faixa">
                          <label>
                            <span className="apenas-leitor-de-tela">Início</span>
                            <input
                              type="time"
                              value={f.inicio}
                              onChange={(e) => mexerNoHorario(i, { inicio: e.target.value })}
                            />
                          </label>
                          <span aria-hidden="true">às</span>
                          <label>
                            <span className="apenas-leitor-de-tela">Fim</span>
                            <input
                              type="time"
                              value={f.fim}
                              onChange={(e) => mexerNoHorario(i, { fim: e.target.value })}
                            />
                          </label>

                          {/* A DURAÇÃO DA SESSÃO é o que fatia a faixa em
                              vagas: das 8 às 12, de 60 em 60, são quatro
                              horários oferecidos ao aluno. */}
                          <label className="eq-faixa-duracao">
                            <span className="apenas-leitor-de-tela">Duração de cada sessão</span>
                            <select
                              value={String(f.duracaoMinutos)}
                              onChange={(e) =>
                                mexerNoHorario(i, { duracaoMinutos: Number(e.target.value) })
                              }
                            >
                              {[30, 45, 50, 60, 90, 120].map((m) => (
                                <option key={m} value={String(m)}>
                                  {m} min
                                </option>
                              ))}
                            </select>
                          </label>

                          {salas.length > 0 && (
                            <label className="eq-faixa-sala">
                              <span className="apenas-leitor-de-tela">Espaço</span>
                              <select
                                value={f.salaId ?? ''}
                                onChange={(e) =>
                                  mexerNoHorario(i, {
                                    salaId: e.target.value === '' ? null : e.target.value,
                                  })
                                }
                              >
                                <option value="">Qualquer espaço</option>
                                {salas.map((sa) => (
                                  <option key={sa.id} value={sa.id}>
                                    {sa.nome}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}

                          <button
                            type="button"
                            className="botao-texto-perigo eq-faixa-fora"
                            onClick={() => removerFaixa(i)}
                            aria-label={`Remover a faixa de ${d.nome}`}
                          >
                            remover
                          </button>

                          {f.fim <= f.inicio && (
                            <span className="eq-faixa-erro">
                              O fim precisa ser depois do início.
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}

        {/* ==================================================
            O QUE ESTA PESSOA ENXERGA — o modo à mão

            Só aparece com "Personalizado" escolhido. Enquanto a função é
            uma das prontas, este quadro estaria mostrando de novo, em
            duas dúzias de linhas, o que o seletor de cima já disse — e
            oferecendo caixas que, mexidas, fariam a função e o acesso
            discordarem na mesma tela.

            O papel diz o que a pessoa PODE; as seções dizem o que ela
            FAZ. A conta é sempre interseção — marcar uma seção nunca dá
            permissão que o papel não tenha —, e o corte vale no
            servidor, não só no menu: a pessoa não vê e também não
            alcança pela URL.
            ================================================== */}
        {valorDaFuncao === 'personalizado' && (
          <fieldset className="campo campo-cheia eq-acessos">
            <legend className="campo-rotulo">Acesso personalizado</legend>

            <label className="campo eq-papel-campo">
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
              {/* SEM a descrição do papel aqui: ela já é a dica da opção
                  "tudo o que o papel permite", logo abaixo, e escrever a
                  mesma frase duas vezes na mesma moldura faz parecer que
                  são duas coisas. */}
            </label>

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
        )}

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

/* ==================================================================== */

/**
 * Criar uma função da academia.
 *
 * APARECE DENTRO DO CADASTRO DA PESSOA, e não numa tela de configuração.
 * O momento em que se descobre que falta o cargo "Estagiário" é
 * exatamente aquele: com o cadastro do estagiário aberto na frente.
 * Mandar a pessoa para outra tela é fazê-la perder o que já digitou.
 *
 * O QUE SE CRIA AQUI É VOCABULÁRIO, NÃO PODER — e o painel diz isso em
 * voz alta. Uma função é um NOME para um par (papel, seções) que já
 * existia: ela não inventa acesso, não soma permissão e não escapa do
 * teto do papel. Sem essa frase, "criar função" soa como criar um nível
 * novo de privilégio, e quem cadastra fica com medo de usar.
 */
function NovaFuncao({
  souDono,
  aoFechar,
  aoCriar,
}: {
  souDono: boolean;
  aoFechar: () => void;
  aoCriar: (f: api.FuncaoDaAcademia) => void;
}): ReactNode {
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [papel, setPapel] = useState<api.PapelDaEquipe>('ADMIN');
  const [recortar, setRecortar] = useState(true);
  const [areas, setAreas] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const opcoes = PAPEIS.filter((p) => p.valor !== 'OWNER' || souDono);
  const escolhido = PAPEIS.find((p) => p.valor === papel);

  const permitidas = permissionsOf(papel);
  const areasDoPapel = AREAS.filter((a) =>
    AREA_PERMISSIONS[a].some((x) => permitidas.includes(x)),
  );

  const alternar = (a: string): void =>
    setAreas((atual) => (atual.includes(a) ? atual.filter((x) => x !== a) : [...atual, a]));

  const enviar = (): void => {
    if (nome.trim().length < 2) {
      setErro('Dê um nome à função — é como ela vai aparecer na lista da equipe.');
      return;
    }
    if (recortar && areas.length === 0) {
      setErro('Marque ao menos uma seção — ou escolha "tudo o que o papel permite".');
      return;
    }
    setErro(null);
    setEnviando(true);
    void api
      .criarFuncaoDaAcademia({
        nome: nome.trim(),
        ...(descricao.trim() !== '' ? { descricao: descricao.trim() } : {}),
        papel,
        areas: recortar ? areas : null,
      })
      .then((r) => aoCriar(r.data))
      .catch((e: unknown) => {
        setErro(e instanceof api.ApiError ? e.message : 'Não foi possível criar a função.');
        setEnviando(false);
      });
  };

  return (
    <fieldset className="campo campo-cheia eq-acessos eq-nova-funcao">
      <legend className="campo-rotulo">Criar uma função</legend>

      <p className="campo-dica eq-nova-aviso">
        Uma função é um <strong>nome</strong> para uma combinação de papel e seções que já existe.
        Ela não cria acesso novo nem passa do que o papel permite — serve para a lista da equipe
        dizer o cargo de verdade em vez de “Administrador” para todo mundo.
      </p>

      <div className="eq-nova-campos">
        <label className="campo">
          <span className="campo-rotulo">Nome da função</span>
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={40}
            autoFocus
            placeholder="Estagiário, Nutricionista, Coordenador…"
          />
        </label>

        <label className="campo">
          <span className="campo-rotulo">Papel base</span>
          <select
            value={papel}
            onChange={(e) => {
              setPapel(e.target.value as api.PapelDaEquipe);
              /* AS SEÇÕES MARCADAS SÃO LIMPAS ao trocar o papel: elas
                 pertenciam ao papel anterior, e uma marcada fora do
                 alcance do novo não daria acesso nenhum — daria uma
                 caixa marcada sem efeito, que é pior. */
              setAreas([]);
            }}
          >
            {opcoes.map((p) => (
              <option key={p.valor} value={p.valor}>
                {p.nome}
              </option>
            ))}
          </select>
          <span className="campo-dica">{escolhido?.descricao}</span>
        </label>

        <label className="campo eq-nova-descricao">
          <span className="campo-rotulo">Explicação (opcional)</span>
          <input
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            maxLength={200}
            placeholder="Uma frase para quem for cadastrar alguém com esta função."
          />
        </label>
      </div>

      <label className="eq-tudo">
        <input
          type="radio"
          name="nova-recorte"
          checked={!recortar}
          onChange={() => setRecortar(false)}
        />
        <span>
          <strong>Tudo o que o papel permite</strong>
          <span className="campo-dica">{escolhido?.descricao}</span>
        </span>
      </label>

      <label className="eq-tudo">
        <input
          type="radio"
          name="nova-recorte"
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
              <input type="checkbox" checked={areas.includes(a)} onChange={() => alternar(a)} />
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

      {erro !== null && (
        <p className="mensagem-erro" role="alert">
          {erro}
        </p>
      )}

      {/* BOTÕES, E NÃO UM `submit`. Este painel vive DENTRO do formulário
          do usuário: um `type="submit"` aqui salvaria a pessoa em vez de
          criar a função, e um Enter no campo do nome faria o mesmo. */}
      <div className="eq-nova-acoes">
        <button type="button" className="botao-secundario" onClick={aoFechar}>
          Cancelar
        </button>
        <button type="button" className="botao-acao" disabled={enviando} onClick={enviar}>
          {enviando ? 'Criando…' : 'Criar função'}
        </button>
      </div>
    </fieldset>
  );
}
