/**
 * Dados de demonstração.
 *
 * Popula uma academia inteira e coerente: alunos com contratos, agenda
 * de verdade, presenças, mensalidades pagas e em atraso, comissões que
 * fecham. Serve para navegar o sistema com informação em todas as telas.
 *
 * Três cuidados que fazem diferença:
 *
 * 1. IDEMPOTENTE. Roda quantas vezes quiser: apaga o tenant de demo pelo
 *    slug antes de recriar. Um seed que duplica dados a cada execução
 *    vira lixo em dois dias.
 *
 * 2. RECUSA BANCO DE PRODUÇÃO. Se encontrar dados que não são de demo, o
 *    script aborta. Um seed rodado por engano em produção com dados
 *    reais de saúde é um incidente, não um deslize.
 *
 * 3. DADOS COERENTES, NÃO ALEATÓRIOS. As presenças batem com a agenda,
 *    os pagamentos batem com os contratos, e a comissão do mês fecha com
 *    o que foi recebido. Dado incoerente esconde bug de cálculo — a tela
 *    fica "cheia" e ninguém percebe que a conta não fecha.
 */
import pg from 'pg';
import { CARGA_PLAUSIVEL, CATALOGO } from './exercicios.js';
import argon2 from 'argon2';

const SLUG_DEMO = 'stabilize-demo';

/* Id fixo para a academia de demonstração. Ver o comentário da limpeza:
   é o que permite definir o contexto de RLS antes de qualquer leitura,
   sem precisar de exceção na política nem de credencial privilegiada. */
const TENANT_DEMO = '5742411a-0000-4000-8000-000000000001';
const SENHA_DEMO = 'stabilize-demo-2026';
const EMAIL_ALUNO_DEMO = 'ana@aluno.demo';

const url = process.env['DATABASE_URL'];
if (url === undefined) {
  console.error('defina DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });

/** Nomes brasileiros plausíveis — dado de demo precisa parecer real. */
const NOMES = [
  'Ana Beatriz Moreira', 'Bruno Carvalho Lima', 'Carla Menezes Rocha',
  'Diego Almeida Souza', 'Elisa Nogueira Prado', 'Felipe Tavares Dias',
  'Gabriela Pinto Ramos', 'Henrique Barbosa Melo', 'Isabela Cardoso Freitas',
  'João Pedro Antunes', 'Karina Duarte Vieira', 'Lucas Ferreira Campos',
  'Mariana Siqueira Braga', 'Nicolas Teixeira Pires', 'Olívia Sampaio Rezende',
  'Paulo Vinícius Andrade', 'Queren Lopes Batista', 'Rafael Monteiro Cunha',
  'Sofia Bandeira Queiroz', 'Thiago Peixoto Nunes', 'Ursula Fontes Machado',
  'Vitor Hugo Salgado', 'Wanda Correia Bastos', 'Yasmin Aguiar Pontes',
  'Zeca Villela Guimarães', 'Amanda Rios Bezerra', 'Caio Estevão Marques',
  'Débora Assunção Neves', 'Eduardo Paiva Coelho', 'Fernanda Leal Xavier',
];

const PROFISSIONAIS = [
  { nome: 'Dra. Renata Stabile', email: 'renata@stabilize.demo', bp: 4000 },
  { nome: 'Dr. Marcelo Aguiar', email: 'marcelo@stabilize.demo', bp: 5000 },
  { nome: 'Camila Fortes', email: 'camila@stabilize.demo', bp: 3500 },
];

const SALAS = [
  { nome: 'Sala de Avaliação', cor: '#4BC1C8' },
  { nome: 'Studio Pilates', cor: '#85CEBD' },
  { nome: 'Sala de Musculação', cor: '#686969' },
  { nome: 'Sala de Fisioterapia', cor: '#2E9AA1' },
];

/** Gerador determinístico: o mesmo seed produz sempre os mesmos dados. */
let semente = 20260315;
function rnd(): number {
  semente = (semente * 1103515245 + 12345) & 0x7fffffff;
  return semente / 0x7fffffff;
}
const escolha = <T>(lista: readonly T[]): T => lista[Math.floor(rnd() * lista.length)]!;

/** Centavos → "1.234,56". Sempre duas casas: toLocaleString sozinho come
    o zero final e imprime "41.487,2", que não é um valor em reais. */
const brl = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const inteiro = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1));

