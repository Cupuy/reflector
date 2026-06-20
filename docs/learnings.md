# Diário de aprendizados por canal

Fricções, surpresas e particularidades descobertas nos testes — insumo para o design das interfaces do projeto oficial.

## WhatsApp Cloud API (Meta)

### 2026-06-10 — Nono dígito brasileiro: wa_id ≠ número de envio (#131030)

**Sintoma:** responder/reagir a uma mensagem recebida falhava com `(#131030) Recipient phone number not in allowed list`, mesmo com o número cadastrado na lista de permissão do modo de teste.

**Causa:** o `wa_id` (campo `from` do webhook) de celulares brasileiros registrados antes do nono dígito vem **sem o 9** (`554896175805`), mas o endpoint de envio espera o número **com o 9** (`5548996175805`). Ou seja: o identificador que o canal usa para o contato não é necessariamente um endereço válido de envio.

**Solução no reflector:** o provider WhatsApp normaliza destinos BR no envio (`normalizeBrazilianMobile`): `55 + DDD + 8 dígitos` começando com 6-9 ganha o 9 após o DDD; fixos (2-5) ficam intactos.

**Implicação para a abstração:** a interface do projeto oficial não deve assumir que o id do remetente de um evento inbound é diretamente utilizável como destinatário. Cada provider precisa ser dono da tradução `contactId → endereço de envio`. A resposta do envio da Meta inclui `contacts[].wa_id` (o id canônico) ao lado de `messages[].id` — vale persistir esse vínculo.

### 2026-06-10 — Modo de teste: lista de permissão de destinatários

Com app não publicado e número de teste, só é possível enviar para até 5 números verificados (API Setup > "Até" > gerenciar lista). Erro fora da lista: `#131030`. Fora da janela de 24h o erro muda para `#131047` (exige template).

### 2026-06-10 — Não existe edição/revogação de mensagem enviada

A Cloud API não tem endpoint para editar nem apagar mensagens já enviadas (o "editar em 15 min" é só dos apps; APIs não-oficiais fazem isso simulando um cliente). Moderação pós-envio precisa virar: (a) fila com delay antes do despacho, ou (b) padrão de correção — reply citando a original com o conteúdo corrigido.

**Implicação para a abstração:** edição é capability que varia por canal (Telegram edita, WhatsApp não). A interface do projeto oficial deve expor capabilities declaráveis por provider (ex.: `supportsEditing`) para o chamador escolher entre editar e corrigir.

### 2026-06-10 — markAsRead não gera webhook

`POST /messages` com `status: "read"` confirma leitura (tique azul no aparelho do remetente), mas a Meta não envia nenhum evento de confirmação — o efeito só é observável no cliente.

---

## Discord

### 2026-06-13 — Modelo push invertido: Gateway WebSocket vs. webhook HTTP

**Diferença fundamental:** o WhatsApp empurra eventos via HTTP POST ao nosso servidor. O Discord funciona ao contrário: **nós nos conectamos** ao Gateway dele via WebSocket e ficamos escutando. Os eventos chegam por essa conexão persistente, não por POST ao `/webhooks/discord`.

Isso forçou uma extensão na interface `ChannelProvider` — métodos de lifecycle opcionais `start()` e `stop()` para providers que precisam de conexão ativa. Providers baseados em webhook puro (WhatsApp) não implementam esses métodos.

**Implicação para a abstração:** o projeto oficial precisa decidir se suporta os dois modelos (push + pull) ou padroniza em um só. A opção `start/stop` na interface é mínima mas suficiente. Uma alternativa mais explícita seria uma interface separada `GatewayProvider extends ChannelProvider`.

**Detalhe operacional:** eventos do Gateway são autenticados por TLS + bot token, sem HMAC no corpo. A coluna `signature_valid` do banco sempre fica `true` para eventos Gateway.

### 2026-06-13 — providerMessageId composto (channelId:messageId)

**Problema:** no WhatsApp, o `wamid` é globalmente único. No Discord, qualquer operação sobre uma mensagem (editar, deletar, reagir) exige dois IDs: `channel_id` + `message_id`. Sem o `channel_id`, a REST API não funciona.

**Solução:** o provider Discord usa `"${channelId}:${messageId}"` como `providerMessageId` composto. Reações recebidas (que não têm ID próprio) usam `"rxn:${userId}:${channelId}:${messageId}:${emoji}"`.

**Implicação para a abstração:** `providerMessageId` não pode ser assumido como um ID opaco e portável. Cada provider define sua estrutura interna. O projeto oficial deve tratar `providerMessageId` como uma string opaca que o próprio provider sabe como decompor.

