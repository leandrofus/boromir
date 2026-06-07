export interface GlobalOptions {
  base: string;
  cert?: string;
  key?: string;
  cacert?: string;
  insecure?: boolean;
  loginPath: string;
  tokenField: string;
}

export interface BrlStep {
  method: string;
  rawPath: string;
  body: string | null;
}

export interface StepRecord {
  index: number;
  file: string;
  method: string;
  rawPath: string;
  url: string | null;
  reqBody: unknown;
  status: number | null;
  respBody: unknown;
  durationMs: number | null;
  error: string | null;
  ok: boolean;
}

export interface RunRecord {
  startedAt: string;
  totalS: number;
  files: string[];
  total: number;
  passed: number;
  failed: number;
  steps: StepRecord[];
}
