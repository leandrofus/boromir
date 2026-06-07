import { buildClient } from '../lib/client';
import { requireAuth } from '../lib/session';
import type { GlobalOptions } from '../lib/types';

interface ReqOptions {
  data?: string;
  params?: string[];
  header?: string[];
}

export async function cmdRequest(
  method: string,
  endpoint: string,
  opts: ReqOptions,
  g: GlobalOptions,
): Promise<void> {
  const client = buildClient(g);
  requireAuth(client);

  for (const h of opts.header ?? []) {
    const idx = h.indexOf(':');
    client.defaults.headers.common[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  const url = `${g.base.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
  const cfg: Record<string, unknown> = { method: method.toUpperCase(), url };
  if (opts.data)   cfg.data   = JSON.parse(opts.data);
  if (opts.params?.length) {
    cfg.params = Object.fromEntries(opts.params.map(p => p.split('=', 2) as [string, string]));
  }

  let r;
  try {
    r = await client.request(cfg);
  } catch (e: unknown) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }

  console.log(`HTTP ${r.status}`);
  if (r.data !== undefined && r.data !== '') {
    console.log(typeof r.data === 'object' ? JSON.stringify(r.data, null, 2) : r.data);
  }
  if (r.status < 200 || r.status >= 300) process.exit(1);
}
