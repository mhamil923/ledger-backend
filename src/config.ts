import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  CORS_ORIGIN: z.string().default('*'),
  /** Your local time zone: decides what "this month" is for the budget.
   *  (Transactions take their month from the bank's UTC posting date.) */
  BUDGET_TZ: z.string().default('America/Chicago'),
  ANTHROPIC_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
  TWELVE_DATA_API_KEY: z.string().optional(),
  // Trading credentials
  ALPACA_PAPER_API_KEY: z.string().optional(),
  ALPACA_PAPER_API_SECRET: z.string().optional(),
  ALPACA_LIVE_API_KEY: z.string().optional(),
  ALPACA_LIVE_API_SECRET: z.string().optional(),
  COINBASE_API_KEY_NAME: z.string().optional(),
  COINBASE_API_PRIVATE_KEY: z.string().optional(),
  /**
   * Master Key-Encryption-Key for sensitive per-user secrets (SimpleFIN
   * Access URLs, future trading API keys). Must be 32 bytes of randomness
   * encoded as base64 (44 chars). Generate with:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   * Optional in dev — banking endpoints return 503 if missing.
   */
  BANKING_ENC_KEY: z
    .string()
    .refine(
      (v) => {
        if (!v) return true;
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'BANKING_ENC_KEY must be 32 random bytes encoded as base64' },
    )
    .optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
