import { loadConfig } from '../config.js';
import { DiscordProvider } from '../providers/discord/provider.js';
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

const app = await buildApp({ providers, store });

await app.listen({ port: config.PORT, host: '0.0.0.0' });
