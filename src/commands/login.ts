import { buildClient } from '../lib/client';
import { saveToken, STATE_FILE } from '../lib/session';
import type { GlobalOptions } from '../lib/types';

export async function cmdLogin(
  opts: { username: string; password: string },
  g: GlobalOptions,
): Promise<void> {
  const client    = buildClient(g);
  const loginPath = g.loginPath.replace(/^\//, '');
  const url       = `${g.base.replace(/\/$/, '')}/${loginPath}`;

  let r;
  try {
    r = await client.post(url, { username: opts.username, password: opts.password });
  } catch (e: unknown) {
    process.stderr.write(`Connection error: ${(e as Error).message}\n`);
    process.exit(1);
  }

  if (r.status < 200 || r.status >= 300) {
    process.stderr.write(`Login failed — HTTP ${r.status}\n`);
    process.exit(1);
  }

  const token = (r.data as Record<string, unknown>)[g.tokenField];
  if (!token || typeof token !== 'string') {
    process.stderr.write(
      `Login response missing field '${g.tokenField}':\n${JSON.stringify(r.data, null, 2)}\n`,
    );
    process.exit(1);
  }

  saveToken(token);
  console.log(`OK — token saved to ${STATE_FILE}`);
}