### 2026-06-13 — Interactions endpoint exige resposta síncrona (PING/PONG)

**Problema:** o Discord verifica a URL do Interactions endpoint enviando um POST com `{ type: 1 }` (PING) e esperando uma resposta JSON `{ type: 1 }` (PONG) dentro de 3 segundos. O servidor atual envia `200 vazio` imediatamente e processa de forma assíncrona — isso quebra o handshake do Interactions.

**Situação atual:** o Interactions endpoint não está ativo (usamos apenas o Gateway). Se precisarmos ativá-lo no futuro, o servidor precisará de um mecanismo para a resposta customizada por provider antes do auto-reply `200`.

**Possíveis soluções:** (a) adicionar `webhookResponse?(body): { status; body } | null` à interface, chamado antes do send da resposta; (b) usar rota dedicada `/webhooks/discord/interactions` fora do handler genérico.

### 2026-06-13 — Reações não têm ID próprio no Discord

**Diferença de modelo:** no WhatsApp, uma reação chega como uma mensagem regular com `id` próprio. No Discord, `MESSAGE_REACTION_ADD` traz `(user_id, channel_id, message_id, emoji)` — sem ID de evento.

Para deduplicação via `INSERT OR IGNORE`, foi necessário construir um ID sintético: `rxn:${userId}:${channelId}:${messageId}:${emoji}`. Isso funciona para dedup mas torna o ID ilegível e não operável.

**Implicação para a abstração:** o tipo `InboundMessage` assume `providerMessageId` como identificador para operações subsequentes. Para reações sem ID nativo, esse campo vira chave artificial de dedup, não um handle de API.

### 2026-06-13 — Endereço de envio é channel_id, não userId

**Diferença de modelo:** no WhatsApp, `to` é um número de telefone (identificador do contato). No Discord, `to` é um `channel_id` — tanto para canais de servidor quanto para DMs. Para DMs, é necessário primeiro criar o canal de DM via `POST /users/@me/channels` passando o `userId` e obter o `channel_id` resultante.

**Solução:** o reflector expõe `POST /api/discord/dm` com `{ userId }` para criar/recuperar o canal de DM e retornar o `channelId` para uso nos envios subsequentes.

**Implicação para a abstração:** o campo `to` de `OutboundMessage` não tem semântica uniforme — cada canal usa seu próprio espaço de endereços. O projeto oficial pode precisar de uma camada de resolução de endereços por provider.

---

## Microsoft Teams

### 2026-06-20 — Provisionamento de app é Microsoft Graph, não Bot Framework

**Contexto:** queríamos listar os usuários do tenant e instalar o bot proativamente para um usuário específico, sem ele precisar abrir o Teams e adicionar o app manualmente.

**Descoberta:** isso não passa pela Bot Framework Connector API (usada em `send`/`editMessage`/`openDM`, escopo `api.botframework.com`). É Microsoft Graph (`graph.microsoft.com`), com OAuth2 e permissões de aplicativo próprias — `User.Read.All` para listar usuários do tenant, `TeamsAppInstallation.ReadWriteForUser.All` para instalar um app em nome de um usuário — concedidas com consentimento de admin no mesmo App Registration do bot. Além disso, só é possível instalar via Graph um app que já está publicado no **catálogo do tenant** (`appCatalogs/teamsApps`, com um `teamsAppId` próprio, diferente do Application ID do App Registration); um app apenas sideloaded (como o bot deste laboratório) não tem entrada no catálogo e não pode ser instalado por essa rota.

**Implicação para a abstração:** isso não é um conceito de canal de mensageria — não há equivalente em WhatsApp/Discord/Slack (no máximo, um fluxo de instalação via OAuth iniciado pelo próprio usuário, nunca um provisionamento administrativo via API). Por isso `listOrgUsers`/`installApp` ficaram como métodos próprios de `TeamsProvider`, fora da interface `ChannelProvider`, com rotas dedicadas (`/api/teams/users`, `/api/teams/install`) registradas em `src/server/index.ts` em vez de `src/server/app.ts` — o dispatcher genérico de canais permanece agnóstico.

### 2026-06-20 — `openDM` não deve prefixar "29:" no AAD Object ID

**Sintoma:** `POST /api/teams/dm` com o AAD Object ID de um usuário (vindo de `listOrgUsers`/Graph) retornava `403 BadArgument: Failed to decrypt pairwise id`.

