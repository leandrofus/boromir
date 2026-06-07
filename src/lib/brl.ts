import type { BrlStep } from './types';

export function parseReqFile(text: string): BrlStep[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      const i1 = line.search(/\s/);
      if (i1 === -1) throw new Error(`bad line (need METHOD /path): ${JSON.stringify(line)}`);
      const method = line.slice(0, i1).toUpperCase();
      const rest   = line.slice(i1).trimStart();
      const i2     = rest.search(/\s/);
      return {
        method,
        rawPath: i2 === -1 ? rest : rest.slice(0, i2),
        body:    i2 === -1 ? null  : rest.slice(i2).trimStart() || null,
      };
    });
}

export function resolve(template: string, responses: unknown[]): string {
  return template.replace(/\{\{(\$[^}]+)\}\}/g, (_, expr: string) => {
    const dot    = expr.indexOf('.');
    const idxStr = dot !== -1 ? expr.slice(0, dot) : expr;
    const parts  = dot !== -1 ? expr.slice(dot + 1).split('.') : [];

    let data: unknown = idxStr === '$prev'
      ? responses[responses.length - 1]
      : responses[parseInt(idxStr.slice(1), 10)];

    if (data === undefined) throw new Error(`no response at ${idxStr}`);

    for (const k of parts) {
      if (Array.isArray(data)) {
        data = data[parseInt(k, 10)];
      } else if (data !== null && typeof data === 'object') {
        data = (data as Record<string, unknown>)[k];
      } else {
        throw new Error(`cannot traverse '${k}' in ${typeof data}`);
      }
    }

    return typeof data === 'object' && data !== null
      ? JSON.stringify(data)
      : String(data ?? '');
  });
}
