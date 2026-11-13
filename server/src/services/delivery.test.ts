import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { createServer, type IncomingMessage } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import type { WeeklyModel } from './weeklyReport.js';

// DB_PATH and the keys file must point at a temp dir before the modules load,
// so they are imported dynamically after these are set.
const TMP = mkdtempSync(path.join(tmpdir(), 'persfin-delivery-'));
process.env.DB_PATH = path.join(TMP, 'delivery.db');
process.env.PERSFIN_ENV_PATH = path.join(TMP, 'keys.env');
const d = await import('./delivery.js');
const weekly = await import('./weeklyReport.js');
const { getDb } = await import('../db/schema.js');
const { dueWeek, weekContaining } = await import('../util/weekWindow.js');
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const EMAIL = { host: 'smtp.example.com', port: 587, user: 'me@example.com', pass: 'app-pass', to: 'me@example.com' };
const generate = ({ week, now }: { week: string; now: Date }) => weekly.generateWeeklyReport({ week, now, ai: false });
const senders = () => ({ email: vi.fn(async () => {}), push: vi.fn(async () => {}) });

beforeEach(() => {
  getDb().prepare('DELETE FROM weekly_reports').run();
  d.clearEmailConfig();
  d.clearPushConfig();
  delete process.env.PERSFIN_PUBLIC_URL;
});

function enableBoth(level: 'full' | 'totals' | 'notice' = 'full') {
  d.saveEmailConfig(EMAIL);
  d.savePushConfig({ url: 'https://ntfy.example.ts.net/persfin', token: 'tk_secret' });
  d.setLevel('email', level);
  d.setLevel('push', level);
}

// A fixed model with category names that must not leak at lower levels.
const model = (): WeeklyModel => ({
  week: weekContaining('2026-11-09'), generatedAt: '2026-11-15T19:00:00.000Z',
  total: 612, priorWeek: 700, avg8: 650, income: 0,
  categories: [
    { category: 'Restaurants & Bars', emoji: '🍽', week: 300, avg: 120, regular: true, mtd: 420, target: 300, projected: 500, status: 'over' },
    { category: 'Groceries', emoji: '🛒', week: 200, avg: 180, regular: true, mtd: 380, target: 500, projected: 560, status: 'at-risk' },
  ],
  up: [], down: [],
  recurring: [{ payee: 'Netflix', category: 'Subscriptions', amount: 17.99, date: '2026-11-10', previous: 15.49, kind: 'price-change' }],
  review: { week: 3, total: 5 }, summary: null,
});
const stored = { html: '<html>Restaurants & Bars Netflix</html>', text: 'full text' };

describe('messages per privacy level', () => {
  it('full sends the whole report', () => {
    const e = d.buildMessage('email', 'full', model(), stored, 'http://mini.ts.net:3001');
    expect(e.html).toBe(stored.html);
    expect(e.subject).toContain('$612');
    expect(e.text).toContain('http://mini.ts.net:3001/api/report/weekly/2026-11-09');
    const p = d.buildMessage('push', 'full', model(), stored, 'http://mini.ts.net:3001');
    expect(p.text).toContain('Restaurants & Bars');
    expect(p.click).toBe('http://mini.ts.net:3001/api/report/weekly/2026-11-09');
  });

  it('totals keeps the amounts but no category, merchant or payee names', () => {
    for (const ch of ['email', 'push'] as const) {
      const m = d.buildMessage(ch, 'totals', model(), stored);
      const all = `${m.subject}\n${m.text}\n${m.html ?? ''}`;
      expect(all).toContain('$612');
      expect(all).toContain('1 category over budget, 1 at risk.');
      expect(all).toContain('3 transactions to review.');
      for (const name of ['Restaurants', 'Groceries', 'Netflix', 'Subscriptions']) expect(all).not.toContain(name);
    }
  });

  it('notice carries no amounts at all', () => {
    for (const ch of ['email', 'push'] as const) {
      const m = d.buildMessage(ch, 'notice', model(), stored);
      const all = `${m.subject}\n${m.text}\n${m.html ?? ''}`;
      expect(all).not.toMatch(/\$\d/);
      expect(all).toContain('is ready');
      for (const name of ['Restaurants', 'Groceries', 'Netflix']) expect(all).not.toContain(name);
    }
  });
});

