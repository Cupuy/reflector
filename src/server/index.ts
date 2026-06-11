import { loadConfig } from '../config.js';
import { WhatsAppProvider } from '../providers/whatsapp/provider.js';
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

const app = await buildApp({ providers: { whatsapp }, store });

await app.listen({ port: config.PORT, host: '0.0.0.0' });
