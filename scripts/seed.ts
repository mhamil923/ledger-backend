import { config, isProd } from '../src/config.js';
import { pool, query, withTransaction } from '../src/db.js';
import { hashPassword, validatePasswordStrength } from '../src/auth/password.js';
import { prompt, promptPassword } from './lib/prompt.js';

interface SeedAsset {
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  display_name: string;
}

const DEFAULT_WATCHLIST: SeedAsset[] = [
  { symbol: 'BTC', asset_type: 'crypto', display_name: 'Bitcoin' },
  { symbol: 'ETH', asset_type: 'crypto', display_name: 'Ethereum' },
  { symbol: 'SOL', asset_type: 'crypto', display_name: 'Solana' },
  { symbol: 'LINK', asset_type: 'crypto', display_name: 'Chainlink' },
  { symbol: 'MATIC', asset_type: 'crypto', display_name: 'Polygon' },
  { symbol: 'SPY', asset_type: 'etf', display_name: 'SPDR S&P 500 ETF' },
  { symbol: 'QQQ', asset_type: 'etf', display_name: 'Invesco QQQ' },
  { symbol: 'NVDA', asset_type: 'stock', display_name: 'NVIDIA' },
  { symbol: 'AAPL', asset_type: 'stock', display_name: 'Apple' },
  { symbol: 'TSLA', asset_type: 'stock', display_name: 'Tesla' },
  { symbol: 'MSFT', asset_type: 'stock', display_name: 'Microsoft' },
];

async function getOrCreateUser(): Promise<{ id: string; created: boolean }> {
  const existing = await query<{ id: string; email: string }>(
    'SELECT id, email FROM users ORDER BY created_at ASC LIMIT 1',
  );
  if (existing.rows[0]) {
    console.log(`Using existing user: ${existing.rows[0].email}`);
    return { id: existing.rows[0].id, created: false };
  }

  const email = await prompt('Email for the first user: ');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid email is required.');
  }

  let password = '';
  while (true) {
    password = await promptPassword('Password (min 12 chars): ');
    const strengthError = validatePasswordStrength(password);
    if (strengthError) {
      console.log(strengthError);
      continue;
    }
    const confirm = await promptPassword('Confirm password: ');
    if (password !== confirm) {
      console.log('Passwords do not match. Try again.\n');
      continue;
    }
    break;
  }

  const hash = await hashPassword(password);
  const result = await query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  const id = result.rows[0]!.id;
  console.log(`Created user ${email}`);
  return { id, created: true };
}

async function seedWatchlist(userId: string): Promise<number> {
  let added = 0;
  await withTransaction(async (client) => {
    for (let i = 0; i < DEFAULT_WATCHLIST.length; i++) {
      const asset = DEFAULT_WATCHLIST[i]!;
      const result = await client.query(
        `INSERT INTO watchlist_items (user_id, symbol, asset_type, display_name, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, symbol, asset_type) DO NOTHING
         RETURNING id`,
        [userId, asset.symbol, asset.asset_type, asset.display_name, i],
      );
      if (result.rowCount && result.rowCount > 0) added++;
    }
  });
  return added;
}

async function main(): Promise<void> {
  if (isProd) {
    console.error('Refusing to run seed in production (NODE_ENV=production).');
    process.exit(1);
  }
  console.log(`Seeding ledger database at ${maskUrl(config.DATABASE_URL)}\n`);

  const { id: userId } = await getOrCreateUser();
  const added = await seedWatchlist(userId);
  console.log(`\nWatchlist: ${added} new asset(s) added (${DEFAULT_WATCHLIST.length} total in default list).`);
  console.log('Seed complete.');
}

function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

main()
  .catch((err) => {
    console.error('\nSeed failed:', err.message ?? err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