describe('runWeeklyDelivery', () => {
  const tuesday = new Date(2026, 10, 17, 8, 0); // Tue Nov 17 → due week Nov 9–15

  it('does nothing while both channels are off', async () => {
    const s = senders();
    const run = await d.runWeeklyDelivery({ now: tuesday, senders: s, generate });
    expect(run).toMatchObject({ week: '2026-11-09', built: false });
    expect(run.results.map(r => r.status)).toEqual(['off', 'off']);
    expect(weekly.listWeeklyReports()).toHaveLength(0);
  });

  it('a level without saved settings reports not-configured', async () => {
    d.setLevel('email', 'full');
    const run = await d.runWeeklyDelivery({ now: tuesday, senders: senders(), generate });
    expect(run.results[0]).toEqual({ channel: 'email', status: 'not-configured' });
  });

  it('catches up a missed week: builds and sends the last finished week once', async () => {
    enableBoth();
    const s = senders();
    const first = await d.runWeeklyDelivery({ now: tuesday, senders: s, generate });
    expect(first).toMatchObject({ week: '2026-11-09', built: true });
    expect(first.results.map(r => r.status)).toEqual(['sent', 'sent']);
    const [row] = weekly.listWeeklyReports();
    expect(row.key).toBe('2026-11-09');
    expect(row.emailSentAt).toBeTruthy();
    expect(row.pushSentAt).toBeTruthy();

    // Idempotent: a second run (another trigger, a restart) sends nothing.
    const again = await d.runWeeklyDelivery({ now: tuesday, senders: s, generate });
    expect(again.built).toBe(false);
    expect(again.results.map(r => r.status)).toEqual(['already-sent', 'already-sent']);
    expect(s.email).toHaveBeenCalledTimes(1);
    expect(s.push).toHaveBeenCalledTimes(1);

    // force sends again, from the stored report (no rebuild).
    const forced = await d.runWeeklyDelivery({ now: tuesday, senders: s, generate, force: true });
    expect(forced.built).toBe(false);
    expect(s.email).toHaveBeenCalledTimes(2);
  });

  it('overlapping runs send once', async () => {
    enableBoth();
    const s = senders();
    await Promise.all([1, 2, 3].map(() => d.runWeeklyDelivery({ now: tuesday, senders: s, generate })));
    expect(s.email).toHaveBeenCalledTimes(1);
    expect(s.push).toHaveBeenCalledTimes(1);
  });

  it('a failed channel stays unsent and is retried; the sent one is not repeated', async () => {
    enableBoth('totals');
    const s = senders();
    s.email.mockRejectedValueOnce(new Error('535 auth failed'));
    const first = await d.runWeeklyDelivery({ now: tuesday, senders: s, generate });
    expect(first.results).toEqual([
      { channel: 'email', status: 'error', error: '535 auth failed' },
      { channel: 'push', status: 'sent' },
    ]);
    const retry = await d.runWeeklyDelivery({ now: tuesday, senders: s, generate });
    expect(retry.built).toBe(false); // push already sent: keep the same figures
    expect(retry.results.map(r => r.status)).toEqual(['sent', 'already-sent']);
    expect(s.push).toHaveBeenCalledTimes(1);
  });

  it('build: true stores the report even with every channel off', async () => {
    const run = await d.runWeeklyDelivery({ now: tuesday, build: true, senders: senders(), generate });
    expect(run.built).toBe(true);
    expect(weekly.listWeeklyReports()[0]).toMatchObject({ key: '2026-11-09', emailSentAt: null, pushSentAt: null });
  });

  it('uses the app address for links', async () => {
    enableBoth('notice');
    process.env.PERSFIN_PUBLIC_URL = 'http://mac-mini.tail1.ts.net:3001';
    const s = senders();
    await d.runWeeklyDelivery({ now: tuesday, senders: s, generate });
    const pushMsg = s.push.mock.calls[0][1] as { click: string };
    expect(pushMsg.click).toBe('http://mac-mini.tail1.ts.net:3001/api/report/weekly/2026-11-09');
  });
});

describe('dueWeek', () => {
  it('is the last finished week until Sunday evening, then the current week', () => {
    expect(dueWeek(new Date(2026, 10, 15, 18, 59)).key).toBe('2026-11-02'); // Sun before 19:00
    expect(dueWeek(new Date(2026, 10, 15, 19, 0)).key).toBe('2026-11-09');  // Sun 19:00
    expect(dueWeek(new Date(2026, 10, 16, 0, 5)).key).toBe('2026-11-09');   // Mon
    expect(dueWeek(new Date(2027, 0, 1, 12, 0)).key).toBe('2026-12-21');    // Fri, across the year end
  });
});