**Causa:** o código original assumia que todo `userId` sem prefixo `29:` precisava receber esse prefixo antes de ir para `members[].id` em `POST /v3/conversations`. Isso é válido para um id Teams já cunhado nesse formato (ex.: vindo de `from.id` de uma activity recebida), mas um AAD Object ID puro **não pode** virar um id Teams só prependendo `29:` — esse prefixo denota um token opaco específico do canal, não um namespace livre.

**Solução:** parei de prefixar — `members: [{ id: userId }]` aceita o AAD Object ID puro (do Graph) e também o id já no formato `29:xxx` (de uma activity), sem distinção. Confirmado via teste manual contra a Connector API: ambos os formatos retornam a mesma conversa 1:1 já existente.

**Implicação para a abstração:** assim como o aprendizado equivalente do WhatsApp (`contactId` do evento inbound ≠ endereço de envio), aqui o inverso também é verdade: um id de usuário obtido por **outra API do mesmo canal** (Graph, não Bot Framework) pode ser diretamente utilizável como member id, mas só se não for adulterado por suposições de formato erradas. Vale desconfiar de qualquer prefixo/sufixo "mágico" adicionado a um id de fora do provider sem confirmação experimental.

### 2026-06-20 — `serviceUrl` para mensagens proativas precisa sobreviver a restarts

**Sintoma:** `POST /api/teams/dm` retornava `500: Teams: nenhum serviceUrl cacheado` mesmo após o bot já ter trocado mensagens com o usuário antes — bastava reiniciar o servidor (no dev, qualquer save sob `tsx watch`) para o erro voltar.

**Causa:** o Bot Framework não expõe o `serviceUrl` (endpoint regional da Connector API para aquele tenant/cloud) por nenhuma API de consulta — ele só chega como campo de uma activity recebida via webhook. O reflector cacheava isso (`defaultServiceUrl`/`defaultTenantId`/`serviceUrlCache`) só em memória, então qualquer restart do processo perdia o cache e exigia receber uma activity nova antes de qualquer mensagem proativa (`openDM`, `send` para uma conversa nunca vista neste processo).

**Solução:** `TeamsProvider` agora persiste esse cache em um arquivo JSON (`statePath`, configurado em `src/server/index.ts` como `<dirname(DATABASE_PATH)>/teams-state.json`) — carregado em `start()` e regravado a cada activity recebida ou DM aberta. Fica fora do `MessageStore`/SQLite genérico de propósito: `serviceUrl` é um conceito só do Bot Framework, sem equivalente em WhatsApp/Discord/Slack (que enviam proativamente com só um token + endpoint fixo), então vazar isso para `core/store.ts` seria o mesmo erro de abstração já registrado para `listOrgUsers`/`installApp`.

**Implicação para a abstração:** nem todo estado "de canal" cabe no `MessageStore` genérico — alguns providers precisam de um pedaço de estado de conexão próprio (aqui, "onde fica o endpoint da API para este tenant") que não é nem mensagem nem webhook request. Vale isolar esse tipo de cache dentro do diretório do provider (arquivo próprio, ou tabela própria se crescer) em vez de forçar um encaixe nas tabelas genéricas.

### 2026-06-20 — `providerMessageId` do Teams excede o `maxParamLength` padrão do router

**Sintoma:** `editMessage`/`deleteMessage` do `TeamsProvider` estavam corretos (confirmado contra a Connector API real), mas `PATCH`/`DELETE /api/teams/messages/:providerMessageId`, `/correct` e `/api/messages/:providerMessageId/timeline` retornavam 404 — não o 404 customizado do handler, o 404 genérico do Fastify ("Route ... not found"), ou seja, a rota nunca era alcançada.

**Causa:** o router do Fastify (`find-my-way`) tem `maxParamLength` default de 100 caracteres por segmento de rota — acima disso, ele **não dá erro, simplesmente não casa a rota** (404 silencioso). O `providerMessageId` composto do Teams (`conversationId|activityId`) passa disso com folga: só o `conversationId` de uma conversa 1:1 já vem com 130+ caracteres. WhatsApp/Slack/Discord nunca expuseram esse limite porque seus ids compostos são bem mais curtos.

**Solução:** `Fastify({ maxParamLength: 300 })` em `src/server/app.ts`. Testado de ponta a ponta contra a Connector API real (`PATCH`, `DELETE`, `/correct`) após o aumento — os três funcionam.

**Implicação para a abstração:** o dispatcher genérico (`src/server/app.ts`) assumiu implicitamente um teto de tamanho para `providerMessageId` que nenhum canal anterior chegava perto de violar. Um limite de infraestrutura desse tipo só aparece quando um canal novo estressa uma dimensão que os outros nunca estressaram — vale tratar qualquer "funciona com curl direto no provider mas 404 via rota" como suspeito de limite do framework, não de bug no provider.

