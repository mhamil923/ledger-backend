/**
 * One-shot script to change the email + password on the existing test user
 * record so it becomes the owner's real personal account. All foreign-keyed
 * data (banks, transactions, bills, journal, etc.) is preserved because
 * those columns reference users(id), not the email.
 *
 * Run with:  npx tsx scripts/set-credentials.ts
 */
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { pool, query } from '../src/db.js';

interface UserRow {
  id: string;
  email: string;
}

function prompt(question: string, masked = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (masked) {
      // Naive masking — replaces echoed characters with *. Good enough so a
      // shoulder surfer doesn't see the password in plain text.
      const stdin = process.stdin as unknown as { on(event: string, listener: (chunk: Buffer) => void): void };
      const out = process.stdout as unknown as { write(s: string): void };
      let value = '';
      out.write(question);
      stdin.on('data', (chunk: Buffer) => {
        const ch = chunk.toString('utf8');
        if (ch === '\n' || ch === '\r' || ch === '\r\n') {
          out.write('\n');
          rl.close();
          resolve(value);
        } else if (ch === '' || ch === '') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            out.write('\b \b');
          }
        } else {
          value += ch;
          out.write('*');
        }
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

async function main(): Promise<void> {
  const existing = await query<UserRow>('SELECT id, email FROM users ORDER BY created_at ASC LIMIT 1');
  if (existing.rows.length === 0) {
    console.error('No users found. Sign up first, then run this script.');
    process.exit(1);
  }
  const user = existing.rows[0]!;
  console.log(`Current account: ${user.email}  (id=${user.id})`);
  console.log('');

  const email = (await prompt('New email: ')).toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('Need a valid email.');
    process.exit(1);
  }
  const password = await prompt('New password (typed silently): ', true);
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const password2 = await prompt('Confirm password: ', true);
  if (password !== password2) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  await query('UPDATE users SET email = $1, password_hash = $2, updated_at = now() WHERE id = $3', [
    email,
    hash,
    user.id,
  ]);

  console.log('');
  console.log(`Updated. Sign in at localhost:8081 with ${email} and your new password.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
