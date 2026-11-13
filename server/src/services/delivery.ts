import nodemailer from 'nodemailer';
import { isIP } from 'net';
import { getDb } from '../db/schema.js';
import { getMeta, setMeta } from './meta.js';
import { setEnvVars, assertSafeEnvText, KeyError, EMAIL_RE } from './keys.js';
import { generateWeeklyReport, getStoredWeeklyReport, type WeeklyModel } from './weeklyReport.js';
import { dueWeek, weekFromKey } from '../util/weekWindow.js';
import {
  weeklySubject, weekLabel, renderWeeklyText, renderWeeklyTotalsText, renderWeeklyNoticeText,
  renderWeeklyBriefHtml, PRIVACY_LEVELS, type PrivacyLevel,
} from '../util/weeklyRender.js';

// Delivery of the weekly report (docs/REBUILD-PLAN.md, Phase 7) by email (the
// owner's own SMTP account) and push (the owner's own ntfy server). These are
// the only two places the app sends report data off this computer; both are off
// until the owner turns them on, and each has a privacy level (see
// util/weeklyRender.ts): full, totals, or notice.
//
// Settings: connection details and secrets live in the keys file (like the
// Plaid keys); the privacy level of each channel lives in `meta`
// (delivery_<channel>_level, 'off' when unset).
//
// Each week is sent at most once per channel: weekly_reports.email_sent_at /
// push_sent_at record it. A failed channel stays unsent and is retried by the
// next run (the daily sync and every server start run a catch-up).

export type Channel = 'email' | 'push';
export const CHANNELS: Channel[] = ['email', 'push'];
export type Level = PrivacyLevel | 'off';

export function getLevel(ch: Channel): Level {
  const v = getMeta(`delivery_${ch}_level`);
  return PRIVACY_LEVELS.includes(v as PrivacyLevel) ? (v as PrivacyLevel) : 'off';
}
export function setLevel(ch: Channel, level: Level): void {
  if (level !== 'off' && !PRIVACY_LEVELS.includes(level)) throw new KeyError('Unknown privacy level.');
  setMeta(`delivery_${ch}_level`, level);
}

// --- connection settings (keys file) ----------------------------------------------

export interface EmailConfig { host: string; port: number; user: string; pass: string; to: string[]; from: string }
export interface PushConfig { url: URL; token: string | null }

const env = (k: string) => process.env[k]?.trim() || '';
const splitList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

export function emailConfig(): EmailConfig | null {
  const host = env('SMTP_HOST'), user = env('SMTP_USER'), pass = process.env.SMTP_PASS ?? '';
  const to = splitList(env('REPORT_EMAIL_TO'));
  if (!host || !user || !pass || !to.length) return null;
  return { host, port: Number(env('SMTP_PORT')) || 587, user, pass, to, from: env('SMTP_FROM') || user };
}

export function pushConfig(): PushConfig | null {
  const raw = env('NTFY_URL');
  if (!raw) return null;
  try { return { url: checkPushUrl(raw), token: env('NTFY_TOKEN') || null }; } catch { return null; }
}

// Hosts that plain http may reach: this computer and the Tailscale network
// (Tailscale encrypts the traffic itself). Anything else must use https.
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.ts.net')) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || (a === 100 && b >= 64 && b <= 127); // loopback, Tailscale 100.64.0.0/10
  }
  if (isIP(h) === 6) return h === '::1' || /^fd7a:115c:a1e0:/.test(h); // Tailscale ULA range
  return false;
}

// The ntfy topic URL, e.g. https://mac-mini.tailnet.ts.net/persfin. One path
// segment at the end is the topic; no credentials, query or fragment.
export function checkPushUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new KeyError('Enter the full topic URL, e.g. https://ntfy.example.ts.net/persfin.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new KeyError('The URL must start with https://.');
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) throw new KeyError('Use https:// for a server outside this computer and your Tailscale network.');
  if (u.username || u.password || u.search || u.hash) throw new KeyError('Put the access token in its own field, not in the URL.');
  const topic = u.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new KeyError('The URL must end with a topic name (letters, digits, - or _).');
  return u;
}

export function getDeliveryStatus() {
  const e = emailConfig(), p = pushConfig();
  return {
    email: {
      configured: !!e, level: getLevel('email'),
      host: env('SMTP_HOST') || null, port: Number(env('SMTP_PORT')) || 587, user: env('SMTP_USER') || null,
      to: env('REPORT_EMAIL_TO') || null, from: env('SMTP_FROM') || null, passSet: !!process.env.SMTP_PASS,
    },
    push: { configured: !!p, level: getLevel('push'), url: env('NTFY_URL') || null, tokenSet: !!env('NTFY_TOKEN') },
    publicUrl: env('PERSFIN_PUBLIC_URL') || null,
  };
}

