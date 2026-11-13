import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { findClaudeBinary, NO_TOOLS_CLAUDE_ARGS, CLAUDE_MODEL, CLAUDE_TIMEOUT_MS, markLoggedIn, markLoggedOut } from './assistant.js';

// One run of the local Claude Code binary with NO tools: everything the model
// needs is in the prompt, so it can't read files, run commands or reach the
// network (NO_TOOLS_CLAUDE_ARGS; see the hard constraints in CLAUDE.md). The
// prompt goes over stdin so it can never be parsed as a flag. The run is killed
// on timeout or when `signal` aborts (e.g. the HTTP client went away), and its
// private temp cwd is always removed.

export type ClaudeRunResult =
  | { ok: true; text: string }
  | { ok: false; error: 'no-binary' | 'not-logged-in' | 'timeout' | 'aborted' | 'failed' };

export type ClaudeRunner = (prompt: string, system: string, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<ClaudeRunResult>;

const LOGIN_HINT = /log ?in|login|authenticat|unauthori[sz]ed|api key|setup-token/i;

export const runClaudeNoTools: ClaudeRunner = async (prompt, system, opts = {}) => {
  const bin = findClaudeBinary();
  if (!bin) return { ok: false, error: 'no-binary' };
  if (opts.signal?.aborted) return { ok: false, error: 'aborted' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'persfin-ai-'));
  return await new Promise<ClaudeRunResult>(resolve => {
    let done = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (r: ClaudeRunResult) => {
      if (done) return; done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      try { child?.kill(); } catch { /* already gone */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve(r);
    };
    const onAbort = () => finish({ ok: false, error: 'aborted' });
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), opts.timeoutMs ?? CLAUDE_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', onAbort);
    try {
      child = spawn(bin, [
        '-p',
        '--model', CLAUDE_MODEL,
        '--system-prompt', system,
        ...NO_TOOLS_CLAUDE_ARGS,
        '--output-format', 'json',
      // stderr is ignored rather than left as an unread pipe that could fill and
      // block the child until the timeout.
      ], { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdin!.on('error', () => { /* child exited before reading the prompt */ });
      child.stdin!.end(prompt);
    } catch (e) {
      console.error('[claude] spawn failed:', e);
      return finish({ ok: false, error: 'failed' });
    }
    let out = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', () => finish({ ok: false, error: 'failed' }));
    child.on('close', () => {
      try {
        const obj = JSON.parse(out.trim()) as { is_error?: boolean; result?: unknown };
        if (obj.is_error || typeof obj.result !== 'string') {
          if (typeof obj.result === 'string' && LOGIN_HINT.test(obj.result)) { markLoggedOut(); return finish({ ok: false, error: 'not-logged-in' }); }
          return finish({ ok: false, error: 'failed' });
        }
        markLoggedIn();
        return finish({ ok: true, text: obj.result });
      } catch {
        return finish({ ok: false, error: LOGIN_HINT.test(out) ? 'not-logged-in' : 'failed' });
      }
    });
  });
};
