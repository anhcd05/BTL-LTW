import argon2 from 'argon2';

/** Same argon2id parameters as apps/api/src/auth-password.ts so the API's argon2.verify accepts it. */
export function hashDemoPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
