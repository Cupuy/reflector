import { dirname, join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { DiscordProvider } from '../providers/discord/provider.js';
import { SlackProvider } from '../providers/slack/provider.js';
import { TeamsProvider } from '../providers/teams/provider.js';
import { WhatsAppProvider } from '../providers/whatsapp/provider.js';
import type { ChannelProvider } from '../core/provider.js';
import { SqliteStore } from '../store/sqlite.js';
import { buildApp } from './app.js';

const config = loadConfig();

const store = new SqliteStore(config.DATABASE_PATH);

const whatsapp = new WhatsAppProvider({
  accessToken: config.WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
  appSecret: config.WHATSAPP_APP_SECRET,
  verifyToken: config.WHATSAPP_VERIFY_TOKEN,
  apiVersion: config.WHATSAPP_API_VERSION,
});

const providers: Record<string, ChannelProvider> = { whatsapp };

if (
  config.DISCORD_BOT_TOKEN !== undefined &&
  config.DISCORD_APPLICATION_ID !== undefined &&
  config.DISCORD_PUBLIC_KEY !== undefined
) {
  providers['discord'] = new DiscordProvider({
    botToken: config.DISCORD_BOT_TOKEN,
    applicationId: config.DISCORD_APPLICATION_ID,
    publicKey: config.DISCORD_PUBLIC_KEY,
  });
}

if (config.SLACK_BOT_TOKEN !== undefined && config.SLACK_SIGNING_SECRET !== undefined) {
  providers['slack'] = new SlackProvider({
    botToken: config.SLACK_BOT_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET,
  });
}

let teamsProvider: TeamsProvider | undefined;
if (config.TEAMS_APP_ID !== undefined && config.TEAMS_APP_PASSWORD !== undefined) {
  teamsProvider = new TeamsProvider({
    appId: config.TEAMS_APP_ID,
    appPassword: config.TEAMS_APP_PASSWORD,
    tenantId: config.TEAMS_TENANT_ID,
    statePath: join(dirname(config.DATABASE_PATH), 'teams-state.json'),
  });
  providers['teams'] = teamsProvider;
}

const app = await buildApp({ providers, store });

// Provisionamento via Microsoft Graph — não é um conceito de ChannelProvider
// (sem equivalente nos outros canais), por isso fica fora de app.ts.
// Ver docs/learnings.md (Microsoft Teams) para o porquê dessa fricção.
if (teamsProvider) {
  app.get('/api/teams/users', async () => teamsProvider!.listOrgUsers());

  app.post('/api/teams/install', async (request, reply) => {
    const parsed = z
      .object({ userId: z.string().min(1), appId: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'payload inválido', issues: parsed.error.issues });
    }

    await teamsProvider!.installApp(parsed.data.userId, parsed.data.appId);
    return reply.code(201).send({ ok: true });
  });
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });
