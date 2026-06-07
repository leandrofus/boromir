import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import { performance } from 'perf_hooks';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { buildClient } from './lib/client';
import { parseReqFile, resolve } from './lib/brl';
import type { GlobalOptions } from './lib/types';
import { saveToken } from './lib/session';
import { writeHtmlReport } from './lib/report';
import type { StepRecord } from './lib/types';

// Extend session type
declare module 'express-session' {
  interface SessionData {
    authToken?: string;
    proxyTarget?: string;
  }
}

// Script injected into proxied HTML pages to auto-capture auth tokens
const TOKEN_CAPTURE_SCRIPT = `
<script>
(function(){
  // Key name patterns that suggest an auth credential
  const KEY_PATTERNS = [
    /token/i, /session/i, /auth/i, /jwt/i, /bearer/i,
    /credential/i, /secret/i, /api[_-]?key/i, /access/i,
    /^sid$/i, /^id$/i, /^key$/i,
  ];
  // A value looks like a credential if it's a JWT, a long opaque string, or a UUID-like value
  function looksLikeToken(v) {
    if (typeof v !== 'string') return false;
    if (v.length < 8) return false;
    if (v.startsWith('eyJ')) return true;                          // JWT
    if (/^[A-Za-z0-9+/=_\-]{20,}$/.test(v)) return true;         // opaque token / base64
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true; // UUID
    return false;
  }
  function keyMatches(k) {
    return KEY_PATTERNS.some(p => p.test(k));
  }
  // Recursively walk a plain object looking for token-like values
  function walkObject(obj, path, found) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const p = path ? path+'.'+k : k;
      if (typeof v === 'string' && (keyMatches(k) || looksLikeToken(v)) && looksLikeToken(v)) {
        found.push([p, v]);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        walkObject(v, p, found);
      }
    }
  }
  const sent = new Set();
  function send(token, source){
    if (sent.has(token)) return;
    sent.add(token);
    fetch('/api/auth/capture-token',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'include',
      body:JSON.stringify({token, source})
    }).catch(()=>{});
  }
  function scanStorage(storage, label) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const raw = storage.getItem(k);
        if (!raw) continue;
        // Try to parse as JSON — the token may be inside a stored object
        if (raw.startsWith('{') || raw.startsWith('[')) {
          try {
            const parsed = JSON.parse(raw);
            const found = [];
            walkObject(parsed, k, found);
            for (const [p, v] of found) send(v, label+':'+p);
          } catch(e) {}
        }
        // Also check the raw string itself
        if ((keyMatches(k) || looksLikeToken(raw)) && looksLikeToken(raw)) {
          send(raw, label+':'+k);
        }
      }
    } catch(e) {}
  }
  function scanCookies() {
    document.cookie.split(';').forEach(c => {
      const eq = c.indexOf('=');
      if (eq < 0) return;
      const name = c.slice(0, eq).trim();
      const val  = decodeURIComponent(c.slice(eq + 1).trim());
      if ((keyMatches(name) || looksLikeToken(val)) && looksLikeToken(val)) {
        send(val, 'cookie:'+name);
      }
    });
  }
  function scan() {
    const before = sent.size;
    scanStorage(localStorage, 'localStorage');
    scanStorage(sessionStorage, 'sessionStorage');
    scanCookies();
    return sent.size > before;
  }
  scan();
  const t = setInterval(() => { scan(); }, 1200);
  setTimeout(() => clearInterval(t), 600000);
  // Intercept fetch responses — scan the JSON body for tokens
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        res.clone().json().then(data => {
          const found = [];
          walkObject(data, '', found);
          for (const [p, v] of found) send(v, 'fetchResponse:'+p);
        }).catch(()=>{});
      }
    } catch(e) {}
    return res;
  };
  // Intercept XHR responses
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...args) {
    this.addEventListener('load', function() {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        if (ct.includes('application/json') && this.responseText) {
          const data = JSON.parse(this.responseText);
          const found = [];
          walkObject(data, '', found);
          for (const [p, v] of found) send(v, 'xhrResponse:'+p);
        }
      } catch(e) {}
    });
    return origOpen.apply(this, args);
  };
})();
</script>`;

const EXTERNAL_AUTH_BASE = process.env.AUTH_BASE_URL || '';

