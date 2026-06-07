/* ═══════════════════════════════════════════════════════
   Boromir Web UI — script.js
   ═══════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────
const state = {
  currentPlaybook: null,   // filename of the open playbook
  parsedCurl: null,        // last parsed curl result
  isDirty: false,          // unsaved editor changes
  lastRun: null,           // last run-playbook response for report saving
};

let editorInstance = null;
let loadedApiSpec = null;

// ─── OpenAPI helpers (used by Monaco providers) ───────────────────

// Returns the path prefix that should be prepended to every spec path.
// OpenAPI 2.x: spec.basePath  |  OpenAPI 3.x: pathname of spec.servers[0].url
function getApiBasePath(spec) {
  if (spec.basePath) {
    const p = spec.basePath.replace(/\/$/, '');
    return p === '' ? '' : p;
  }
  if (spec.servers && spec.servers.length > 0) {
    const serverUrl = spec.servers[0].url || '';
    try {
      const pathname = new URL(serverUrl).pathname.replace(/\/$/, '');
      return pathname === '' ? '' : pathname;
    } catch {
      // relative server URL like "/v2"
      const p = serverUrl.replace(/\/$/, '');
      return p.startsWith('/') ? p : '';
    }
  }
  return '';
}

// Given a full path from the editor line, strip the basePath prefix to get the spec key.
function stripBasePath(fullPath, basePath) {
  if (basePath && fullPath.startsWith(basePath)) {
    return fullPath.slice(basePath.length) || '/';
  }
  return fullPath;
}

function buildOpDocs(specPath, method, op, spec) {
  const defs = spec.definitions || (spec.components && spec.components.schemas) || {};
  const basePath = getApiBasePath(spec);
  const fullPath = basePath + specPath;
  let md = `**\`${method.toUpperCase()} ${fullPath}\`**\n\n`;
  if (op.summary) md += `${op.summary}\n\n`;
  if (op.description) md += `_${op.description}_\n\n`;

  const params = (op.parameters || []).filter(p => p.in !== 'body');
  if (params.length) {
    md += `**Parameters:**\n`;
    params.forEach(p => {
      const type = p.type || (p.schema && p.schema.type) || 'any';
      md += `- \`${p.name}\` *(${p.in}, ${type}${p.required ? ', required' : ''})* ${p.description ? '— ' + p.description : ''}\n`;
    });
    md += '\n';
  }

  const bodyParam = (op.parameters || []).find(p => p.in === 'body');
  if (bodyParam && bodyParam.schema) {
    md += `**Request Body:**\n\`\`\`\n${schemaToText(bodyParam.schema, defs, 0)}\`\`\`\n\n`;
  }

  if (op.requestBody) {
    const content = op.requestBody.content || {};
    const jsonContent = content['application/json'] || content['*/*'];
    if (jsonContent && jsonContent.schema) {
      md += `**Request Body:**\n\`\`\`\n${schemaToText(jsonContent.schema, defs, 0)}\`\`\`\n\n`;
    }
  }

  const resps = op.responses || {};
  const codes = Object.keys(resps).slice(0, 3);
  if (codes.length) {
    md += `**Responses:** ${codes.map(c => `\`${c}\` ${resps[c].description || ''}`).join(' · ')}\n`;
  }

  return md;
}

function schemaToText(schema, defs, depth) {
  if (!schema || depth > 3) return '';
  const pad = '  '.repeat(depth);

  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    const refSchema = defs[name];
    if (!refSchema) return `${pad}${name}\n`;
    return schemaToText(refSchema, defs, depth);
  }

  if (schema.type === 'array') {
    const itemText = schema.items ? schemaToText(schema.items, defs, depth).trim() : 'any';
    return `${pad}[ ${itemText} ]\n`;
  }

  if (schema.properties || schema.type === 'object') {
    const props = schema.properties || {};
    const reqd = schema.required || [];
    return Object.entries(props).map(([name, prop]) => {
      const req = reqd.includes(name) ? '*' : ' ';
      const type = prop.type || (prop.$ref ? prop.$ref.split('/').pop() : 'object');
      const desc = prop.description ? `  // ${prop.description}` : '';
      return `${pad}${req} ${name}: ${type}${desc}`;
    }).join('\n') + '\n';
  }

  return `${pad}${schema.type || 'any'}\n`;
}

