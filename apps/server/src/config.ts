import { resolve } from 'node:path';

// 服务端配置，全部从环境变量读取，见 .env.example
export interface Config {
  host: string;
  port: number;
  databasePath: string;
  jwtSecret: string;
  rootKeyHash: string;
  publicOrigin?: string;
  offlineTtlSeconds: number;
  emailCodeTtlSeconds: number;
  qqBotPluginToken?: string;
  qqBindingTtlSeconds: number;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    fromEmail: string;
    fromName: string;
  };
}

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(options: { allowInsecureTestDefaults?: boolean } = {}): Config {
  const test = options.allowInsecureTestDefaults === true;
  const jwtSecret = process.env.JWT_SECRET ?? (test ? 'test-secret-that-is-long-enough-32' : '');
  const rootKeyHash = process.env.ADMIN_ROOT_KEY_HASH ?? (test ? '0'.repeat(64) : '');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  if (!/^[a-f\d]{64}$/i.test(rootKeyHash)) throw new Error('ADMIN_ROOT_KEY_HASH must be a SHA-256 hex digest');

  const smtpValues = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_EMAIL'] as const;
  const smtpPresent = smtpValues.some((name) => process.env[name]);
  if (smtpPresent && !smtpValues.every((name) => process.env[name])) {
    throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM_EMAIL must be configured together');
  }

  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: integer('PORT', 3210),
    databasePath: process.env.DATABASE_PATH ?? resolve('data', 'lanmiao.sqlite'),
    jwtSecret,
    rootKeyHash: rootKeyHash.toLowerCase(),
    publicOrigin: process.env.PUBLIC_ORIGIN,
    offlineTtlSeconds: integer('OFFLINE_TTL_SECONDS', 86_400),
    emailCodeTtlSeconds: integer('EMAIL_CODE_TTL_SECONDS', 600),
    qqBotPluginToken: process.env.QQ_BOT_PLUGIN_TOKEN?.trim() || undefined,
    qqBindingTtlSeconds: integer('QQ_BINDING_TTL_SECONDS', 300),
    smtp: smtpPresent
      ? {
          host: process.env.SMTP_HOST!,
          port: integer('SMTP_PORT', 465),
          secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
          user: process.env.SMTP_USER!,
          pass: process.env.SMTP_PASS!,
          fromEmail: process.env.SMTP_FROM_EMAIL!,
          fromName: process.env.SMTP_FROM_NAME ?? '蓝天科技',
        }
      : undefined,
  };
}
