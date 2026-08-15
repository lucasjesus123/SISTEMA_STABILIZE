# Subir o Stabilize numa VPS

Do zero ao sistema no ar. Cada passo diz **por que** existe — o que não
se entende não se mantém, e daqui a seis meses quem lê isto pode ser
outra pessoa.

> **O que foi e o que não foi verificado.** O `docker-compose.yml`, o
> guard de senhas do banco e a sintaxe de todos os scripts foram
> executados e conferidos. **A construção da imagem não foi**: o
> ambiente onde este código foi escrito bloqueia o registro do Docker
> (403 na CDN), então o `docker build` nunca rodou. Trate o primeiro
> build como o passo que pode precisar de ajuste — e é o único.

---

## 1. A máquina

Para 30 empresas e até 90 usuários simultâneos, **2 vCPU / 4 GB / 40 GB
SSD** sobra. O gargalo aqui é I/O de banco, não CPU.

Ubuntu 24.04 LTS. Como `root`, uma vez:

```bash
apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 zstd ufw fail2ban unattended-upgrades

# Um usuário sem privilégio para operar o sistema. Rodar o compose como
# root significa que qualquer erro de digitação num caminho de volume
# alcança o sistema de arquivos inteiro.
adduser --disabled-password --gecos '' stabilize
usermod -aG docker stabilize
```

### Firewall — antes de qualquer coisa subir

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP (só para o redirecionamento e o ACME)
ufw allow 443         # HTTPS, tcp e udp (HTTP/3)
ufw enable
```

O PostgreSQL **não** aparece nesta lista, e não é esquecimento: ele não
publica porta nenhuma. Fala com a API pela rede interna do compose. Para
administrar o banco de fora, use um túnel:

```bash
ssh -L 5432:localhost:5432 stabilize@SEU_IP
```

Expor 5432 "só para o DBeaver" é como a maioria dos vazamentos de banco
começa.

### SSH sem senha

```bash
# NA SUA MÁQUINA:
ssh-copy-id stabilize@SEU_IP

# NA VPS, depois de confirmar que a chave funciona:
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
```

---

## 2. O domínio

Aponte um registro **A** para o IP da VPS antes de subir. O Caddy emite
o certificado sozinho na primeira requisição, e para isso o Let's
Encrypt precisa resolver o nome. DNS errado é o motivo nº 1 de "o HTTPS
não funcionou".

```bash
dig +short sistema.stabilize.com.br    # tem que devolver o IP da VPS
```

---

## 3. Instalar

Como usuário `stabilize`:

```bash
git clone https://github.com/lucasjesus123/SISTEMA_STABILIZE.git /opt/stabilize
cd /opt/stabilize
./deploy/gerar-segredos.sh
```

O script pergunta domínio e e-mail e gera **todos** os segredos com
`openssl rand`. Não existe arquivo de exemplo para copiar — porque
arquivo de exemplo é copiado com os valores de exemplo dentro.

> **Guarde uma cópia do `.env` fora da VPS**, num gerenciador de senhas.
> As senhas do banco não estão em nenhum outro lugar. Perder o disco com
> ele é perder o acesso aos dados.

---

## 4. Subir

```bash
docker compose build
docker compose up -d postgres
sleep 20                      # o banco inicializa o cluster na 1ª vez

# Migrations, com a credencial de MIGRAÇÃO — nunca a da API.
set -a; . ./.env; set +a
docker compose run --rm \
  -e DATABASE_MIGRATION_URL \
  -e STABILIZE_APP_PASSWORD \
  -e STABILIZE_MIGRATOR_PASSWORD \
  api ./packages/db/scripts/migrate.sh

docker compose up -d
docker compose ps             # tudo 'healthy'
```

### Por que duas credenciais de banco

`stabilize_migrator` é dono do schema e roda DDL. `stabilize_app` é o
que a API usa: **sem DDL e sem `BYPASSRLS`**. Se a API for comprometida,
o atacante não derruba tabela nem desliga o isolamento entre empresas —
o `002_roles.sql` inclusive **se recusa a rodar** com senha placeholder
ou com menos de 16 caracteres.

### Criar a primeira academia

```bash
docker compose exec -T postgres psql -U postgres -d stabilize
```

```sql
-- O id é seu; guarde-o para o próximo comando.
INSERT INTO tenants (id, name, slug)
VALUES (gen_random_uuid(), 'Stabilize — Clínica do Músculo', 'stabilize')
RETURNING id;

