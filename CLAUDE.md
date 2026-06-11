# reflector

Laboratório de integração com canais de comunicação (WhatsApp, e futuramente Telegram, Instagram, etc.). O objetivo NÃO é construir um produto: é explorar webhooks e APIs de cada canal para entender seus modelos de eventos, autenticação e envio de mensagens, e a partir disso desenhar uma camada de abstração (interfaces) madura o suficiente para ser levada ao projeto oficial.

## Princípio central

Todo aprendizado deve convergir para as interfaces em `src/core/`. Código específico de canal vive isolado em `src/providers/<canal>/` e só conversa com o resto do sistema através das interfaces de `core`. Se um provider precisar vazar um conceito específico dele para fora do seu diretório, isso é um sinal de que a abstração precisa ser revisada — registre a fricção em `docs/learnings.md` antes de contornar.

## Stack

- Node.js >= 22, TypeScript estrito, ESM (`"type": "module"`)
- Fastify para receber webhooks (precisamos do raw body para validar assinaturas)
- Zod para validar payloads de webhook e variáveis de ambiente
- Vitest para testes
- `tsx` para rodar em dev com watch

## Comandos

```bash
npm run dev        # servidor de webhooks em watch mode (porta 3000)
npm run build      # tsc para dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## Estrutura

```
src/
  core/            # interfaces agnósticas de canal (ChannelProvider, mensagens, eventos, MessageStore)
  providers/
    whatsapp/      # implementação WhatsApp Cloud API (Meta) + fixtures de payload
  store/           # SqliteStore: persistência de requests de webhook e correlações
  server/          # Fastify: rotas de webhook, verificação, dispatch para providers
  config.ts        # carregamento e validação (Zod) das env vars
docs/
  learnings.md     # diário de aprendizados e fricções de cada canal
```

## Persistência e correlação (objetivo central dos testes)

Toda request recebida no webhook é persistida em SQLite (`data/reflector.db`, configurável via `DATABASE_PATH`) — inclusive as de assinatura inválida. Tabelas:

- `webhook_requests` — headers + corpo bruto + validade da assinatura (matéria-prima do laboratório)
- `outbound_messages` — mensagens enviadas via API, com `provider_message_id` (wamid) e resposta crua da API
- `inbound_messages` — mensagens recebidas, com dedupe por `provider_message_id` (UNIQUE + INSERT OR IGNORE)
- `status_events` — eventos de status (sent/delivered/read/failed); sem dedupe de propósito, para observar reentregas

A correlação envio ↔ webhook se dá por `provider_message_id`: o wamid retornado pelo envio é o mesmo `id` dos eventos de status. Cada inbound/status também aponta o `webhook_request_id` de origem, ligando o evento traduzido à request bruta. A timeline de um envio também inclui **reações** (content `reaction` cujo `targetMessageId` é o wamid) e **replies** (`reply_to`, vindo de `context.id`).

Tipos de mensagem recebida mapeados pelo provider WhatsApp: `text`, mídia (`image`/`audio`/`video`/`document`/`sticker`), `reaction`, `location`, `contacts`, `interactive` (button/list reply) e `button` de template — os dois últimos unificados no tipo agnóstico `choice`. Mensagens apagadas pelo usuário e tipos sem suporte (enquetes, efêmeras) chegam como `unsupported` com `errors` no raw. Somente o campo `messages` da WABA está assinado por enquanto.

## Endpoints

- `GET  /` — dashboard de inspeção (`public/index.html`, vanilla JS, sem build): timeline dos envios, payloads traduzidos vs. brutos, e link de cada status/inbound para a webhook request de origem
- `GET  /webhooks/:channel` — handshake de verificação
- `POST /webhooks/:channel` — recepção de eventos (raw body + assinatura)
- `POST /api/:channel/send` — dispara mensagem (`{ to, content: { kind: 'text' | 'template' | 'media' | 'reaction', ... }, replyTo? }`); `replyTo` cita uma mensagem (reply); `reaction` reage a um wamid (emoji vazio remove)
- `POST /api/:channel/messages/:providerMessageId/read` — confirma leitura de mensagem recebida ("visto" do nosso lado)
- `POST /api/:channel/messages/:providerMessageId/correct` — padrão de correção pós-envio (`{ text }`): reage ⚠️ à mensagem original e envia reply citando-a com o texto corrigido (a Cloud API não permite editar mensagem enviada — ver docs/learnings.md)
- `GET  /api/messages/:providerMessageId/timeline` — envio + status correlacionados (encode o wamid na URL)
- `GET  /api/messages/outbound` | `/api/messages/inbound` | `/api/webhook-requests` — inspeção

## Canal atual: WhatsApp Cloud API (Meta)

- API oficial via Graph API (`https://graph.facebook.com/v23.0/`)
- Envio: `POST /<PHONE_NUMBER_ID>/messages` com Bearer token
- Webhook tem dois fluxos distintos:
  - `GET /webhooks/whatsapp` — verificação inicial: comparar `hub.verify_token` com `WHATSAPP_VERIFY_TOKEN` e responder `hub.challenge` em texto puro
  - `POST /webhooks/whatsapp` — eventos: SEMPRE validar `X-Hub-Signature-256` (HMAC-SHA256 do raw body com `WHATSAPP_APP_SECRET`) antes de processar
- Responder o POST com 200 imediatamente; processar o evento de forma assíncrona. A Meta reenvia eventos não confirmados (esperar duplicatas — dedupe por `message.id`)
- Janela de 24h: mensagens livres só dentro de 24h após o último contato do usuário; fora dela, apenas templates aprovados
- Mídia recebida vem como `media_id` — requer `GET /<media_id>` para obter URL temporária (expira em ~5 min) e download autenticado

## Exposição local (ngrok)

Webhooks da Meta exigem HTTPS público. Usamos ngrok apontando para a porta do servidor:

```bash
ngrok http 3000
```

Importante: no plano free a URL aleatória muda a cada restart, o que obriga a reconfigurar o webhook na Meta toda vez. Para evitar isso, use o domínio estático gratuito da conta (Dashboard ngrok > Domains):

```bash
ngrok http 3000 --url=<seu-subdominio>.ngrok-free.app
```

A URL pública (`https://<seu-subdominio>.ngrok-free.app/webhooks/whatsapp`) é configurada no app da Meta (App Dashboard > WhatsApp > Configuration > Webhook), junto com o mesmo valor de `WHATSAPP_VERIFY_TOKEN`. O inspector local do ngrok (`http://localhost:4040`) é um aliado extra para ver as requests cruas chegando.

## Variáveis de ambiente

Copiar `.env.example` para `.env` (nunca commitar `.env`). Todas validadas em `src/config.ts` na inicialização — falhar rápido se algo faltar.

## Convenções

- Tipos de domínio (mensagem, contato, evento) definidos em `core` de forma agnóstica; cada provider traduz seu payload nativo para esses tipos (e nunca o contrário)
- Payloads brutos de webhook devem ser logados em dev (são a principal fonte de aprendizado)
- Testes de tradução de payload usam fixtures reais capturadas em `src/providers/<canal>/fixtures/`
