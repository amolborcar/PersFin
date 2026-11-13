import { useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { fmtDate } from '../lib/format.ts';

// Setup → Report delivery: where the weekly report is sent (server:
// services/delivery.ts). Email goes through the owner's own SMTP account, push
// through the owner's own ntfy server. Each channel is off until a privacy
// level is chosen. Passwords and tokens are write-only: the server says only
// whether one is saved.

type Level = 'off' | 'full' | 'totals' | 'notice';
export interface DeliveryStatus {
  email: { configured: boolean; level: Level; host: string | null; port: number; user: string | null; to: string | null; from: string | null; passSet: boolean };
  push: { configured: boolean; level: Level; url: string | null; tokenSet: boolean };
  publicUrl: string | null;
  dueWeek: string;
}
interface ChannelResult { channel: 'email' | 'push'; status: string; error?: string }

const LEVELS: { value: Level; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'full', label: 'Full report' },
  { value: 'totals', label: 'Totals only' },
  { value: 'notice', label: 'Notice only' },
];
const LEVEL_HELP: Record<Level, string> = {
  off: 'Nothing is sent.',
  full: 'The whole report: categories, amounts, recurring charges.',
  totals: 'The week’s total and comparisons, and how many categories are over budget. No category or merchant names.',
  notice: 'Only “your report is ready”, with a link. No amounts.',
};

const fieldStyle: React.CSSProperties = { fontSize: 13, padding: '6px 8px', width: '100%' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--muted)' };
const smallBtn: React.CSSProperties = { fontSize: 12, padding: '6px 12px' };
const sectionStyle: React.CSSProperties = { borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 };

async function call(method: string, url: string, body?: unknown): Promise<unknown> {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `HTTP ${r.status}`);
  return d;
}