// Walk back from lineNumber to find the METHOD /path line this body belongs to.
// Skips blank lines, comments, and JSON-looking lines (body content).
function findMethodPathAbove(model, lineNumber) {
  for (let ln = lineNumber - 1; ln >= Math.max(1, lineNumber - 30); ln--) {
    const line = model.getLineContent(ln).trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(\/[^\s]*)$/i);
    if (m) return m;
    // Stop if we hit something that's clearly not JSON (not the body we came from)
    if (!/^[{}\[\]"',\s]/.test(line) && !/^\s*"[^"]*"\s*:/.test(line)) break;
  }
  return null;
}

// Resolve a $ref to its target schema (one level deep)
function resolveRef(schema, defs) {
  if (schema && schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return defs[name] || schema;
  }
  return schema;
}

// Get the resolved request body schema for an operation
function getBodySchema(op, defs) {
  // OpenAPI 2.x body parameter
  const bodyParam = (op.parameters || []).find(p => p.in === 'body');
  if (bodyParam && bodyParam.schema) return resolveRef(bodyParam.schema, defs);
  // OpenAPI 3.x requestBody
  if (op.requestBody) {
    const content = op.requestBody.content || {};
    const schema = (content['application/json'] || content['*/*'] || Object.values(content)[0] || {}).schema;
    if (schema) return resolveRef(schema, defs);
  }
  return null;
}

function initMonaco(initialContent = '') {
  if (editorInstance) {
    editorInstance.setValue(initialContent);
    return;
  }

  const editorEl = $('playbookEditor');
  if (!editorEl) return;

  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], function () {
    // Registrar el lenguaje BRL
    monaco.languages.register({ id: 'brl' });

    // Definición de tokens para coloreado sintáctico
    monaco.languages.setMonarchTokensProvider('brl', {
      tokenizer: {
        root: [
          // Comentarios
          [/^#.*$/, 'comment'],
          
          // Métodos HTTP
          [/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/, 'keyword'],
          
          // Paths / URLs relativas o absolutas
          [/\/[\w\-\.\/\?&\=\+%\#\{\}\$]*/, 'string.path'],
          
          // Variables / Encadenamiento: {{$0.id}} o {{$prev.id}}
          [/\{\{\$[a-zA-Z0-9\._-]+\}\}/, 'variable'],
          
          // Bloques JSON
          [/\{.*$/, 'string.json'],
        ]
      }
    });

    // Tema personalizado oscuro para Boromir / BRL
    monaco.editor.defineTheme('brl-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
        { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
        { token: 'string.path', foreground: 'ce9178' },
        { token: 'string.json', foreground: 'b5cea8' },
        { token: 'variable', foreground: '4ec9b0', fontStyle: 'bold' }
      ],
      colors: {
        'editor.background': '#13151a',
        'editor.foreground': '#e3e6ed',
        'editor.lineHighlightBackground': '#1c1f26',
        'editorGutter.background': '#13151a'
      }
    });

    monaco.languages.registerCompletionItemProvider('brl', {
      triggerCharacters: ['/', ' ', '"', ','],
      provideCompletionItems: (model, position) => {
        const lineContent = model.getLineContent(position.lineNumber);
        const col = position.column;
        const suggestions = [];

        // HTTP methods at start of line
        if (col <= 8 && !/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s/.test(lineContent)) {
          ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].forEach(m => {
            suggestions.push({
              label: m,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: m + ' ',
              range: new monaco.Range(position.lineNumber, 1, position.lineNumber, col)
            });
          });
        }

        // Path completions from loaded OpenAPI spec
        const methodLineMatch = lineContent.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(.*)$/i);
        if (methodLineMatch && loadedApiSpec && loadedApiSpec.paths) {
          const method = methodLineMatch[1].toLowerCase();
          const afterMethodCol = methodLineMatch[1].length + 2;
          const basePath = getApiBasePath(loadedApiSpec);
          Object.entries(loadedApiSpec.paths).forEach(([specPath, ops]) => {
            if (!ops[method]) return;
            const op = ops[method];
            const fullPath = basePath + specPath;
            suggestions.push({
              label: fullPath,
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: fullPath,
              detail: op.summary || '',
              documentation: { value: buildOpDocs(specPath, method, op, loadedApiSpec) },
              range: new monaco.Range(position.lineNumber, afterMethodCol, position.lineNumber, col)
            });
          });
        }

        // Body field completions — BRL format is: METHOD /path {body} all on one line
        const bodyLineMatch = lineContent.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(\/[^\s]*)\s+(\{.*)$/i);
        if (bodyLineMatch && loadedApiSpec && loadedApiSpec.paths) {
          const method = bodyLineMatch[1].toLowerCase();
          const fullPath = bodyLineMatch[2];
          // Strip basePath so the lookup matches spec.paths keys
          const specPath = stripBasePath(fullPath, getApiBasePath(loadedApiSpec));
          // 0-indexed position of '{' in the line
          const bodyStartIdx = bodyLineMatch[1].length + 1 + bodyLineMatch[2].length + 1;
          const bodyOpenCol = bodyStartIdx + 1; // 1-based Monaco col of '{'

          if (col > bodyOpenCol) { // cursor is inside the body
            const ops = loadedApiSpec.paths[specPath];
            if (ops && ops[method]) {
              const defs = loadedApiSpec.definitions ||
                (loadedApiSpec.components && loadedApiSpec.components.schemas) || {};
              const bodySchema = getBodySchema(ops[method], defs);
              if (bodySchema && bodySchema.properties) {
                const reqd = bodySchema.required || [];

                // Count quotes in the body portion before the cursor to determine
                // whether the cursor is inside an open string (odd = inside a key)
                const bodyBeforeCursor = lineContent.substring(bodyStartIdx, col - 1);
                const quoteCount = (bodyBeforeCursor.match(/"/g) || []).length;
                const insideString = quoteCount % 2 === 1;

                const wordInfo = model.getWordAtPosition(position);
                const wordStart = wordInfo ? wordInfo.startColumn : col;
                const wordEnd   = wordInfo ? wordInfo.endColumn   : col;

                Object.entries(bodySchema.properties).forEach(([name, prop]) => {
                  const type = prop.type || (prop.$ref ? prop.$ref.split('/').pop() : 'object');
                  const isRequired = reqd.includes(name);
                  suggestions.push({
                    label: name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    // If inside an open quote, supply only name + closing quote + colon
                    insertText: insideString ? `${name}": ` : `"${name}": `,
                    detail: type + (isRequired ? '  ✱ required' : ''),
                    documentation: { value: prop.description || '' },
                    sortText: isRequired ? `0_${name}` : `1_${name}`,
                    range: new monaco.Range(position.lineNumber, wordStart, position.lineNumber, wordEnd)
                  });
                });
              }
            }
          }
        }

        // Variable chaining completions
        if (lineContent.includes('{{')) {
          const varRange = new monaco.Range(position.lineNumber, col - 2, position.lineNumber, col);
          [
            { label: '{{$prev.id}}', doc: 'Field from the previous response' },
            { label: '{{$0.id}}', doc: 'Field from the first response' },
          ].forEach(({ label, doc }) => {
            suggestions.push({
              label,
              kind: monaco.languages.CompletionItemKind.Variable,
              insertText: label,
              documentation: doc,
              range: varRange
            });
          });
        }

        return { suggestions };
      }
    });

    monaco.languages.registerHoverProvider('brl', {
      provideHover: (model, position) => {
        const lineContent = model.getLineContent(position.lineNumber);
        const word = model.getWordAtPosition(position);

        if (word && ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].includes(word.word)) {
          return {
            contents: [
              { value: `**HTTP Method: ${word.word}**` },
              { value: 'Defines the request action in the BRL sequence.' }
            ]
          };
        }

        // Show OpenAPI docs when hovering over a BRL line (with or without body)
        if (loadedApiSpec && loadedApiSpec.paths) {
          const methodMatch = lineContent.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(\/[^\s]*)/i);
          if (methodMatch) {
            const method = methodMatch[1].toLowerCase();
            const fullPath = methodMatch[2];
            const specPath = stripBasePath(fullPath, getApiBasePath(loadedApiSpec));
            const ops = loadedApiSpec.paths[specPath];
            if (ops && ops[method]) {
              return { contents: [{ value: buildOpDocs(specPath, method, ops[method], loadedApiSpec) }] };
            }
          }
        }

        return null;
      }
    });

    editorInstance = monaco.editor.create(editorEl, {
      value: initialContent,
      language: 'brl',
      theme: 'brl-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      lineHeight: 22,
      tabSize: 2,
      padding: { top: 12 }
    });

    editorInstance.onDidChangeModelContent(() => {
      state.isDirty = true;
      const fname = $('editorFileName').textContent;
      if (!fname.endsWith(' *')) $('editorFileName').textContent = fname + ' *';
    });

    // ── Keyboard actions ──────────────────────────────────────────────

    editorInstance.addAction({
      id: 'brl-run-all',
      label: 'BRL: Run All Steps',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => $('runPlaybookBtn').click(),
    });

    editorInstance.addAction({
      id: 'brl-run-selection',
      label: 'BRL: Run Selection / Current Line',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: (ed) => {
        const sel = ed.getSelection();
        let text;
        if (sel && !sel.isEmpty()) {
          text = ed.getModel().getValueInRange(sel);
        } else {
          text = ed.getModel().getLineContent(ed.getPosition().lineNumber);
        }
        text = text.trim();
        if (!text || text.startsWith('#')) {
          toast('No runnable step here', 'error');
          return;
        }
        runPlaybookText(text);
      },
    });

    editorInstance.addAction({
      id: 'brl-import-curl',
      label: 'BRL: Import cURL from Clipboard',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyU],
      run: async (ed) => {
        let curlText;
        try {
          curlText = await navigator.clipboard.readText();
        } catch {
          toast('Clipboard access denied — use the cURL Import tab', 'error');
          return;
        }
        const trimmed = curlText.trim();
        if (!trimmed.toLowerCase().startsWith('curl')) {
          toast('Clipboard does not contain a cURL command', 'error');
          return;
        }
        const { ok, data } = await api('POST', '/api/parse-curl', { curl: trimmed });
        if (!ok || !data.success) { toast(data.message || 'Parse failed', 'error'); return; }
        const brlLine = curlToBrl(data.parsed);
        const pos = ed.getPosition();
        const model = ed.getModel();
        const isEmptyLine = model.getLineContent(pos.lineNumber).trim() === '';
        const col = isEmptyLine ? 1 : model.getLineMaxColumn(pos.lineNumber);
        const prefix = isEmptyLine ? '' : '\n';
        ed.executeEdits('import-curl', [{
          range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col),
          text: prefix + brlLine,
          forceMoveMarkers: true,
        }]);
        toast('cURL imported ✓', 'success');
      },
    });

    // ── Status bar ────────────────────────────────────────────────────
    const mod = navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl';
    $('sbRunAll').innerHTML   = `<kbd>${mod}+⇧+↵</kbd> Run All`;
    $('sbRunLine').innerHTML  = `<kbd>${mod}+↵</kbd> Run Line/Selection`;
    $('sbImportCurl').innerHTML = `<kbd>${mod}+⇧+U</kbd> Import cURL`;
  });
}

