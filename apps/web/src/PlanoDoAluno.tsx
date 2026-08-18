import { useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Erro } from './ui.jsx';
import { JanelaDeAtendimento } from './JanelaDeAtendimento.jsx';
import type { Principal } from './api.js';

/**
 * O plano do aluno e o fecho do cadastro.
 *
 * DUAS COISAS QUE O CADASTRO NÃO TINHA e sem as quais o fluxo não
 * fechava: quanto o aluno paga (e quanto disso é do professor) e o
 * primeiro horário dele na agenda. As duas ficam aqui porque acontecem
 * no mesmo minuto — quem cadastra alguém no balcão combina o valor e
 * marca a primeira aula na mesma conversa, e obrigar essa pessoa a
 * atravessar três telas depois é o que faz metade dos alunos ficar sem
 * contrato e sem horário no sistema.
 */

const CICLOS: { valor: api.CicloCobranca; nome: string }[] = [
  { valor: 'MONTHLY', nome: 'Mensal' },
  { valor: 'SESSION', nome: 'Por sessão' },
  { valor: 'WEEKLY', nome: 'Semanal' },
  { valor: 'BIWEEKLY', nome: 'Quinzenal' },
  { valor: 'QUARTERLY', nome: 'Trimestral' },
  { valor: 'SEMIANNUAL', nome: 'Semestral' },
  { valor: 'ANNUAL', nome: 'Anual' },
];

export interface DadosDoPlano {
  ciclo: api.CicloCobranca;
  valor: string;
  comissaoPercentual: string;
  diaDeCobranca: string;
  profissionalId: string;
}

export const planoVazio = (): DadosDoPlano => ({
  ciclo: 'MONTHLY',
  valor: '',
  comissaoPercentual: '',
  diaDeCobranca: '10',
  profissionalId: '',
});

/**
 * A seção "Plano e cobrança" do formulário do aluno.
 *
 * Fica DENTRO do `<form className="formulario">` do cadastro e usa as
 * mesmas classes de grade — por isso não abre um `<form>` próprio:
 * formulário aninhado é HTML inválido, e o navegador desfaz o de dentro
 * de um jeito que varia por navegador.
 */
export function SecaoDoPlano({
  plano,
  aoMudar,
  equipe,
  bloqueado,
}: {
  plano: DadosDoPlano;
  aoMudar: (p: DadosDoPlano) => void;
  equipe: api.Profissional[];
  bloqueado: boolean;
}): ReactNode {
  const mexer = (m: Partial<DadosDoPlano>): void => aoMudar({ ...plano, ...m });
  const porSessao = plano.ciclo === 'SESSION';

  return (
    <>
      <h2 className="formulario-secao campo-cheia">Plano e cobrança</h2>
      <p className="campo-cheia campo-dica">
        {bloqueado
          ? 'Só quem administra a academia define valor e comissão.'
          : 'Deixe o valor em branco se o aluno ainda não tem plano fechado. Dá para definir depois.'}
      </p>

      <label className="campo campo-terco">
        <span className="campo-rotulo">Valor</span>
        <input
          inputMode="decimal"
          value={plano.valor}
          onChange={(e) => mexer({ valor: e.target.value })}
          placeholder="349,90"
          disabled={bloqueado}
        />
        <span className="campo-dica">{porSessao ? 'por sessão' : 'a cada cobrança'}</span>
      </label>

      <label className="campo campo-terco">
        <span className="campo-rotulo">Periodicidade</span>
        <select
          value={plano.ciclo}
          onChange={(e) => mexer({ ciclo: e.target.value as api.CicloCobranca })}
          disabled={bloqueado}
        >
          {CICLOS.map((c) => (
            <option key={c.valor} value={c.valor}>
              {c.nome}
            </option>
          ))}
        </select>
      </label>

      <label className="campo campo-terco">
        <span className="campo-rotulo">Dia da cobrança</span>
        <input
          inputMode="numeric"
          value={porSessao ? '' : plano.diaDeCobranca}
          onChange={(e) => mexer({ diaDeCobranca: e.target.value })}
          placeholder="10"
          disabled={bloqueado || porSessao}
        />
        <span className="campo-dica">{porSessao ? 'não se aplica' : 'de 1 a 28'}</span>
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Professor responsável</span>
        <select
          value={plano.profissionalId}
          onChange={(e) => mexer({ profissionalId: e.target.value })}
          disabled={bloqueado}
        >
          <option value="">Nenhum</option>
          {equipe.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nome}
            </option>
          ))}
        </select>
        <span className="campo-dica">É de quem a comissão deste aluno será.</span>
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Porcentagem do professor</span>
        <input
          inputMode="decimal"
          value={plano.comissaoPercentual}
          onChange={(e) => mexer({ comissaoPercentual: e.target.value })}
          placeholder="30"
          disabled={bloqueado}
        />
        {/* A conta é feita sobre o que ENTROU, não sobre o cobrado — é o
            que impede a academia de dever comissão sobre inadimplência. */}
        <span className="campo-dica">
          Sobre o que o aluno efetivamente pagar. Em branco significa zero.
        </span>
      </label>
    </>
  );
}