### 2026-06-20 — Bot não pode enviar reações com a própria identidade no Teams

**Contexto:** WhatsApp, Slack e Discord enviam reações como o próprio bot (token do bot reage, e a reação aparece como tendo sido feita pelo bot/app). Queríamos paridade no Teams.

**Descoberta:** não existe caminho para isso.
- Bot Framework Connector API (usada em `send`/`editMessage`/`deleteMessage`) não expõe nenhuma operação de reação — a lista completa de operações é `Create conversation`, `Send/Reply to activity`, `Update/Delete activity`, `Get/Delete member(s)`, `Send conversation history`, attachments; `MessageReaction` só existe como campo recebido em activities inbound (`messageReaction`), nunca como algo postável.
- Microsoft Graph `chatMessage: setReaction` (`POST /chats/{id}/messages/{id}/setReaction` ou o equivalente em `/teams/.../channels/...`) declara explicitamente **Application: Not supported** na tabela de permissões, tanto para chat quanto para channel — só funciona com permissão delegada (usuário autenticado). Fonte: [chatMessage: setReaction](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-1.0).
- Mesmo implementando o fluxo OAuth delegado (OAuthCard + magic code via Bot Framework Token Service), o token resultante representa o **usuário que fez login**, não o bot — é assim que delegated permission funciona no Microsoft identity platform (a chamada à Graph fica autenticada como aquela pessoa). A reação apareceria como "fulano reagiu", nunca como o bot. Não há equivalente a um "token delegado do próprio bot": um service principal não consegue se autenticar interativamente.

**Decisão:** não implementado. `send()` lança erro explicando a causa real (nem Bot Framework nem Graph app-only suportam, e Graph delegado não resolveria o objetivo de "bot reage"). Reações **recebidas** (usuário reage à mensagem do bot) continuam funcionando normalmente via `messageReaction` inbound — é a direção que de fato importa para o objetivo do laboratório (capturar a interação do usuário), e essa direção não tem essa limitação.

**Implicação para a abstração:** o tipo agnóstico `OutboundMessage.content.kind === 'reaction'` em `core/types.ts` assume implicitamente que "o bot pode reagir com a própria identidade" — verdade em WhatsApp/Slack/Discord, falsa no Teams. Diferente da maioria das fricções catalogadas aqui (que são sobre *como* traduzir um conceito equivalente), essa é sobre um canal **não ter o conceito** do lado de envio — e nenhuma camada de abstração resolve isso; o melhor que `core` pode fazer é manter `send()` como `Promise` que pode rejeitar, e cada provider documentar claramente quando uma capacidade do `OutboundMessage` não tem equivalente nativo.

### 2026-06-20 — Responder no dashboard usava o `sender` (userId) como `to`, mas Teams precisa do conversationId

**Sintoma:** clicar "responder" numa mensagem recebida no dashboard, para Teams, retornava `400: {"error":{"code":"ServiceError","message":"Unknown"}}` da Connector API, num `POST /v3/conversations/<id>/activities` onde `<id>` era visivelmente um id de usuário (`29:xxx`), não uma conversa.

**Causa:** o dashboard (`public/index.html`) calcula o endereço de reply genericamente como `m.sender`, que funciona para WhatsApp (telefone serve tanto de sender quanto de endereço de envio). Já tinha sido corrigido para Discord (`replyTo = providerMessageId.split(':')[0]` → channelId) — ver aprendizado "Endereço de envio é channel_id, não userId" — mas Teams ficou de fora dessa exceção e caiu no caminho genérico, enviando o `from.id` (`29:xxx`, formato de membro) como se fosse `conversationId`.

**Solução:** mesmo padrão do Discord, adaptado ao separador do Teams: `replyTo = providerMessageId.split('|')[0]` (a parte antes do `|` é o `conversationId`, já que o provider monta `providerMessageId` como `` `${conversationId}|${activityId}` ``).

**Implicação para a abstração:** reforça o aprendizado do Discord — "endereço de envio ≠ sender" não é exceção rara, é a regra para qualquer canal cujo `providerMessageId` componha `conversationId` com algo mais. Qualquer novo canal adicionado ao dashboard precisa ser auditado contra essa suposição (`replyTo = m.sender`) antes de assumir que vai funcionar — o `core` não tem como impor isso porque a semântica de `to` é, por design, opaca e específica de cada provider.
