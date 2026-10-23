import { pool, query } from '../src/db.js';
import { hashPassword, validatePasswordStrength } from '../src/auth/password.js';
import { prompt, promptPassword } from './lib/prompt.js';

async function main(): Promise<void> {
  const email = await prompt('Email: ');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid email is required.');
  }

  const existing = await query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [
    email,
  ]);
  if (existing.rows[0]) {
    throw new Error(`User ${email} already exists.`);
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
  await query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, hash]);
  console.log(`Created user ${email}`);
}

main()
  .catch((err) => {
    console.error('Failed:', err.message ?? err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
