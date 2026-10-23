import { pool, query } from '../src/db.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../src/auth/password.js';
import { prompt, promptPassword } from './lib/prompt.js';

async function main(): Promise<void> {
  const email = await prompt('Email: ');
  const result = await query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  const user = result.rows[0];
  if (!user) {
    throw new Error(`No user found for ${email}`);
  }

  const current = await promptPassword('Current password: ');
  const ok = await verifyPassword(current, user.password_hash);
  if (!ok) {
    throw new Error('Current password is incorrect.');
  }

  let next = '';
  while (true) {
    next = await promptPassword('New password (min 12 chars): ');
    const err = validatePasswordStrength(next);
    if (err) {
      console.log(err);
      continue;
    }
    const confirm = await promptPassword('Confirm new password: ');
    if (next !== confirm) {
      console.log('Passwords do not match. Try again.\n');
      continue;
    }
    break;
  }

  const hash = await hashPassword(next);
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, user.id]);
  console.log('Password updated.');
}

main()
  .catch((err) => {
    console.error('Failed:', err.message ?? err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