export default function ReportDelivery() {
  const { data, refetch } = useApi<DeliveryStatus>('/api/delivery');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setMsg(null);
    try {
      const ok = await fn();
      if (ok) setMsg({ kind: 'ok', text: ok });
      refetch();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally { setBusy(null); }
  }

  if (!data) return <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>Loading…</p>;
  // key: remount the forms when the saved values change, so they show them.
  return (
    <div>
      <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>
        The report is sent on Sunday at 7 pm. If the Mac is off then, it is sent when the app runs next.
        These are the only ways report data leaves this computer.
      </p>
      <PublicUrlForm key={`u${data.publicUrl}`} status={data} busy={busy} run={run} />
      <EmailForm key={`e${data.email.host}${data.email.user}${data.email.to}${data.email.from}${data.email.port}`} status={data} busy={busy} run={run} />
      <PushForm key={`p${data.push.url}`} status={data} busy={busy} run={run} />
      <div style={{ ...sectionStyle, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn-ghost" style={smallBtn}
          disabled={!!busy || (data.email.level === 'off' && data.push.level === 'off')}
          onClick={() => run('send', async () => {
            if (!confirm(`Send the report for the week of ${fmtDate(data.dueWeek)} now, on each channel that is on?`)) return;
            const r = await call('POST', '/api/delivery/send', { force: true }) as { results: ChannelResult[] };
            const failed = r.results.filter(x => x.status === 'error');
            if (failed.length) throw new Error(failed.map(f => `${f.channel}: ${f.error}`).join(' · '));
            const sent = r.results.filter(x => x.status === 'sent').map(x => x.channel);
            return sent.length ? `Sent by ${sent.join(' and ')}.` : 'Nothing to send: turn on a channel first.';
          })}>
          {busy === 'send' ? 'Sending…' : `Send the week of ${fmtDate(data.dueWeek)} now`}
        </button>
      </div>
      {msg && <p role="status" style={{ fontSize: 12.5, margin: '8px 2px 0', color: msg.kind === 'error' ? 'var(--red)' : 'var(--green)' }}>{msg.text}</p>}
    </div>
  );
}

type FormProps = { status: DeliveryStatus; busy: string | null; run: (label: string, fn: () => Promise<string | void>) => void };

function PublicUrlForm({ status, busy, run }: FormProps) {
  const [url, setUrl] = useState(status.publicUrl ?? '');
  return (
    <form onSubmit={e => { e.preventDefault(); run('url', async () => { await call('PUT', '/api/delivery/public-url', { url }); return 'Address saved.'; }); }}>
      <label style={labelStyle}>
        App address for links (your Tailscale address)
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://mac-mini.tail1234.ts.net:3001"
            spellCheck={false} style={fieldStyle} disabled={!!busy} />
          <button type="submit" className="btn-ghost" style={smallBtn} disabled={!!busy || url === (status.publicUrl ?? '')}>Save</button>
        </div>
      </label>
      {!status.publicUrl && (status.email.level !== 'off' || status.push.level !== 'off') && (
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--amber, var(--muted))' }}>
          Without it, links in the report point at localhost and do not open on your phone.
        </p>
      )}
    </form>
  );
}

function LevelSelect({ channel, status, busy, run }: FormProps & { channel: 'email' | 'push' }) {
  const s = status[channel];
  return (
    <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      Send
      <select value={s.level} disabled={!!busy || !s.configured} style={{ fontSize: 13, padding: '4px 6px', width: 'auto' }}
        title={s.configured ? LEVEL_HELP[s.level] : 'Save the settings first.'}
        onChange={e => run('level', async () => { await call('PUT', '/api/delivery/levels', { [channel]: e.target.value }); })}>
        {LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
      </select>
      <span style={{ fontSize: 11.5 }}>{s.configured ? LEVEL_HELP[s.level] : 'Save the settings first.'}</span>
    </label>
  );
}

function EmailForm(props: FormProps) {
  const { status, busy, run } = props;
  const e0 = status.email;
  const [f, setF] = useState({ host: e0.host ?? '', port: String(e0.port || 587), user: e0.user ?? '', pass: '', to: e0.to ?? '', from: e0.from ?? '' });
  const set = (k: keyof typeof f) => (ev: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: ev.target.value });
  return (
    <form style={sectionStyle} onSubmit={ev => {
      ev.preventDefault();
      run('email', async () => { await call('PUT', '/api/delivery/email', { ...f, port: Number(f.port) }); setF({ ...f, pass: '' }); return 'Email settings saved.'; });
    }}>
      <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>Email</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <label style={labelStyle}>SMTP server<input value={f.host} onChange={set('host')} placeholder="smtp.gmail.com" spellCheck={false} style={fieldStyle} /></label>
        <label style={labelStyle}>Port (465 or 587)<input value={f.port} onChange={set('port')} inputMode="numeric" style={fieldStyle} /></label>
        <label style={labelStyle}>User name<input value={f.user} onChange={set('user')} placeholder="you@gmail.com" autoComplete="off" spellCheck={false} style={fieldStyle} /></label>
        <label style={labelStyle}>App password<input type="password" value={f.pass} onChange={set('pass')} autoComplete="new-password"
          placeholder={e0.passSet ? 'Saved (leave empty to keep)' : 'An app password'} style={fieldStyle} /></label>
        <label style={labelStyle}>Send to<input value={f.to} onChange={set('to')} placeholder="you@example.com" spellCheck={false} style={fieldStyle} /></label>
        <label style={labelStyle}>From (optional)<input value={f.from} onChange={set('from')} placeholder="same as user name" spellCheck={false} style={fieldStyle} /></label>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
        Always encrypted: TLS on port 465, STARTTLS on other ports. Gmail and iCloud need an app password, not your account password.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="submit" className="btn-primary" style={smallBtn} disabled={!!busy}>{busy === 'email' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn-ghost" style={smallBtn} disabled={!!busy || !e0.configured}
          onClick={() => run('test-email', async () => { await call('POST', '/api/delivery/test/email'); return `Test email sent to ${e0.to}.`; })}>
          {busy === 'test-email' ? 'Sending…' : 'Send test email'}
        </button>
        {e0.configured && <button type="button" className="btn-ghost" style={smallBtn} disabled={!!busy}
          onClick={() => run('email', async () => { if (confirm('Remove the email settings and the saved password?')) await call('DELETE', '/api/delivery/email'); })}>Remove</button>}
      </div>
      <div style={{ marginTop: 8 }}><LevelSelect channel="email" {...props} /></div>
    </form>
  );
}

function PushForm(props: FormProps) {
  const { status, busy, run } = props;
  const p0 = status.push;
  const [url, setUrl] = useState(p0.url ?? '');
  const [token, setToken] = useState('');
  return (
    <form style={sectionStyle} onSubmit={ev => {
      ev.preventDefault();
      run('push', async () => { await call('PUT', '/api/delivery/push', { url, token }); setToken(''); return 'Push settings saved.'; });
    }}>
      <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>Push (ntfy)</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
        <label style={labelStyle}>Topic URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://mac-mini.tail1234.ts.net:2586/persfin" spellCheck={false} style={fieldStyle} /></label>
        <label style={labelStyle}>Access token<input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="new-password"
          placeholder={p0.tokenSet ? 'Saved (leave empty to keep)' : 'tk_… (if the topic needs one)'} style={fieldStyle} /></label>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
        Your own ntfy server. Plain http is allowed only on this Mac and your Tailscale network. Subscribe to the same topic in the ntfy phone app.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="submit" className="btn-primary" style={smallBtn} disabled={!!busy}>{busy === 'push' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn-ghost" style={smallBtn} disabled={!!busy || !p0.configured}
          onClick={() => run('test-push', async () => { await call('POST', '/api/delivery/test/push'); return 'Test push sent.'; })}>
          {busy === 'test-push' ? 'Sending…' : 'Send test push'}
        </button>
        {p0.configured && <button type="button" className="btn-ghost" style={smallBtn} disabled={!!busy}
          onClick={() => run('push', async () => { if (confirm('Remove the push settings and the saved token?')) await call('DELETE', '/api/delivery/push'); })}>Remove</button>}
      </div>
      <div style={{ marginTop: 8 }}><LevelSelect channel="push" {...props} /></div>
    </form>
  );
}