// ─── DOM helpers ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const show = (el) => el?.classList.remove('hidden');
const hide = (el) => el?.classList.add('hidden');

// ─── API wrapper ──────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({ success: false, message: res.statusText }));
  return { ok: res.ok, status: res.status, data: json };
}

// ─── Toast notifications ──────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed; bottom:1.5rem; right:1.5rem; z-index:9999;
    background:var(--bg-elevated); border:1px solid var(--border);
    border-left: 3px solid ${type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--accent)'};
    color:var(--text); padding:.7rem 1rem; border-radius:8px;
    font-size:.82rem; box-shadow:var(--shadow); max-width:320px;
    animation:slideUp .25s ease; pointer-events:none;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════

let authPollTimer = null;

async function checkAuth() {
  const { data } = await api('GET', '/api/auth/status');
  showApp(data.baseUrl);
}

function updateConnectionBadge(baseUrl) {
  const resolvedUrl = baseUrl || localStorage.getItem('boromir_baseUrl') || '';
  const dot = $('authDot');
  if (resolvedUrl) {
    $('baseUrlInput').value = resolvedUrl;
    localStorage.setItem('boromir_baseUrl', resolvedUrl);
    try { $('userName').textContent = new URL(resolvedUrl).host; }
    catch { $('userName').textContent = resolvedUrl; }
    dot.textContent = '●';
    dot.style.color = 'var(--green)';
  } else {
    $('userName').textContent = 'not connected';
    dot.textContent = '○';
    dot.style.color = '';
  }
}