/**
 * Grava o contrato depois que o aluno já existe.
 *
 * SEPARADO DO CADASTRO de propósito. Um aluno sem plano é um cadastro
 * legítimo — alguém que veio conhecer e ainda não fechou —, e falhar a
 * criação inteira porque o valor saiu com vírgula errada perderia os
 * dezoito campos que já estavam certos. Se isto falhar, o aluno já está
 * salvo e a tela seguinte diz o que faltou.
 */
export async function gravarPlano(alunoId: string, plano: DadosDoPlano): Promise<void> {
  if (plano.valor.trim() === '') return;
  await api.salvarContrato(alunoId, {
    ciclo: plano.ciclo,
    valor: plano.valor,
    comissaoPercentual: plano.comissaoPercentual.trim() === '' ? 0 : plano.comissaoPercentual,
    ...(plano.ciclo !== 'SESSION' && plano.diaDeCobranca.trim() !== ''
      ? { diaDeCobranca: Number(plano.diaDeCobranca) }
      : {}),
    ...(plano.profissionalId !== '' ? { profissionalId: plano.profissionalId } : {}),
  });
}

/* ====================================================================
 * O fecho: cadastro salvo, agora marca o primeiro horário
 * ================================================================== */

/**
 * A tela que aparece logo depois de cadastrar um aluno novo.
 *
 * NÃO É UMA CONFIRMAÇÃO — é o próximo passo. "Aluno cadastrado. [OK]"
 * devolve a pessoa para uma lista e a obriga a recomeçar noutra aba para
 * fazer a única coisa que ela ia fazer em seguida. Aqui o horário é
 * marcado sem sair do lugar.
 */
