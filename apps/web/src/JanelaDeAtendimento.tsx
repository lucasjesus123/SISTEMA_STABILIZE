import { useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';

/**
 * Em que dias e horas um profissional atende.
 *
 * EXISTE PARA TRANSFORMAR UMA RECUSA EM INFORMAÇÃO. Sem isto, quem marca
 * escolhe o profissional, escolhe o dia, escolhe a hora, aperta o botão
 * — e só então descobre que aquela pessoa nunca trabalhou de manhã. O
 * servidor está certo em recusar; o erro é a tela ter deixado a escolha
 * parecer possível.
 *
 * Quando a data escolhida cai fora da janela, o aviso é explícito e
 * aparece ANTES do envio.
 */

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "seg a sex" quando os dias são seguidos; "seg, qua, sex" quando não. */
function resumirDias(dias: number[]): string {
  const unicos = [...new Set(dias)].sort((a, b) => a - b);
  if (unicos.length === 0) return '';
  if (unicos.length === 1) return DIAS[unicos[0]!]!;
  const seguidos = unicos.every((d, i) => i === 0 || d === unicos[i - 1]! + 1);
  return seguidos
    ? `${DIAS[unicos[0]!]} a ${DIAS[unicos[unicos.length - 1]!]}`
    : unicos.map((d) => DIAS[d]).join(', ');
}

const hhmm = (t: string): string => t.slice(0, 5).replace(':00', 'h').replace(':', 'h');

/**
 * O dia da semana e a hora de um instante, LIDOS NO FUSO DA ACADEMIA.
 *
 * O servidor valida a janela de atendimento nesse fuso. Se a tela ler o
 * mesmo instante no fuso de quem está olhando, os dois discordam para
 * qualquer pessoa que abra o sistema de fora — e a tela passa a prometer
 * um horário que o servidor recusa, que é pior do que não dizer nada.
 */
function naAcademia(quando: Date, fuso: string): { diaDaSemana: number; hora: string } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(quando);
  const pega = (t: string): string => partes.find((p) => p.type === t)?.value ?? '';
  const semana = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(pega('weekday'));
  /* `hour12: false` devolve "24" à meia-noite em alguns motores. */
  const h = pega('hour') === '24' ? '00' : pega('hour');
  return { diaDaSemana: semana, hora: `${h}:${pega('minute')}` };
}

export function JanelaDeAtendimento({
  profissionalId,
  /** Data escolhida, "AAAA-MM-DD". Sem ela, mostra só o resumo da semana. */
  dia,
  /** Hora escolhida, "HH:MM". */
  hora,
  /** Fuso da academia. Sem ele, cai no do navegador. */
  fuso,
}: {
  profissionalId: string;
  dia?: string;
  hora?: string;
  fuso?: string;
}): ReactNode {
  const [faixas, setFaixas] = useState<api.FaixaDeHorario[] | null>(null);

  useEffect(() => {
    if (profissionalId === '') return;
    let vivo = true;
    setFaixas(null);
    api
      .buscarHorarios(profissionalId)
      .then((r) => vivo && setFaixas(r.data))
      /* Falha aqui não pode travar a marcação: quem não tem
         `availability:read` simplesmente não vê o resumo. */
      .catch(() => vivo && setFaixas([]));
    return () => {
      vivo = false;
    };
  }, [profissionalId]);

  if (faixas === null || profissionalId === '') return null;

  if (faixas.length === 0) {
    return (
      <span className="campo-dica jan-alerta">
        Este profissional não tem horário de atendimento cadastrado — nada pode ser marcado para
        ele. Defina em Agenda → Horários de atendimento.
      </span>
    );
  }

  const resumo = agruparPorFaixa(faixas)
    .map((g) => `${resumirDias(g.dias)} ${hhmm(g.inicio)}–${hhmm(g.fim)}`)
    .join(' · ');

  if (dia === undefined) return <span className="campo-dica">Atende {resumo}.</span>;

  /* "2026-08-25" partido à mão: `new Date("2026-08-25")` é interpretado
     como UTC e, a oeste de Greenwich, cai no dia anterior — a terça
     viraria segunda na hora de descobrir o dia da semana. */
  const [ano, mes, d] = dia.split('-').map(Number);
  if (ano === undefined || mes === undefined || d === undefined) return null;

  /* O instante que será ENVIADO ao servidor, relido no fuso da academia
     — que é exatamente o que o servidor vai fazer com ele. */
  const [hh, mm] = (hora ?? '00:00').split(':').map(Number);
  const instante = new Date(ano, mes - 1, d, hh ?? 0, mm ?? 0);
  const local = naAcademia(instante, fuso ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const diaDaSemana = local.diaDaSemana;
  const horaNaAcademia = local.hora;
  /* Se o navegador está noutro fuso, a hora que a pessoa digitou não é a
     hora que a academia vai ver. Dizer isso é a diferença entre um aviso
     útil e um aviso que parece defeito. */
  const outroFuso = hora !== undefined && hora !== '' && horaNaAcademia !== hora;
  const naAcademiaTexto = outroFuso ? ` (${horaNaAcademia} na academia)` : '';

  const doDia = faixas.filter((f) => f.diaDaSemana === diaDaSemana);

  if (doDia.length === 0) {
    return (
      <span className="campo-dica jan-alerta">
        Não atende {DIAS[diaDaSemana]}. Atende {resumo}.
      </span>
    );
  }

  if (hora !== undefined && hora !== '') {
    const dentro = doDia.some((f) => horaNaAcademia >= f.inicio && horaNaAcademia < f.fim);
    if (!dentro) {
      return (
        <span className="campo-dica jan-alerta">
          {DIAS[diaDaSemana]} atende {doDia.map((f) => `${hhmm(f.inicio)}–${hhmm(f.fim)}`).join(' e ')}
          , e {hora}
          {naAcademiaTexto} está fora.
        </span>
      );
    }
  }

  return (
    <span className="campo-dica jan-ok">
      {DIAS[diaDaSemana]} atende {doDia.map((f) => `${hhmm(f.inicio)}–${hhmm(f.fim)}`).join(' e ')}.
    </span>
  );
}

/** Junta faixas com o mesmo horário para não repetir "8h–18h" cinco vezes. */
function agruparPorFaixa(
  faixas: api.FaixaDeHorario[],
): { inicio: string; fim: string; dias: number[] }[] {
  const mapa = new Map<string, { inicio: string; fim: string; dias: number[] }>();
  for (const f of faixas) {
    const chave = `${f.inicio}-${f.fim}`;
    const g = mapa.get(chave);
    if (g === undefined) mapa.set(chave, { inicio: f.inicio, fim: f.fim, dias: [f.diaDaSemana] });
    else g.dias.push(f.diaDaSemana);
  }
  return [...mapa.values()].sort((a, b) => a.inicio.localeCompare(b.inicio));
}
