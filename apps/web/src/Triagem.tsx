import { useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Carregando, Erro } from './ui.jsx';

/**
 * PAR-Q e termo de responsabilidade.
 *
 * DUAS TELAS, UM FORMULÁRIO. O aluno assina pelo aplicativo e a academia
 * registra pelo balcão para quem não tem o aplicativo — mas as perguntas
 * e o texto do termo são os mesmos, servidos pela API. Duas cópias da
 * mesma lista em dois arquivos é como uma delas fica para trás numa
 * revisão do questionário sem que ninguém perceba.
 *
 * O PADRÃO É NENHUMA RESPOSTA MARCADA. A tentação é marcar "não" em tudo
 * de saída, porque é a resposta de nove em cada dez pessoas e economiza
 * sete toques. É exatamente por isso que não se faz: quem abre a tela já
 * respondida passa direto, e o um em dez que tinha um "sim" a dar
 * assinou uma declaração falsa sem perceber. O servidor recusa
 * formulário incompleto justamente para que este atrito não possa ser
 * removido depois "para melhorar a conversão".
 */

export const ROTULO_DA_TRIAGEM: Record<api.SituacaoDaTriagem, string> = {
  NUNCA_ASSINOU: 'Sem triagem',
  VALIDA: 'Triagem em dia',
  VENCIDA: 'Triagem vencida',
  AGUARDANDO_ATESTADO: 'Aguardando atestado',
};

export const TOM_DA_TRIAGEM: Record<api.SituacaoDaTriagem, string> = {
  NUNCA_ASSINOU: 'atencao',
  VALIDA: 'ok',
  VENCIDA: 'atencao',
  AGUARDANDO_ATESTADO: 'erro',
};

/* ==================================================================== */

/**
 * O formulário em si. Compartilhado pelas duas telas.
 *
 * `classe` existe porque o aplicativo do aluno tem folha de estilo
 * própria (fundo quase preto, tipos maiores) e o sistema tem a dele.
 * O que muda é a casca; a lógica de responder e assinar é uma só.
 */