function showApp(baseUrl) {
  hide($('loginOverlay'));
  $('app').classList.remove('hidden');
  stopAuthPoll();
  closeIframeLogin();
  updateConnectionBadge(baseUrl);
  loadPlaybooks();
  loadReports();
  loadSavedSpec();
  initMonaco('# New BRL Playbook\nGET /api/health\n');
}

function openConnectModal() {
  closeIframeLogin();
  show($('loginOverlay'));
}

// ─── Tab switching ─────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    $(`tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`)?.classList.remove('hidden');
  });
});

// ─── Proxy / iframe login ──────────────────────────────────────────

$('openProxyBtn').addEventListener('click', async () => {
  const baseUrl = $('proxyBaseUrl').value.trim();
  const loginPath = $('proxyLoginPath').value.trim() || '/v2/login';
  const errEl = $('loginError');
  hide(errEl);

  if (!baseUrl) {
    errEl.textContent = 'Please enter the Application URL';
    show(errEl);
    return;
  }

  // 1. Tell the server which target to proxy
  const { data } = await api('POST', '/api/auth/set-proxy-target', { baseUrl });
  if (!data.success) {
    errEl.textContent = data.message || 'Failed to set proxy target';
    show(errEl);
    return;
  }

  // 2. Load proxied login page in iframe
  const iframeSrc = `/proxy${loginPath.startsWith('/') ? loginPath : '/' + loginPath}`;
  $('loginIframe').src = iframeSrc;

  // 3. Switch to iframe view
  hide($('loginCard'));
  show($('loginIframeWrapper'));

  // 4. Poll auth status until login detected
  startAuthPoll();
});

