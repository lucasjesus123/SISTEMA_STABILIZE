/**
 * CPF e data de nascimento — as duas conferências que faltavam no
 * cadastro do aluno.
 *
 * POR QUE ISTO É UM ARQUIVO PRÓPRIO. A conferência de CPF já existia,
 * escondida dentro de `acesso.routes.ts`, e rodava tarde demais: no dia
 * em que alguém tentava criar o acesso do aluno ao aplicativo. Quem
 * digitou o CPF errado foi a recepção, semanas antes, e a essa altura
 * ninguém lembra do cadastro — o sintoma vira "o aplicativo não deixa o
 * aluno entrar", que manda procurar o problema no lugar errado.
 *
 * Medido antes desta mudança: `POST /api/students` aceitava
 * `documento: '11111111111'` e `documento: 'abcdefghijk'` com 201, e
 * `dataNascimento: '2099-01-01'` também.
 */

/**
 * Confere os dígitos verificadores do CPF.
 *
 * NÃO é frescura de validação: o CPF vira o LOGIN do aluno no
 * aplicativo. Um dígito trocado cria uma conta que ele nunca consegue
 * acessar — ele digita o CPF certo e o sistema diz "não existe".
 */
export function cpfEhValido(cpf: string): boolean {
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const [tamanho, posicao] of [
    [9, 10],
    [10, 11],
  ] as const) {
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) soma += Number(cpf[i]) * (posicao - i);
    const resto = ((soma * 10) % 11) % 10;
    if (resto !== Number(cpf[tamanho])) return false;
  }
  return true;
}

/** Só os dígitos: a recepção digita com ponto e traço. */
export function apenasDigitos(v: string): string {
  return v.replace(/\D/g, '');
}

/**
 * O campo `documento` aceita mais que CPF — carteirinha, RG, passaporte
 * de aluno estrangeiro. Por isso a regra NÃO é "tem que ser um CPF
 * válido", e sim: **se parece um CPF, precisa ser um CPF**.
 *
 * Onze dígitos é o que caracteriza a tentativa. Um RG tem oito ou nove;
 * um passaporte tem letra. Quem digitou onze dígitos quis dizer CPF, e
 * é aí que o dígito verificador vale a pena — em qualquer outro formato
 * ele não se aplica e recusar seria inventar uma regra que a academia
 * não pediu.
 */
export function documentoEhAceitavel(documento: string): boolean {
  const limpo = apenasDigitos(documento);
  if (limpo.length !== 11) return true;
  return cpfEhValido(limpo);
}

/**
 * Nascimento no futuro, e gente de mais de 120 anos.
 *
 * O limite superior importa mais do que parece: a data de nascimento
 * alimenta o aniversário no WhatsApp e a idade no prontuário. Um "2099"
 * digitado por engano vira um aluno que nunca faz aniversário e uma
 * idade negativa na ficha — e nenhum dos dois grita.
 *
 * A margem de um dia no futuro é de propósito: o servidor pode estar em
 * UTC e a academia três horas atrás, e quem nasceu hoje não pode ser
 * recusado por causa de fuso.
 */
export function nascimentoEhPlausivel(iso: string): boolean {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;

  /* A DATA PRECISA VOLTAR IGUAL AO QUE ENTROU.

     `new Date('2020-02-31T12:00:00Z')` não devolve erro: devolve 2 de
     MARÇO. O JavaScript rola o excedente para o mês seguinte em
     silêncio, então "31 de fevereiro" — que sai de um dedo escorregando
     no teclado — viraria uma data válida e ERRADA no cadastro, sem nada
     avisando. Comparar o que voltou com o que entrou é a única forma de
     pegar isso. */
  const voltou = d.toISOString().slice(0, 10);
  if (voltou !== iso) return false;
  const agora = Date.now();
  const umDia = 24 * 60 * 60 * 1000;
  if (d.getTime() > agora + umDia) return false;
  const centoEVinteAnos = 120 * 365.25 * umDia;
  return d.getTime() >= agora - centoEVinteAnos;
}

/**
 * Confere os dígitos verificadores do CNPJ.
 *
 * Mesma história do CPF, com outro prejuízo: o CNPJ da academia sai
 * impresso no papel timbrado dos relatórios, na carteirinha do aluno e
 * na cobrança. Um dígito errado ali não impede nada de funcionar — só
 * torna inválido todo documento que a academia entregar, e ninguém
 * descobre até um contador conferir.
 */
export function cnpjEhValido(cnpj: string): boolean {
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;

  /* PESOS EXPLÍCITOS, e não calculados num laço.

     Tentei gerar a sequência (5,4,3,2,9,8,7,6,5,4,3,2) com aritmética e
     errei o ponto onde ela reinicia — os dois CNPJs de teste, que são
     válidos e foram conferidos à mão, voltaram falsos. A sequência do
     CNPJ não é regular como a do CPF: ela desce até 2 e RECOMEÇA em 9.
     Escrita é conferível; calculada, só parece certa. */
  const digito = (pesos: readonly number[]): number => {
    const soma = pesos.reduce((a, peso, i) => a + Number(cnpj[i]) * peso, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const primeiro = digito([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (primeiro !== Number(cnpj[12])) return false;

  const segundo = digito([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return segundo === Number(cnpj[13]);
}

/**
 * O documento da EMPRESA. Aceita CNPJ e também CPF, porque a academia
 * pode ser um MEI ou um profissional autônomo — os dois casos existem e
 * os dois emitem recibo.
 *
 * A regra é a mesma dos alunos: quatorze dígitos é tentativa de CNPJ,
 * onze é tentativa de CPF, e qualquer outra coisa passa.
 */
export function documentoDaEmpresaEhAceitavel(documento: string): boolean {
  const limpo = apenasDigitos(documento);
  if (limpo.length === 14) return cnpjEhValido(limpo);
  if (limpo.length === 11) return cpfEhValido(limpo);
  return true;
}
