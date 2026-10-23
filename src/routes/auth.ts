import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  const { email, password } = parsed.data;

  const result = await query<{ id: string; email: string; password_hash: string }>(
    'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [email],
  );
  const user = result.rows[0];
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = signToken({ sub: user.id, email: user.email });
  res.json({ token, user: { id: user.id, email: user.email } });
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(1),
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  const { current_password, new_password } = parsed.data;
  const userId = req.user!.id;

  const strengthError = validatePasswordStrength(new_password);
  if (strengthError) {
    res.status(400).json({ error: strengthError });
    return;
  }

  const result = await query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const ok = await verifyPassword(current_password, row.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const newHash = await hashPassword(new_password);
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
    newHash,
    userId,
  ]);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});