$('cancelIframeBtn').addEventListener('click', () => {
  closeIframeLogin();
});

function closeIframeLogin() {
  hide($('loginIframeWrapper'));
  show($('loginCard'));
  $('loginIframe').src = '';
  stopAuthPoll();
}

function startAuthPoll() {
  stopAuthPoll();
  let dots = 0;
  const statusDot = $('iframeStatusDot');
  const statusText = $('iframeStatusText');
  statusDot.style.background = 'var(--accent)';

  authPollTimer = setInterval(async () => {
    dots = (dots + 1) % 4;
    statusText.textContent = 'Waiting for login' + '.'.repeat(dots);

    const { data } = await api('GET', '/api/auth/status');
    if (data.authenticated) {
      statusDot.style.background = 'var(--green)';
      statusText.textContent = '✓ Connected!';
      setTimeout(() => {
        hide($('loginOverlay'));
        closeIframeLogin();
        stopAuthPoll();
        updateConnectionBadge(data.baseUrl);
        toast('Connected ✓', 'success');
        loadPlaybooks();
        loadReports();
        loadSavedSpec();
      }, 600);
    }
  }, 1000);
}

function stopAuthPoll() {
  if (authPollTimer) {
    clearInterval(authPollTimer);
    authPollTimer = null;
  }
}

// ─── Connect modal ─────────────────────────────────────────────────

$('connectBtn').addEventListener('click', openConnectModal);
$('userBadge').addEventListener('click', openConnectModal);

$('closeConnectBtn').addEventListener('click', () => {
  hide($('loginOverlay'));
  closeIframeLogin();
});

// ─── Logout ────────────────────────────────────────────────────────

$('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  updateConnectionBadge(null);
  toast('Disconnected', 'info');
});



// ═══════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
    const target = $(`view${view.charAt(0).toUpperCase() + view.slice(1)}`);
    if (target) { target.classList.remove('hidden'); target.classList.add('active'); }
    if (view === 'reports') loadReports();
  });
});

$('sidebarToggle').addEventListener('click', () => {
  $('sidebar').classList.toggle('collapsed');
});

// ═══════════════════════════════════════════════════════
// PLAYBOOKS
// ═══════════════════════════════════════════════════════

async function loadPlaybooks() {
  const { data } = await api('GET', '/api/playbooks');
  renderPlaybookList(data.playbooks || []);
}

function renderPlaybookList(playbooks) {
  const list = $('playbookList');
  if (!playbooks.length) {
    list.innerHTML = '<li class="file-list-empty">No playbooks yet</li>';
    return;
  }
  const filter = $('playbookSearch').value.toLowerCase();
  const filtered = playbooks.filter(p => p.name.toLowerCase().includes(filter));
  list.innerHTML = filtered.map(p => `
    <li class="file-item ${state.currentPlaybook === p.name ? 'active' : ''}"
        data-name="${p.name}" tabindex="0" role="button">
      <span class="file-item-icon">📄</span>
      <span class="file-item-name" title="${p.name}">${p.name}</span>
    </li>
  `).join('');

  list.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', () => openPlaybook(item.dataset.name));
    item.addEventListener('keydown', e => e.key === 'Enter' && openPlaybook(item.dataset.name));
  });
}

async function openPlaybook(name) {
  if (state.isDirty && !confirm('You have unsaved changes. Discard?')) return;
  const { data } = await api('GET', `/api/playbooks/${encodeURIComponent(name)}`);
  if (!data.success) return toast(data.message, 'error');
  state.currentPlaybook = name;
  state.isDirty = false;
  if (editorInstance) {
    editorInstance.setValue(data.content);
  } else {
    initMonaco(data.content);
  }
  $('editorFileName').textContent = name;
  show($('deletePlaybookBtn'));
  hide($('runResults'));
  document.querySelectorAll('.file-item').forEach(li => {
    li.classList.toggle('active', li.dataset.name === name);
  });
}

$('playbookSearch').addEventListener('input', async () => {
  const { data } = await api('GET', '/api/playbooks');
  renderPlaybookList(data.playbooks || []);
});

$('refreshPlaybooksBtn').addEventListener('click', loadPlaybooks);

$('newPlaybookBtn').addEventListener('click', () => {
  if (state.isDirty && !confirm('Discard unsaved changes?')) return;
  const name = prompt('Playbook filename:', 'new-playbook.req');
  if (!name) return;
  const fname = name.endsWith('.req') || name.endsWith('.brl') ? name : name + '.req';
  state.currentPlaybook = fname;
  state.isDirty = false;
  const initialText = `# ${fname}\nGET /api/health\n`;
  if (editorInstance) {
    editorInstance.setValue(initialText);
  } else {
    initMonaco(initialText);
  }
  $('editorFileName').textContent = fname;
  show($('deletePlaybookBtn'));
  hide($('runResults'));
});