export function FormularioDaTriagem({
  perguntas,
  termo,
  nomeSugerido,
  aoAssinar,
  prefixo = 'tri',
}: {
  perguntas: api.PerguntaDoParq[];
  termo: api.TermoVigente;
  nomeSugerido: string;
  aoAssinar: (dados: api.Assinatura) => Promise<void>;
  prefixo?: string;
}): ReactNode {
  const [respostas, setRespostas] = useState<Record<string, boolean>>({});
  const [observacoes, setObservacoes] = useState('');
  const [nome, setNome] = useState('');
  const [li, setLi] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const faltam = perguntas.filter((p) => typeof respostas[p.chave] !== 'boolean').length;
  const algumSim = perguntas.some((p) => respostas[p.chave] === true);
  const podeAssinar = faltam === 0 && li && nome.trim().split(/\s+/).length >= 2 && !enviando;

  const enviar = async (): Promise<void> => {
    setErro(null);
    setEnviando(true);
    try {
      await aoAssinar({
        respostas,
        observacoes: observacoes.trim() === '' ? null : observacoes.trim(),
        assinadoNome: nome.trim(),
      });
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível assinar.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className={`${prefixo}-formulario`}>
      <ol className={`${prefixo}-perguntas`}>
        {perguntas.map((p, i) => (
          <li key={p.chave}>
            <span className={`${prefixo}-pergunta-texto`}>
              <span className={`${prefixo}-numero`} aria-hidden="true">
                {i + 1}
              </span>
              {p.texto}
            </span>
            <span className={`${prefixo}-sim-nao`} role="group" aria-label={p.texto}>
              {/* NÃO VEM PRIMEIRO na leitura, mas SIM vem primeiro no
                  código do botão: a ordem visual segue a convenção de
                  formulário (sim à esquerda) e a semântica não muda. */}
              {([true, false] as const).map((valor) => (
                <button
                  key={String(valor)}
                  type="button"
                  className={respostas[p.chave] === valor ? 'escolhido' : ''}
                  aria-pressed={respostas[p.chave] === valor}
                  onClick={() => setRespostas((r) => ({ ...r, [p.chave]: valor }))}
                >
                  {valor ? 'Sim' : 'Não'}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ol>

      {/* O AVISO APARECE ASSIM QUE O PRIMEIRO "SIM" É MARCADO, e não
          depois de assinar. Descobrir no fim que vai precisar de
          atestado é o tipo de surpresa que faz a pessoa voltar e trocar
          a resposta. */}
      {algumSim && (
        <p className={`${prefixo}-alerta`}>
          Com pelo menos um <strong>Sim</strong>, é preciso apresentar liberação médica por
          escrito antes de começar a treinar. Você pode assinar agora e trazer o atestado depois.
        </p>
      )}

      <label className="campo">
        <span className="campo-rotulo">Quer acrescentar alguma coisa? (opcional)</span>
        <textarea
          value={observacoes}
          onChange={(e) => setObservacoes(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Cirurgia no joelho em 2023, ainda faço fisioterapia"
        />
      </label>

      <details className={`${prefixo}-termo`}>
        <summary>Ler o termo de responsabilidade ({termo.versao})</summary>
        <pre>{termo.texto}</pre>
      </details>

      <label className={`${prefixo}-li`}>
        <input type="checkbox" checked={li} onChange={(e) => setLi(e.target.checked)} />
        <span>Li e concordo com o termo de responsabilidade acima.</span>
      </label>

      <label className="campo">
        <span className="campo-rotulo">Assine escrevendo o nome completo</span>
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder={nomeSugerido}
          autoComplete="off"
          maxLength={160}
        />
        <span className="campo-dica">
          O nome digitado vale como assinatura, junto com a data e o registro deste acesso.
        </span>
      </label>

      {erro !== null && <Erro mensagem={erro} />}

      <button
        type="button"
        className="botao-acao grande"
        disabled={!podeAssinar}
        onClick={() => void enviar()}
      >
        {enviando ? 'Assinando…' : 'Assinar'}
      </button>

      {/* Dizer o que falta é melhor que um botão apagado sem explicação:
          o botão desabilitado sozinho vira "o sistema está travado". */}
      {!podeAssinar && !enviando && (
        <p className={`${prefixo}-falta`}>
          {faltam > 0
            ? faltam === 1
              ? 'Falta responder 1 pergunta.'
              : `Faltam responder ${faltam} perguntas.`
            : !li
              ? 'Marque que leu o termo.'
              : 'Escreva o nome completo para assinar.'}
        </p>
      )}
    </div>
  );
}

/* ==================================================================== */

/**
 * A seção da ficha do aluno, no sistema.
 *
 * MOSTRA A SITUAÇÃO ANTES DO FORMULÁRIO. Quem abre esta aba na maioria
 * das vezes quer conferir se está em dia, não preencher de novo.
 */
export function AbaTriagem({
  alunoId,
  nome,
  podeConfigurar = false,
}: {
  alunoId: string;
  nome: string;
  /** `tenant:settings` — quem responde pela empresa edita o questionário. */
  podeConfigurar?: boolean;
}): ReactNode {
  const [dados, setDados] = useState<{
    atual: api.TriagemResumo;
    historico: api.TriagemCompleta[];
  } | null>(null);
  const [base, setBase] = useState<{
    perguntas: api.PerguntaDoParq[];
    termo: api.TermoVigente;
  } | null>(null);
  const [assinando, setAssinando] = useState(false);
  const [editandoPerguntas, setEditandoPerguntas] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    Promise.all([api.buscarTriagemDoAluno(alunoId), api.buscarPerguntasDaTriagem()])
      .then(([t, p]) => {
        setDados(t.data);
        setBase(p.data);
      })
      .catch((e: unknown) =>
        setErro(e instanceof api.ApiError ? e.message : 'Não foi possível carregar.'),
      );
  }, [alunoId, versao]);

  if (erro !== null) return <Erro mensagem={erro} />;
  if (dados === null || base === null) return <Carregando rotulo="Carregando a triagem" />;

  const recarregar = (): void => {
    setAssinando(false);
    setVersao((v) => v + 1);
  };

  const aguardando = dados.historico.find(
    (h) => h.precisaLiberacaoMedica && h.liberadoEm === null,
  );

  if (editandoPerguntas) {
    return (
      <EditorDePerguntas
        perguntas={base.perguntas}
        aoSair={() => setEditandoPerguntas(false)}
        aoSalvar={() => {
          setEditandoPerguntas(false);
          recarregar();
        }}
      />
    );
  }

  return (
    <div className="tri-aba">
      <div className="tri-situacao">
        <span className={`pilula ${TOM_DA_TRIAGEM[dados.atual.situacao]}`}>
          {ROTULO_DA_TRIAGEM[dados.atual.situacao]}
        </span>
        {dados.atual.validoAte !== null && dados.atual.situacao !== 'NUNCA_ASSINOU' && (
          <span className="tri-validade">
            {dados.atual.situacao === 'VENCIDA' ? 'Venceu em ' : 'Vale até '}
            {dataCurta(dados.atual.validoAte)}
          </span>
        )}
        {!assinando && (
          <button type="button" className="botao-acao" onClick={() => setAssinando(true)}>
            {dados.atual.situacao === 'NUNCA_ASSINOU' ? 'Preencher agora' : 'Renovar'}
          </button>
        )}
        {/* A EDIÇÃO DO QUESTIONÁRIO MORA AQUI, ao lado de onde ele é
            usado. Numa tela de configurações à parte, quem percebe que
            falta uma pergunta é quem está preenchendo — e essa pessoa
            nunca vai procurar em Configurações. */}
        {podeConfigurar && !assinando && (
          <button
            type="button"
            className="botao-texto"
            onClick={() => setEditandoPerguntas(true)}
          >
            Editar as perguntas
          </button>
        )}
      </div>

      {dados.atual.situacao === 'NUNCA_ASSINOU' && !assinando && (
        <p className="tri-nota-forte">
          Este aluno nunca respondeu ao PAR-Q nem assinou o termo. Se ele passar mal treinando,
          a academia não tem nada que mostre o que perguntou sobre a saúde dele.
        </p>
      )}

      {aguardando !== undefined && (
        <div className="tri-liberacao">
          <p>
            O PAR-Q assinado em {dataCurta(aguardando.assinadaEm!)} teve pelo menos um{' '}
            <strong>Sim</strong>. Falta a liberação médica.
          </p>
          <button
            type="button"
            className="botao-acao"
            onClick={() => {
              void api
                .liberarTriagem(aguardando.id)
                .then(recarregar)
                .catch((e: unknown) =>
                  setErro(e instanceof api.ApiError ? e.message : 'Não foi possível liberar.'),
                );
            }}
          >
            Registrar liberação médica
          </button>
          <span className="campo-dica">
            Anexe o atestado na aba Anexos antes de registrar — o documento é a prova, isto aqui
            é só o registro de que ele chegou.
          </span>
        </div>
      )}

      {assinando && (
        <>
          <p className="tri-nota">
            Preencha com o aluno na sua frente. O registro vai dizer que quem digitou foi a
            academia, e não ele — o que vale menos como prova do que a assinatura pelo
            aplicativo.
          </p>
          <FormularioDaTriagem
            perguntas={base.perguntas}
            termo={base.termo}
            nomeSugerido={nome}
            aoAssinar={async (d) => {
              await api.assinarTriagemPelaAcademia(alunoId, d);
              recarregar();
            }}
          />
          <button type="button" className="botao-texto" onClick={() => setAssinando(false)}>
            Cancelar
          </button>
        </>
      )}

      {dados.historico.length > 0 && !assinando && (
        <section className="tri-historico">
          <h3>Histórico</h3>
          {dados.historico.map((h) => (
            /* AS PERGUNTAS DA PRÓPRIA ASSINATURA, e não as de hoje. Ler o
               questionário atual para exibir uma assinatura antiga faria
               um "sim" de dois anos atrás responder a uma pergunta que
               nunca foi feita. As assinaturas anteriores a esta
               funcionalidade têm a lista vazia e caem no padrão. */
            <Registro
              key={h.id}
              triagem={h}
              perguntas={h.perguntas.length > 0 ? h.perguntas : base.perguntas}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function Registro({
  triagem: h,
  perguntas,
}: {
  triagem: api.TriagemCompleta;
  perguntas: api.PerguntaDoParq[];
}): ReactNode {
  const [aberto, setAberto] = useState(false);
  const sins = perguntas.filter((p) => h.respostas[p.chave] === true);

  return (
    <article className="tri-registro">
      <button type="button" className="tri-registro-topo" onClick={() => setAberto(!aberto)}>
        <span>
          {dataCurta(h.assinadaEm!)} · assinado por {h.assinadoNome}
          <span className="tri-origem">
            {h.assinadoPeloAluno ? 'pelo aplicativo' : 'pela academia'}
          </span>
        </span>
        <span aria-hidden="true">{aberto ? '−' : '+'}</span>
      </button>
      {aberto && (
        <div className="tri-registro-corpo">
          <p className="tri-resumo">
            {sins.length === 0
              ? 'Respondeu "não" a todas as perguntas.'
              : sins.length === 1
                ? 'Respondeu "sim" a 1 pergunta:'
                : `Respondeu "sim" a ${sins.length} perguntas:`}
          </p>
          {sins.length > 0 && (
            <ul className="tri-sins">
              {sins.map((p) => (
                <li key={p.chave}>{p.texto}</li>
              ))}
            </ul>
          )}
          {h.observacoes !== null && <p className="tri-obs">“{h.observacoes}”</p>}
          <details className="tri-termo">
            <summary>Termo assinado ({h.termoVersao})</summary>
            {/* O TEXTO VEM DA LINHA, e não do modelo de hoje. É a razão
                de a coluna existir: um termo assinado que muda quando a
                academia reescreve o modelo não prova nada. */}
            <pre>{h.termoTexto}</pre>
          </details>
        </div>
      )}
    </article>
  );
}

/** "2026-08-19" ou ISO → "19/08/2026", sem deslocar fuso. */
function dataCurta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

/* ==================================================================== */

/**
 * O editor do questionário da academia.
 *
 * A RESSALVA VAI NA TELA, e não só no código. O peso do PAR-Q vem de ele
 * ser O PAR-Q — questionário validado, revisado por sociedades de
 * medicina do esporte, que um perito reconhece. Quem edita precisa saber
 * disso no momento em que está editando, e não descobrir depois. Por
 * isso as perguntas do padrão vêm marcadas, e a de apagar avisa.
 *
 * ACRESCENTAR É O CAMINHO PRINCIPAL, e é onde o botão está. Editar a
 * redação existe (nem toda academia fala com o aluno do mesmo jeito) e
 * apagar uma do PAR-Q é o caminho estreito de propósito.
 *
 * CADA PERGUNTA DIZ SE ELA EXIGE ATESTADO. É a única configuração que
 * muda comportamento de verdade: "já treinou antes?" não pode mandar
 * ninguém ao médico, e "tem pino na articulação?" precisa mandar.
 */
export function EditorDePerguntas({
  perguntas,
  aoSair,
  aoSalvar,
}: {
  perguntas: api.PerguntaDoParq[];
  aoSair: () => void;
  aoSalvar: () => void;
}): ReactNode {
  const [lista, setLista] = useState<api.PerguntaEditavel[]>(() =>
    perguntas.map((p) => ({ ...p })),
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const mexer = (i: number, campo: 'texto' | 'exigeLiberacao', valor: string | boolean): void => {
    setLista((atual) => atual.map((p, k) => (k === i ? { ...p, [campo]: valor } : p)));
  };

  const mover = (i: number, passo: -1 | 1): void => {
    const destino = i + passo;
    if (destino < 0 || destino >= lista.length) return;
    setLista((atual) => {
      const copia = [...atual];
      const [item] = copia.splice(i, 1);
      copia.splice(destino, 0, item!);
      return copia;
    });
  };

  const doParq = lista.filter((p) => p.origem === 'PARQ').length;
  const valido = lista.length > 0 && lista.every((p) => p.texto.trim().length >= 8);

  const gravar = async (): Promise<void> => {
    setErro(null);
    setSalvando(true);
    try {
      await api.salvarPerguntasDaTriagem(
        lista.map((p) => ({
          ...(p.chave !== undefined ? { chave: p.chave } : {}),
          texto: p.texto.trim(),
          exigeLiberacao: p.exigeLiberacao,
          origem: p.origem,
        })),
      );
      aoSalvar();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível salvar.');
      setSalvando(false);
    }
  };

  return (
    <div className="ped">
      <div className="secao-cabecalho linha-cabecalho">
        <div>
          <h2>Perguntas da triagem</h2>
          <p>
            O que o aluno responde antes do primeiro treino — no aplicativo ou no balcão.
          </p>
        </div>
        <button type="button" className="botao-secundario" onClick={aoSair}>
          ← Voltar
        </button>
      </div>

      {/* O AVISO FICA NO ALTO E NÃO NO RODAPÉ. Quem vai reescrever sete
          perguntas precisa saber o que está em jogo antes de reescrever a
          primeira. */}
      <p className="ped-ressalva">
        <strong>As {doParq} perguntas marcadas como padrão são o PAR-Q</strong> — um questionário
        validado por sociedades de medicina do esporte, e o que um perito reconhece numa
        discussão sobre o que a academia perguntou. Ajustar a redação para a linguagem de quem
        atende aqui é seguro; <strong>apagar uma delas</strong> deixa a triagem de ser o PAR-Q.
        Acrescentar as suas perguntas não tira nada disso.
      </p>

      <ol className="ped-lista">
        {lista.map((p, i) => (
          <li key={p.chave ?? `nova-${i}`} className={p.origem === 'PARQ' ? 'padrao' : ''}>
            <div className="ped-cabeca">
              <span className="ped-n">{i + 1}</span>
              <span className={`pilula ${p.origem === 'PARQ' ? 'ok' : 'apagada'} pequena`}>
                {p.origem === 'PARQ' ? 'PAR-Q' : 'da academia'}
              </span>
              <span className="ped-mover">
                <button
                  type="button"
                  disabled={i === 0}
                  aria-label="Subir"
                  onClick={() => mover(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === lista.length - 1}
                  aria-label="Descer"
                  onClick={() => mover(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ped-tirar"
                  onClick={() => {
                    const aviso =
                      p.origem === 'PARQ'
                        ? 'Esta é uma pergunta do PAR-Q. Sem ela a triagem deixa de ser o questionário padrão — e a academia deixa de perguntar sobre isso. Tirar mesmo assim?'
                        : 'Tirar esta pergunta?';
                    if (window.confirm(aviso)) {
                      setLista((atual) => atual.filter((_, k) => k !== i));
                    }
                  }}
                >
                  tirar
                </button>
              </span>
            </div>

            <textarea
              value={p.texto}
              rows={2}
              maxLength={400}
              onChange={(e) => mexer(i, 'texto', e.target.value)}
            />

            <label className={`ped-exige ${p.origem === 'PARQ' ? 'travada' : ''}`}>
              <input
                type="checkbox"
                checked={p.exigeLiberacao}
                /* As do PAR-Q exigem sempre — é a regra do questionário, e
                   o servidor força isso de qualquer jeito. Travar aqui
                   evita oferecer um controle que não obedece. */
                disabled={p.origem === 'PARQ'}
                onChange={(e) => mexer(i, 'exigeLiberacao', e.target.checked)}
              />
              <span>
                Um <strong>Sim</strong> aqui exige atestado médico antes de treinar
                {p.origem === 'PARQ' && ' (sempre, no PAR-Q)'}
              </span>
            </label>
          </li>
        ))}
      </ol>

      <div className="ped-acoes">
        <button
          type="button"
          className="botao-secundario"
          onClick={() =>
            setLista((atual) => [
              ...atual,
              { texto: '', exigeLiberacao: false, origem: 'ACADEMIA' },
            ])
          }
        >
          + Acrescentar pergunta
        </button>

        <button
          type="button"
          className="botao-texto"
          onClick={() => {
            if (
              window.confirm(
                'Descartar as suas alterações e voltar às sete perguntas do PAR-Q padrão?',
              )
            ) {
              void api
                .restaurarPerguntasDaTriagem()
                .then(aoSalvar)
                .catch((e: unknown) =>
                  setErro(e instanceof api.ApiError ? e.message : 'Não foi possível restaurar.'),
                );
            }
          }}
        >
          Restaurar o PAR-Q padrão
        </button>
      </div>

      {erro !== null && <Erro mensagem={erro} />}

      <div className="ped-rodape">
        <span className="campo-dica">
          {lista.length === 1 ? '1 pergunta' : `${lista.length} perguntas`} · quem já assinou
          continua com o questionário do dia da assinatura.
        </span>
        <button
          type="button"
          className="botao-acao"
          disabled={salvando || !valido}
          onClick={() => void gravar()}
        >
          {salvando ? 'Salvando…' : 'Salvar o questionário'}
        </button>
      </div>
    </div>
  );
}
