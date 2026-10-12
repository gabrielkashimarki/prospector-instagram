# prospector-instagram

Prospecção no Instagram feita pelo **seu próprio Chrome**, no seu computador:

1. **Descobre** perfis por busca, hashtag ou lista sua.
2. **Lê** o perfil público (nome, bio, seguidores, últimas legendas).
3. **Qualifica** com regras suas e, se você quiser, com uma nota da IA.
4. **Escreve a primeira mensagem** com IA, no seu tom.
5. **Envia a DM** pelo Chrome, só se você ligar o modo envio (vem desligado).
6. Mostra **quem respondeu** (lead quente) e exporta tudo em planilha.

O código já vem pronto. A instalação é um `npm install` e um assistente de perguntas no terminal: **nenhuma IA é usada para instalar**. A IA só entra depois, para dar nota aos perfis e escrever rascunhos, com modelo barato por padrão e um teto de gasto por dia.

Inspirado no Buscando 1 Milhão, de Matheus Gomes (https://github.com/soumatheusgomes/buscandomilhao).

## Antes de usar, leia

- **Automatizar ações no Instagram vai contra os Termos de Uso do Instagram.** A conta pode ser limitada, bloqueada ou desativada. Use uma conta que você aceita arriscar e comece devagar. A responsabilidade pelo uso é sua.
- Os limites padrão são conservadores e há aquecimento (poucas DMs por dia na primeira semana). Aumentar os limites aumenta o risco.
- Mande mensagem só para quem faz sentido receber. Respeite quem pedir para parar. Os dados coletados são de terceiros: guarde só o necessário e apague quando não precisar mais (LGPD).
- O programa **nunca pede nem guarda a senha do Instagram**. Você entra no Instagram uma vez, na janela do Chrome dedicado.

## O que você precisa

- Computador com macOS, Windows ou Linux, ligado enquanto prospecta.
- **Google Chrome** instalado.
- **Node.js** versão LTS (22.18 ou mais nova): baixe em https://nodejs.org e instale como qualquer programa.
- Uma **chave de API de IA** com alguns dólares de crédito: Anthropic (padrão, a mais barata), OpenAI ou OpenRouter.
- Uma conta do Instagram para prospectar (de preferência profissional).

## Instalação, passo a passo

Abra o Terminal (no Windows, o "Prompt de Comando" ou "PowerShell") e copie um comando por vez.

**1. Baixe o projeto**: na página do repositório no GitHub, clique em "Code" e depois "Download ZIP". Descompacte e entre na pasta pelo terminal (troque o caminho pelo da sua pasta):

```
cd Downloads/prospector-instagram-main
```

(Quem usa git pode fazer `git clone` com o endereço da página.)

**2. Instale as dependências:**

```
npm install
```

**3. Responda o assistente** (nicho, buscas, sua mensagem, chave da IA, onde guardar os dados):

```
npm run instalar
```

**4. Abra o Chrome dedicado e entre no Instagram** com a conta que vai prospectar. Faça isso uma vez só e deixe essa janela aberta (use seu Chrome normal para o resto):

```
npm run chrome
```

**5. Coloque as buscas na fila:**

```
npm run descobrir
```

**6. Deixe trabalhando** (para parar, aperte Ctrl+C):

```
npm run rodar
```

**7. Acompanhe e baixe a planilha** (em outra janela do terminal):

```
npm run status
npm run exportar
```

A planilha fica na pasta `exportacoes/` e abre no Excel ou no Google Planilhas. A coluna `abertura` tem a mensagem que a IA escreveu para cada perfil.

**8. Quando os rascunhos estiverem bons**, abra o arquivo `config.yaml`, troque `modo: rascunho` por `modo: envio` e rode `npm run rodar` de novo. A partir daí as DMs saem de verdade, dentro dos limites.

## Quanto custa rodar por dia

O programa não tem servidor nem mensalidade. O único custo é a IA, cobrada por uso pelo provedor que você escolheu.

Estimativa com o padrão (Claude Haiku 5.5, US$ 0,10 por milhão de tokens de entrada e US$ 0,50 por milhão de saída):

| O que acontece | Tokens por perfil (aprox.) | Custo por perfil |
|---|---|---|
| Nota da IA para um perfil lido | 500 de entrada, 80 de saída | US$ 0,0001 |
| Primeira mensagem de um perfil aprovado | 600 de entrada, 120 de saída | US$ 0,0001 |

Um dia cheio com os limites padrão (até 200 perfis lidos e 20 mensagens) fica perto de **US$ 0,02 a US$ 0,05**. Com OpenAI ou OpenRouter (gpt-5-mini) espere de 3 a 5 vezes isso. Desligando a nota da IA (`usar_ia: false`) o custo cai quase a zero.

Isso é estimativa: preço de modelo muda e perfis com bio longa gastam mais. O valor real do dia aparece no `npm run status`, e o `teto_diario_usd` do `config.yaml` (padrão US$ 0,50) para a IA quando é atingido. Confira os preços no site do provedor e ajuste `preco_entrada_por_milhao` e `preco_saida_por_milhao` se mudarem.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run instalar` | Assistente de configuração (sem IA). |
| `npm run chrome` | Abre o Chrome dedicado para você entrar no Instagram. |
| `npm run descobrir` | Coloca buscas, hashtags e perfis do `config.yaml` na fila. Rodar duas vezes no mesmo dia não duplica. |
| `npm run rodar` | Trabalha a fila até você apertar Ctrl+C. Pode parar e voltar quando quiser: continua de onde parou. |
| `npm run status` | Andamento, limites do dia, gasto de IA, pausa e últimos eventos. |
| `npm run pausar` / `npm run retomar` | Pausa e retoma esta conta. |
| `npm run exportar` | Planilha CSV com todos os leads, notas, motivos e mensagens. |
| `npm run respostas` / `npm run aprovar` | Respostas escritas pela IA esperando sua aprovação (veja "Respostas"). |

## Configuração

Tudo fica no `config.yaml`, com comentários explicando cada campo. Os principais:

| Campo | Para que serve |
|---|---|
| `nicho`, `descoberta` | Quem você procura: termos de busca, hashtags, perfis que você já conhece e a lista de nunca contatar. |
| `qualificacao` | Palavras que indicam o perfil certo, palavras que eliminam, faixa de seguidores, nota mínima e a descrição do cliente ideal para a IA. |
| `dono.buscar_na_bio` | Se a bio disser "CEO: @fulano", a mensagem vai para a pessoa em vez da empresa. |
| `mensagem` | Quem assina, o que você oferece, objetivo, tom e regras extras da primeira mensagem. |
| `modo` | `rascunho` (padrão, nada sai) ou `envio`. |
| `curtir_antes_da_dm`, `seguimento` | Curtir o último post antes da DM e mandar um segundo contato para quem não respondeu (os dois desligados por padrão). |
| `limites`, `janela`, `pausas` | Quantas ações por hora e por dia, horário de trabalho e pausas aleatórias. |
| `ia` | Provedor, modelo, preços e teto diário de gasto. |
| `caixa` | Como acompanhar as respostas (veja abaixo). |

Os segredos (chaves) ficam no arquivo `.env`, que nunca vai para o GitHub.

## Segurança da conta

- **Limites por hora e por dia** para DM, curtida, leitura de perfil e busca, com espera sorteada entre ações do mesmo tipo.
- **Aquecimento**: 5 DMs por dia na primeira semana, mais 5 a cada semana, até o limite.
- **Janela de horário**: fora dela o navegador não faz nada.
- **Pausa automática** quando o Instagram pede verificação, mostra "tente novamente mais tarde" ou quando há falhas demais na última hora. O `npm run status` diz o motivo; resolva e rode `npm run retomar`.
- **Sessão perdida**: se o Instagram deslogar, o programa pausa e avisa para você entrar de novo na janela do Chrome dedicado.
- **Chrome fechado ou travado** não derruba nada: o trabalho espera 5 minutos e tenta de novo. O Chrome dedicado é reiniciado de tempos em tempos para liberar memória.
- **Nunca manda a mesma DM duas vezes.** Se o programa cair bem na hora de enviar, o lead fica como `incerto` para você conferir no Instagram.

## Estados do lead

`novo` → `lido` → `qualificado` → `rascunho` → `enviado` → `quente` (respondeu).
Também podem aparecer: `descartado` (não passou na nota), `sem_perfil`, `via_dono` (a mensagem foi para o dono citado na bio), `nao_entregavel` (o perfil não aceita mensagem), `sem_dm`, `encerrado` (pediu para parar) e `incerto`.

## Respostas

Depois da primeira DM você escolhe, no assistente ou em `caixa.provedor`:

- **`nenhum` (padrão)**: você responde pelo celular. No modo envio, alguns dias depois o programa abre a conversa no Chrome para ver quem respondeu e marca como lead quente.
- **`zernio`**: lê e responde pela API da Zernio (gratuita para uma conta). Crie a conta em zernio.com, conecte o Instagram, copie a chave da API para o `.env` (`ZERNIO_API_KEY`) e o id da conta para `caixa.zernio_conta`.
- **`meta`**: pelo seu próprio app da Meta (passo a passo abaixo).

Com `zernio` ou `meta`, quem responde vira lead quente e a IA escreve um rascunho de resposta. Por padrão (`respostas: rascunho`) nada sai sem você: veja com `npm run respostas` e envie com `npm run aprovar -- 12` (ou `--todas`). `automatico` envia sozinho e `desligado` não escreve rascunho. A Meta só deixa responder até 24 horas depois da última mensagem do contato; fora disso o rascunho fica como `fora_da_janela`.

### App próprio da Meta, passo a passo

1. A conta do Instagram precisa ser **profissional** (Empresa ou Criador de conteúdo).
2. Em https://developers.facebook.com crie um app do tipo **Empresa** e adicione o produto **Instagram**, opção "API com login do Instagram".
3. Em "Funções do app", adicione a conta do Instagram como **testadora** e aceite o convite no Instagram (Configurações, Apps e sites).
4. Peça as permissões `instagram_business_basic`, `instagram_business_manage_messages` e `instagram_business_manage_comments`.
5. Na tela de configuração da API, clique em **Gerar token** para a sua conta e cole no `.env` como `META_ACCESS_TOKEN`.
6. Em `config.yaml`, deixe `caixa.provedor: meta`.

Sem a análise do app pela Meta, isso só funciona para contas com papel no app (administrador, desenvolvedor ou testador). Para usar na sua própria conta é o suficiente. O token vale 60 dias: gere outro antes de vencer.

## Vários computadores (Supabase)

Para prospectar com várias contas do Instagram ao mesmo tempo, cada computador com a sua, todos na mesma base:

1. Crie um projeto gratuito em https://supabase.com.
2. No projeto, clique em **Connect**, escolha **Transaction pooler** e copie a connection string (porta 6543). Troque `[YOUR-PASSWORD]` pela senha do banco.
3. Em cada computador, rode `npm run instalar`, escolha "Vários computadores" e cole a connection string. Ela vai só para o `.env` daquele computador: nunca coloque no `config.yaml` nem mande por mensagem.
4. Cada computador usa um @ diferente em `operador.instagram`.

O que muda: os limites e o aquecimento valem por conta; a fila é dividida entre as máquinas sem trabalho repetido; e um perfil nunca é abordado duas vezes, nem por contas diferentes. A planilha mostra quem abordou cada lead e quando. O programa liga a proteção de linha (RLS) em todas as tabelas, então a chave pública do Supabase não lê nada.

### Respostas na hora (opcional, só com Supabase)

Sem isso, o computador consulta a caixa a cada `sincronizar_a_cada_minutos`. Com isso, a Meta ou a Zernio avisam uma função do seu Supabase na hora, e o computador sincroniza assim que vê o aviso. Precisa do Supabase CLI (https://supabase.com/docs/guides/cli):

```
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase secrets set META_APP_SECRET=... META_VERIFY_TOKEN=um-texto-que-voce-inventa ZERNIO_WEBHOOK_SECRET=...
supabase functions deploy receber-webhook --no-verify-jwt
```

(Defina só os segredos do provedor que você usa. Rode `npm run status` pelo menos uma vez antes, para criar as tabelas.)

O endereço da função é `https://SEU_PROJECT_REF.supabase.co/functions/v1/receber-webhook?provedor=meta` (ou `?provedor=zernio`). Na Meta, cadastre esse endereço em Webhooks do produto Instagram com o mesmo `META_VERIFY_TOKEN` e assine o campo `messages`. Na Zernio, cadastre o endereço e o segredo do webhook. Por fim, em `config.yaml`, troque `caixa.receber` para `webhook_supabase`. A função confere a assinatura de cada aviso e recusa o que não for da Meta ou da Zernio.

## Problemas comuns

- **"Não consegui conectar ao Chrome dedicado"**: rode `npm run chrome`. Se o Chrome não estiver no lugar padrão, informe o caminho em `CHROME_PATH` no `.env`.
- **Pausado por sessão perdida**: entre no Instagram de novo na janela do Chrome dedicado e rode `npm run retomar`.
- **Pausado por restrição**: abra o Instagram nessa janela, resolva o aviso e espere algumas horas antes de retomar. Considere baixar os limites.
- **Lead `incerto`**: abra a conversa no Instagram. Se a mensagem saiu, nada a fazer; se não saiu, envie à mão.
- **Algo mudou no Instagram e a leitura parou de funcionar**: o print da tela no momento da falha fica em `dados/diagnostico/` (só no seu computador).

## O que este projeto não faz

Não liga, não manda WhatsApp, não cria contas, não compra seguidores e não contorna verificação do Instagram. Não lê comentários e não responde stories.

## Para quem programa

- Node.js com TypeScript rodando direto (sem build), SQLite embutido no Node (`node:sqlite`) ou Postgres (`postgres`), Playwright conectado ao Chrome por CDP, `zod` para validar o `config.yaml`.
- Um processo só, com duas filas (navegador e geral) guardadas no próprio banco. No Postgres, várias máquinas dividem a fila com `for update skip locked`.
- O schema é um SQL só, escrito no que SQLite e Postgres entendem, com versões em `src/db.ts`. Sem ORM nem gerador de migração: menos peças para quem instala.
- Leitura das páginas do Instagram em `src/navegador/extrair.ts`, testada com HTML sintético em `test/fixtures/`.
- `npm run verificar` roda tipos, lint e testes. Para os testes também rodarem no Postgres: `TEST_DATABASE_URL=postgres://... npm test` (um Postgres descartável em Docker serve).

## Licença

MIT. Veja `LICENSE`.
