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