// El listener de input ahora se maneja dentro de Monaco de forma nativa

$('savePlaybookBtn').addEventListener('click', async () => {
  const name = state.currentPlaybook;
  if (!name) return toast('No playbook open', 'error');
  const content = editorInstance ? editorInstance.getValue() : '';
  const { data } = await api('PUT', `/api/playbooks/${encodeURIComponent(name)}`, { content });
  if (data.success) {
    state.isDirty = false;
    $('editorFileName').textContent = name;
    toast(`Saved ${name}`, 'success');
    loadPlaybooks();
  } else {
    toast(data.message || 'Save failed', 'error');
  }
});

$('deletePlaybookBtn').addEventListener('click', async () => {
  const name = state.currentPlaybook;
  if (!name || !confirm(`Delete "${name}"?`)) return;
  const { data } = await api('DELETE', `/api/playbooks/${encodeURIComponent(name)}`);
  if (data.success) {
    state.currentPlaybook = null;
    state.isDirty = false;
    if (editorInstance) editorInstance.setValue('');
    $('editorFileName').textContent = 'Untitled.req';
    hide($('deletePlaybookBtn'));
    hide($('runResults'));
    toast(`Deleted ${name}`, 'success');
    loadPlaybooks();
  } else {
    toast(data.message || 'Delete failed', 'error');
  }
});

// Persist baseUrl so it survives backend restarts
$('baseUrlInput').addEventListener('change', () => {
  const url = $('baseUrlInput').value.trim();
  if (url) localStorage.setItem('boromir_baseUrl', url);
});

// ─── Run helpers ───────────────────────────────────────────────────
async function runPlaybookText(text) {
  const baseUrl = $('baseUrlInput').value.trim();
  if (!baseUrl) { toast('Enter a Base URL first', 'error'); return; }
  const trimmed = text.trim();
  if (!trimmed) { toast('Nothing to run', 'error'); return; }

  const keepGoing = $('keepGoingToggle').checked;
  const btn = $('runPlaybookBtn');
  btn.textContent = '⏳ Running…';
  btn.disabled = true;
  hide($('runResults'));

  const { data } = await api('POST', '/api/run-playbook', { playbook: trimmed, baseUrl, keepGoing });
  btn.textContent = '▶ Run';
  btn.disabled = false;

  if (!data.results) return toast(data.message || 'Run failed', 'error');
  state.lastRun = data;
  renderResults(data);
}

function curlToBrl(parsed) {
  const { method, url, body } = parsed;
  let path;
  try { const u = new URL(url); path = u.pathname + u.search; }
  catch { path = url; }
  return body ? `${method} ${path} ${body}` : `${method} ${path}`;
}

$('runPlaybookBtn').addEventListener('click', () => {
  const playbook = editorInstance ? editorInstance.getValue() : '';
  if (!playbook.trim()) return toast('Editor is empty', 'error');
  runPlaybookText(playbook);
});

