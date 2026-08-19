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
export function AbaTriagem({ alunoId, nome }: { alunoId: string; nome: string }): ReactNode {
  const [dados, setDados] = useState<{
    atual: api.TriagemResumo;
    historico: api.TriagemCompleta[];
  } | null>(null);
  const [base, setBase] = useState<{
    perguntas: api.PerguntaDoParq[];
    termo: api.TermoVigente;
  } | null>(null);
  const [assinando, setAssinando] = useState(false);
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
            <Registro key={h.id} triagem={h} perguntas={base.perguntas} />
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