-- A senha vai como hash argon2id, gerado fora do banco:
--   docker compose exec api node -e "import('argon2').then(a=>a.default.hash('SUA_SENHA',{type:a.default.argon2id,memoryCost:65536,timeCost:3,parallelism:1}).then(console.log))"
SET app.tenant_id = 'O_ID_ACIMA';
INSERT INTO users (tenant_id, email, password_hash, full_name, role)
VALUES ('O_ID_ACIMA', 'voce@stabilize.com.br', 'O_HASH', 'Seu Nome', 'OWNER');
```

O `SET app.tenant_id` não é decoração: **toda** tabela tem RLS com
`FORCE`, e sem contexto o `INSERT` não enxerga nada — inclusive para o
superusuário do compose, que é justamente o ponto.

---

## 5. Backup — a parte que costuma ser mentira

```bash
crontab -e
```

```cron
0 3 * * * /opt/stabilize/deploy/backup.sh >> /var/log/stabilize-backup.log 2>&1
```

O `backup.sh` faz algo que a maioria dos scripts de backup não faz:
**restaura o dump num banco descartável e confere se tem empresa dentro**
antes de considerá-lo bom. Os dois modos de falha clássicos são
silenciosos — dump truncado por disco cheio, e dump válido de um banco
vazio porque a credencial mudou. Nos dois casos o arquivo existe, tem
tamanho, e ninguém percebe até o dia do desastre. Aqui, um backup que
não passa na verificação é renomeado para `.SUSPEITO` e o script sai com
erro.

**Backup no mesmo disco do sistema não é backup.** Mande para fora:

```bash
apt install -y rclone
rclone config          # configure um destino (S3, Backblaze, Drive…)
# e acrescente ao cron, depois do backup:
30 3 * * * rclone sync /var/backups/stabilize remoto:stabilize-backups
```

### Testar a restauração — de verdade, uma vez

```bash
./deploy/restaurar.sh /var/backups/stabilize/banco-DATA.dump
```

Faça isso **agora**, com o sistema recém-instalado, e não durante o
incidente. Quem restaura pela primeira vez às três da manhã descobre os
problemas às três da manhã.

---

## 6. Atualizar

```bash
cd /opt/stabilize
git pull
docker compose build
set -a; . ./.env; set +a
docker compose run --rm -e DATABASE_MIGRATION_URL -e STABILIZE_APP_PASSWORD \
  -e STABILIZE_MIGRATOR_PASSWORD api ./packages/db/scripts/migrate.sh
docker compose up -d
```

Faça backup **antes** de migration que mexa em estrutura. As migrations
são idempotentes (`IF NOT EXISTS`), então reexecutar é seguro.

---

## 7. Vigiar

```bash
docker compose logs -f api          # aplicação
docker compose logs -f proxy        # TLS e requisições
docker stats --no-stream            # memória e CPU
df -h                               # o disco enche por anexos e WAL
```

O que merece alerta, em ordem de probabilidade:

| Sinal | Por que importa |
|---|---|
| disco > 80% | anexos e WAL crescem sozinhos; disco cheio corrompe backup |
| `stabilize-backup.log` com `SUSPEITO` | o backup parou de prestar **hoje** |
| contêiner reiniciando | `docker compose ps` mostra o contador |
| `outcome = 'DENIED'` no `audit_log` | alguém tentando alcançar dado de outro |

Consulta útil para o último caso:

```sql
SELECT created_at, actor_id, action, resource_id
  FROM audit_log
 WHERE outcome = 'DENIED' AND created_at > now() - interval '7 days'
 ORDER BY created_at DESC;
```

---

## 8. O que **falta** antes de dado real entrar

Honestidade em vez de checklist verde:

- [ ] **Restauração testada** (passo 5). Sem isto o backup é fé.
- [ ] **`.env` copiado para fora da VPS.**
- [ ] **Cópia externa dos backups** configurada.
- [ ] **Fontes servidas localmente.** Hoje o front busca Outfit e Source
      Sans no Google Fonts. Funciona, mas cria dependência de rede de
      terceiro e vaza o IP de cada usuário para o Google. Baixar e servir
      do próprio domínio resolve as duas coisas.
- [ ] **Monitoramento externo** (UptimeRobot ou similar) apontando para
      `/health`. Monitoramento que roda na mesma máquina não avisa quando
      a máquina cai.
- [ ] **Auditoria de dependências** com egress liberado:
      `pnpm audit` e semgrep com as regras completas do OWASP. O ambiente
      de desenvolvimento bloqueia `semgrep.dev`; só as 10 regras próprias
      do projeto rodaram.

---

## Problemas comuns

**O certificado não sai.** Quase sempre DNS. `dig +short SEU_DOMINIO`
tem que devolver o IP da VPS, e a porta 80 tem que estar aberta — o
desafio do Let's Encrypt passa por ela. `docker compose logs proxy` diz
o motivo exato.

**A API não sobe, o banco está `healthy`.** Confira se as migrations
rodaram: `docker compose logs api` mostra falha de conexão quando o papel
`stabilize_app` ainda não existe.

**Login sempre falha.** O hash da senha precisa ser argon2id gerado pelo
comando do passo 4. Um hash de outro algoritmo é recusado sem mensagem
específica — de propósito, para não distinguir "usuário não existe" de
"senha errada".

**Tudo volta 404 dentro do sistema.** Falta contexto de tenant, ou o
usuário não pertence à empresa daquele dado. O `audit_log` com
`outcome = 'DENIED'` mostra quem tentou o quê.
