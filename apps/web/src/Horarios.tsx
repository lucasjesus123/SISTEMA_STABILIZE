import { useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Erro } from './ui.jsx';

/**
 * A janela semanal de um profissional.
 *
 * ARQUIVO PRÓPRIO, e não mais dentro de `Agenda.tsx`, porque agora ele
 * tem DOIS pontos de entrada: a Agenda (onde se pensa em horário) e o
 * cadastro da pessoa (onde se procura pelo profissional). Um componente,
 * um caminho de gravação, duas portas.
 *
 * ISTO QUASE VIROU DUAS TELAS. Eu procurei "disponibilidade" no código,
 * não achei, concluí que a tela não existia e escrevi uma segunda dentro
 * do cadastro do usuário. Duas telas editando a mesma tabela é a receita
 * para uma delas envelhecer diferente e o operador não saber em qual
 * acreditar. Se um dia isto voltar a parecer ausente: o nome no código é
 * "Horários", não "disponibilidade".
 */

/* ====================================================================
 * Horários de atendimento
 * ================================================================== */

const DIAS_LONGOS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

interface Faixa {
  chave: string;
  diaDaSemana: number;
  inicio: string;
  fim: string;
  duracaoMinutos: number;
  salaId: string | null;
}

let contador = 0;
const novaChave = (): string => `f${++contador}`;

/**
 * A janela semanal de um profissional.
 *
 * ESTA TELA EXISTE PORQUE SEM ELA A AGENDA NÃO MARCA NADA. O servidor
 * recusa qualquer horário fora das faixas declaradas — corretamente —, e
 * um profissional recém-cadastrado tem zero faixas. Sem uma tela para
 * criá-las, a única resposta possível a qualquer tentativa de marcação
 * seria "horário indisponível", para sempre.
 *
 * A EDIÇÃO É DA SEMANA INTEIRA, e o botão salva tudo de uma vez. Faixa
 * apagada some de verdade: o PUT substitui, não acrescenta.
 */