// ─── Auth helpers ────────────────────────────────────────────────────────────

function getAuthToken(req: Request): string | undefined {
  if (req.session?.authToken) return req.session.authToken;
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (typeof req.query.token === 'string') return req.query.token;
  if (req.cookies?.authToken) return req.cookies.authToken;
  return undefined;
}

function applyToken(client: ReturnType<typeof buildClient>, token: string) {
  client.defaults.headers.common['Authorization'] = `Bearer ${token}`;
}

// ─── cURL parser ─────────────────────────────────────────────────────────────

function parseCurl(curlCmd: string): Record<string, unknown> {
  const trimmed = curlCmd.trim().replace(/\\\n/g, ' ');
  const parts: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let start = trimmed.startsWith('curl') ? 4 : 0;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);

  const result: any = { method: 'GET', url: '', headers: {}, body: null };
  let i = 0;
  while (i < parts.length) {
    const t = parts[i];
    if (!result.url && !t.startsWith('-')) { result.url = t; i++; continue; }
    switch (t) {
      case '-X': case '--request': result.method = (parts[++i] || 'GET').toUpperCase(); break;
      case '-H': case '--header': {
        const h = parts[++i] || '';
        const idx = h.indexOf(':');
        if (idx > -1) result.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        break;
      }
      case '-d': case '--data': case '--data-raw':
        result.body = parts[++i] || null;
        if (result.method === 'GET') result.method = 'POST';
        break;
    }
    i++;
  }
  return result;
}

// ─── Express setup ────────────────────────────────────────────────────────────

const app = express();

app.use('/api', express.json({ limit: '4mb' }));
app.use('/api', express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  name: 'boromir_sid',
  secret: process.env.SESSION_SECRET || 'boromir-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// Re-hydrate session from persistent cookies when the session store is empty (e.g. after restart).
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.session.authToken && req.cookies?.authToken) {
    req.session.authToken = req.cookies.authToken;
  }
  if (!req.session.proxyTarget && req.cookies?.proxyTarget) {
    req.session.proxyTarget = req.cookies.proxyTarget;
  }
  next();
});

const webRoot = path.resolve(__dirname, './web');
app.use(express.static(webRoot));

// ─── Auth endpoints ───────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { username, password, baseUrl } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Missing credentials' });
  }
  const authBase = baseUrl || EXTERNAL_AUTH_BASE;
  if (!authBase) {
    return res.status(400).json({ success: false, message: 'No AUTH_BASE_URL configured' });
  }

  // Try common login endpoints
  const loginPaths = ['/api/auth/login', '/auth/login', '/login', '/api/login', '/api/token'];
  let token: string | undefined;

  for (const loginPath of loginPaths) {
    try {
      const resp = await axios.post(`${authBase}${loginPath}`, { username, password }, {
        timeout: 5000,
        validateStatus: (s) => s < 500,
      });
      if (resp.status < 300) {
        token = resp.data?.token
          || resp.data?.access_token
          || resp.data?.accessToken
          || resp.data?.jwt
          || resp.data?.data?.token;
        if (token) break;
      }
    } catch {
      // try next path
    }
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication failed or token not found in response' });
  }

  res.cookie('authToken', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  req.session!.authToken = token;
  req.session!.proxyTarget = authBase.replace(/\/$/, '');
  res.cookie('proxyTarget', authBase.replace(/\/$/, ''), { sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  try { saveToken(token); } catch (e) { }
  return res.json({ success: true, token });
});

app.post('/api/auth/set-token', (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'Missing token' });
  res.cookie('authToken', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  req.session!.authToken = token;
  try { saveToken(token); } catch (e) { }
  return res.json({ success: true });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  req.session.destroy(() => { });
  res.clearCookie('authToken');
  res.clearCookie('proxyTarget');
  return res.json({ success: true });
});

app.get('/api/auth/status', (req: Request, res: Response) => {
  const token = getAuthToken(req);
  if (token) {
    return res.json({ authenticated: true, baseUrl: req.session?.proxyTarget || null });
  }
  return res.json({ authenticated: false });
});

// ─── Proxy-based login (iframe flow) ─────────────────────────────────────────

