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