function renderResults(data) {
  const { success, total, failed, totalMs, results } = data;
  const el = $('runResults');
  show(el);

  const meta = $('resultsMeta');
  const time = totalMs ? `${(totalMs / 1000).toFixed(2)}s` : '';
  meta.innerHTML = `
    <span class="${failed === 0 ? 'ok' : 'fail'}">${total - failed}/${total} OK</span>
    ${failed > 0 ? `<span class="fail"> · ${failed} failed</span>` : ''}
    ${time ? `<span> · ${time}</span>` : ''}
  `;

  const stepsEl = $('resultsSteps');
  stepsEl.innerHTML = '';

  results.forEach((step) => {
    const statusClass = step.error ? 'fail' : step.ok ? 'ok' : 'warn';
    const statusLabel = step.error ? 'ERR' : step.status || '?';
    const statusCls = step.error ? 'status-fail' : step.ok ? 'status-ok' : 'status-warn';
    const method = (step.method || 'GET').toUpperCase();

    const card = document.createElement('div');
    card.className = `step-card ${statusClass} expanded`;
    card.innerHTML = `
      <div class="step-header">
        <span class="step-index">#${step.index + 1}</span>
        <span class="step-method method-${method}">${method}</span>
        <span class="step-url" title="${step.url || step.rawPath}">${step.url || step.rawPath || '—'}</span>
        <span class="step-status ${statusCls}">${statusLabel}</span>
        <span class="step-duration">${step.durationMs != null ? step.durationMs + 'ms' : ''}</span>
        <span class="step-chevron">›</span>
      </div>
      <div class="step-body">
        ${step.error ? `<div class="step-error">${escapeHtml(step.error)}</div>` : ''}
        ${step.reqBody ? `
          <div class="step-section">
            <div class="step-body-label">Request Body</div>
            <pre>${escapeHtml(JSON.stringify(step.reqBody, null, 2))}</pre>
          </div>` : ''}
        ${step.respBody !== null && step.respBody !== undefined ? `
          <div class="step-section">
            <div class="step-body-label">Response Body</div>
            <pre>${escapeHtml(typeof step.respBody === 'object' ? JSON.stringify(step.respBody, null, 2) : String(step.respBody))}</pre>
          </div>` : ''}
      </div>
    `;

    card.querySelector('.step-header').addEventListener('click', () => {
      card.classList.toggle('expanded');
    });

    stepsEl.appendChild(card);
  });

  // Scroll results panel to the last step
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

$('closeResults').addEventListener('click', () => {
  $('runResults').classList.remove('maximized');
  $('maximizeResultsBtn').textContent = '⛶';
  hide($('runResults'));
});

$('maximizeResultsBtn').addEventListener('click', () => {
  const el = $('runResults');
  const isMax = el.classList.toggle('maximized');
  $('maximizeResultsBtn').textContent = isMax ? '⊡' : '⛶';
  if (isMax) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
});

$('saveReportBtn').addEventListener('click', async () => {
  if (!state.lastRun) return toast('No run data to save', 'error');
  const playbookName = $('editorFileName').textContent.replace(' *', '').trim();
  const { data } = await api('POST', '/api/reports/save', {
    results: state.lastRun.results,
    startedAt: state.lastRun.startedAt,
    totalMs: state.lastRun.totalMs,
    playbookName,
  });
  if (data.success) {
    toast(`Report saved: ${data.name}`, 'success');
    loadReports();
  } else {
    toast(data.message || 'Save failed', 'error');
  }
});

// ═══════════════════════════════════════════════════════
// cURL IMPORT
// ═══════════════════════════════════════════════════════

$('parseCurlBtn').addEventListener('click', async () => {
  const curl = $('curlInput').value.trim();
  if (!curl) return toast('Paste a cURL command first', 'error');

  const { data } = await api('POST', '/api/parse-curl', { curl });
  if (!data.success) return toast(data.message || 'Parse failed', 'error');

  state.parsedCurl = data.parsed;
  renderCurlResult(data.parsed);
  show($('curlResultPanel'));
  show($('importToPlaybookBtn'));

  const token = extractTokenFromHeaders(data.parsed.headers);
  if (token) show($('setTokenFromCurlBtn'));
  else hide($('setTokenFromCurlBtn'));
});

function renderCurlResult(parsed) {
  const grid = $('curlResultGrid');
  const rows = [
    ['Method', parsed.method],
    ['URL', parsed.url],
    ['Headers', JSON.stringify(parsed.headers, null, 2)],
    ['Body', parsed.body || '(none)'],
  ];
  grid.innerHTML = rows.map(([label, value]) => `
    <div class="result-row">
      <label>${label}</label>
      <pre>${escapeHtml(String(value))}</pre>
    </div>
  `).join('');
}

function extractTokenFromHeaders(headers) {
  const auth = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === 'authorization');
  if (!auth) return null;
  const val = auth[1];
  if (typeof val === 'string' && val.startsWith('Bearer ')) return val.slice(7).trim();
  return null;
}

$('setTokenFromCurlBtn').addEventListener('click', async () => {
  if (!state.parsedCurl) return;
  const token = extractTokenFromHeaders(state.parsedCurl.headers);
  if (!token) return toast('No Bearer token found', 'error');
  const { data } = await api('POST', '/api/auth/set-token', { token });
  if (data.success) toast('Token updated ✓', 'success');
  else toast(data.message, 'error');
});

$('importToPlaybookBtn').addEventListener('click', () => {
  if (!state.parsedCurl) return;
  const p = state.parsedCurl;
  let url;
  try {
    const u = new URL(p.url);
    url = u.pathname + u.search;
  } catch {
    url = p.url;
  }
  const line = p.body
    ? `${p.method} ${url}\n${p.body}`
    : `${p.method} ${url}`;

  const existing = editorInstance ? editorInstance.getValue() : '';
  const newVal = existing ? existing + '\n' + line : line;
  if (editorInstance) {
    editorInstance.setValue(newVal);
  } else {
    initMonaco(newVal);
  }
  state.isDirty = true;

  // Switch to playbooks view
  $('navPlaybooks').click();
  toast('Added to playbook editor', 'success');
});

// ═══════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════

