import axios, { type AxiosInstance } from 'axios';
import * as https from 'https';
import * as fs from 'fs';
import type { GlobalOptions } from './types';

export function buildClient(g: GlobalOptions): AxiosInstance {
  const cfg: Record<string, unknown> = { validateStatus: () => true };

  if (g.cert || g.key || g.cacert || g.insecure) {
    const ao: https.AgentOptions = {};
    if (g.cert)     ao.cert = fs.readFileSync(g.cert);
    if (g.key)      ao.key  = fs.readFileSync(g.key);
    if (g.cacert)   ao.ca   = fs.readFileSync(g.cacert);
    if (g.insecure) ao.rejectUnauthorized = false;
    cfg.httpsAgent = new https.Agent(ao);
  }

  return axios.create(cfg);
}
