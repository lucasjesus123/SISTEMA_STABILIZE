import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Carregando, Erro } from './ui.jsx';
import { e164ParaMascara, mascararTelefone, telefoneParaE164 } from '@stabilize/shared';

/**
 * CRM — quem ainda não é aluno.
 *
 * A TELA ABRE NA FILA, e não na lista. Uma lista de interessados é um
 * arquivo que ninguém consulta; a fila responde "com quem eu falo
 * hoje", com o mais atrasado no topo. É a diferença entre um CRM usado
 * e um CRM preenchido uma vez na semana de implantação.
 *
 * O ATRASO VEM DO SERVIDOR. Calcular "hoje menos a data" no navegador
 * faria a ordem da fila depender do relógio do celular de quem abriu —
 * e um aparelho com a data errada reordenaria o trabalho do dia sem
 * ninguém notar.
 */

const ORIGENS: { valor: string; rotulo: string }[] = [
  { valor: 'INDICACAO', rotulo: 'Indicação' },
  { valor: 'INSTAGRAM', rotulo: 'Instagram' },
  { valor: 'GOOGLE', rotulo: 'Google' },
  { valor: 'FACHADA', rotulo: 'Passou na porta' },
  { valor: 'WHATSAPP', rotulo: 'WhatsApp' },
  { valor: 'EVENTO', rotulo: 'Evento' },
  { valor: 'OUTRO', rotulo: 'Outro' },
];

const STATUS: { valor: string; rotulo: string }[] = [
  { valor: 'NOVO', rotulo: 'Novo' },
  { valor: 'CONTATADO', rotulo: 'Em conversa' },
  { valor: 'VISITOU', rotulo: 'Visitou' },
  { valor: 'MATRICULOU', rotulo: 'Matriculou' },
  { valor: 'PERDIDO', rotulo: 'Perdido' },
];

const rotulo = (lista: { valor: string; rotulo: string }[], v: string): string =>
  lista.find((x) => x.valor === v)?.rotulo ?? v;

const hojeIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * O atraso em palavras.
 *
 * "há 3 dias" e "em 2 dias" dizem o que "-2" não diz. E "hoje" é o caso
 * que mais aparece numa fila que funciona.
 */
function comoAtraso(dias: number | null): { texto: string; classe: string } {
  if (dias === null) return { texto: 'sem data', classe: 'sem-data' };
  if (dias > 0) return { texto: `há ${dias} dia${dias > 1 ? 's' : ''}`, classe: 'atrasado' };
  if (dias === 0) return { texto: 'hoje', classe: 'hoje' };
  const falta = -dias;
  return { texto: `em ${falta} dia${falta > 1 ? 's' : ''}`, classe: 'futuro' };
}

type Aba = 'fila' | 'todos' | 'funil';

export function Crm({ podeConverter }: { podeConverter: boolean }): ReactNode {
  const [aba, setAba] = useState<Aba>('fila');
  const [versao, setVersao] = useState(0);
  const [aberto, setAberto] = useState<string | null>(null);
  const [novo, setNovo] = useState(false);

  const recarregar = (): void => setVersao((v) => v + 1);

  return (
    <>
      <div className="secao-cabecalho">
        <h1>Interessados</h1>
        <p>
          Quem ainda não é aluno: ligou, veio conhecer, fez experimental. O que não fica aqui fica
          no caderno da recepção — ou não fica.
        </p>
      </div>

      <div className="crm-topo">
        <nav className="acad-abas" aria-label="Seções do CRM">
          {(
            [
              ['fila', 'Fila de hoje'],
              ['todos', 'Todos'],
              ['funil', 'Funil'],
            ] as const
          ).map(([id, nome]) => (
            <button
              key={id}
              type="button"
              className={`acad-aba ${aba === id ? 'ativa' : ''}`}
              aria-current={aba === id ? 'true' : undefined}
              onClick={() => setAba(id)}
            >
              {nome}
            </button>
          ))}
        </nav>
        <button type="button" className="botao-acao" onClick={() => setNovo(true)}>
          Novo interessado
        </button>
      </div>

      {novo && (
        <FormularioDeLead
          aoFechar={() => setNovo(false)}
          aoSalvar={() => {
            setNovo(false);
            recarregar();
          }}
        />
      )}

      {aba === 'funil' ? (
        <Funil versao={versao} />
      ) : (
        <Lista modo={aba} versao={versao} aoAbrir={setAberto} />
      )}

      {aberto !== null && (
        <Ficha
          id={aberto}
          podeConverter={podeConverter}
          aoFechar={() => setAberto(null)}
          aoMudar={recarregar}
        />
      )}
    </>
  );
}