async function loadReports() {
  const { data } = await api('GET', '/api/reports');
  const reports = data.reports || [];
  const grid = $('reportsList');
  if (!reports.length) {
    grid.innerHTML = '<p class="empty-state">No reports found.<br>Run a playbook with a report output to see them here.</p>';
    return;
  }
  grid.innerHTML = reports.map(r => `
    <div class="report-card" data-name="${r.name}" tabindex="0" role="button">
      <div class="report-card-name">📊 ${r.name}</div>
      <div class="report-card-meta">${formatDate(r.createdAt)} · ${formatSize(r.size)}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.report-card').forEach(card => {
    card.addEventListener('click', () => openReport(card.dataset.name));
    card.addEventListener('keydown', e => e.key === 'Enter' && openReport(card.dataset.name));
  });
}

function openReport(name) {
  const frame = $('reportFrame');
  frame.src = `/api/reports/${encodeURIComponent(name)}`;
  show(frame);
  frame.scrollIntoView({ behavior: 'smooth' });
}

$('refreshReportsBtn').addEventListener('click', loadReports);

// ═══════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch { return iso; }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Monaco maneja nativamente la indentación con Tab, así que no requerimos custom listeners aquí

// Warn before leaving with unsaved changes
window.addEventListener('beforeunload', (e) => {
  if (state.isDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ═══════════════════════════════════════════════════════
// OPENAPI / SWAGGER MODAL
// ═══════════════════════════════════════════════════════

$('openSwaggerModalBtn').addEventListener('click', () => show($('swaggerOverlay')));

function closeSwaggerModal() {
  hide($('swaggerOverlay'));
  hide($('swaggerError'));
}

$('closeSwaggerModalBtn').addEventListener('click', closeSwaggerModal);
$('cancelSwaggerBtn').addEventListener('click', closeSwaggerModal);

// Scoped tab switching for the swagger modal
$('swaggerTabs').querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    $('swaggerTabs').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    [$('tabPaste'), $('tabUrl')].forEach(p => p && p.classList.add('hidden'));
    if (tab === 'paste') $('tabPaste').classList.remove('hidden');
    if (tab === 'url') $('tabUrl').classList.remove('hidden');
  });
});

$('submitSwaggerBtn').addEventListener('click', async () => {
  const errEl = $('swaggerError');
  hide(errEl);

  const activeTab = ($('swaggerTabs').querySelector('.tab-btn.active') || {}).dataset
    ? $('swaggerTabs').querySelector('.tab-btn.active').dataset.tab
    : 'paste';

  if (activeTab === 'url') {
    const url = $('swaggerUrlInput').value.trim();
    if (!url) { errEl.textContent = 'Enter a spec URL'; show(errEl); return; }

    const btn = $('submitSwaggerBtn');
    const origText = btn.textContent;
    btn.textContent = 'Loading…';
    btn.disabled = true;

    const { ok, data } = await api('POST', '/api/openapi/fetch', { url });
    btn.textContent = origText;
    btn.disabled = false;

    if (!ok || !data.success) {
      errEl.textContent = data.message || 'Failed to fetch spec';
      show(errEl);
      return;
    }
    applyOpenApiSpec(data.content, errEl);
  } else {
    const text = $('swaggerPasteArea').value.trim();
    if (!text) { errEl.textContent = 'Paste a spec first'; show(errEl); return; }
    applyOpenApiSpec(text, errEl);
  }
});

function applyOpenApiSpec(specText, errEl) {
  let spec;
  try {
    try { spec = JSON.parse(specText); }
    catch { spec = jsyaml.load(specText); }
  } catch (e) {
    if (errEl) { errEl.textContent = 'Parse error: ' + e.message; show(errEl); }
    return;
  }

  if (!spec || typeof spec !== 'object' || !spec.paths) {
    if (errEl) { errEl.textContent = 'Invalid spec: no "paths" found'; show(errEl); }
    return;
  }

  loadedApiSpec = spec;
  closeSwaggerModal();
  const count = Object.keys(spec.paths).length;
  toast(`OpenAPI spec loaded — ${count} paths available`, 'success');
  api('POST', '/api/openapi/spec', { spec: specText });
}

async function loadSavedSpec() {
  const { data } = await api('GET', '/api/openapi/spec');
  if (data.success && data.spec) {
    try {
      let spec;
      try { spec = JSON.parse(data.spec); }
      catch { spec = jsyaml.load(data.spec); }
      if (spec && spec.paths) {
        loadedApiSpec = spec;
        toast(`OpenAPI spec restored — ${Object.keys(spec.paths).length} paths`, 'success');
      }
    } catch { /* ignore corrupt stored spec */ }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────
checkAuth();