describe('settings', () => {
  it('saves email settings to the keys file and never returns the password', () => {
    d.saveEmailConfig({ ...EMAIL, to: 'a@example.com, b@example.com' });
    const s = d.getDeliveryStatus();
    expect(s.email).toMatchObject({ configured: true, host: 'smtp.example.com', to: 'a@example.com,b@example.com', passSet: true });
    expect(JSON.stringify(s)).not.toContain('app-pass');
    expect(readFileSync(process.env.PERSFIN_ENV_PATH!, 'utf8')).toContain('SMTP_PASS=app-pass');
    // An empty password keeps the saved one.
    d.saveEmailConfig({ ...EMAIL, pass: '' });
    expect(d.emailConfig()?.pass).toBe('app-pass');
  });

  it('rejects bad email settings', () => {
    expect(() => d.saveEmailConfig({ ...EMAIL, to: 'not-an-address' })).toThrow(/recipient/);
    expect(() => d.saveEmailConfig({ ...EMAIL, host: 'smtp.example.com\nCLAUDE_BIN=/x' })).toThrow(/line breaks/);
    expect(() => d.saveEmailConfig({ ...EMAIL, port: 0 })).toThrow(/port/);
  });

  it('allows plain http for ntfy only on this computer and the Tailscale network', () => {
    expect(d.checkPushUrl('https://ntfy.example.com/persfin').hostname).toBe('ntfy.example.com');
    expect(d.checkPushUrl('http://mac-mini.tail1.ts.net:2586/persfin').port).toBe('2586');
    expect(d.checkPushUrl('http://100.101.102.103/persfin').hostname).toBe('100.101.102.103');
    expect(d.checkPushUrl('http://127.0.0.1:2586/persfin').hostname).toBe('127.0.0.1');
    expect(() => d.checkPushUrl('http://ntfy.example.com/persfin')).toThrow(/https/);
    expect(() => d.checkPushUrl('http://192.168.1.5/persfin')).toThrow(/https/);
    expect(() => d.checkPushUrl('https://user:pw@ntfy.example.com/persfin')).toThrow(/token/);
    expect(() => d.checkPushUrl('https://ntfy.example.com/')).toThrow(/topic/);
  });

  it('checks the app address', () => {
    d.savePublicUrl('http://mac-mini.tail1.ts.net:3001/');
    expect(d.appUrl()).toBe('http://mac-mini.tail1.ts.net:3001');
    expect(() => d.savePublicUrl('http://x.ts.net:3001/budget')).toThrow(/only the address/);
    d.savePublicUrl('');
    expect(d.appUrl()).toBe(`http://localhost:${process.env.PORT ?? 3001}`);
  });
});

describe('ntfySend', () => {
  it('publishes JSON to the server root with the topic, the token and the click link', async () => {
    let seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const srv = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => { seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) }; res.end('{}'); });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      await d.ntfySend({ url: d.checkPushUrl(`http://127.0.0.1:${port}/persfin`), token: 'tk_1' },
        { subject: 'PersFin · Week of Nov 9 – 15, 2026', text: 'spent $612 (−12%)', click: 'http://x.ts.net:3001/api/report/weekly/2026-11-09' });
    } finally { srv.close(); }
    expect(seen.url).toBe('/');
    expect(seen.auth).toBe('Bearer tk_1');
    expect(seen.body).toMatchObject({ topic: 'persfin', title: 'PersFin · Week of Nov 9 – 15, 2026', message: 'spent $612 (−12%)', click: 'http://x.ts.net:3001/api/report/weekly/2026-11-09' });
  });

  it('reports an HTTP error from ntfy', async () => {
    const srv = createServer((_req, res) => { res.statusCode = 403; res.end('forbidden'); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      await expect(d.ntfySend({ url: d.checkPushUrl(`http://127.0.0.1:${port}/persfin`), token: null }, { subject: 's', text: 't' }))
        .rejects.toThrow('ntfy answered HTTP 403: forbidden');
    } finally { srv.close(); }
  });
});

describe('sendTest', () => {
  it('needs saved settings, then uses them', async () => {
    const s = senders();
    await expect(d.sendTest('email', s)).rejects.toThrow(/Save the email settings/);
    d.saveEmailConfig(EMAIL);
    await d.sendTest('email', s);
    expect(s.email.mock.calls[0][0]).toMatchObject({ host: 'smtp.example.com', port: 587, to: ['me@example.com'], from: 'me@example.com' });
  });
});
