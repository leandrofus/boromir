import { buildClient } from '../lib/client';
import { requireAuth } from '../lib/session';
import type { GlobalOptions } from '../lib/types';

type Schema   = Record<string, unknown>;
type OpObject = Record<string, unknown>;

interface DocsOptions {
  endpoint?: string;
  filter?: string;
}

function schemaType(s: Schema): string {
  if (!s) return '';
  if ('$ref' in s) return (s.$ref as string).split('/').pop() ?? '';
  if (s.type === 'array') return `array[${schemaType((s.items as Schema) ?? {})}]`;
  return (s.type as string) || 'object';
}

function printSchema(label: string, schema: Schema, defs: Schema, indent = 6): void {
  const pad = ' '.repeat(indent);
  if ('$ref' in schema) {
    const name  = (schema.$ref as string).split('/').pop() ?? '';
    const ref   = (defs[name] as Schema) ?? {};
    const props = (ref.properties as Record<string, Schema>) ?? {};
    const reqd  = (ref.required as string[]) ?? [];
    console.log(`${pad}${label}: ${name}`);
    for (const [p, ps] of Object.entries(props)) {
      const r = reqd.includes(p) ? '*' : ' ';
      console.log(`${pad}  ${r} ${p} (${schemaType(ps)}) ${ps.description ?? ''}`);
    }
  } else if (schema.type === 'array') {
    console.log(`${pad}${label}: array[${schemaType((schema.items as Schema) ?? {})}]`);
  } else if (Object.keys(schema).length) {
    console.log(`${pad}${label}: ${schemaType(schema)}`);
  }
}

function showEndpoint(spec: Schema, endpoint: string): void {
  const defs    = (spec.definitions ?? (spec.components as Schema ?? {}).schemas ?? {}) as Schema;
  const paths   = (spec.paths as Record<string, Record<string, OpObject>>) ?? {};
  const matches = Object.entries(paths).filter(([p]) => p.includes(endpoint));

  if (!matches.length) {
    process.stderr.write(`No endpoint matching '${endpoint}'\n`);
    process.exit(1);
  }

  for (const [p, ops] of matches) {
    for (const [method, op] of Object.entries(ops)) {
      if (method.startsWith('x-')) continue;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`  ${method.toUpperCase()}  ${p}`);
      console.log(`  ${op.summary ?? ''}`);
      if (op.description) console.log(`  ${op.description}`);

      const params = (op.parameters as Schema[]) ?? [];
      if (params.length) {
        console.log('\n  Parameters:');
        for (const param of params) {
          const typ = (param.type as string) || schemaType((param.schema as Schema) ?? {});
          const req = param.required ? 'required' : 'optional';
          console.log(`    [${param.in}] ${param.name} (${typ}, ${req}) — ${param.description ?? ''}`);
        }
      }

      for (const bp of params.filter(p => p.in === 'body')) {
        printSchema('  Request body', (bp.schema as Schema) ?? {}, defs);
      }

      const resps = (op.responses as Record<string, Schema>) ?? {};
      if (Object.keys(resps).length) {
        console.log('\n  Responses:');
        for (const [code, resp] of Object.entries(resps)) {
          console.log(`    ${code}: ${resp.description ?? ''}`);
          if (resp.schema) printSchema('       body', resp.schema as Schema, defs);
        }
      }
    }
  }
}

export async function cmdDocs(opts: DocsOptions, g: GlobalOptions): Promise<void> {
  const client = buildClient(g);
  requireAuth(client);

  let r;
  try {
    r = await client.get(`${g.base.replace(/\/$/, '')}/swagger/doc.json`);
  } catch (e: unknown) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }

  if (r.status === 401) {
    process.stderr.write('Token rejected — re-run `boromir login`\n');
    process.exit(1);
  }

  const spec  = r.data as Schema;
  let paths   = (spec.paths as Record<string, Record<string, OpObject>>) ?? {};

  if (opts.filter) {
    paths = Object.fromEntries(Object.entries(paths).filter(([p]) => p.includes(opts.filter!)));
  }

  if (opts.endpoint) { showEndpoint(spec, opts.endpoint); return; }

  const order = ['get', 'post', 'put', 'patch', 'delete'];
  for (const [p, ops] of Object.entries(paths).sort()) {
    for (const m of order) {
      if (!(m in ops)) continue;
      const op = ops[m];
      const tag = ((op.tags as string[]) ?? [''])[0];
      console.log(`  ${m.toUpperCase().padEnd(7)} ${p.padEnd(55)} [${tag}] ${op.summary ?? ''}`);
    }
  }
  console.log(`\n${Object.keys(paths).length} paths. Use \`docs -e /path\` for details.`);
}
