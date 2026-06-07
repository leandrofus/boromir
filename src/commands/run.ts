import * as fs from 'fs';
import { performance } from 'perf_hooks';
import { buildClient } from '../lib/client';
import { requireAuth } from '../lib/session';
import { parseReqFile, resolve } from '../lib/brl';
import { writeHtmlReport } from '../lib/report';
import type { GlobalOptions, StepRecord } from '../lib/types';

interface RunOptions {
  keepGoing?: boolean;
  report?: string;
}

export async function cmdRun(
  files: string[],
  opts: RunOptions,
  g: GlobalOptions,
): Promise<void> {
  const client      = buildClient(g);
  requireAuth(client);

  const responses: unknown[]       = [];
  const reportSteps: StepRecord[]  = [];
  let total = 0, failed = 0;
  const startedAt = new Date();
  const runStart  = performance.now();

  for (const filepath of files) {
    let steps;
    try {
      steps = parseReqFile(fs.readFileSync(filepath, 'utf8'));
    } catch (e: unknown) {
      process.stderr.write(`[ERROR] ${filepath}: ${(e as Error).message}\n`);
      process.exit(1);
    }

    console.log(`\n=== ${filepath} (${steps.length} step(s)) ===`);

    for (let i = 0; i < steps.length; i++) {
      const { method, rawPath, body: rawBody } = steps[i];
      total++;
      const label = `[${i}] ${method}`;
      const rec: StepRecord = {
        index: responses.length, file: filepath, method, rawPath,
        url: null, reqBody: null, status: null, respBody: null,
        durationMs: null, error: null, ok: false,
      };

      let pathR: string, bodyR: string | null;
      try {
        pathR = resolve(rawPath, responses);
        bodyR = rawBody ? resolve(rawBody, responses) : null;
      } catch (e: unknown) {
        const msg = `RESOLVE ERROR: ${(e as Error).message}`;
        process.stderr.write(`  ${label} ${msg}\n`);
        rec.error = msg;
        failed++;
        responses.push(null);
        reportSteps.push(rec);
        if (!opts.keepGoing) process.exit(1);
        continue;
      }

      const url = `${g.base.replace(/\/$/, '')}/${pathR.replace(/^\//, '')}`;
      rec.url = url;
      const reqCfg: Record<string, unknown> = { method, url };

      if (bodyR) {
        try {
          reqCfg.data = JSON.parse(bodyR);
          rec.reqBody = reqCfg.data;
        } catch (e: unknown) {
          const msg = `BODY JSON ERROR: ${(e as Error).message} — raw: ${bodyR}`;
          process.stderr.write(`  ${label} ${msg}\n`);
          rec.error = msg;
          failed++;
          responses.push(null);
          reportSteps.push(rec);
          if (!opts.keepGoing) process.exit(1);
          continue;
        }
      }

      console.log(`\n  ${label} ${url}`);
      if (bodyR) console.log(`       body: ${bodyR}`);

      const t0 = performance.now();
      let r;
      try {
        r = await client.request(reqCfg);
      } catch (e: unknown) {
        const msg = `CONNECTION ERROR: ${(e as Error).message}`;
        process.stderr.write(`  ${label} ${msg}\n`);
        rec.error = msg;
        failed++;
        responses.push(null);
        reportSteps.push(rec);
        if (!opts.keepGoing) process.exit(1);
        continue;
      }

      rec.durationMs = Math.round((performance.now() - t0) * 10) / 10;
      rec.status     = r.status;
      rec.ok         = r.status >= 200 && r.status < 300;

      console.log(`       HTTP ${r.status}  (${rec.durationMs}ms)`);
      const rd = r.data as unknown;
      if (rd !== undefined && rd !== '') {
        console.log(typeof rd === 'object' ? JSON.stringify(rd, null, 4) : rd);
      }

      rec.respBody = rd ?? null;
      responses.push(rec.respBody);
      reportSteps.push(rec);

      if (!rec.ok) {
        failed++;
        if (!opts.keepGoing) {
          process.stderr.write(
            `\nStopped at step ${i} — HTTP ${r.status}. Use --keep-going to continue.\n`,
          );
          if (opts.report) {
            writeHtmlReport(opts.report, reportSteps, (performance.now() - runStart) / 1000, startedAt, files);
          }
          process.exit(1);
        }
      }
    }
  }

  const totalS = (performance.now() - runStart) / 1000;
  console.log();

  if (opts.report) {
    writeHtmlReport(opts.report, reportSteps, totalS, startedAt, files);
    console.log(`Report: ${opts.report}`);
  }

  if (failed) {
    process.stderr.write(`${failed}/${total} request(s) failed.\n`);
    process.exit(1);
  } else {
    console.log(`${total}/${total} request(s) OK.  (${(totalS * 1000).toFixed(0)}ms total)`);
  }
}
