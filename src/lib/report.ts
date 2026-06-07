import * as fs from 'fs';
import * as path from 'path';
import type { StepRecord, RunRecord } from './types';

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pretty(v: unknown): string {
  if (v === null || v === undefined) return '';
  return esc(typeof v === 'object' ? JSON.stringify(v, null, 2) : v);
}

const METHOD_COLOR: Record<string, string> = {
  GET: '#61affe', POST: '#49cc90', PUT: '#fca130',
  PATCH: '#50e3c2', DELETE: '#f93e3e',
};

function statusColor(sc: number | null): string {
  const s = String(sc ?? '');
  return s.startsWith('2') ? '#49cc90' : s.startsWith('3') ? '#fca130' : '#f93e3e';
}

function renderStepsTable(steps: StepRecord[]): string {
  const rows = steps.map(s => {
    const st  = s.status ?? '—';
    const dur = s.durationMs != null ? `${s.durationMs}ms` : '—';
    const mc  = METHOD_COLOR[s.method] ?? '#aaa';
    const reqBodyHtml = s.reqBody != null
      ? `<pre class="body">${pretty(s.reqBody)}</pre>` : '';
    const respHtml = s.respBody != null
      ? `<details><summary>Response body</summary><pre class="body resp">${pretty(s.respBody)}</pre></details>` : '';
    const errHtml = s.error ? `<div class="err">${esc(s.error)}</div>` : '';
    return `<tr class="${s.ok ? 'ok' : 'fail'}">
      <td class="idx">#${s.index}</td>
      <td><span class="badge" style="background:${mc}">${esc(s.method)}</span></td>
      <td class="url">${esc(s.url ?? s.rawPath)}</td>
      <td><span class="status" style="color:${statusColor(s.status)}">${esc(st)}</span></td>
      <td class="dur">${dur}</td>
      <td class="detail">${reqBodyHtml}${respHtml}${errHtml}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr>
    <th>#</th><th>Method</th><th>URL</th><th>Status</th><th>Duration</th><th>Detail</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

function miniBar(passed: number, failed: number, total: number): string {
  const pp = total ? (passed / total * 100).toFixed(0) : 0;
  const fp = total ? (failed / total * 100).toFixed(0) : 0;
  return `<div class="bar"><div class="bar-p" style="width:${pp}%"></div><div class="bar-f" style="width:${fp}%"></div></div>`;
}

const CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e2e8f0;font-size:14px}
header{background:#1a1d2e;padding:18px 32px;border-bottom:1px solid #2d3150;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:18px;font-weight:700;color:#fff}
header .meta{color:#8892a4;font-size:12px}
section{padding:0 0 32px}
.run-header{display:flex;justify-content:space-between;align-items:flex-start;padding:16px 32px 0;background:#141625;border-bottom:1px solid #2d3150}
.run-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 6px;border-radius:3px;margin-right:10px}
.current-label{background:#2d3150;color:#61affe}
.run-ts{color:#e2e8f0;font-family:monospace;font-size:13px;margin-right:16px}
.run-files{color:#8892a4;font-size:12px}
.run-dur{color:#61affe;font-family:monospace;font-size:20px;font-weight:700;padding-bottom:16px}
.summary{display:flex;gap:32px;padding:20px 32px;background:#141625;border-bottom:1px solid #2d3150}
.stat{text-align:center}
.stat .n{font-size:28px;font-weight:700}
.stat .l{font-size:10px;color:#8892a4;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.total .n{color:#e2e8f0}.passed .n{color:#49cc90}.failed .n{color:#f93e3e}.dur-stat .n{color:#61affe}
.container{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{background:#1a1d2e;padding:9px 16px;text-align:left;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #2d3150}
td{padding:9px 16px;border-bottom:1px solid #1e2236;vertical-align:top}
tr.ok{background:#0f1117}tr.ok:hover{background:#141625}
tr.fail{background:#1a0f0f}tr.fail:hover{background:#1f1212}
.idx{color:#4a5568;width:38px;font-family:monospace;font-size:12px}
.badge{display:inline-block;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:700;color:#fff;font-family:monospace}
.url{font-family:monospace;font-size:12px;color:#a8b4cf;word-break:break-all}
.status{font-weight:700;font-family:monospace;font-size:13px}
.dur{color:#8892a4;font-family:monospace;white-space:nowrap;font-size:12px}
.detail{max-width:560px}
pre.body{background:#0a0c14;border:1px solid #2d3150;border-radius:4px;padding:10px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#a8c5da;margin-top:6px;max-height:250px;overflow-y:auto}
pre.resp{color:#c3e6cb}
details summary{cursor:pointer;color:#61affe;font-size:12px;margin-top:4px;user-select:none;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary:hover{color:#a8d8ff}
.err{color:#f93e3e;font-family:monospace;font-size:12px;margin-top:4px}
.history{padding:0 32px 40px}
.history h2{font-size:14px;font-weight:600;color:#8892a4;text-transform:uppercase;letter-spacing:.06em;padding:28px 0 12px;border-top:1px solid #2d3150;margin-top:16px}
.day-group{margin-bottom:8px}
.day-label{font-size:11px;font-weight:700;color:#4a5568;text-transform:uppercase;letter-spacing:.06em;padding:12px 0 6px}
.hist-run{border:1px solid #1e2236;border-radius:6px;margin-bottom:6px;overflow:hidden}
.hist-run.run-fail{border-color:#2d1515}
.hist-run summary{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#141625;cursor:pointer;user-select:none}
.hist-run.run-fail summary{background:#130d0d}
.hist-run summary:hover{background:#1a1d2e}
.hist-time{font-family:monospace;font-size:13px;color:#e2e8f0;min-width:70px}
.hist-files{font-size:12px;color:#8892a4;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hist-dur{font-family:monospace;font-size:12px;color:#61affe;min-width:50px;text-align:right}
.hist-counts{font-size:12px;white-space:nowrap}
.hc-pass{color:#49cc90}.hc-fail{color:#f93e3e}
.bar{width:80px;height:6px;background:#1e2236;border-radius:3px;overflow:hidden;display:flex}
.bar-p{background:#49cc90;height:100%}.bar-f{background:#f93e3e;height:100%}
.hist-run .container{padding:0}`;

export function writeHtmlReport(
  reportPath: string,
  steps: StepRecord[],
  totalS: number,
  startedAt: Date,
  files: string[],
): void {
  const ext      = path.extname(reportPath);
  const histPath = ext
    ? reportPath.slice(0, -ext.length) + '.history.json'
    : reportPath + '.history.json';

  let history: RunRecord[] = [];
  if (fs.existsSync(histPath)) {
    try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch { /* start fresh */ }
  }

  const currentRun: RunRecord = {
    startedAt: startedAt.toISOString().slice(0, 19),
    totalS: Math.round(totalS * 1000) / 1000,
    files,
    total: steps.length,
    passed: steps.filter(s => s.ok).length,
    failed: steps.filter(s => !s.ok).length,
    steps,
  };
  history.push(currentRun);
  fs.writeFileSync(histPath, JSON.stringify(history), 'utf8');

  const tsStr  = startedAt.toISOString().slice(0, 19).replace('T', ' ');
  const durStr = `${totalS.toFixed(2)}s`;
  const cr     = currentRun;

  const currentSection = `
<section class="current">
  <div class="run-header">
    <div>
      <span class="run-label current-label">CURRENT RUN</span>
      <span class="run-ts">${esc(tsStr)}</span>
      <span class="run-files">${esc(files.join(', '))}</span>
    </div>
    <div class="run-dur">${durStr}</div>
  </div>
  <div class="summary">
    <div class="stat total"><div class="n">${cr.total}</div><div class="l">Total</div></div>
    <div class="stat passed"><div class="n">${cr.passed}</div><div class="l">Passed</div></div>
    <div class="stat failed"><div class="n">${cr.failed}</div><div class="l">Failed</div></div>
    <div class="stat dur-stat"><div class="n">${durStr}</div><div class="l">Duration</div></div>
  </div>
  <div class="container">${renderStepsTable(steps)}</div>
</section>`;

  const pastRuns = history.slice(0, -1).reverse();
  let historyHtml = '';
  if (pastRuns.length) {
    const byDay: Record<string, RunRecord[]> = {};
    for (const run of pastRuns) {
      const day = run.startedAt.slice(0, 10);
      (byDay[day] ??= []).push(run);
    }
    historyHtml = '<section class="history"><h2>Execution History</h2>';
    for (const [day, runs] of Object.entries(byDay)) {
      historyHtml += `<div class="day-group"><div class="day-label">${esc(day)}</div>`;
      for (const run of runs) {
        const okCls = run.failed === 0 ? 'run-ok' : 'run-fail';
        historyHtml += `<details class="hist-run ${okCls}">
          <summary>
            <span class="hist-time">${esc(run.startedAt.slice(11))}</span>
            <span class="hist-files">${esc(run.files.join(', '))}</span>
            ${miniBar(run.passed, run.failed, run.total)}
            <span class="hist-counts">
              <span class="hc-pass">${run.passed} ok</span>
              <span class="hc-fail">${run.failed} fail</span>
            </span>
            <span class="hist-dur">${run.totalS.toFixed(2)}s</span>
          </summary>
          <div class="container">${renderStepsTable(run.steps)}</div>
        </details>`;
      }
      historyHtml += '</div>';
    }
    historyHtml += '</section>';
  }

  fs.writeFileSync(reportPath, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Boromir — API Report — ${esc(tsStr)}</title>
<style>${CSS}
</style>
</head>
<body>
<header>
  <h1>Boromir</h1>
  <span class="meta">${esc(tsStr)}</span>
</header>
${currentSection}
${historyHtml}
</body>
</html>`, 'utf8');
}
