# Reflector

Laboratório de integração com canais de comunicação (WhatsApp, e futuramente Telegram, Instagram, etc.).

O objetivo **não** é construir um produto: é explorar webhooks e APIs de cada canal para entender seus modelos de eventos, autenticação e envio de mensagens — e, a partir disso, desenhar uma camada de abstração (interfaces) madura o suficiente para ser levada ao projeto oficial.

## Princípio central

Todo aprendizado converge para as interfaces em `src/core/`. Código específico de canal vive isolado em `src/providers/<canal>/` e só conversa com o resto do sistema através das interfaces de `core`. Se um provider precisar vazar um conceito específico dele para fora do seu diretório, a abstração precisa ser revisada — a fricção é registrada em [`docs/learnings.md`](docs/learnings.md) antes de qualquer contorno.

## Stack

| Tecnologia | Papel |
|---|---|
| Node.js >= 22 + TypeScript estrito (ESM) | Runtime e linguagem |
| [Fastify](https://fastify.dev) + `fastify-raw-body` | Servidor de webhooks (raw body para validar assinaturas) |
| [Zod](https://zod.dev) | Validação de payloads de webhook e variáveis de ambiente |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Persistência local de requests e correlações |
| [Vitest](https://vitest.dev) | Testes |
| [tsx](https://tsx.is) | Dev server com watch |

## Estrutura

```
src/
  core/            # interfaces agnósticas de canal (ChannelProvider, mensagens, eventos, MessageStore)
  providers/
    whatsapp/      # implementação WhatsApp Cloud API (Meta) + fixtures de payload
  store/           # SqliteStore: persistência de requests de webhook e correlações
  server/          # Fastify: rotas de webhook, verificação, dispatch para providers
  config.ts        # carregamento e validação (Zod) das env vars
public/
  index.html       # dashboard de inspeção (vanilla JS, sem build)
docs/
  learnings.md     # diário de aprendizados e fricções de cada canal
```

## Setup

1. **Pré-requisitos**: Node.js >= 22 e uma conta na [Meta for Developers](https://developers.facebook.com) com um app WhatsApp configurado.

2. **Instalar dependências**:

   ```bash
   npm install
   ```

3. **Configurar ambiente**:

   ```bash
   cp .env.example .env
   ```

   Preencha as variáveis (todas validadas com Zod em `src/config.ts` na inicialização — o servidor falha rápido se algo faltar):

   | Variável | Origem |
   |---|---|
   | `PORT` | Porta do servidor (padrão 3000) |
   | `WHATSAPP_ACCESS_TOKEN` | App Dashboard > WhatsApp > API Setup (em dev, token temporário de 24h) |
   | `WHATSAPP_PHONE_NUMBER_ID` | ID do número remetente (não é o número em si) |
   | `WHATSAPP_BUSINESS_ACCOUNT_ID` | WABA ID |
   | `WHATSAPP_APP_SECRET` | App Dashboard > Settings > Basic — valida `X-Hub-Signature-256` |
   | `WHATSAPP_VERIFY_TOKEN` | String arbitrária sua, repetida na configuração do webhook na Meta |
   | `WHATSAPP_API_VERSION` | Versão da Graph API (ex.: `v23.0`) |

4. **Rodar**:

   ```bash
   npm run dev
   ```

## Comandos

```bash
npm run dev        # servidor de webhooks em watch mode (porta 3000)
npm run build      # tsc para dist/
npm start          # roda o build (dist/)
npm test           # vitest (run único)
npm run test:watch # vitest em watch mode
npm run typecheck  # tsc --noEmit
```

## Exposição local (ngrok)

Webhooks da Meta exigem HTTPS público. Use ngrok apontando para a porta do servidor — de preferência com o domínio estático gratuito da conta (Dashboard ngrok > Domains), para não reconfigurar o webhook na Meta a cada restart:

```bash
ngrok http 3000 --url=<seu-subdominio>.ngrok-free.app
```

A URL pública (`https://<seu-subdominio>.ngrok-free.app/webhooks/whatsapp`) é configurada no App Dashboard da Meta (WhatsApp > Configuration > Webhook), junto com o mesmo valor de `WHATSAPP_VERIFY_TOKEN`. O inspector local do ngrok (`http://localhost:4040`) ajuda a ver as requests cruas chegando.

## Endpoints

| Método e rota | Descrição |
|---|---|
| `GET /` | Dashboard de inspeção: timeline dos envios, payloads traduzidos vs. brutos |
| `GET /webhooks/:channel` | Handshake de verificação do webhook |
| `POST /webhooks/:channel` | Recepção de eventos (raw body + validação de assinatura) |
| `POST /api/:channel/send` | Dispara mensagem (`{ to, content, replyTo? }` — `content.kind`: `text` \| `template` \| `media` \| `reaction`) |
| `POST /api/:channel/messages/:providerMessageId/read` | Confirma leitura de mensagem recebida |
| `POST /api/:channel/messages/:providerMessageId/correct` | Correção pós-envio: reage ⚠️ à original e envia reply com o texto corrigido |
| `GET /api/messages/:providerMessageId/timeline` | Envio + status correlacionados (encode o wamid na URL) |
| `GET /api/messages/outbound` | Lista mensagens enviadas |
| `GET /api/messages/inbound` | Lista mensagens recebidas |
| `GET /api/webhook-requests` | Lista requests brutas de webhook |

## Persistência e correlação

Toda request recebida no webhook é persistida em SQLite (`data/reflector.db`, configurável via `DATABASE_PATH`) — inclusive as de assinatura inválida:

- `webhook_requests` — headers + corpo bruto + validade da assinatura (matéria-prima do laboratório)
- `outbound_messages` — mensagens enviadas via API, com `provider_message_id` (wamid) e resposta crua
- `inbound_messages` — mensagens recebidas, com dedupe por `provider_message_id`
- `status_events` — eventos de status (sent/delivered/read/failed); **sem** dedupe de propósito, para observar reentregas da Meta

A correlação envio ↔ webhook se dá pelo `provider_message_id`: o wamid retornado no envio é o mesmo `id` dos eventos de status. Cada inbound/status aponta também a `webhook_request_id` de origem, ligando o evento traduzido à request bruta.

## Canal atual: WhatsApp Cloud API (Meta)

Particularidades relevantes (detalhes e fricções em [`docs/learnings.md`](docs/learnings.md)):

- Webhook tem dois fluxos: `GET` (verificação via `hub.challenge`) e `POST` (eventos, sempre validando `X-Hub-Signature-256` antes de processar)
- Responder o `POST` com 200 imediatamente e processar de forma assíncrona — a Meta reenvia eventos não confirmados (dedupe por `message.id`)
- Janela de 24h: mensagens livres só dentro de 24h após o último contato do usuário; fora dela, apenas templates aprovados
- Mídia recebida vem como `media_id` — exige um `GET /<media_id>` para obter URL temporária (~5 min) e download autenticado
- A Cloud API não permite editar mensagem enviada — daí o padrão de correção via reação + reply

## Testes

Testes de tradução de payload usam fixtures reais capturadas em `src/providers/<canal>/fixtures/`. Rode com `npm test`.
