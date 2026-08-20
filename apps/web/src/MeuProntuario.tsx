import { useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { FormularioDaTriagem } from './Triagem.jsx';
import { Cartao } from './Carteirinha.jsx';

/**
 * A aba "Eu" do aplicativo do aluno: carteirinha, anamneses e exames.
 *
 * A FOTO É EXIGIDA AQUI, e não numa parede antes de entrar. Bloquear o
 * aplicativo inteiro até o aluno tirar uma foto é o tipo de exigência
 * que faz a pessoa desistir na porta — ela abriu o app às seis da manhã
 * para ver o treino, não para resolver pendência de cadastro. O pedido
 * aparece no alto, insistente e impossível de ignorar, e o resto
 * continua funcionando.
 *
 * AS ANAMNESES SÃO SOMENTE LEITURA. Ele tem direito de ver o que
 * escreveram sobre a saúde dele; não tem direito de editar, porque
 * anamnese é registro clínico assinado por quem atendeu.
 *
 * OS EXAMES QUE ELE VÊ SÃO OS QUE ELE MESMO ENVIOU. Laudo, avaliação
 * interna e observação clínica ficam de fora: não são para o paciente
 * descobrir sozinho pelo aplicativo, e sim numa consulta, com alguém do
 * lado para explicar.
 */

const TAMANHO_MAXIMO_MB = 15;

export function MeuProntuario(): ReactNode {
  const [carteirinha, setCarteirinha] = useState<api.MinhaCarteirinha | null>(null);
  const [foto, setFoto] = useState<string | null>(null);
  const [versaoDaFoto, setVersaoDaFoto] = useState(0);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api
      .buscarMinhaCarteirinha()
      .then((r) => setCarteirinha(r.data))
      .catch((e: unknown) =>
        setErro(e instanceof api.ApiError ? e.message : 'Não foi possível carregar.'),
      );
  }, []);

  useEffect(() => {
    let vivo = true;
    let atual: string | null = null;
    void api.baixarMinhaFoto().then((url) => {
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
  }, [versaoDaFoto]);

  /* DUAS COISAS PRECISAM MUDAR ao enviar a foto: o blob, para o cartão
     mostrar a imagem nova, e o `temFoto` da carteirinha, para o pedido
     sumir. Atualizar só o primeiro deixava a foto aparecer no cartão com
     o aviso "Falta a sua foto" logo acima — o que se lê como defeito. */
  const aoTrocarFoto = (): void => {
    setVersaoDaFoto((v) => v + 1);
    setCarteirinha((c) => (c === null ? null : { ...c, temFoto: true }));
  };

  if (erro !== null) return <p className="app-erro">{erro}</p>;
  if (carteirinha === null) return <p className="app-carregando">Carregando…</p>;

  return (
    <div className="app-eu">
      {/* A TRIAGEM VEM ANTES DA FOTO. As duas são pendências de
          cadastro, mas só uma delas envolve a possibilidade de alguém
          passar mal treinando. Quando as duas faltam, é a de saúde que
          tem que estar no alto. */}
      <MinhaTriagem />

      {!carteirinha.temFoto && <PedidoDeFoto aoEnviar={aoTrocarFoto} />}

      <MinhaCarteirinha dados={carteirinha} foto={foto} />

      {carteirinha.temFoto && <TrocarFoto aoEnviar={aoTrocarFoto} />}

      <MinhasAnamneses />
      <MeusExames />
    </div>
  );
}

/* ==================================================================== */

/**
 * A carteirinha no aplicativo.
 *
 * É O MESMO COMPONENTE DO SISTEMA, e não uma segunda versão. Antes eram
 * dois desenhos com as mesmas informações — um em `.app-cart-*` e outro
 * em `.cart-*` — e nada garantia que continuassem parecidos. Um cartão
 * que muda de cara conforme onde é aberto não é um documento; e o aluno
 * mostra o celular para a mesma recepcionista que vê o cartão impresso.
 */
function MinhaCarteirinha({
  dados,
  foto,
}: {
  dados: api.MinhaCarteirinha;
  foto: string | null;
}): ReactNode {
  return (
    <div className="app-carteirinha">
      <Cartao
        ficha={{ id: '', nome: dados.nome, codigo: dados.codigo, status: dados.status }}
        foto={foto}
        academia={dados.academia}
        desde={dados.desde}
        compacto
      />
    </div>
  );
}

/* ==================================================================== */

/**
 * O pedido de foto.
 *
 * INSISTENTE E NÃO BLOQUEANTE. Uma parede antes do app faz a pessoa
 * desistir na porta; um aviso discreto no rodapé nunca é lido. Isto
 * fica no alto, com cor, e some sozinho quando a foto chega.
 */
function PedidoDeFoto({ aoEnviar }: { aoEnviar: () => void }): ReactNode {
  return (
    <section className="app-pedido">
      <h2>Falta a sua foto</h2>
      <p>
        Ela aparece na sua carteirinha e é como a recepção reconhece você. Leva dez segundos.
      </p>
      <Envio rotulo="Tirar ou escolher foto" destaque aoEnviar={aoEnviar} />
    </section>
  );
}

function TrocarFoto({ aoEnviar }: { aoEnviar: () => void }): ReactNode {
  return <Envio rotulo="Trocar a foto" aoEnviar={aoEnviar} />;
}

function Envio({
  rotulo,
  destaque = false,
  aoEnviar,
}: {
  rotulo: string;
  destaque?: boolean;
  aoEnviar: () => void;
}): ReactNode {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const escolher = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (arquivo === undefined) return;
    setErro(null);
    setEnviando(true);
    try {
      await api.enviarMinhaFoto(arquivo);
      aoEnviar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível enviar.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      <label className={destaque ? 'app-botao' : 'app-botao-fraco'}>
        {enviando ? 'Enviando…' : rotulo}
        {/* `capture` faz o celular abrir a câmera direto em vez da
            galeria. É a diferença entre tirar a foto agora e prometer
            procurar uma depois. */}
        <input
          type="file"
          accept="image/*"
          capture="user"
          onChange={(e) => void escolher(e)}
          disabled={enviando}
        />
      </label>
      {erro !== null && <p className="app-erro-linha">{erro}</p>}
    </>
  );
}

/* ==================================================================== */

function MinhasAnamneses(): ReactNode {
  const [lista, setLista] = useState<api.MinhaAnamnese[] | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);

  useEffect(() => {
    api
      .buscarMinhasAnamneses()
      .then((r) => setLista(r.data))
      .catch(() => setLista([]));
  }, []);

  if (lista === null) return null;

  return (
    <section className="app-bloco">
      <h2>Minha anamnese</h2>
      {lista.length === 0 ? (
        <p className="app-vazio">
          Ainda não foi preenchida. Ela é feita na academia, com o profissional que te atende.
        </p>
      ) : (
        lista.map((a) => (
          <article key={a.id} className="app-anamnese">
            <button
              type="button"
              className="app-anamnese-topo"
              aria-expanded={aberta === a.id}
              onClick={() => setAberta(aberta === a.id ? null : a.id)}
            >
              <span>
                {new Date(a.criadoEm).toLocaleDateString('pt-BR')}
                {a.profissional !== null && ` · ${a.profissional}`}
              </span>
              <span aria-hidden="true">{aberta === a.id ? '−' : '+'}</span>
            </button>
            {aberta === a.id && (
              <dl className="app-anamnese-corpo">
                {Object.entries(a.respostas)
                  .filter(([, v]) => v !== null && v !== '' && v !== false)
                  .map(([campo, valor]) => (
                    <div key={campo}>
                      <dt>{rotuloDoCampo(campo)}</dt>
                      <dd>{formatarResposta(valor)}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </article>
        ))
      )}
      {/* Dizer que é leitura evita a pergunta "como eu corrijo isso
          aqui" — que vira uma ligação para a recepção. */}
      <p className="app-nota">
        Só leitura. Para corrigir alguma coisa, fale com quem te atende.
      </p>
    </section>
  );
}

/** `dor_lombar` → `Dor lombar`. */
function rotuloDoCampo(campo: string): string {
  const texto = campo.replace(/_/g, ' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function formatarResposta(valor: unknown): string {
  if (valor === true) return 'Sim';
  if (Array.isArray(valor)) return valor.join(', ');
  if (typeof valor === 'object' && valor !== null) return JSON.stringify(valor);
  return String(valor);
}

/* ==================================================================== */

function MeusExames(): ReactNode {
  const [lista, setLista] = useState<api.MeuExame[] | null>(null);
  const [descricao, setDescricao] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    api
      .buscarMeusExames()
      .then((r) => setLista(r.data))
      .catch(() => setLista([]));
  }, [versao]);

  const escolher = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (arquivo === undefined) return;
    if (arquivo.size > TAMANHO_MAXIMO_MB * 1024 * 1024) {
      setErro(`O arquivo tem mais de ${TAMANHO_MAXIMO_MB} MB. Envie um menor.`);
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      await api.enviarMeuExame(arquivo, descricao.trim());
      setDescricao('');
      setVersao((v) => v + 1);
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível enviar.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <section className="app-bloco">
      <h2>Meus exames</h2>
      <p className="app-nota">
        Envie aqui o que a academia precisa ver — exame de sangue, laudo, atestado. Fica guardado
        no seu prontuário.
      </p>

      <label className="app-campo">
        <span>O que é este arquivo?</span>
        <input
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
          placeholder="Hemograma de março"
          maxLength={300}
        />
      </label>

      <label className="app-botao-fraco">
        {enviando ? 'Enviando…' : 'Escolher arquivo'}
        <input
          type="file"
          accept="application/pdf,image/*"
          onChange={(e) => void escolher(e)}
          disabled={enviando}
        />
      </label>
      {erro !== null && <p className="app-erro-linha">{erro}</p>}

      {lista !== null && lista.length > 0 && (
        <ul className="app-exames">
          {lista.map((x) => (
            <li key={x.id}>
              <span className="app-exame-nome">{x.descricao ?? x.nome}</span>
              <span className="app-exame-meta">
                {new Date(x.criadoEm).toLocaleDateString('pt-BR')} ·{' '}
                {Math.max(1, Math.round(x.tamanhoBytes / 1024))} KB
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ==================================================================== */

/**
 * O PAR-Q e o termo, no aplicativo.
 *
 * QUEM JÁ ASSINOU NÃO VÊ QUASE NADA — uma linha dizendo até quando vale.
 * Manter o formulário à vista para quem já respondeu faria a pessoa
 * responder de novo por engano, e cada assinatura nova é um documento
 * novo no prontuário dela.
 *
 * QUEM NÃO ASSINOU VÊ UM PEDIDO QUE NÃO DÁ PARA IGNORAR, e ainda assim
 * NÃO É UMA PAREDE. Bloquear o aplicativo inteiro até a pessoa responder
 * sete perguntas às seis da manhã é como se perde o aluno na porta. O
 * que se ganha barrando é uma assinatura apressada; o que se perde é a
 * pessoa.
 */
function MinhaTriagem(): ReactNode {
  const [dados, setDados] = useState<{
    perguntas: api.PerguntaDoParq[];
    termo: api.TermoVigente;
    atual: api.TriagemResumo;
  } | null>(null);
  const [abrindo, setAbrindo] = useState(false);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    api
      .buscarMinhaTriagem()
      .then((r) => setDados(r.data))
      .catch(() => setDados(null));
  }, [versao]);

  if (dados === null) return null;

  const { situacao } = dados.atual;

  if (situacao === 'VALIDA' && !abrindo) {
    return (
      <section className="app-bloco app-triagem-ok">
        <h2>Ficha de saúde</h2>
        <p className="app-nota">
          Em dia
          {dados.atual.validoAte !== null && ` até ${dataBr(dados.atual.validoAte)}`}. Se alguma
          coisa mudar na sua saúde, avise a academia.
        </p>
      </section>
    );
  }

  if (situacao === 'AGUARDANDO_ATESTADO' && !abrindo) {
    return (
      <section className="app-pedido">
        <h2>Falta o seu atestado</h2>
        <p>
          Você respondeu <strong>Sim</strong> a pelo menos uma pergunta da ficha de saúde. Traga
          uma liberação médica por escrito antes de começar a treinar — você pode enviá-la aqui
          mesmo, em <strong>Meus exames</strong>.
        </p>
      </section>
    );
  }

  if (!abrindo) {
    return (
      <section className="app-pedido">
        <h2>{situacao === 'VENCIDA' ? 'Sua ficha de saúde venceu' : 'Falta a sua ficha de saúde'}</h2>
        <p>
          {situacao === 'VENCIDA'
            ? 'Faz mais de um ano que você respondeu. Um minuto para atualizar.'
            : 'São sete perguntas de sim ou não, e um termo para ler. Leva um minuto e é o que permite treinar com segurança.'}
        </p>
        <button type="button" className="app-botao" onClick={() => setAbrindo(true)}>
          Preencher agora
        </button>
      </section>
    );
  }

  return (
    <section className="app-bloco app-triagem">
      <h2>Ficha de saúde</h2>
      <FormularioDaTriagem
        perguntas={dados.perguntas}
        termo={dados.termo}
        nomeSugerido="Seu nome completo"
        prefixo="app-tri"
        aoAssinar={async (d) => {
          await api.assinarMinhaTriagem(d);
          setAbrindo(false);
          setVersao((v) => v + 1);
        }}
      />
      <button type="button" className="app-botao-fraco" onClick={() => setAbrindo(false)}>
        Deixar para depois
      </button>
    </section>
  );
}

/** "2026-08-19" → "19/08/2026", sem passar por Date e sem deslocar fuso. */
function dataBr(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