/* ==================================================================
 * A fila e a lista
 * ================================================================ */

function Lista({
  modo,
  versao,
  aoAbrir,
}: {
  modo: 'fila' | 'todos';
  versao: number;
  aoAbrir: (id: string) => void;
}): ReactNode {
  const [leads, setLeads] = useState<api.Lead[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');

  useEffect(() => {
    let vivo = true;
    setLeads(null);
    const p = modo === 'fila' ? api.listarFila() : api.listarLeads(status, busca);
    p.then((r) => vivo && setLeads(r.data)).catch((e: unknown) => {
      if (vivo) setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar.');
    });
    return () => {
      vivo = false;
    };
  }, [modo, versao, status, busca]);

  if (erro !== null) return <Erro mensagem={erro} />;

  return (
    <>
      {modo === 'todos' && (
        <div className="crm-filtros">
          <input
            type="search"
            placeholder="Procurar por nome"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          {/* `aria-label` porque nao ha <label> visivel: o filtro fica ao
              lado da busca e o rotulo seria ruido. Sem ele, quem usa
              leitor de tela ouve "caixa de combinacao" e mais nada. */}
          <select
            value={status}
            aria-label="Filtrar por etapa"
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Todas as etapas</option>
            {STATUS.map((s) => (
              <option key={s.valor} value={s.valor}>
                {s.rotulo}
              </option>
            ))}
          </select>
        </div>
      )}

      {leads === null ? (
        <Carregando rotulo="Carregando" />
      ) : leads.length === 0 ? (
        <div className="estado-vazio">
          <p>
            {modo === 'fila' ? (
              <>
                <strong>Nada na fila.</strong> Ninguém com contato marcado para hoje ou atrasado.
              </>
            ) : (
              <>
                <strong>Nenhum interessado ainda.</strong> Cadastre quem ligar perguntando preço —
                é o registro mais barato de fazer e o mais caro de perder.
              </>
            )}
          </p>
        </div>
      ) : (
        <table className="tabela crm-tabela">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Origem</th>
              <th>Etapa</th>
              <th>Responsável</th>
              <th>Contatos</th>
              <th>{modo === 'fila' ? 'Falar' : 'Próximo contato'}</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const a = comoAtraso(l.atrasoDias);
              return (
                <tr key={l.id} onClick={() => aoAbrir(l.id)} className="clicavel">
                  <td>
                    <strong>{l.nome}</strong>
                    {l.whatsapp !== null && (
                      <span className="crm-zap">{e164ParaMascara(l.whatsapp)}</span>
                    )}
                  </td>
                  <td>{rotulo(ORIGENS, l.origem)}</td>
                  <td>
                    <span className={`crm-selo ${l.status.toLowerCase()}`}>
                      {rotulo(STATUS, l.status)}
                    </span>
                  </td>
                  <td>{l.responsavel ?? '—'}</td>
                  <td>{l.contatos === 0 ? '—' : l.contatos}</td>
                  <td>
                    <span className={`crm-prazo ${a.classe}`}>{a.texto}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ==================================================================
 * O funil
 * ================================================================ */

function Funil({ versao }: { versao: number }): ReactNode {
  const [dados, setDados] = useState<api.Funil | null>(null);
  const [dias, setDias] = useState(90);

  useEffect(() => {
    let vivo = true;
    setDados(null);
    void api
      .buscarFunil(dias)
      .then((r) => vivo && setDados(r.data))
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [dias, versao]);

  if (dados === null) return <Carregando rotulo="Somando o funil" />;

  const maior = Math.max(1, ...dados.etapas.map((e) => e.quantos));

  return (
    <section className="crm-funil">
      <div className="crm-funil-topo">
        <select
          value={dias}
          aria-label="Período do funil"
          onChange={(e) => setDias(Number(e.target.value))}
        >
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
          <option value={365}>Último ano</option>
        </select>
      </div>

      <div className="crm-indicadores">
        <div>
          <span className="crm-ind-rotulo">Interessados</span>
          <strong>{dados.total}</strong>
        </div>
        <div>
          <span className="crm-ind-rotulo">Já decidiram</span>
          <strong>{dados.decididos}</strong>
        </div>
        <div>
          <span className="crm-ind-rotulo">Conversão</span>
          <strong>{dados.conversao === null ? '—' : `${dados.conversao}%`}</strong>
        </div>
      </div>

      {/* A CONTA É SOBRE QUEM DECIDIU, e a tela diz isso em vez de deixar
          a pessoa supor. Uma taxa de conversão sem denominador declarado
          é um número que cada um interpreta de um jeito. */}
      <p className="rel-apoio">
        A conversão é sobre quem já decidiu — matriculou ou foi perdido. Quem ainda está em
        conversa não entra na conta: contá-lo como não-convertido faria a taxa piorar sozinha só
        porque entraram interessados novos.
      </p>

      <div className="crm-etapas">
        {dados.etapas.map((e) => (
          <div key={e.status} className="crm-etapa">
            <span className="crm-etapa-nome">{rotulo(STATUS, e.status)}</span>
            <span
              className={`crm-etapa-barra ${e.status.toLowerCase()}`}
              style={{ width: `${(e.quantos / maior) * 100}%` }}
            />
            <span className="crm-etapa-num">{e.quantos}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ==================================================================
 * A ficha do interessado
 * ================================================================ */

function Ficha({
  id,
  podeConverter,
  aoFechar,
  aoMudar,
}: {
  id: string;
  podeConverter: boolean;
  aoFechar: () => void;
  aoMudar: () => void;
}): ReactNode {
  const [lead, setLead] = useState<api.LeadDetalhe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [proximo, setProximo] = useState('');
  const [novoStatus, setNovoStatus] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [editando, setEditando] = useState(false);

  const carregar = useCallback(async (): Promise<void> => {
    try {
      const { data } = await api.buscarLead(id);
      setLead(data);
      setProximo(data.proximoContato ?? '');
      setNovoStatus(data.status);
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar.');
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const registrar = async (): Promise<void> => {
    if (texto.trim() === '') return;
    setOcupado(true);
    setErro(null);
    try {
      await api.registrarContato(id, {
        texto: texto.trim(),
        proximoContato: proximo === '' ? null : proximo,
        ...(novoStatus !== '' && novoStatus !== 'MATRICULOU' ? { status: novoStatus } : {}),
      });
      setTexto('');
      await carregar();
      aoMudar();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível registrar.');
    } finally {
      setOcupado(false);
    }
  };

  const converter = async (): Promise<void> => {
    const cpf = window.prompt(
      'Converter em aluno.\n\nCPF (opcional agora — é o login do aplicativo dele, dá para preencher depois):',
      '',
    );
    if (cpf === null) return;
    setOcupado(true);
    setErro(null);
    try {
      await api.converterLead(id, cpf.replace(/\D/g, ''));
      aoMudar();
      aoFechar();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível converter.');
    } finally {
      setOcupado(false);
    }
  };

  if (lead === null) {
    return (
      <div className="crm-painel" role="dialog" aria-label="Interessado">
        <Carregando rotulo="Carregando" />
      </div>
    );
  }

  const convertido = lead.status === 'MATRICULOU';

  return (
    <div className="crm-painel" role="dialog" aria-label={`Interessado ${lead.nome}`}>
      <div className="crm-painel-topo">
        <div>
          <h2>{lead.nome}</h2>
          <span className={`crm-selo ${lead.status.toLowerCase()}`}>
            {rotulo(STATUS, lead.status)}
          </span>
        </div>
        <button type="button" className="botao-texto" onClick={aoFechar}>
          Fechar
        </button>
      </div>

      {erro !== null && (
        <div className="mensagem-erro" role="alert">
          <p>{erro}</p>
        </div>
      )}

      {convertido ? (
        /* UM LEAD CONVERTIDO É HISTÓRIA. Não se edita — reescrever
           apagaria o registro de como aquele aluno chegou, que é o
           único motivo de guardar isto depois da matrícula. */
        <p className="crm-convertido">
          <strong>Virou aluno</strong>
          {lead.convertidoEm !== null &&
            ` em ${new Date(lead.convertidoEm).toLocaleDateString('pt-BR')}`}
          . O cadastro agora é o do aluno; este registro fica como histórico de origem.
        </p>
      ) : editando ? (
        <FormularioDeLead
          lead={lead}
          aoFechar={() => setEditando(false)}
          aoSalvar={() => {
            setEditando(false);
            void carregar();
            aoMudar();
          }}
        />
      ) : (
        <>
          <dl className="crm-dados">
            <div>
              <dt>WhatsApp</dt>
              <dd>{lead.whatsapp === null ? '—' : e164ParaMascara(lead.whatsapp)}</dd>
            </div>
            <div>
              <dt>Origem</dt>
              <dd>{rotulo(ORIGENS, lead.origem)}</dd>
            </div>
            <div>
              <dt>Responsável</dt>
              <dd>{lead.responsavel ?? '—'}</dd>
            </div>
            <div>
              <dt>Interesse</dt>
              <dd>{lead.interesse ?? '—'}</dd>
            </div>
          </dl>

          <div className="crm-acoes">
            <button type="button" className="botao-secundario" onClick={() => setEditando(true)}>
              Editar dados
            </button>
            {podeConverter && (
              <button
                type="button"
                className="botao-acao"
                disabled={ocupado}
                onClick={() => void converter()}
              >
                Virou aluno
              </button>
            )}
          </div>

          {/* REGISTRAR A CONVERSA E MARCAR O PRÓXIMO NO MESMO LUGAR.
              Separar em dois passos é como o CRM para de ser
              atualizado: anota-se a conversa, fecha-se a tela, e o
              próximo contato nunca é marcado. */}
          <section className="crm-registrar">
            <h3>Registrar contato</h3>
            <textarea
              rows={3}
              placeholder="O que foi conversado?"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <div className="crm-registrar-linha">
              <label className="campo">
                <span className="campo-rotulo">Voltar a falar em</span>
                <input
                  type="date"
                  value={proximo}
                  min={hojeIso()}
                  onChange={(e) => setProximo(e.target.value)}
                />
              </label>
              <label className="campo">
                <span className="campo-rotulo">Etapa</span>
                <select value={novoStatus} onChange={(e) => setNovoStatus(e.target.value)}>
                  {STATUS.filter((s) => s.valor !== 'MATRICULOU').map((s) => (
                    <option key={s.valor} value={s.valor}>
                      {s.rotulo}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="botao-acao"
                disabled={ocupado || texto.trim() === ''}
                onClick={() => void registrar()}
              >
                {ocupado ? 'Salvando…' : 'Registrar'}
              </button>
            </div>
          </section>
        </>
      )}

      <section className="crm-historico">
        <h3>Histórico</h3>
        {lead.historico.length === 0 ? (
          <p className="cart-nota">Nenhum contato registrado ainda.</p>
        ) : (
          <ol>
            {lead.historico.map((h) => (
              <li key={h.id}>
                <p>{h.texto}</p>
                <span>
                  {h.autor ?? 'alguém'} · {new Date(h.em).toLocaleString('pt-BR')}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/* ==================================================================
 * O formulário
 * ================================================================ */

function FormularioDeLead({
  lead,
  aoFechar,
  aoSalvar,
}: {
  lead?: api.LeadDetalhe;
  aoFechar: () => void;
  aoSalvar: () => void;
}): ReactNode {
  const [nome, setNome] = useState(lead?.nome ?? '');
  const [whatsapp, setWhatsapp] = useState(e164ParaMascara(lead?.whatsapp ?? null));
  const [origem, setOrigem] = useState(lead?.origem ?? 'OUTRO');
  const [interesse, setInteresse] = useState(lead?.interesse ?? '');
  const [proximo, setProximo] = useState(lead?.proximoContato ?? '');
  const [responsavel, setResponsavel] = useState(lead?.responsavelId ?? '');
  const [observacoes, setObservacoes] = useState(lead?.observacoes ?? '');
  const [equipe, setEquipe] = useState<api.Profissional[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vivo = true;
    void api
      .buscarProfissionais()
      .then((r) => vivo && setEquipe(r.data.filter((p) => p.ativo)))
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setOcupado(true);
    setErro(null);
    try {
      const dados: api.LeadParaGravar = {
        nome: nome.trim(),
        whatsapp: telefoneParaE164(whatsapp),
        email: null,
        origem,
        interesse: interesse.trim() === '' ? null : interesse.trim(),
        observacoes: observacoes.trim() === '' ? null : observacoes.trim(),
        responsavelId: responsavel === '' ? null : responsavel,
        proximoContato: proximo === '' ? null : proximo,
      };
      if (lead === undefined) await api.criarLead(dados);
      else await api.salvarLead(lead.id, { ...dados, status: lead.status });
      aoSalvar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível salvar.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <form className="formulario crm-form" onSubmit={(e) => void enviar(e)} noValidate>
      <label className="campo campo-meia">
        <span className="campo-rotulo">Nome</span>
        <input value={nome} onChange={(e) => setNome(e.target.value)} required autoFocus />
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">WhatsApp</span>
        <input
          inputMode="tel"
          placeholder="(51) 99999-9999"
          value={whatsapp}
          onChange={(e) => setWhatsapp(mascararTelefone(e.target.value))}
        />
        {/* Opcional de propósito: um formulário que exige telefone é um
            formulário que a recepção não preenche no meio do
            atendimento — e aí o interessado não fica em lugar nenhum. */}
        <span className="campo-dica">Opcional. Só o nome já basta para registrar.</span>
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Como chegou</span>
        <select value={origem} onChange={(e) => setOrigem(e.target.value)}>
          {ORIGENS.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.rotulo}
            </option>
          ))}
        </select>
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Quem vai cuidar</span>
        <select value={responsavel} onChange={(e) => setResponsavel(e.target.value)}>
          <option value="">Ninguém ainda</option>
          {equipe.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nome}
            </option>
          ))}
        </select>
        <span className="campo-dica">Sem dono, é responsabilidade de todos — ou seja, de ninguém.</span>
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Interesse</span>
        <input
          value={interesse}
          placeholder="Musculação 3× por semana"
          onChange={(e) => setInteresse(e.target.value)}
        />
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Falar de novo em</span>
        <input
          type="date"
          value={proximo}
          min={hojeIso()}
          onChange={(e) => setProximo(e.target.value)}
        />
        <span className="campo-dica">É o que coloca esta pessoa na fila de trabalho.</span>
      </label>

      <label className="campo campo-cheia">
        <span className="campo-rotulo">Observações</span>
        <textarea rows={2} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
      </label>

      {erro !== null && (
        <div className="mensagem-erro campo-cheia" role="alert">
          <p>{erro}</p>
        </div>
      )}

      <div className="formulario-acoes campo-cheia">
        <button type="submit" className="botao-acao" disabled={ocupado}>
          {ocupado ? 'Salvando…' : lead === undefined ? 'Cadastrar' : 'Salvar'}
        </button>
        <button type="button" className="botao-texto" onClick={aoFechar}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
