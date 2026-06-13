import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_PATH: z.string().default('data/reflector.db'),

  // WhatsApp Cloud API (Meta)
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_API_VERSION: z.string().default('v23.0'),

  // Discord Bot — opcionais; se omitidos, o provider não é registrado
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  DISCORD_APPLICATION_ID: z.string().min(1).optional(),
  DISCORD_PUBLIC_KEY: z.string().min(1).optional(),

  // Slack App — opcionais; se omitidos, o provider não é registrado
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida — verifique o .env (${problems})`);
  }
  return result.data;
}
