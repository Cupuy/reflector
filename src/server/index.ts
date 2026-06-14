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

if (config.TEAMS_APP_ID !== undefined && config.TEAMS_APP_PASSWORD !== undefined) {
  providers['teams'] = new TeamsProvider({
    appId: config.TEAMS_APP_ID,
    appPassword: config.TEAMS_APP_PASSWORD,
    tenantId: config.TEAMS_TENANT_ID,
  });
}

const app = await buildApp({ providers, store });

await app.listen({ port: config.PORT, host: '0.0.0.0' });
