#!/usr/bin/env node
import { Command } from 'commander';
import { cmdLogin } from './commands/login';
import { cmdRequest } from './commands/request';
import { cmdRun } from './commands/run';
import { cmdDocs } from './commands/docs';
import type { GlobalOptions } from './lib/types';

function collect(val: string, prev: string[]): string[] {
  return [...(prev ?? []), val];
}

const program = new Command();

program
  .name('boromir')
  .description('One does not simply walk into requests.\n\nBRL — Batch Request Language. Authenticate once, script your API.')
  .version('1.0.0')
  .option('--base <url>',           'API base URL',                       'https://localhost:8080')
  .option('--cert <file>',          'Client cert PEM (mTLS)')
  .option('--key <file>',           'Client key PEM (mTLS)')
  .option('--cacert <file>',        'CA cert PEM to verify server')
  .option('--insecure',             'Skip TLS verification')
  .option('--login-path <path>',    'Login endpoint path',                '/api/auth/login')
  .option('--token-field <field>',  'JSON field containing bearer token', 'token');

program
  .command('login')
  .description('Authenticate and save token')
  .requiredOption('-u, --username <username>', 'Username')
  .requiredOption('-p, --password <password>', 'Password')
  .action(async (opts, cmd) => {
    await cmdLogin(opts as { username: string; password: string }, cmd.parent!.opts() as GlobalOptions);
  });

program
  .command('req <method> <endpoint>')
  .description('Make a single authenticated request')
  .option('-d, --data <json>',      'JSON request body')
  .option('-q, --params <K=V>',     'Query param (repeatable)', collect, [] as string[])
  .option('-H, --header <K:V>',     'Extra header (repeatable)', collect, [] as string[])
  .action(async (method: string, endpoint: string, opts, cmd) => {
    await cmdRequest(method, endpoint, opts as { data?: string; params?: string[]; header?: string[] }, cmd.parent!.opts() as GlobalOptions);
  });

program
  .command('run <files...>')
  .description('Execute .req file(s) in BRL batch mode with response chaining')
  .option('--keep-going',           'Continue on error instead of stopping')
  .option('--report <file.html>',   'Write HTML report to this path')
  .action(async (files: string[], opts, cmd) => {
    await cmdRun(files, opts as { keepGoing?: boolean; report?: string }, cmd.parent!.opts() as GlobalOptions);
  });

program
  .command('docs')
  .description('Browse Swagger/OpenAPI docs (requires auth)')
  .option('-e, --endpoint <path>',  'Show full detail for endpoints matching this substring')
  .option('-f, --filter <path>',    'Filter endpoint list by path substring')
  .action(async (opts, cmd) => {
    await cmdDocs(opts as { endpoint?: string; filter?: string }, cmd.parent!.opts() as GlobalOptions);
  });

program
  .command('serve')
  .description('Start the Boromir Web UI (default port 8888)')
  .option('--port <n>', 'Port to listen on', '8888')
  .option('--auth-url <url>', 'External auth base URL')
  .option('--base-url <url>', 'Default API base URL for playbook runs')
  .option('--playbooks-dir <dir>', 'Directory to store playbooks')
  .option('--reports-dir <dir>', 'Directory to read reports from')
  .action((opts) => {
    if (opts.port) process.env.PORT = opts.port;
    if (opts.authUrl) process.env.AUTH_BASE_URL = opts.authUrl;
    if (opts.baseUrl) process.env.BASE_URL = opts.baseUrl;
    if (opts.playbooksDir) process.env.PLAYBOOKS_DIR = opts.playbooksDir;
    if (opts.reportsDir) process.env.REPORTS_DIR = opts.reportsDir;
    // Dynamic require so server only loads when needed
    require('./server');
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
