# Configuração dos canais

Guia de referência para obter as credenciais e configurar cada canal no reflector.
Copie `.env.example` para `.env` e preencha as variáveis conforme cada seção abaixo.

---

## Exposição local (ngrok)

Todos os canais exigem um endpoint HTTPS público. Use o domínio estático gratuito do ngrok para não ter que reconfigurar os webhooks a cada restart.

```bash
# Instale ngrok e autentique uma vez
ngrok config add-authtoken <seu-token>   # dashboard.ngrok.com > Your Authtoken

# Suba apontando para o servidor local
ngrok http 3000 --url=<seu-subdominio>.ngrok-free.app
```

O inspector local em `http://localhost:4040` mostra todas as requests recebidas com headers e corpo — aliado essencial para debugar assinaturas e payloads.

---

## WhatsApp (Meta Cloud API)

**Pré-requisito:** conta Meta for Developers e um número de teste associado ao WABA.

### 1. Criar o app

1. Acesse [developers.facebook.com](https://developers.facebook.com) > **My Apps** > **Create App**
2. Tipo: **Business**
3. Após criar, vá em **Add Products** e adicione **WhatsApp**

### 2. Obter as credenciais

| Variável | Onde encontrar |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | **WhatsApp > API Setup** — em dev use o token temporário (24 h); em produção, crie um System User Token permanente em **Business Settings > System Users** |
| `WHATSAPP_PHONE_NUMBER_ID` | **WhatsApp > API Setup** — campo "Phone number ID" (não é o número de telefone) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | **WhatsApp > API Setup** — campo "WhatsApp Business Account ID" |
| `WHATSAPP_APP_SECRET` | **Settings > Basic > App Secret** — clique em "Show" |
| `WHATSAPP_VERIFY_TOKEN` | Valor arbitrário que você escolhe (ex.: `meu-token-secreto`) |
| `WHATSAPP_API_VERSION` | Manter `v23.0` ou atualizar conforme o CLAUDE.md |

### 3. Configurar o webhook

1. **WhatsApp > Configuration > Webhook** > **Edit**
2. Callback URL: `https://<ngrok>/webhooks/whatsapp`
3. Verify Token: o mesmo valor que você colocou em `WHATSAPP_VERIFY_TOKEN`
4. Clique **Verify and Save**
5. Em **Webhook Fields**, habilite: `messages`

### 4. Testar

```bash
# Enviar mensagem de texto
curl -X POST http://localhost:3000/api/whatsapp/send \
  -H 'content-type: application/json' \
  -d '{ "to": "5511999999999", "content": { "kind": "text", "text": "Olá!" } }'
```

O número de destino deve estar na lista de contatos de teste do WABA em dev.

---

## Discord

**Pré-requisito:** conta Discord e servidor próprio para testes.

### 1. Criar o app e o bot

1. Acesse [discord.com/developers/applications](https://discord.com/developers/applications) > **New Application**
2. Vá em **Bot** > **Add Bot**
3. Em **Privileged Gateway Intents**, habilite:
   - **MESSAGE CONTENT** ← obrigatório para ler o texto das mensagens

### 2. Obter as credenciais

| Variável | Onde encontrar |
|---|---|
| `DISCORD_BOT_TOKEN` | **Bot > Token** — clique **Reset Token** para gerar/ver |
| `DISCORD_APPLICATION_ID` | **General Information > Application ID** |
| `DISCORD_PUBLIC_KEY` | **General Information > Public Key** (hex, para verificar o Interactions endpoint) |

### 3. Convidar o bot para o servidor

1. **OAuth2 > URL Generator**
2. Scopes: `bot`
3. Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Manage Messages`
4. Copie a URL gerada, abra no browser e selecione seu servidor de testes

### 4. Configurar o Interactions endpoint (opcional)

O reflector recebe eventos via **Gateway WebSocket** (não pelo Interactions endpoint), então essa configuração é opcional. Se quiser explorar o fluxo de interactions:

1. **General Information > Interactions Endpoint URL**: `https://<ngrok>/webhooks/discord`

### 5. Testar

```bash
# Listar servidores e canais disponíveis
curl http://localhost:3000/api/discord/destinations

# Enviar mensagem para um canal
curl -X POST http://localhost:3000/api/discord/send \
  -H 'content-type: application/json' \
  -d '{ "to": "<channelId>", "content": { "kind": "text", "text": "Olá!" } }'

# Abrir DM com um usuário e enviar mensagem
curl -X POST http://localhost:3000/api/discord/dm \
  -H 'content-type: application/json' \
  -d '{ "userId": "<userId>" }'
# Retorna { "channelId": "..." } — use esse ID como "to" no /send
```

O `channelId` do canal aparece no Discord ao ativar **Settings > Advanced > Developer Mode** e clicar com botão direito no canal > **Copy Channel ID**.

---

## Slack

**Pré-requisito:** workspace Slack onde você tem permissão para instalar apps.

### 1. Criar o app

1. Acesse [api.slack.com/apps](https://api.slack.com/apps) > **Create New App** > **From scratch**
2. Escolha o workspace de testes

### 2. Configurar escopos OAuth

Em **OAuth & Permissions > Scopes > Bot Token Scopes**, adicione:

| Escopo | Para que serve |
|---|---|
| `chat:write` | Enviar mensagens |
| `channels:read` | Listar canais públicos |
| `groups:read` | Listar canais privados |
| `im:read` | Listar DMs |
| `im:write` | Abrir DMs |
| `mpim:read` | Listar group DMs |
| `reactions:add` | Adicionar reações |
| `channels:history` | Ler histórico de canais públicos |
| `groups:history` | Ler histórico de canais privados |
| `im:history` | Ler histórico de DMs |

### 3. Instalar o app e obter as credenciais

1. **OAuth & Permissions > Install to Workspace** — autorize
2. Após instalar:

| Variável | Onde encontrar |
|---|---|
| `SLACK_BOT_TOKEN` | **OAuth & Permissions > Bot User OAuth Token** (começa com `xoxb-`) |
| `SLACK_SIGNING_SECRET` | **Basic Information > App Credentials > Signing Secret** |

### 4. Configurar o webhook de eventos

1. **Event Subscriptions > Enable Events**: ative
2. Request URL: `https://<ngrok>/webhooks/slack`
   - O Slack faz uma verificação `url_verification` — o servidor responde automaticamente
3. Em **Subscribe to bot events**, adicione:
   - `message.channels` — mensagens em canais públicos
   - `message.groups` — mensagens em canais privados
   - `message.im` — mensagens diretas
   - `message.mpim` — mensagens em group DMs
4. Clique **Save Changes** e reinstale o app se pedido

### 5. Testar

```bash
# Listar canais e DMs disponíveis
curl http://localhost:3000/api/slack/destinations

# Enviar mensagem para um canal
curl -X POST http://localhost:3000/api/slack/send \
  -H 'content-type: application/json' \
  -d '{ "to": "<channelId>", "content": { "kind": "text", "text": "Olá!" } }'

# Abrir DM com um usuário
curl -X POST http://localhost:3000/api/slack/dm \
  -H 'content-type: application/json' \
  -d '{ "userId": "<memberId>" }'
# Retorna { "channelId": "..." } — use esse ID como "to" no /send
```

O `channelId` e `memberId` aparecem no Slack ao clicar com botão direito no canal/usuário > **Copy Link** — o ID está no final da URL.

---

## Microsoft Teams

**Pré-requisito:** acesso ao [portal.azure.com](https://portal.azure.com) com permissão para criar App Registrations (ou um app existente que você possa usar).

### 1. App Registration no Azure

Se ainda não tiver um app:

1. **Microsoft Entra ID > App registrations > New registration**
2. Supported account types: **Multitenant** (ou Single tenant se o bot for só interno)
3. Após criar, anote o **Application (client) ID** e o **Directory (tenant) ID**

Para criar o client secret:

1. **Certificates & secrets > Client secrets > New client secret**
2. Copie o **Value** imediatamente — some ao sair da tela

| Variável | Onde encontrar |
|---|---|
| `TEAMS_APP_ID` | **Overview > Application (client) ID** |
| `TEAMS_APP_PASSWORD` | **Certificates & secrets > Client secrets > Value** (copie ao criar) |
| `TEAMS_TENANT_ID` | **Overview > Directory (tenant) ID** — omita para bots multitenant |

### 2. Criar o Azure Bot Resource

1. **Create a resource > Azure Bot**
2. Preencha:
   - Bot handle: nome único global (ex.: `reflector-bot-xyz`)
   - Pricing tier: **F0** (gratuito)
   - Microsoft App ID: **Use existing app registration** → cole o `TEAMS_APP_ID`
   - App type: bata com o "Supported account types" do passo anterior
3. Após criar, vá em **Configuration** e preencha:
   - **Messaging endpoint**: `https://<ngrok>/webhooks/teams`
4. Vá em **Channels > Microsoft Teams > Apply** para habilitar o canal

### 3. Criar o app manifest do Teams

Crie uma pasta `teams-app/` na raiz do projeto com:

**`teams-app/manifest.json`**
```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<TEAMS_APP_ID>",
  "packageName": "com.reflector.bot",
  "developer": {
    "name": "Reflector Lab",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "name": { "short": "Reflector Bot", "full": "Reflector Lab Bot" },
  "description": { "short": "Bot de laboratório", "full": "Bot de laboratório de integração" },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#FFFFFF",
  "bots": [
    {
      "botId": "<TEAMS_APP_ID>",
      "scopes": ["personal", "team", "groupChat"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

Substitua `<TEAMS_APP_ID>` pelo seu Application (client) ID (aparece duas vezes).

Adicione dois ícones PNG obrigatórios:
- `color.png` — 192×192 px
- `outline.png` — 32×32 px, fundo transparente

Empacote:
```bash
cd teams-app && zip ../reflector-bot.zip manifest.json color.png outline.png
```

### 4. Instalar o bot no Teams (sideloading)

1. No Teams: **Apps** (barra lateral) > **Manage your apps**
2. **Upload an app > Upload a custom app** > selecione `reflector-bot.zip`
3. **Add** para instalar no escopo pessoal, ou **Add to a team** para um canal

> Se a opção de upload não aparecer, o admin do tenant precisa habilitar em **Teams Admin Center > Setup policies > Allow uploading custom apps**.

### 5. Testar

O Teams só envia eventos após o bot estar instalado e o ngrok estar ativo com o endpoint configurado no Azure Bot.

```bash
# 1. Inicie o servidor e o ngrok
npm run dev
ngrok http 3000 --url=<seu-subdominio>.ngrok-free.app

# 2. Envie uma mensagem ao bot no Teams (escopo pessoal)
#    O log do servidor mostrará o payload e o conversationId será cacheado

# 3. Ver conversas conhecidas (para obter o conversationId)
curl http://localhost:3000/api/teams/destinations

# 4. Responder via API
curl -X POST http://localhost:3000/api/teams/send \
  -H 'content-type: application/json' \
  -d '{ "to": "<conversationId>", "content": { "kind": "text", "text": "Olá do bot!" } }'

# 5. Responder citando uma mensagem específica
curl -X POST http://localhost:3000/api/teams/send \
  -H 'content-type: application/json' \
  -d '{
    "to": "<conversationId>",
    "content": { "kind": "text", "text": "Resposta aqui" },
    "replyTo": "<conversationId>|<activityId>"
  }'
```

> **Diagnóstico de JWT:** se o servidor rejeitar as requests do Teams com assinatura inválida, inspecione o token em `http://localhost:4040` (ngrok inspector) — cole o valor do header `Authorization` em [jwt.ms](https://jwt.ms) e verifique se o campo `aud` bate com o `TEAMS_APP_ID`.

---

## Referência rápida das variáveis

```bash
# WhatsApp
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_API_VERSION=v23.0

# Discord
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=
DISCORD_PUBLIC_KEY=

# Slack
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=

# Teams
TEAMS_APP_ID=
TEAMS_APP_PASSWORD=
TEAMS_TENANT_ID=   # omitir para multitenant
```