export function CadastroConcluido({
  alunoId,
  nome,
  principal,
  avisoDoPlano,
  aoAbrirFicha,
}: {
  alunoId: string;
  nome: string;
  principal: Principal;
  avisoDoPlano: string | null;
  aoAbrirFicha: () => void;
}): ReactNode {
  const [equipe, setEquipe] = useState<api.Profissional[]>([]);
  const [salas, setSalas] = useState<api.Sala[]>([]);
  const [profissional, setProfissional] = useState('');
  const [sala, setSala] = useState('');
  const [dia, setDia] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [hora, setHora] = useState('09:00');
  const [duracao, setDuracao] = useState(60);
  const [erro, setErro] = useState<string | null>(null);
  const [marcado, setMarcado] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    /* O PROFISSIONAL PADRÃO É O DO CONTRATO, e só na falta dele quem
       está logado. O aluno acabou de ser vinculado a um professor na
       tela anterior; abrir aqui com outro nome selecionado é oferecer o
       erro pronto para quem só vai apertar o botão. */
    void Promise.all([api.buscarProfissionais(), api.buscarContrato(alunoId).catch(() => null)])
      .then(([r, contrato]) => {
        const ativos = r.data.filter((p) => p.ativo);
        setEquipe(ativos);
        const doPlano = contrato?.data?.profissional?.id;
        setProfissional(
          (p) =>
            p ||
            (doPlano ??
              ativos.find((x) => x.id === principal.id)?.id ??
              ativos[0]?.id) ||
            '',
        );
      })
      .catch(() => undefined);
    api
      .buscarSalas()
      .then((r) => setSalas(r.data.filter((s) => s.ativa)))
      .catch(() => undefined);
  }, [principal.id, alunoId]);

  const marcar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      /* Monta a data em hora LOCAL e converte na hora do envio. Concatenar
         "2026-08-19T09:00Z" mandaria 9h de Londres, que aqui são 6h. */
      const [ano, mes, d] = dia.split('-').map(Number);
      const [h, min] = hora.split(':').map(Number);
      const inicio = new Date(ano!, mes! - 1, d!, h!, min!);
      await api.marcarCompromisso({
        studentId: alunoId,
        professionalId: profissional,
        ...(sala !== '' ? { roomId: sala } : {}),
        inicio: inicio.toISOString(),
        fim: new Date(inicio.getTime() + duracao * 60_000).toISOString(),
      });
      setMarcado(
        inicio.toLocaleDateString('pt-BR', {
          weekday: 'long',
          day: '2-digit',
          month: 'long',
        }) + ` às ${hora}`,
      );
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível marcar.');
    } finally {
      setEnviando(false);
    }
  };

  const podeMarcar = principal.permissions.includes('schedule:write');

  return (
    <>
      <div className="secao-cabecalho">
        <p className="plt-eyebrow">Cadastro concluído</p>
        <h1>{nome} está no sistema</h1>
        <p>Falta uma coisa só para o cadastro estar de pé: o primeiro horário.</p>
      </div>

      {avisoDoPlano !== null && (
        <div className="conc-aviso" role="alert">
          <strong>O aluno foi salvo, mas o plano não.</strong> {avisoDoPlano} Dá para definir o
          valor depois, pela ficha.
        </div>
      )}

      {!podeMarcar ? (
        <div className="conc-caixa">
          <p>Seu perfil não marca horários. Abra a ficha para continuar o atendimento.</p>
        </div>
      ) : marcado !== null ? (
        <div className="conc-caixa conc-pronto">
          <p>
            <strong>Horário marcado</strong> para {marcado}. Ele já aparece na agenda da academia.
          </p>
        </div>
      ) : (
        <form className="formulario conc-form" onSubmit={(e) => void marcar(e)} noValidate>
          <label className="campo campo-meia">
            <span className="campo-rotulo">Dia</span>
            <input type="date" value={dia} onChange={(e) => setDia(e.target.value)} required />
          </label>
          <label className="campo campo-terco">
            <span className="campo-rotulo">Hora</span>
            <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} required />
          </label>
          <label className="campo campo-terco">
            <span className="campo-rotulo">Duração</span>
            <select value={duracao} onChange={(e) => setDuracao(Number(e.target.value))}>
              {[30, 45, 60, 90].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Profissional</span>
            <select value={profissional} onChange={(e) => setProfissional(e.target.value)}>
              {equipe.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
            {/* A janela de atendimento aparece AQUI, antes do botão. Sem
                isto a pessoa escolhe, envia e só então descobre que
                aquele profissional nunca trabalhou de manhã. */}
            <JanelaDeAtendimento
              profissionalId={profissional}
              dia={dia}
              hora={hora}
              {...(principal.timezone !== undefined ? { fuso: principal.timezone } : {})}
            />
          </label>

          {salas.length > 0 && (
            <label className="campo campo-meia">
              <span className="campo-rotulo">Espaço</span>
              <select value={sala} onChange={(e) => setSala(e.target.value)}>
                <option value="">Sem espaço definido</option>
                {salas.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nome}
                  </option>
                ))}
              </select>
            </label>
          )}

          {erro !== null && (
            <div className="mensagem-erro campo-cheia" role="alert">
              <p>{erro}</p>
              {/* A recusa mais comum é horário fora da janela de
                  atendimento, e a mensagem crua não diz onde arrumar. */}
              <p className="campo-dica">
                Se o sistema disser que o horário está indisponível, confira os Horários de
                atendimento desse profissional, na aba Agenda.
              </p>
            </div>
          )}

          {/* UM caminho de saída, não dois. "Marcar depois" e "Abrir a
              ficha" levavam ao mesmo lugar por botões de peso
              diferente, e dois destaques na mesma tela significam
              nenhum. */}
          <div className="formulario-acoes campo-cheia">
            <button type="button" className="botao-secundario" onClick={aoAbrirFicha}>
              Marcar depois
            </button>
            <button type="submit" className="botao-acao" disabled={enviando}>
              {enviando ? 'Marcando…' : 'Marcar primeiro horário'}
            </button>
          </div>
        </form>
      )}

      {(marcado !== null || !podeMarcar) && (
        <div className="formulario-acoes">
          <button type="button" className="botao-acao" onClick={aoAbrirFicha}>
            Abrir a ficha de {nome.split(' ')[0]}
          </button>
        </div>
      )}
    </>
  );
}

/** Carrega a equipe uma vez, para a seção do plano. */
export function useEquipe(): api.Profissional[] {
  const [equipe, setEquipe] = useState<api.Profissional[]>([]);
  useEffect(() => {
    api
      .buscarProfissionais()
      .then((r) => setEquipe(r.data.filter((p) => p.ativo)))
      .catch(() => undefined);
  }, []);
  return equipe;
}

/** O plano já gravado de um aluno, para a tela de edição. */
export function usePlanoExistente(alunoId: string | undefined): DadosDoPlano | null {
  const [plano, setPlano] = useState<DadosDoPlano | null>(null);
  useEffect(() => {
    if (alunoId === undefined) return;
    api
      .buscarContrato(alunoId)
      .then((r) => {
        const c = r.data;
        if (c === null) return;
        setPlano({
          ciclo: c.ciclo,
          /* Centavos para o texto que a pessoa digitaria: 34990 vira
             "349,90", e não "349.9". */
          valor: (c.valorCentavos / 100).toFixed(2).replace('.', ','),
          comissaoPercentual:
            c.comissaoBp === 0 ? '' : String(c.comissaoPercentual).replace('.', ','),
          diaDeCobranca: c.diaDeCobranca === null ? '' : String(c.diaDeCobranca),
          profissionalId: c.profissional?.id ?? '',
        });
      })
      .catch(() => undefined);
  }, [alunoId]);
  return plano;
}

export { Erro as ErroDoPlano };