export function Horarios({
  equipe,
  salas,
  inicial,
  podeEscolherProfissional,
  aoSair,
}: {
  equipe: api.Profissional[];
  salas: api.Sala[];
  /** Quem já vem escolhido. Vazio = o primeiro da lista. */
  inicial?: string | undefined;
  podeEscolherProfissional: boolean;
  aoSair: () => void;
}): ReactNode {
  const [quem, setQuem] = useState(
    /* `inicial` em vez do `principal` inteiro: o componente só usava o
       id para escolher o padrão, e pedir o Principal completo obrigava
       quem o chama do cadastro da pessoa a inventar um. */
    () => equipe.find((p) => p.id === inicial)?.id ?? equipe[0]?.id ?? '',
  );
  const [faixas, setFaixas] = useState<Faixa[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (quem === '') return;
    let vivo = true;
    setFaixas(null);
    setSalvo(false);
    api
      .buscarHorarios(quem)
      .then((r) => {
        if (!vivo) return;
        setFaixas(r.data.map((f) => ({ ...f, chave: novaChave() })));
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setFaixas([]);
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar os horários.');
      });
    return () => {
      vivo = false;
    };
  }, [quem]);

  const mexer = (chave: string, mudanca: Partial<Faixa>): void => {
    setSalvo(false);
    setFaixas((f) => f?.map((x) => (x.chave === chave ? { ...x, ...mudanca } : x)) ?? null);
  };

  const acrescentar = (dia: number): void => {
    setSalvo(false);
    setFaixas((f) => [
      ...(f ?? []),
      { chave: novaChave(), diaDaSemana: dia, inicio: '08:00', fim: '18:00', duracaoMinutos: 60, salaId: null },
    ]);
  };

  /* SEMANA COMERCIAL EM UM CLIQUE. É o que a maioria das academias
     precisa, e digitá-la à mão são dez campos e cinco chances de errar. */
  const preencherPadrao = (): void => {
    setSalvo(false);
    setFaixas(
      [1, 2, 3, 4, 5].map((dia) => ({
        chave: novaChave(),
        diaDaSemana: dia,
        inicio: '08:00',
        fim: '20:00',
        duracaoMinutos: 60,
        salaId: null,
      })),
    );
  };

  const salvar = async (): Promise<void> => {
    if (faixas === null) return;
    setErro(null);
    setSalvando(true);
    try {
      await api.salvarHorarios(
        quem,
        faixas.map(({ chave: _chave, ...f }) => f),
      );
      setSalvo(true);
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível salvar.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Voltar para a agenda
      </button>
      <div className="secao-cabecalho">
        <h1>Horários de atendimento</h1>
        <p>
          Os dias e as faixas em que este profissional recebe aluno. Fora daqui, o sistema recusa a
          marcação — inclusive a que o próprio aluno tentar pelo aplicativo.
        </p>
      </div>

      <div className="ag-filtros">
        <label className="campo ag-filtro">
          <span className="campo-rotulo">Profissional</span>
          <select
            value={quem}
            onChange={(e) => setQuem(e.target.value)}
            disabled={!podeEscolherProfissional}
          >
            {equipe.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
          {!podeEscolherProfissional && (
            <span className="campo-dica">Você edita os seus próprios horários.</span>
          )}
        </label>
      </div>

      {erro !== null && <Erro mensagem={erro} />}

      {faixas !== null && faixas.length === 0 && (
        <div className="hr-vazio">
          <p>
            <strong>Este profissional ainda não tem horário nenhum</strong>, e por isso nada pode
            ser marcado para ele.
          </p>
          <button type="button" className="botao-acao" onClick={preencherPadrao}>
            Usar segunda a sexta, 8h às 20h
          </button>
        </div>
      )}

      {faixas !== null && (
        <div className="hr-semana">
          {[1, 2, 3, 4, 5, 6, 0].map((dia) => {
            const doDia = faixas.filter((f) => f.diaDaSemana === dia);
            return (
              <section key={dia} className={`hr-dia ${doDia.length === 0 ? 'fechado' : ''}`}>
                <header>
                  <h2>{DIAS_LONGOS[dia]}</h2>
                  <button type="button" className="botao-texto" onClick={() => acrescentar(dia)}>
                    + faixa
                  </button>
                </header>

                {doDia.length === 0 ? (
                  <p className="hr-fechado">Fechado</p>
                ) : (
                  doDia.map((f) => (
                    <div key={f.chave} className="hr-faixa">
                      <input
                        type="time"
                        value={f.inicio}
                        onChange={(e) => mexer(f.chave, { inicio: e.target.value })}
                        aria-label="Início"
                      />
                      <span className="hr-ate">às</span>
                      <input
                        type="time"
                        value={f.fim}
                        onChange={(e) => mexer(f.chave, { fim: e.target.value })}
                        aria-label="Fim"
                      />
                      <select
                        value={f.duracaoMinutos}
                        onChange={(e) => mexer(f.chave, { duracaoMinutos: Number(e.target.value) })}
                        aria-label="Duração de cada atendimento"
                      >
                        {[30, 45, 60, 90].map((m) => (
                          <option key={m} value={m}>
                            {m} min
                          </option>
                        ))}
                      </select>
                      {salas.length > 0 && (
                        <select
                          value={f.salaId ?? ''}
                          onChange={(e) => mexer(f.chave, { salaId: e.target.value || null })}
                          aria-label="Espaço"
                        >
                          <option value="">Qualquer espaço</option>
                          {salas.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.nome}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        className="botao-texto-perigo"
                        onClick={() =>
                          setFaixas((v) => v?.filter((x) => x.chave !== f.chave) ?? null)
                        }
                      >
                        Remover
                      </button>
                    </div>
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}

      <div className="formulario-acoes">
        {salvo && <span className="aviso-salvo">Horários salvos.</span>}
        <button
          type="button"
          className="botao-acao"
          disabled={salvando || faixas === null}
          onClick={() => void salvar()}
        >
          {salvando ? 'Salvando…' : 'Salvar horários'}
        </button>
      </div>
    </>
  );
}

