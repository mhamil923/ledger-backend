import crypto from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM authenticated encryption for per-user secrets at rest.
// The master key (KEK) is `BANKING_ENC_KEY` in env, 32 random bytes base64.
// We store a base64-encoded JSON envelope: { v: 1, iv, ct, tag }. The version
// field lets us migrate the format later without rewriting every row.

interface Envelope {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

export function isBankingCryptoConfigured(): boolean {
  return !!config.BANKING_ENC_KEY;
}

function getKey(): Buffer {
  if (!config.BANKING_ENC_KEY) {
    throw new Error('BANKING_ENC_KEY is not configured');
  }
  return Buffer.from(config.BANKING_ENC_KEY, 'base64');
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: Envelope = {
    v: 1,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

export function decryptSecret(encoded: string): string {
  const key = getKey();
  let env: Envelope;
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    env = JSON.parse(json) as Envelope;
  } catch {
    throw new Error('Encrypted secret is malformed');
  }
  if (env.v !== 1) throw new Error(`Unsupported envelope version: ${env.v}`);
  const iv = Buffer.from(env.iv, 'base64');
  const ct = Buffer.from(env.ct, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
