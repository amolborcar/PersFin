import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// The real spawn path, against a fake `claude` binary (a Node script) that
// echoes back what it received. Proves the isolation promise in CLAUDE.md for
// runClaudeNoTools: no tools, user MCP servers ignored, prompt over stdin
// (never argv), killed on timeout and on abort.
const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-fakeclaude-'));
const fake = path.join(TMP, 'claude');
writeFileSync(fake, `#!/usr/bin/env node
let stdin = '';
process.stdin.on('data', c => { stdin += c; });
process.stdin.on('end', () => {
  if (stdin.includes('SLEEP')) { setTimeout(() => {}, 60000); return; }
  if (stdin.includes('LOGIN')) { process.stdout.write(JSON.stringify({ is_error: true, result: 'Invalid API key · Please run /login' })); return; }
  process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }) }));
});
`);
chmodSync(fake, 0o755);
process.env.CLAUDE_BIN = fake;
// The runner never opens the database, but its imports load the schema module:
// point DB_PATH at the temp dir so nothing can touch data/kevfin.db.
process.env.DB_PATH = path.join(TMP, 'unused.db');

let runClaudeNoTools: typeof import('./claudeRunner.js').runClaudeNoTools;
beforeAll(async () => { ({ runClaudeNoTools } = await import('./claudeRunner.js')); });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('runClaudeNoTools', () => {
  it('runs with no tools and sends the prompt over stdin only', async () => {
    const prompt = '--dangerous-looking prompt with merchant text';
    const r = await runClaudeNoTools(prompt, 'SYSTEM TEXT');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seen = JSON.parse(r.text) as { argv: string[]; stdin: string; cwd: string };
    expect(seen.stdin).toBe(prompt);
    expect(seen.argv).not.toContain(prompt);
    expect(seen.argv).toContain('-p');
    expect(after(seen.argv, '--tools')).toBe('');
    expect(seen.argv).toContain('--strict-mcp-config');
    expect(seen.argv).not.toContain('--allowedTools');
    expect(after(seen.argv, '--system-prompt')).toBe('SYSTEM TEXT');
    expect(seen.cwd).toMatch(/kevfin-ai-/); // a private temp dir
  });

  it('is killed on timeout', async () => {
    const t0 = Date.now();
    expect(await runClaudeNoTools('SLEEP', 's', { timeoutMs: 500 })).toEqual({ ok: false, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('is killed when the caller aborts', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    expect(await runClaudeNoTools('SLEEP', 's', { signal: ac.signal })).toEqual({ ok: false, error: 'aborted' });
  });

  it('reports a missing login', async () => {
    expect(await runClaudeNoTools('LOGIN', 's')).toEqual({ ok: false, error: 'not-logged-in' });
  });
});