// Set the target URL to proxy (called before opening the iframe)
app.post('/api/auth/set-proxy-target', (req: Request, res: Response) => {
  const { baseUrl } = req.body;
  if (!baseUrl) return res.status(400).json({ success: false, message: 'Missing baseUrl' });
  const host = req.headers.host || '';
  if (baseUrl.includes(host) || baseUrl.includes('localhost:8888')) {
    return res.status(400).json({ success: false, message: 'Cannot proxy to the proxy server itself.' });
  }
  const target = baseUrl.replace(/\/$/, '');
  req.session!.proxyTarget = target;
  res.cookie('proxyTarget', target, { sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  return res.json({ success: true });
});

// Token captured by the injected script running inside the proxied login page
app.post('/api/auth/capture-token', (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length < 10) {
    return res.status(400).json({ success: false, message: 'Invalid token' });
  }
  req.session!.authToken = token;
  res.cookie('authToken', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  if (req.session!.proxyTarget) {
    res.cookie('proxyTarget', req.session!.proxyTarget, { sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  }
  try { saveToken(token); } catch (e) { }
  return res.json({ success: true });
});

// ─── Proxy factory (reutilizado para /proxy/* y el fallback genérico) ─────────
function buildProxy(target: string, stripPrefix?: string) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    selfHandleResponse: true,
    secure: false,
    ...(stripPrefix ? { pathRewrite: { ['^' + stripPrefix]: '' } } : {}),
    on: {
      proxyReq: (proxyReq, req: any, res) => {
        console.log(`[Proxy Req] ${req.method} ${req.url} | Cookies sent: ${req.headers['cookie'] || 'none'}`);
      },
      proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        // Eliminar headers que bloquean el iframe
        delete (proxyRes.headers as Record<string, any>)['x-frame-options'];
        delete (proxyRes.headers as Record<string, any>)['content-security-policy'];
        delete (proxyRes.headers as Record<string, any>)['x-content-security-policy'];

        // Rewrite Set-Cookie headers from the target portal:
        // - strip Domain/Secure/Path/SameSite=None so cookies work on localhost
        // - force Max-Age=7 days so they survive browser restarts (needed for session replay after backend restart)
        if (proxyRes.headers['set-cookie']) {
          const cookies = Array.isArray(proxyRes.headers['set-cookie'])
            ? proxyRes.headers['set-cookie']
            : [proxyRes.headers['set-cookie']];
          proxyRes.headers['set-cookie'] = cookies.map((c: string) => {
            let clean = c.replace(/;\s*Domain=[^;]*/gi, '')
              .replace(/;\s*Secure/gi, '')
              .replace(/;\s*Path=[^;]*/gi, '')
              .replace(/;\s*SameSite=[^;]*/gi, '')
              .replace(/;\s*Max-Age=[^;]*/gi, '')
              .replace(/;\s*Expires=[^;]*/gi, '');
            return clean + '; Path=/; SameSite=Lax; Max-Age=604800';
          });
        }

        // Interceptar y reescribir redirecciones para mantener el flujo dentro de /proxy
        if (proxyRes.headers['location']) {
          let loc = proxyRes.headers['location'] as string;
          const targetNormalized = target.replace(/\/$/, '');
          if (loc.startsWith(targetNormalized)) {
            loc = loc.slice(targetNormalized.length);
          }
          if (loc.startsWith('/') && !loc.startsWith('/proxy')) {
            if (stripPrefix === '/proxy') {
              loc = '/proxy' + loc;
            }
          }
          proxyRes.headers['location'] = loc;
          console.log(`[Proxy Redirect] Rewrote Location: ${loc}`);
        }

        // Capturar tokens de cookies del upstream
        const setCookies = proxyRes.headers['set-cookie'] || [];
        const cookieArr = Array.isArray(setCookies) ? setCookies : [setCookies];
        const tokenCookieNames = ['token', 'access_token', 'accessToken', 'jwt', 'auth_token', 'authToken', 'id_token', 'nexus_session', 'session', 'sid'];
        for (const cookieStr of cookieArr) {
          if (!cookieStr) continue;
          const [pair] = (cookieStr as string).split(';');
          const eqIdx = pair.indexOf('=');
          if (eqIdx < 0) continue;
          const name = pair.slice(0, eqIdx).trim();
          const val = pair.slice(eqIdx + 1).trim();
          const isJWT = val.startsWith('eyJ') && val.length > 20;
          if ((tokenCookieNames.includes(name.toLowerCase()) || isJWT) && val.length > 10) {
            if (!(req as any).session?.authToken) {
              (req as any).session!.authToken = val;
              (res as any).cookie('authToken', val, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
              try { saveToken(val); } catch (e) { }
              console.log(`[Proxy Token Capture] Captured token from cookie "${name}"`);
            }
          }
        }

        const contentType = (proxyRes.headers['content-type'] || '') as string;

        // HTML: reescribir rutas absolutas → /proxy/ e inyectar script de captura
        if (contentType.includes('text/html')) {
          let html = responseBuffer.toString('utf8');

          // Reescribir src="/...", href="/...", action="/..." para que pasen por /proxy/
          html = html
            .replace(/((?:src|href|action|data-src|data-href)=["'])\//g, '$1/proxy/')
            .replace(/url\((['"]?)\//g, 'url($1/proxy/');

          // Inyectar base tag y script de captura de token
          const baseTag = `<base href="/proxy/">`;
          if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>\n' + baseTag);
          } else if (html.includes('</head>')) {
            html = html.replace('</head>', baseTag + '\n</head>');
          }

          if (html.includes('</head>')) {
            html = html.replace('</head>', TOKEN_CAPTURE_SCRIPT + '\n</head>');
          } else {
            html = TOKEN_CAPTURE_SCRIPT + html;
          }
          return html;
        }

        // CSS: reescribir url() con rutas absolutas
        if (contentType.includes('text/css')) {
          let css = responseBuffer.toString('utf8');
          css = css.replace(/url\((['"]?)\//g, 'url($1/proxy/');
          return css;
        }

        return responseBuffer;
      }),
    },
  });
}

// Reverse proxy middleware — forwards /proxy/* to the configured target
app.use('/proxy', (req: Request, res: Response, next: NextFunction) => {
  const target = req.session?.proxyTarget;
  console.log(`[Proxy] /proxy request: ${req.method} ${req.url} -> Target: ${target}`);
  if (!target) return res.status(400).send('No proxy target. Call /api/auth/set-proxy-target first.');

  buildProxy(target, '/proxy')(req, res, next);
});

// Generic fallback proxy: quando a SPA carrega assets via rutas relativas (p.ex. /assets/index.js)
// y la sesión tiene un proxyTarget, los reenvía al target en lugar de devolver el index.html
app.use((req: Request, res: Response, next: NextFunction) => {
  const target = req.session?.proxyTarget;
  const ownPaths = ['/api/', '/proxy'];
  if (ownPaths.some(p => req.path.startsWith(p))) return next();
  const boromirStatic = ['script.js', 'style.css', 'index.html'];
  if (boromirStatic.some(f => req.path === '/' + f || req.path === '/')) return next();

  if (target) {
    console.log(`[Proxy Fallback] request: ${req.method} ${req.url} -> Target: ${target}`);
    return buildProxy(target)(req, res, next);
  }

  console.log(`[SPA Fallback Skip] request: ${req.method} ${req.url} (No target in session)`);
  next();
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

const authGuard = (req: Request, res: Response, next: NextFunction) => {
  if (getAuthToken(req)) return next();
  return res.status(401).json({ success: false, message: 'Unauthorized' });
};

// ─── cURL parse endpoint ──────────────────────────────────────────────────────

app.post('/api/parse-curl', (req: Request, res: Response) => {
  const { curl } = req.body;
  if (!curl) return res.status(400).json({ success: false, message: 'Missing curl command' });
  try {
    const parsed = parseCurl(curl);
    return res.json({ success: true, parsed });
  } catch (e) {
    return res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── OpenAPI spec fetch (proxy-aware) ────────────────────────────────────────

app.post('/api/openapi/fetch', async (req: Request, res: Response) => {
  const { url } = req.body as { url: string };
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing url' });
  }

  let targetUrl = url;
  if (url.startsWith('/')) {
    const proxyTarget = req.session?.proxyTarget;
    if (!proxyTarget) {
      return res.status(400).json({ success: false, message: 'No proxy target set — login first or use an absolute URL' });
    }
    targetUrl = proxyTarget.replace(/\/$/, '') + url;
  }

  try {
    const token = getAuthToken(req);
    const headers: Record<string, string> = {
      Accept: 'application/json, application/yaml, text/yaml, text/plain, */*',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const resp = await axios.get(targetUrl, {
      timeout: 10000,
      validateStatus: () => true,
      headers,
    });

    if (resp.status >= 400) {
      return res.status(resp.status).json({ success: false, message: `Remote returned ${resp.status}` });
    }

    const content = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    return res.json({ success: true, content });
  } catch (e) {
    return res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── Playbooks CRUD (filesystem-based) ───────────────────────────────────────

const playbooksDir = path.resolve(process.env.PLAYBOOKS_DIR || path.join(process.cwd(), 'playbooks'));
if (!fs.existsSync(playbooksDir)) fs.mkdirSync(playbooksDir, { recursive: true });

app.get('/api/playbooks', (_req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(playbooksDir)
      .filter(f => f.endsWith('.req') || f.endsWith('.brl'));
    const playbooks = files.map(f => {
      const stat = fs.statSync(path.join(playbooksDir, f));
      return { name: f, size: stat.size, updatedAt: stat.mtime };
    });
    return res.json({ success: true, playbooks });
  } catch (e) {
    return res.status(500).json({ success: false, message: (e as Error).message });
  }
});

app.get('/api/playbooks/:name', (req: Request, res: Response) => {
  const file = path.join(playbooksDir, path.basename(String(req.params.name)));
  if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: 'Not found' });
  const content = fs.readFileSync(file, 'utf8');
  return res.json({ success: true, content });
});

app.put('/api/playbooks/:name', (req: Request, res: Response) => {
  const { content } = req.body;
  if (content == null) return res.status(400).json({ success: false, message: 'Missing content' });
  const file = path.join(playbooksDir, path.basename(String(req.params.name)));
  fs.writeFileSync(file, content, 'utf8');
  return res.json({ success: true });
});

app.delete('/api/playbooks/:name', (req: Request, res: Response) => {
  const file = path.join(playbooksDir, path.basename(String(req.params.name)));
  if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: 'Not found' });
  fs.unlinkSync(file);
  return res.json({ success: true });
});

// ─── Run playbook endpoint ────────────────────────────────────────────────────

app.post('/api/run-playbook', authGuard, async (req: Request, res: Response) => {
  const { playbook, baseUrl, keepGoing } = req.body as {
    playbook: string;
    baseUrl?: string;
    keepGoing?: boolean;
  };

  if (!playbook) return res.status(400).json({ success: false, message: 'Missing playbook content' });

  const base = baseUrl || process.env.BASE_URL || '';
  if (!base) return res.status(400).json({ success: false, message: 'Missing base URL' });

  const token = getAuthToken(req);
  const g: GlobalOptions = {
    base,
    loginPath: '/api/auth/login',
    tokenField: 'token',
  };

  const client = buildClient(g);
  if (token) applyToken(client, token);

  // Forward incoming cookies (except Boromir ones) to target API to support cookie-based session/auth
  const incomingCookie = req.headers['cookie'];
  if (incomingCookie) {
    const filteredCookies = incomingCookie.split(';')
      .map(c => c.trim())
      .filter(c => !c.startsWith('boromir_sid=') && !c.startsWith('authToken='))
      .join('; ');
    if (filteredCookies) {
      client.defaults.headers.common['Cookie'] = filteredCookies;
    }
  }

  let steps;
  try {
    steps = parseReqFile(playbook);
  } catch (e: any) {
    return res.status(400).json({ success: false, message: 'Failed to parse playbook', error: e.message });
  }

  const responses: unknown[] = [];
  const results: any[] = [];
  let total = 0, failed = 0;
  const startedAt = new Date().toISOString();
  const runStart = performance.now();

  for (let i = 0; i < steps.length; i++) {
    const { method, rawPath, body: rawBody } = steps[i];
    total++;
    const rec: any = {
      index: i, method, rawPath,
      url: null, reqBody: null, status: null, respBody: null,
      durationMs: null, error: null, ok: false,
    };

    let pathR: string, bodyR: string | null;
    try {
      pathR = resolve(rawPath, responses);
      bodyR = rawBody ? resolve(rawBody, responses) : null;
    } catch (e: any) {
      rec.error = `RESOLVE ERROR: ${e.message}`;
      failed++;
      responses.push(null);
      results.push(rec);
      if (!keepGoing) break;
      continue;
    }

    rec.url = `${base.replace(/\/$/, '')}/${pathR.replace(/^\//, '')}`;
    const reqCfg: Record<string, any> = { method, url: rec.url };

    if (bodyR) {
      try { reqCfg.data = JSON.parse(bodyR); rec.reqBody = reqCfg.data; }
      catch (e: any) {
        rec.error = `BODY JSON ERROR: ${e.message}`;
        failed++;
        responses.push(null);
        results.push(rec);
        if (!keepGoing) break;
        continue;
      }
    }

    const t0 = performance.now();
    try {
      const r = await client.request(reqCfg);
      rec.durationMs = Math.round((performance.now() - t0) * 10) / 10;
      rec.status = r.status;
      rec.ok = r.status >= 200 && r.status < 300;
      rec.respBody = r.data;
      responses.push(rec.respBody);
    } catch (e: any) {
      rec.error = `CONNECTION ERROR: ${e.message}`;
      rec.durationMs = Math.round((performance.now() - t0) * 10) / 10;
      failed++;
      responses.push(null);
    }

    results.push(rec);
    if (!rec.ok && !rec.error && !keepGoing) { if (!rec.ok) { failed++; break; } }
  }

  const totalMs = performance.now() - runStart;
  return res.json({ success: failed === 0, startedAt, totalMs, total, failed, results });
});

// ─── OpenAPI spec persistence ─────────────────────────────────────────────────

const specPath = path.join(process.cwd(), 'openapi-spec.json');

app.get('/api/openapi/spec', (_req: Request, res: Response) => {
  if (!fs.existsSync(specPath)) return res.json({ success: false, spec: null });
  try {
    const content = fs.readFileSync(specPath, 'utf8');
    return res.json({ success: true, spec: content });
  } catch (e) {
    return res.status(500).json({ success: false, message: (e as Error).message });
  }
});

app.post('/api/openapi/spec', (req: Request, res: Response) => {
  const { spec } = req.body as { spec: string };
  if (!spec) return res.status(400).json({ success: false, message: 'Missing spec' });
  try {
    fs.writeFileSync(specPath, spec, 'utf8');
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

const reportsDir = path.resolve(process.env.REPORTS_DIR || path.join(process.cwd(), 'reports'));
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

app.get('/api/reports', (_req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('.html'));
    const reports = files.map(f => {
      const stat = fs.statSync(path.join(reportsDir, f));
      return { name: f, size: stat.size, createdAt: stat.mtime };
    }).sort((a, b) => +b.createdAt - +a.createdAt);
    return res.json({ success: true, reports });
  } catch (e) {
    return res.status(500).json({ success: false, message: (e as Error).message });
  }
});

app.get('/api/reports/:name', (req: Request, res: Response) => {
  const file = path.join(reportsDir, path.basename(String(req.params.name)));
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/html');
  res.sendFile(file);
});

app.post('/api/reports/save', (req: Request, res: Response) => {
  const { results, startedAt, totalMs, playbookName } = req.body as {
    results: StepRecord[];
    startedAt: string;
    totalMs: number;
    playbookName?: string;
  };
  if (!results) return res.status(400).json({ success: false, message: 'Missing results' });
  try {
    const steps = results.map((r, i) => ({ ...r, index: i, file: playbookName || 'web' }));
    const ts = new Date(startedAt || Date.now()).toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const name = `${playbookName ? playbookName.replace(/\.[^.]+$/, '') + '-' : 'run-'}${ts}.html`;
    const outFile = path.join(reportsDir, name);
    writeHtmlReport(outFile, steps as StepRecord[], totalMs / 1000, new Date(startedAt || Date.now()), [playbookName || 'web']);
    return res.json({ success: true, name });
  } catch (e) {
    return res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(String(process.env.PORT || '8888'), 10);
app.listen(PORT, () => {
  console.log(`Boromir Web UI → http://localhost:${PORT}`);
  console.log(`Playbooks dir  → ${playbooksDir}`);
  console.log(`Reports dir    → ${reportsDir}`);
});
