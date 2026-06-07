import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AxiosInstance } from 'axios';

export const STATE_FILE = path.join(os.homedir(), '.boromir_session.json');

export function loadToken(client: AxiosInstance): boolean {
  if (!fs.existsSync(STATE_FILE)) return false;
  const { token } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { token: string };
  client.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  return true;
}

export function saveToken(token: string): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ token }), { mode: 0o600 });
}

export function requireAuth(client: AxiosInstance): void {
  if (!loadToken(client)) {
    process.stderr.write('Not authenticated — run `boromir login` first\n');
    process.exit(1);
  }
}