// Save the SMTP settings. An empty or missing password keeps the saved one.
export function saveEmailConfig(input: { host?: string; port?: number | string; user?: string; pass?: string; to?: string; from?: string }): void {
  const host = (input.host ?? '').trim(), user = (input.user ?? '').trim(), to = (input.to ?? '').trim(), from = (input.from ?? '').trim();
  const port = Number(input.port ?? 587);
  for (const [label, v] of [['Server', host], ['User name', user], ['To', to], ['From', from], ['Password', input.pass ?? '']]) assertSafeEnvText(label, v);
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new KeyError('Enter the SMTP server name, e.g. smtp.gmail.com.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new KeyError('Enter a port number (465 or 587).');
  if (!user || /\s/.test(user)) throw new KeyError('Enter the SMTP user name (usually your email address).');
  const toList = splitList(to);
  if (!toList.length || toList.length > 5 || !toList.every(a => EMAIL_RE.test(a))) throw new KeyError('Enter one to five recipient addresses, separated by commas.');
  if (from && !EMAIL_RE.test(from)) throw new KeyError('Enter a valid From address, or leave it empty.');
  if (!input.pass && !process.env.SMTP_PASS) throw new KeyError('Enter the password (an app password for Gmail or iCloud).');
  setEnvVars({
    SMTP_HOST: host, SMTP_PORT: String(port), SMTP_USER: user, REPORT_EMAIL_TO: toList.join(','), SMTP_FROM: from,
    ...(input.pass ? { SMTP_PASS: input.pass } : {}),
  });
}

export function clearEmailConfig(): void {
  setEnvVars({ SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', REPORT_EMAIL_TO: '', SMTP_FROM: '' });
  setLevel('email', 'off');
}

// Save the ntfy topic URL. A missing token keeps the saved one; clearToken removes it.
export function savePushConfig(input: { url?: string; token?: string; clearToken?: boolean }): void {
  const url = checkPushUrl(input.url ?? '').toString();
  const token = (input.token ?? '').trim();
  assertSafeEnvText('Access token', token);
  setEnvVars({ NTFY_URL: url, ...(token ? { NTFY_TOKEN: token } : input.clearToken ? { NTFY_TOKEN: '' } : {}) });
}

export function clearPushConfig(): void {
  setEnvVars({ NTFY_URL: '', NTFY_TOKEN: '' });
  setLevel('push', 'off');
}

// The address links in the report point at, e.g. http://mac-mini.tailnet.ts.net:3001
// so they open from the phone. Empty clears it (links then use localhost).
export function savePublicUrl(raw: string): void {
  const s = raw.trim().replace(/\/+$/, '');
  assertSafeEnvText('App address', s);
  if (s) {
    let u: URL;
    try { u = new URL(s); } catch { throw new KeyError('Enter the full address, e.g. http://mac-mini.tailnet.ts.net:3001.'); }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
      throw new KeyError('Enter only the address and port, e.g. http://mac-mini.tailnet.ts.net:3001.');
    }
  }
  setEnvVars({ PERSFIN_PUBLIC_URL: s });
}

export const appUrl = () => env('PERSFIN_PUBLIC_URL').replace(/\/+$/, '') || `http://localhost:${process.env.PORT ?? 3001}`;

// --- senders -----------------------------------------------------------------------

export interface OutMessage { subject: string; text: string; html?: string; click?: string }
export type EmailSender = (cfg: EmailConfig, msg: OutMessage) => Promise<void>;
export type PushSender = (cfg: PushConfig, msg: OutMessage) => Promise<void>;

// TLS always: implicit TLS on port 465, otherwise STARTTLS is required (the
// send fails rather than fall back to plain text).
export const smtpSend: EmailSender = async (cfg, msg) => {
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465, requireTLS: cfg.port !== 465,
    auth: { user: cfg.user, pass: cfg.pass }, tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    await transport.sendMail({ from: `PersFin <${cfg.from}>`, to: cfg.to, subject: msg.subject, text: msg.text, html: msg.html });
  } finally {
    transport.close();
  }
};

// ntfy JSON publishing (POST {topic, title, message, click} to the server root):
// JSON keeps non-ASCII text (–, −, emoji) intact, which HTTP headers cannot.
export const ntfySend: PushSender = async (cfg, msg) => {
  const parts = cfg.url.pathname.split('/').filter(Boolean);
  const topic = parts.pop()!;
  const base = `${cfg.url.origin}/${parts.map(encodeURIComponent).join('/')}`;
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify({ topic, title: msg.subject, message: msg.text, tags: ['moneybag'], ...(msg.click ? { click: msg.click } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`ntfy answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
};

// --- messages per channel and level -------------------------------------------------

export function reportUrl(key: string, base = appUrl()): string {
  return `${base}/api/report/weekly/${key}`;
}

export function buildMessage(ch: Channel, level: PrivacyLevel, m: WeeklyModel, stored: { html: string; text: string }, base = appUrl()): OutMessage {
  const link = reportUrl(m.week.key, base);
  if (ch === 'push') {
    return {
      subject: level === 'notice' ? 'PersFin weekly report' : `PersFin · Week of ${weekLabel(m)}`,
      text: level === 'full' ? renderWeeklyText(m) : level === 'totals' ? renderWeeklyTotalsText(m) : renderWeeklyNoticeText(m),
      click: link,
    };
  }
  const subject = weeklySubject(m, level);
  if (level === 'full') return { subject, html: stored.html, text: `${stored.text}\n\nFull report: ${link}` };
  const text = level === 'totals' ? renderWeeklyTotalsText(m) : renderWeeklyNoticeText(m);
  return { subject, html: renderWeeklyBriefHtml(m, level, { reportUrl: link }), text: `${text}\n\nFull report: ${link}` };
}

// --- run ---------------------------------------------------------------------------

export interface ChannelResult { channel: Channel; status: 'sent' | 'already-sent' | 'off' | 'not-configured' | 'error'; error?: string }
export interface DeliveryRun { week: string; built: boolean; results: ChannelResult[] }
export interface DeliveryOpts {
  now?: Date;
  week?: string;     // a Monday; default: the week now due (util/weekWindow.ts dueWeek)
  build?: boolean;   // build the report even when there is nothing to send
  force?: boolean;   // send again on channels that already sent this week
  senders?: { email?: EmailSender; push?: PushSender };
  generate?: (opts: { week: string; now: Date }) => Promise<unknown>;
}

// Runs one at a time, so a scheduled run and a startup catch-up that overlap
// can't both send the same week.
let queue: Promise<unknown> = Promise.resolve();
export function runWeeklyDelivery(opts: DeliveryOpts = {}): Promise<DeliveryRun> {
  const run = queue.then(() => deliverOnce(opts));
  queue = run.catch(() => undefined);
  return run;
}

async function deliverOnce(opts: DeliveryOpts): Promise<DeliveryRun> {
  const now = opts.now ?? new Date();
  const w = opts.week ? weekFromKey(opts.week) : dueWeek(now);
  if (!w) throw new KeyError('week must be a Monday (YYYY-MM-DD)');
  const db = getDb();
  const sentAt = () => db.prepare('SELECT email_sent_at AS email, push_sent_at AS push FROM weekly_reports WHERE week_key = ?')
    .get(w.key) as Record<Channel, string | null> | undefined;
  const before = sentAt();

  const results: ChannelResult[] = [];
  const pending: { ch: Channel; level: PrivacyLevel }[] = [];
  for (const ch of CHANNELS) {
    const level = getLevel(ch);
    if (level === 'off') results.push({ channel: ch, status: 'off' });
    else if (!(ch === 'email' ? emailConfig() : pushConfig())) results.push({ channel: ch, status: 'not-configured' });
    else if (before?.[ch] && !opts.force) results.push({ channel: ch, status: 'already-sent' });
    else pending.push({ ch, level });
  }

  // Build with the latest data before the week's first send. Once one channel
  // has sent, later sends reuse the stored report so both carry the same figures.
  const anySent = !!(before?.email || before?.push);
  const build = before ? pending.length > 0 && !anySent : pending.length > 0 || !!opts.build;
  if (build) await (opts.generate ?? generateWeeklyReport)({ week: w.key, now });
  if (!pending.length) return { week: w.key, built: build, results };

  const stored = getStoredWeeklyReport(w.key);
  if (!stored) throw new Error(`no stored report for the week of ${w.key}`);
  const email = opts.senders?.email ?? smtpSend, push = opts.senders?.push ?? ntfySend;
  const base = appUrl();
  const sent = await Promise.all(pending.map(async ({ ch, level }): Promise<ChannelResult> => {
    try {
      const msg = buildMessage(ch, level, stored.model, stored, base);
      if (ch === 'email') await email(emailConfig()!, msg);
      else await push(pushConfig()!, msg);
      db.prepare(`UPDATE weekly_reports SET ${ch === 'email' ? 'email_sent_at' : 'push_sent_at'} = ? WHERE week_key = ?`)
        .run(new Date().toISOString(), w.key);
      return { channel: ch, status: 'sent' };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[delivery] ${ch} for the week of ${w.key} failed:`, error);
      return { channel: ch, status: 'error', error };
    }
  }));
  const order = (r: ChannelResult) => CHANNELS.indexOf(r.channel);
  return { week: w.key, built: build, results: [...results, ...sent].sort((a, b) => order(a) - order(b)) };
}

// A short test message on one channel, with the saved settings.
export async function sendTest(ch: Channel, senders: DeliveryOpts['senders'] = {}): Promise<void> {
  const msg: OutMessage = {
    subject: ch === 'email' ? 'PersFin test email' : 'PersFin test',
    text: 'This is a test from PersFin. Your weekly report will arrive the same way.',
  };
  if (ch === 'email') {
    const cfg = emailConfig();
    if (!cfg) throw new KeyError('Save the email settings first.');
    await (senders.email ?? smtpSend)(cfg, msg);
  } else {
    const cfg = pushConfig();
    if (!cfg) throw new KeyError('Save the push settings first.');
    await (senders.push ?? ntfySend)(cfg, msg);
  }
}