/** Carga em gramas, ou null quando o exercício não usa carga externa. */
const cargaDe = (nome: string): number | null => {
  const faixa = CARGA_PLAUSIVEL[nome];
  if (faixa === undefined) return null;
  // Arredondado para 2,5 kg, que é como as anilhas existem no mundo.
  const kg = Math.round(inteiro(faixa[0], faixa[1]) / 2.5) * 2.5;
  return Math.round(kg * 1000);
};

async function main(): Promise<void> {
  const client = await pool.connect();

  try {
    // -----------------------------------------------------------------
    // Guarda contra rodar em produção.
    // -----------------------------------------------------------------
    const outros = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenants WHERE slug <> $1`,
      [SLUG_DEMO],
    );
    const n = outros.rows[0]?.n ?? 0;
    if (n > 0 && process.env['SEED_FORCE'] !== 'sim') {
      console.error(
        `\nABORTADO: o banco tem ${n} empresa(s) que não são de demonstração.\n` +
          `Este script apaga e recria dados. Se é realmente o que você quer,\n` +
          `rode de novo com SEED_FORCE=sim.\n`,
      );
      process.exit(1);
    }

    /* A LIMPEZA USA UM ID FIXO, e não uma busca por slug.
       
       A versão anterior fazia `SELECT id FROM tenants WHERE slug = $1`
       ANTES de definir o contexto — e `tenants` tem RLS. Sem contexto,
       `current_tenant_id()` é NULL, a política não casa com nada e a
       consulta devolvia ZERO linhas. O laço não rodava, nada era
       apagado, e a criação seguinte batia em "duplicate key".
       Funcionava na primeira execução, quando não havia o que limpar, e
       quebrava em toda reexecução. É o mesmo ovo-e-galinha do login
       (preciso do tenant para ter contexto, preciso de contexto para
       ler o tenant), que lá é resolvido com uma função SECURITY
       DEFINER.
       
       Aqui não precisa de função nenhuma: dado de demonstração pode ter
       id conhecido. Com o id na mão, o contexto é definido antes de
       qualquer leitura e a RLS deixa de ser um obstáculo — sem abrir
       exceção nenhuma na política. */
    console.log('==> limpando dados de demonstração anteriores');
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', TENANT_DEMO]);
    /* Os treinos saem primeiro. `workout_plans.professional_id` é
       RESTRICT de propósito — prescrição sem autor não vale — e isso
       faria a cascata do tenant esbarrar nos usuários. */
    await client.query('DELETE FROM workout_plans');
    await client.query('DELETE FROM tenants WHERE id = $1', [TENANT_DEMO]);
    await client.query('COMMIT');

    // -----------------------------------------------------------------
    console.log('==> criando a academia');
    await client.query('BEGIN');

    const tenantId = TENANT_DEMO;
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);
    await client.query(
      `INSERT INTO tenants (id, name, slug, timezone) VALUES ($1,$2,$3,'America/Sao_Paulo')`,
      [tenantId, 'Stabilize — Clínica do Músculo', SLUG_DEMO],
    );

    const hash = await argon2.hash(SENHA_DEMO, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    const criarUsuario = async (
      nome: string,
      email: string,
      papel: string,
    ): Promise<string> => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,$4,$5::user_role) RETURNING id`,
        [tenantId, email, hash, nome, papel],
      );
      return r.rows[0]!.id;
    };

    const ownerId = await criarUsuario('Lucas Jesus', 'admin@stabilize.demo', 'OWNER');
    await criarUsuario('Recepção Stabilize', 'recepcao@stabilize.demo', 'RECEPTION');

    const profIds: string[] = [];
    for (const p of PROFISSIONAIS) {
      profIds.push(await criarUsuario(p.nome, p.email, 'PROFESSIONAL'));
    }

    const salaIds: string[] = [];
    for (const s of SALAS) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO rooms (tenant_id,name,color) VALUES ($1,$2,$3) RETURNING id`,
        [tenantId, s.nome, s.cor],
      );
      salaIds.push(r.rows[0]!.id);
    }

    // -----------------------------------------------------------------
    console.log('==> disponibilidade dos profissionais');
    for (let i = 0; i < profIds.length; i += 1) {
      // Segunda a sexta, manhã e tarde, com janelas diferentes por
      // profissional para a agenda não parecer gerada por laço.
      for (let dia = 1; dia <= 5; dia += 1) {
        await client.query(
          `INSERT INTO availability_rules
             (tenant_id, professional_id, weekday, start_time, end_time, slot_minutes, room_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            tenantId,
            profIds[i],
            dia,
            i === 0 ? '06:00' : i === 1 ? '08:00' : '13:00',
            i === 0 ? '12:00' : i === 1 ? '14:00' : '20:00',
            60,
            salaIds[i % salaIds.length],
          ],
        );
      }
    }

    // -----------------------------------------------------------------
    console.log('==> alunos, contratos e prontuário');
    const hoje = new Date();
    const alunos: { id: string; profId: string; bp: number; valor: number; ciclo: string }[] = [];

    for (let i = 0; i < NOMES.length; i += 1) {
      const nome = NOMES[i]!;
      const profIdx = i % profIds.length;
      const profId = profIds[profIdx]!;
      const bp = PROFISSIONAIS[profIdx]!.bp;

      // Mistura de mensalistas e avulsos, como numa academia real.
      const avulso = i % 5 === 4;
      const ciclo = avulso ? 'SESSION' : 'MONTHLY';
      const valor = avulso ? 12000 : escolha([24990, 29990, 34990, 39990]);

      // Aniversários espalhados, e alguns HOJE, para a rotina de
      // felicitação ter o que mostrar na tela.
      const aniversario =
        i < 2
          ? new Date(Date.UTC(1990 + i, hoje.getMonth(), hoje.getDate()))
          : new Date(Date.UTC(inteiro(1965, 2006), inteiro(0, 11), inteiro(1, 28)));

      const status = i >= NOMES.length - 3 ? 'INACTIVE' : 'ACTIVE';

      const r = await client.query<{ id: string }>(
        `INSERT INTO students
           (tenant_id, full_name, email, phone, whatsapp, birth_date, status,
            address_city, address_state, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::student_status,'Belo Horizonte','MG',$8)
         RETURNING id`,
        [
          tenantId,
          nome,
          `${nome.split(' ')[0]!.toLowerCase()}${i}@email.demo`,
          `(31) 9${inteiro(1000, 9999)}-${inteiro(1000, 9999)}`,
          `+55319${inteiro(10_000_000, 99_999_999)}`,
          aniversario.toISOString().slice(0, 10),
          status,
          new Date(Date.UTC(2025, inteiro(0, 11), inteiro(1, 28))).toISOString().slice(0, 10),
        ],
      );
      const alunoId = r.rows[0]!.id;

      await client.query(
        `INSERT INTO student_professionals (tenant_id, student_id, professional_id)
         VALUES ($1,$2,$3)`,
        [tenantId, alunoId, profId],
      );

      await client.query(
        `INSERT INTO student_contracts
           (tenant_id, student_id, professional_id, cycle, amount_cents,
            commission_bp, billing_day, starts_on)
         VALUES ($1,$2,$3,$4::billing_cycle,$5,$6,$7,'2025-01-01')`,
        [tenantId, alunoId, profId, ciclo, valor, bp, inteiro(1, 28)],
      );

      // Anamnese para parte dos alunos — o prontuário precisa ter
      // conteúdo, mas nem todo aluno tem avaliação feita.
      if (i % 3 === 0) {
        await client.query(
          `INSERT INTO anamneses
             (tenant_id, student_id, professional_id, chief_complaint, goals,
              height_cm, weight_g, performed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval)`,
          [
            tenantId,
            alunoId,
            profId,
            escolha([
              'Dor lombar ao final do dia',
              'Desconforto no ombro direito ao elevar o braço',
              'Recuperação pós-cirúrgica de joelho',
              'Rigidez cervical por postura no trabalho',
            ]),
            escolha([
              'Ganho de força e retorno ao esporte',
              'Alívio da dor e melhora da mobilidade',
              'Condicionamento geral e postura',
            ]),
            inteiro(155, 192),
            inteiro(52_000, 98_000),
            inteiro(10, 180),
          ],
        );
      }

      alunos.push({ id: alunoId, profId, bp, valor, ciclo });
    }

    /* ACESSO AO APLICATIVO DO ALUNO.

       Aluno e usuário são coisas separadas de propósito: a academia
       cadastra centenas de alunos, e só uma parte deles quer (ou pede)
       acesso ao aplicativo. O vínculo é `students.user_id`, e é ele que
       o login usa para colocar o `sid` no token — o identificador que
       transforma o escopo em SELF e faz o portal responder "os SEUS
       dados" sem que o aplicativo precise mandar id nenhum na URL.

       Aqui damos acesso à primeira aluna, que é justamente uma das que
       fazem aniversário hoje e tem agenda cheia — assim a primeira tela
       do aplicativo tem o que mostrar. */
    const alunaDemo = alunos[0]!;
    const usuarioAluno = await criarUsuario(NOMES[0]!, EMAIL_ALUNO_DEMO, 'STUDENT');
    await client.query('UPDATE students SET user_id = $1 WHERE id = $2', [
      usuarioAluno,
      alunaDemo.id,
    ]);

    await client.query('COMMIT');

    // -----------------------------------------------------------------
    console.log('==> agenda dos últimos 60 e próximos 20 dias');
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);

    let agendados = 0;
    let presencas = 0;
    let faltas = 0;

    for (let offset = -60; offset <= 20; offset += 1) {
      const dia = new Date(hoje);
      dia.setDate(dia.getDate() + offset);
      const semana = dia.getDay();
      if (semana === 0 || semana === 6) continue; // fim de semana fechado

      for (let hora = 7; hora <= 18; hora += 1) {
        // Nem todo horário é ocupado — agenda cheia demais parece falsa.
        if (rnd() > 0.42) continue;

        const aluno = escolha(alunos.filter((a) => a.id !== undefined));
        const profIdx = profIds.indexOf(aluno.profId);

        const inicio = new Date(
          Date.UTC(dia.getFullYear(), dia.getMonth(), dia.getDate(), hora + 3, 0, 0),
        );
        const fim = new Date(inicio.getTime() + 60 * 60 * 1000);

        /* Passado vira presença ou falta; futuro fica agendado. A
           proporção de falta (~12%) é realista e faz o indicador de
           frequência mostrar algo diferente de 100%. */
        let status: string;
        if (offset < 0) {
          const faltou = rnd() < 0.12;
          status = faltou ? 'NO_SHOW' : 'ATTENDED';
          if (faltou) faltas += 1;
          else presencas += 1;
        } else {
          status = 'SCHEDULED';
          agendados += 1;
        }

        /* A restrição de exclusão do banco recusa choque de horário.
           Em vez de tentar prever, deixamos o banco decidir e seguimos
           adiante — é exatamente o comportamento que a aplicação real
           tem, e exercitá-lo aqui já é uma pequena prova de que
           funciona. */
        try {
          await client.query('SAVEPOINT sp');
          await client.query(
            `INSERT INTO appointments
               (tenant_id, student_id, professional_id, room_id, period, status,
                checked_in_at, is_included_in_plan, price_cents, created_by)
             VALUES ($1,$2,$3,$4, tstzrange($5,$6,'[)'), $7::appointment_status,
                     $8, $9, $10, $11)`,
            [
              tenantId,
              aluno.id,
              aluno.profId,
              salaIds[profIdx % salaIds.length],
              inicio,
              fim,
              status,
              status === 'ATTENDED' ? inicio : null,
              aluno.ciclo !== 'SESSION',
              aluno.ciclo === 'SESSION' ? aluno.valor : null,
              ownerId,
            ],
          );
          await client.query('RELEASE SAVEPOINT sp');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT sp');
        }
      }
    }
    await client.query('COMMIT');

    // -----------------------------------------------------------------
    console.log('==> biblioteca de exercícios e prescrição');
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);

    const exercicioIds = new Map<string, string>();
    for (const e of CATALOGO) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO exercises (tenant_id, name, muscle_group, equipment, instructions)
         VALUES ($1,$2,$3::muscle_group,$4,$5) RETURNING id`,
        [tenantId, e.nome, e.grupo, e.equipamento ?? null, e.instrucoes ?? null],
      );
      exercicioIds.set(e.nome, r.rows[0]!.id);
    }

    /* Um treino ativo de verdade para os primeiros alunos: uma tela de
       prescrição vazia não deixa ninguém avaliar se o módulo serve. */
    const divisao: { dia: string; exercicios: string[] }[] = [
      {
        dia: 'A — Empurrar',
        exercicios: [
          'Supino reto com barra',
          'Supino inclinado com halteres',
          'Desenvolvimento com halteres',
          'Elevação lateral',
          'Tríceps na polia com barra',
        ],
      },
      {
        dia: 'B — Puxar',
        exercicios: [
          'Puxada frontal na polia alta',
          'Remada curvada com barra',
          'Remada unilateral com halter',
          'Face pull',
          'Rosca direta com barra',
        ],
      },
      {
        dia: 'C — Pernas',
        exercicios: [
          'Agachamento livre',
          'Levantamento terra romeno',
          'Leg press 45°',
          'Elevação pélvica com barra',
          'Panturrilha em pé',
          'Prancha isométrica',
        ],
      },
    ];

    let treinosCriados = 0;
    for (let i = 0; i < Math.min(alunos.length, 14); i++) {
      const aluno = alunos[i]!;
      const plano = await client.query<{ id: string }>(
        `INSERT INTO workout_plans
           (tenant_id, student_id, professional_id, name, goal, status, starts_on, notes)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE',CURRENT_DATE - $6::int, $7)
         RETURNING id`,
        [
          tenantId,
          aluno.id,
          aluno.profId,
          'Treino ABC — hipertrofia',
          escolha([
            'Hipertrofia geral com ênfase em membros inferiores',
            'Recomposição corporal',
            'Retorno gradual após lesão',
            'Ganho de força nos básicos',
          ]),
          inteiro(5, 60),
          'Progredir carga quando completar todas as séries no topo da faixa.',
        ],
      );

      for (const bloco of divisao) {
        let posicao = 0;
        for (const nome of bloco.exercicios) {
          const exercicioId = exercicioIds.get(nome);
          if (exercicioId === undefined) continue;
          await client.query(
            `INSERT INTO workout_items
               (tenant_id, plan_id, exercise_id, day_label, position, sets, reps,
                load_g, rest_seconds)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              tenantId,
              plano.rows[0]!.id,
              exercicioId,
              bloco.dia,
              posicao++,
              inteiro(3, 4),
              escolha(['8-12', '10-12', '12-15', '6-8']),
              // Carga em gramas, dentro da faixa plausível do exercício.
              // Sem faixa = peso corporal, mobilidade ou cardio.
              cargaDe(nome),
              escolha([45, 60, 90]),
            ],
          );
        }
      }
      treinosCriados++;
    }
    await client.query('COMMIT');
    console.log(
      `    ${CATALOGO.length} exercícios na biblioteca, ${treinosCriados} treinos ativos`,
    );

    // -----------------------------------------------------------------
    console.log('==> financeiro: mensalidades, despesas e recebimentos');
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);

    let recebido = 0;
    let emAberto = 0;

    // Seis meses de mensalidades.
    for (let mesAtras = 5; mesAtras >= 0; mesAtras -= 1) {
      const competencia = new Date(hoje.getFullYear(), hoje.getMonth() - mesAtras, 1);
      const vencimento = new Date(hoje.getFullYear(), hoje.getMonth() - mesAtras, 10);

      for (const aluno of alunos) {
        if (aluno.ciclo === 'SESSION') continue;

        const contrato = await client.query<{ id: string }>(
          `SELECT id FROM student_contracts WHERE student_id = $1 LIMIT 1`,
          [aluno.id],
        );

        const entry = await client.query<{ id: string }>(
          `INSERT INTO finance_entries
             (tenant_id, direction, description, category, amount_cents, due_date,
              competence_date, student_id, professional_id, contract_id, created_by)
           VALUES ($1,'RECEIVABLE',$2,'Mensalidade',$3,$4,$5,$6,$7,$8,$9)
           RETURNING id`,
          [
            tenantId,
            `Mensalidade ${competencia.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}`,
            aluno.valor,
            vencimento.toISOString().slice(0, 10),
            competencia.toISOString().slice(0, 10),
            aluno.id,
            aluno.profId,
            contrato.rows[0]?.id ?? null,
            ownerId,
          ],
        );

        /* Meses antigos majoritariamente pagos; o mês corrente com
           inadimplência de verdade, para o painel ter o que mostrar. */
        const pagou = mesAtras === 0 ? rnd() < 0.62 : rnd() < 0.94;
        if (pagou) {
          const pagoEm = new Date(vencimento);
          pagoEm.setDate(pagoEm.getDate() + inteiro(-4, 6));
          await client.query(
            `INSERT INTO finance_payments
               (tenant_id, entry_id, amount_cents, method, paid_at, recorded_by)
             VALUES ($1,$2,$3,$4::payment_method,$5,$6)`,
            [
              tenantId,
              entry.rows[0]!.id,
              aluno.valor,
              escolha(['PIX', 'CREDIT_CARD', 'CASH', 'DEBIT_CARD']),
              pagoEm,
              ownerId,
            ],
          );
          recebido += aluno.valor;
        } else {
          emAberto += aluno.valor;
        }
      }
    }

    // Despesas fixas — sem elas o fluxo de caixa fica irreal.
    const DESPESAS: [string, string, number][] = [
      ['Aluguel do imóvel', 'Instalações', 780_000],
      ['Energia elétrica', 'Instalações', 96_500],
      ['Água', 'Instalações', 18_400],
      ['Internet e telefonia', 'Instalações', 24_900],
      ['Sistema de gestão', 'Software', 19_900],
      ['Material de fisioterapia', 'Insumos', 62_300],
      ['Contabilidade', 'Serviços', 89_000],
      ['Limpeza', 'Serviços', 120_000],
    ];

    for (let mesAtras = 5; mesAtras >= 0; mesAtras -= 1) {
      for (const [descricao, categoria, valor] of DESPESAS) {
        const venc = new Date(hoje.getFullYear(), hoje.getMonth() - mesAtras, 5);
        const e = await client.query<{ id: string }>(
          `INSERT INTO finance_entries
             (tenant_id, direction, description, category, amount_cents, due_date,
              competence_date, supplier_name, created_by)
           VALUES ($1,'PAYABLE',$2,$3,$4,$5,$5,$6,$7) RETURNING id`,
          [
            tenantId,
            descricao,
            categoria,
            valor + inteiro(-3000, 3000),
            venc.toISOString().slice(0, 10),
            `Fornecedor ${categoria}`,
            ownerId,
          ],
        );
        if (mesAtras > 0) {
          await client.query(
            `INSERT INTO finance_payments
               (tenant_id, entry_id, amount_cents, method, paid_at, recorded_by)
             SELECT $1, id, amount_cents, 'BANK_TRANSFER', due_date, $2
               FROM finance_entries WHERE id = $3`,
            [tenantId, ownerId, e.rows[0]!.id],
          );
        }
      }
    }

    await client.query('COMMIT');

    // -----------------------------------------------------------------
    /* O contexto de tenant é de TRANSAÇÃO (SET LOCAL), então o COMMIT
       acima o descartou. Sem redefinir, a RLS devolveria zero em todas
       as contagens e o resumo mentiria dizendo que nada foi criado —
       foi exatamente o que aconteceu na primeira execução. */
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);
    const resumo = await client.query<{ t: string; n: number }>(
      `SELECT 'alunos' AS t, count(*)::int AS n FROM students
       UNION ALL SELECT 'agendamentos', count(*)::int FROM appointments
       UNION ALL SELECT 'lançamentos', count(*)::int FROM finance_entries
       UNION ALL SELECT 'pagamentos', count(*)::int FROM finance_payments`,
    );
    await client.query('COMMIT');

    console.log('\n===================================================');
    console.log(' Dados de demonstração criados');
    console.log('===================================================');
    for (const r of resumo.rows) {
      console.log(`  ${r.t.padEnd(14)} ${r.n}`);
    }
    console.log(`  presenças      ${presencas}`);
    console.log(`  faltas         ${faltas}`);
    console.log(`  futuros        ${agendados}`);
    console.log(`  recebido       R$ ${brl(recebido)}`);
    console.log(`  em aberto      R$ ${brl(emAberto)}`);
    console.log('\n  Acesso:');
    console.log(`    admin@stabilize.demo     ${SENHA_DEMO}   (proprietário)`);
    console.log(`    renata@stabilize.demo    ${SENHA_DEMO}   (profissional)`);
    console.log(`    recepcao@stabilize.demo  ${SENHA_DEMO}   (recepção)`);
    console.log(`    ${EMAIL_ALUNO_DEMO}            ${SENHA_DEMO}   (aluna — aplicativo)`);
    console.log('\n  Estas senhas são de DEMONSTRAÇÃO. Nunca use este seed');
    console.log('  num banco que vá receber dados reais.\n');
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((erro: unknown) => {
  const mensagem = erro instanceof Error ? erro.message : String(erro);

  /* Caso legado com nome próprio: um banco semeado por uma versão
     anterior tem a academia de demonstração com id ALEATÓRIO, que a
     limpeza por id fixo não alcança — e o erro que sai é uma violação
     de unicidade, que não diz nada a quem está tentando resetar a demo.
     Melhor gastar seis linhas explicando do que deixar a pessoa
     procurando. */
  if (mensagem.includes('tenants_slug_key')) {
    console.error(
      '\nfalha ao popular: já existe uma academia de demonstração criada por uma\n' +
        'versão anterior deste script, com id aleatório — a limpeza por id fixo não\n' +
        'a alcança porque `tenants` tem RLS.\n\n' +
        'Remova-a uma única vez, com a credencial de migração:\n\n' +
        "  psql \"$DATABASE_MIGRATION_URL\" -c \"SET app.tenant_id = '<id>'; DELETE FROM tenants WHERE slug = 'stabilize-demo'\"\n\n" +
        'ou recrie o banco. Depois deste ponto, reexecutar o seed funciona sempre.\n',
    );
    process.exit(1);
  }

  console.error('falha ao popular:', mensagem);
  process.exit(1);
});
