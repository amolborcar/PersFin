import { useState, useEffect, useCallback } from 'react';
import NetWorthChart from '../components/NetWorthChart.tsx';
import ConnectPlaid from '../components/ConnectPlaid.tsx';
import TopNav, { type View } from '../components/TopNav.tsx';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { parseNum, parseNumOrNull } from '../lib/parseNum.ts';
import { RANGES, rangeCutoff, type RangeKey } from '../lib/dateRange.ts';
import { sinceLabel, visitTitle } from '../lib/sinceLabel.ts';
import { fmtMoney, fmtDate, fmtMonth } from '../lib/format.ts';
import { relTime, newestTimestamp } from '../lib/relTime.ts';
import type {
  Snapshot, Account, ManualAsset, PlaidItem, AccountCategory,
} from '@shared/apiTypes';

// The dashboard page: net-worth KPIs and history chart, connected accounts and
// manual assets. Extracted from App.tsx, which is now just the
// shell (routes, privacy state, the assistant). Response types come from the
// shared API contract (@shared/apiTypes) instead of hand-copied interfaces.

// The headline figures, snapshotted so the dashboard can show how each has
// moved since the user's previous visit (persisted under `mon.lastSession`).
interface SessionSnapshot {
  net_worth: number;
  accounts_total: number;
  // When this visit began (ISO). Optional: snapshots stored before it was added
  // still load, and just get the undated "since last visit" label.
  at?: string;
}

// Captured once per page load rather than per mount: the dashboard unmounts when
// the user visits another section, and re-reading the stored snapshot on return
// would compare this session against itself (always "+$0").
let sessionBaseline: SessionSnapshot | null = null;
let baselineCaptured = false;
// This page load's visit time (ISO), fixed on first use and stamped into the stored snapshot.
let visitAt: string | null = null;

type Category = AccountCategory;

const CATEGORY_LABELS: Record<Category, string> = {
  banking: 'Cash & Banking',
  brokerage: 'Brokerage',
  credit: 'Credit Cards',
  other: 'Other Accounts',
};
const CATEGORY_ORDER: Category[] = ['brokerage', 'banking', 'credit', 'other'];

// Text-link look for small actions (edit / hide / close …). They're real <button>s
// so they're keyboard-focusable; this strips the global button chrome.
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, borderRadius: 4,
  fontFamily: 'inherit', fontSize: 11, fontWeight: 400, color: 'var(--accent)', cursor: 'pointer',
};

function EditableField({ label, initialValue, color, onSave }: {
  label: string;
  initialValue: number | null;
  color: string;
  onSave: (v: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(initialValue ?? ''));

  async function save() {
    // Blank/unparseable input cancels — saving it as 0 would zero out an asset
    // value (or any other figure) just because the field was cleared.
    const v = parseNumOrNull(value);
    if (v != null) await onSave(v);
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          style={{ width: 100, padding: '4px 8px', fontSize: 13 }}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        />
        <button className="btn-primary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={save}>Save</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)', marginRight: 8 }}>{label}</span>
      <button
        style={{ ...linkBtn, fontSize: 13, fontWeight: 600, color }}
        // Refresh the draft on open — the value may have changed (e.g. a sync)
        // since mount, and saving a stale draft would overwrite the fresh one.
        onClick={() => { setValue(String(initialValue ?? '')); setEditing(true); }}
        title="Click to edit"
        aria-label={`Edit ${label || 'value'}`}
      >{fmt(initialValue)} ✎</button>
    </div>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n !== 1 ? 's' : ''}`;
}

const INDEX_OPTIONS: { key: string; symbol: string; label: string }[] = [
  { key: 'none', symbol: '', label: 'No index' },
  { key: 'sp500', symbol: 'SPY', label: 'S&P 500' },
  { key: 'qqq', symbol: 'QQQ', label: 'Nasdaq 100 (QQQ)' },
  { key: 'target', symbol: 'VFIFX', label: 'Target Retmt 2050' },
];

// When privacy mode is on, all money is masked. Set from App's render so the
// whole subtree (which re-renders on toggle) picks it up without prop-drilling.
let HIDE_BALANCES = false;

function fmt(n: number | null) {
  if (HIDE_BALANCES) return '••••••';
  if (n == null) return '—';
  return fmtMoney(n);
}

// A compact signed-money delta for the KPI cards: "+$1,234" / "−$980". Honors
// privacy mode like fmt(). Returns '' when the change rounds to zero so the
// caller can drop the badge entirely rather than render a noisy "+$0".
function fmtDelta(n: number): string {
  if (HIDE_BALANCES) return '•••';
  if (Math.round(n) === 0) return '';
  return fmtMoney(n, { sign: true });
}

const CAT_OPTIONS: { value: Category; label: string }[] = [
  { value: 'brokerage', label: 'Brokerage' },
  { value: 'banking', label: 'Cash & Banking' },
  { value: 'credit', label: 'Credit Cards' },
  { value: 'other', label: 'Other' },
];

function AccountRow({ account: a, byInstitution, onRecategorize, onRename, onHide }: {
  account: Account;
  byInstitution: boolean;
  onRecategorize: (id: string, category: Category) => void;
  onRename: (id: string, name: string | null) => void;
  onHide: (id: string, hidden: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.name);

  function commit() {
    if (draft.trim() && draft.trim() !== a.name) onRename(a.id, draft.trim());
    setEditing(false);
  }

  return (
    <div
      draggable={!editing}
      onDragStart={e => { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'move'; }}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '5px 0', fontSize: 13, cursor: editing ? 'text' : 'grab',
      }}
    >
      <span style={{ color: 'var(--muted)', fontSize: 12, marginRight: 6, cursor: 'grab' }} title="Drag to another section">⠿</span>
      {editing ? (
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          style={{ flex: 1, marginRight: 8, padding: '2px 6px', fontSize: 13 }}
        />
      ) : (
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <button
            onClick={() => { setDraft(a.name); setEditing(true); }}
            title="Click to rename"
            aria-label={`Rename ${a.name}`}
            style={{ ...linkBtn, fontSize: 'inherit', color: 'inherit', textAlign: 'left' }}
          >{a.name} <span style={{ fontSize: 10, opacity: 0.5 }} aria-hidden>✎</span></button>
          {!byInstitution && <span style={{ fontSize: 11, color: 'var(--muted)' }}> ({a.org_name})</span>}
          {a.renamed ? (
            <button onClick={() => onRename(a.id, null)} title="Reset to original name"
              style={{ ...linkBtn, fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>reset</button>
          ) : null}
        </span>
      )}
      {/* Keyboard/touch-friendly fallback for the drag-to-recategorize gesture. */}
      {!editing && (
        <select
          value={a.category}
          draggable={false}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          onChange={e => onRecategorize(a.id, e.target.value as Category)}
          title="Change category"
          style={{ background: 'transparent', border: '1px solid transparent', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', marginRight: 8, padding: '1px 2px', maxWidth: 92 }}
        >
          {CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      <button
        onClick={() => onHide(a.id, true)}
        title="Hide from list and net worth"
        aria-label={`Hide ${a.name} from list and net worth`}
        style={{ ...linkBtn, color: 'var(--muted)', marginRight: 8, opacity: 0.6 }}
      >hide</button>
      <span style={{ color: a.balance < 0 ? 'var(--red)' : 'var(--text)', minWidth: 80, textAlign: 'right' }}>
        {fmt(a.balance)}
      </span>
    </div>
  );
}

function AccountGroups({ accounts, byInstitution, onRecategorize, onRename, onHide }: {
  accounts: Account[];
  byInstitution: boolean;
  onRecategorize: (id: string, category: Category) => void;
  onRename: (id: string, name: string | null) => void;
  onHide: (id: string, hidden: boolean) => void;
}) {
  const [overCat, setOverCat] = useState<Category | null>(null);
  const [collapsedList, setCollapsedList] = usePersistentState<Category[]>('mon.collapsedCategories', []);
  const [collapsedInst, setCollapsedInst] = usePersistentState<string[]>('mon.collapsedInstitutions', []);
  const [showHidden, setShowHidden] = usePersistentState<boolean>('mon.showHidden', false);
  const collapsed = new Set(collapsedList);
  const collapsedInstSet = new Set(collapsedInst);

  function toggleCollapse(cat: Category) {
    setCollapsedList(prev => (prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]));
  }
  // Keyed by `${category}|${org}` so an institution that appears in more than one
  // category (e.g. a brokerage that also has a credit card) collapses independently.
  function toggleInstitution(key: string) {
    setCollapsedInst(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  }

  const visible = accounts.filter(a => !a.hidden);
  const hidden = accounts.filter(a => a.hidden);

  return (
    <div style={{ marginTop: 8 }}>
      {CATEGORY_ORDER.map(cat => {
        const rows = visible.filter(a => a.category === cat);
        const subtotal = rows.reduce((s, a) => s + a.balance, 0);
        const orgs = byInstitution ? [...new Set(rows.map(r => r.org_name))].sort() : [null];
        const isOver = overCat === cat;
        const isCollapsed = collapsed.has(cat);

        return (
          <div
            key={cat}
            onDragOver={e => { e.preventDefault(); if (overCat !== cat) setOverCat(cat); }}
            onDragLeave={() => setOverCat(c => (c === cat ? null : c))}
            onDrop={e => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              setOverCat(null);
              if (id) onRecategorize(id, cat);
            }}
            style={{
              marginTop: 12, padding: '6px 8px', borderRadius: 8,
              border: isOver ? '1px dashed var(--accent)' : '1px solid transparent',
              background: isOver ? 'var(--accent-dim)' : 'transparent',
              transition: 'background 0.1s',
            }}
          >
            <div
              onClick={() => toggleCollapse(cat)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: 0.5, color: 'var(--muted)', marginBottom: 4, cursor: 'pointer',
              }}
            >
              <span>
                <span style={{ display: 'inline-block', width: 12, opacity: 0.7 }}>{isCollapsed ? '▸' : '▾'}</span>
                {CATEGORY_LABELS[cat]}
                {isCollapsed && rows.length > 0 && (
                  <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>({rows.length})</span>
                )}
              </span>
              <span>{fmt(subtotal)}</span>
            </div>
            {isCollapsed ? null : rows.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--muted)', opacity: 0.6, padding: '4px 0' }}>
                Drag an account here…
              </p>
            ) : (
              orgs.map(org => {
                const orgRows = org === null ? rows : rows.filter(r => r.org_name === org);
                const instKey = `${cat}|${org}`;
                const instCollapsed = byInstitution && org !== null && collapsedInstSet.has(instKey);
                const orgSubtotal = orgRows.reduce((s, a) => s + a.balance, 0);
                return (
                  <div key={org ?? '_all'} style={{ marginLeft: byInstitution ? 8 : 0 }}>
                    {byInstitution && org !== null && (
                      <div
                        onClick={() => toggleInstitution(instKey)}
                        title={instCollapsed ? 'Expand institution' : 'Collapse institution'}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          fontSize: 12, fontWeight: 600, color: 'var(--text)', marginTop: 6,
                          cursor: 'pointer', padding: '2px 0',
                        }}
                      >
                        <span>
                          <span style={{ display: 'inline-block', width: 12, opacity: 0.6 }}>{instCollapsed ? '▸' : '▾'}</span>
                          {org}
                          {instCollapsed && orgRows.length > 0 && (
                            <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>({orgRows.length})</span>
                          )}
                        </span>
                        <span style={{ color: 'var(--muted)' }}>{fmt(orgSubtotal)}</span>
                      </div>
                    )}
                    {!instCollapsed && orgRows.map(a => (
                      <AccountRow key={a.id} account={a} byInstitution={byInstitution} onRecategorize={onRecategorize} onRename={onRename} onHide={onHide} />
                    ))}
                  </div>
                );
              })
            )}
          </div>
        );
      })}

      {/* Hidden accounts — excluded from net worth, reversible */}
      {hidden.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
          <button
            onClick={() => setShowHidden(s => !s)}
            aria-expanded={showHidden}
            style={{ ...linkBtn, fontSize: 12, color: 'var(--muted)' }}
          >
            {showHidden ? '▾' : '▸'} Hidden accounts ({hidden.length}) · excluded from net worth
          </button>
          {showHidden && hidden.map(a => (
            <div key={a.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '5px 0', fontSize: 13, opacity: 0.6,
            }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name} <span style={{ fontSize: 11, color: 'var(--muted)' }}>({a.org_name})</span>
              </span>
              <button onClick={() => onHide(a.id, false)} title="Unhide" aria-label={`Unhide ${a.name}`}
                style={{ ...linkBtn, marginRight: 8 }}>unhide</button>
              <span style={{ minWidth: 80, textAlign: 'right' }}>{fmt(a.balance)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline editor for a manual asset's annual growth/interest rate. A null rate
// reads as a muted "+ rate" prompt; clearing the field (empty) sets it back to
// null, which the Forecast treats as "leave in the investment pool".
function RateField({ rate, onSave }: { rate: number | null; onSave: (v: number | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(rate != null ? String(rate) : '');

  async function save() {
    const trimmed = value.trim();
    await onSave(trimmed === '' ? null : parseNum(trimmed));
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="e.g. 4.5"
          style={{ width: 64, padding: '4px 6px', fontSize: 12 }}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>%/yr</span>
        <button className="btn-primary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={save}>Save</button>
      </div>
    );
  }

  return (
    <button
      onClick={() => { setValue(rate != null ? String(rate) : ''); setEditing(true); }}
      title="Annual growth/interest rate used to project this asset in the Forecast"
      aria-label="Edit annual growth rate"
      style={{
        ...linkBtn, fontSize: 12, whiteSpace: 'nowrap',
        color: rate != null ? 'var(--accent)' : 'var(--muted)',
        opacity: rate != null ? 1 : 0.7,
      }}
    >{rate != null ? `${rate}%/yr ✎` : '+ rate'}</button>
  );
}

function ManualAssetRow({ asset, onUpdate }: { asset: ManualAsset; onUpdate: () => void }) {
  async function patch(body: object) {
    await fetch(`/api/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    onUpdate();
  }
  async function remove() {
    if (!confirm(`Remove “${asset.name}” from your net worth?`)) return;
    await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
    onUpdate();
  }
  return (
    // flex-wrap: on a phone the rate/value/Remove controls drop to a second line
    // instead of squeezing the name down to a sliver.
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      padding: '8px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: '1 1 160px', minWidth: 0 }}>
        <p style={{ fontWeight: 500, fontSize: 14 }}>{asset.name}</p>
        <select
          value={asset.category}
          onChange={e => patch({ category: e.target.value })}
          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', paddingLeft: 0 }}
        >
          {CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <RateField rate={asset.interest_rate} onSave={v => patch({ interest_rate: v })} />
      </div>
      <EditableField label="" initialValue={asset.value} color="var(--green)" onSave={v => patch({ value: v })} />
      <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red)' }}
        onClick={remove}>Remove</button>
    </div>
  );
}

function AddManualAsset({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [rate, setRate] = useState('');
  const [category, setCategory] = useState<Category>('other');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    await fetch('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Blank rate → null (legacy investment-pool behavior in the Forecast).
      body: JSON.stringify({ name, value: parseNum(value), category, interest_rate: rate.trim() === '' ? null : parseNum(rate) }),
    });
    setName(''); setValue(''); setRate(''); setCategory('other');
    setLoading(false);
    onAdded();
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Treasury bonds" style={{ flex: 2, minWidth: 140 }} />
      <input value={value} onChange={e => setValue(e.target.value)} placeholder="Value" style={{ flex: 1, minWidth: 90 }} />
      <input value={rate} onChange={e => setRate(e.target.value)} placeholder="Rate %/yr" title="Optional annual growth/interest rate, used in the Forecast" style={{ flex: 1, minWidth: 80 }} />
      <select value={category} onChange={e => setCategory(e.target.value as Category)}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 14, padding: '0 8px' }}>
        {CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button type="submit" className="btn-primary" disabled={loading} style={{ whiteSpace: 'nowrap' }}>
        {loading ? 'Adding…' : '+ Add Asset'}
      </button>
    </form>
  );
}

// Inline notice strip (sync failure, server unreachable).
const bannerStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  padding: '10px 14px', borderRadius: 10, fontSize: 13,
  background: 'var(--surface)', border: '1px solid var(--red)',
};

export default function Dashboard({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [byInstitution, setByInstitution] = usePersistentState('mon.byInstitution', true);
  const [range, setRange] = usePersistentState<RangeKey>('mon.range', 'ALL');
  const [chartMode, setChartMode] = usePersistentState<'stacked' | 'lines'>('mon.chartMode', 'stacked');
  const [backfilling, setBackfilling] = useState(false);
  // Last sync / backfill problem or result, shown inline (dismissible / replaced on the next run).
  const [syncError, setSyncError] = useState<string | null>(null);
  const [backfillNote, setBackfillNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [excluded, setExcluded] = usePersistentState<string[]>('mon.excluded', []);
  const [indexKey, setIndexKey] = usePersistentState('mon.indexKey', 'none');
  const [indexSeries, setIndexSeries] = useState<{ date: string; close: number }[]>([]);
  const [showConnections, setShowConnections] = usePersistentState('mon.showConnections', false);
  HIDE_BALANCES = privacy; // synced each render so fmt() everywhere honors it

  const showAccounts = !excluded.includes('accounts');
  const indexOpt = INDEX_OPTIONS.find(o => o.key === indexKey) ?? INDEX_OPTIONS[0];

  // Fetch the comparison index series when the selection changes.
  useEffect(() => {
    if (!indexOpt.symbol) { setIndexSeries([]); return; }
    let cancelled = false;
    fetch(`/api/net-worth/index?symbol=${encodeURIComponent(indexOpt.symbol)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setIndexSeries(Array.isArray(d) ? d : []); })
      .catch(() => { if (!cancelled) setIndexSeries([]); });
    return () => { cancelled = true; };
  }, [indexOpt.symbol]);

  function toggleExclude(key: string) {
    setExcluded(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  }

  // Clicking a series in the chart legend toggles the same inclusion as the cards.
  function toggleSeries(dataKey: string) {
    if (dataKey === 'accounts_total') toggleExclude('accounts');
  }

  const { data: history, loading: historyLoading, error: historyError, refetch: refetchHistory } = useApi<Snapshot[]>('/api/net-worth/history?days=10000');
  const { data: breakdown, loading: breakdownLoading, error: breakdownError, refetch: refetchBreakdown } = useApi<{ accounts: Account[]; manualAssets: ManualAsset[] }>('/api/net-worth/breakdown');
  const { data: plaidItems, refetch: refetchPlaid } = useApi<PlaidItem[]>('/api/plaid/items');

  const latest = history?.[0];
  // Nothing has loaded and the requests failed: the server is down/unreachable, which
  // must not read as an empty account.
  const serverDown = !!historyError && !history && !!breakdownError && !breakdown;
  // updated_at of the most recently synced visible account (SQLite UTC, see relTime).
  const syncedAt = newestTimestamp((breakdown?.accounts ?? []).filter(a => !a.hidden).map(a => a.updated_at));

  // "Change since last session" for the KPI cards. `lastSession` persists the
  // headline figures from the previous visit; the first time this page load sees
  // real figures we freeze those into the module-level session baseline (so the
  // deltas stay stable while the user is here, including across navigation) and
  // then keep the stored baseline updated to the newest figures, so the NEXT
  // visit compares against where things stood when this session ended.
  const [lastSession, setLastSession] = usePersistentState<SessionSnapshot | null>('mon.lastSession', null);
  const [baseline, setBaseline] = useState<SessionSnapshot | null>(sessionBaseline);

  const visitTip = visitTitle(baseline?.at);

  useEffect(() => {
    if (!latest) return;
    if (!baselineCaptured) {
      baselineCaptured = true;
      sessionBaseline = lastSession; // prior-session figures; null on first-ever visit
      setBaseline(lastSession);
    }
    // Stamp the snapshot with this page load's visit time. `visitAt` never changes
    // after it's first set, so once the write lands (lastSession.at === visitAt) the
    // effect's re-run sees nothing to do and can't loop; it's also idempotent under
    // StrictMode's double-run. The baseline above was captured first, so it keeps
    // the PREVIOUS visit's `at`.
    visitAt ??= new Date().toISOString();
    const snap: SessionSnapshot = {
      net_worth: latest.net_worth,
      accounts_total: latest.accounts_total,
      at: visitAt,
    };
    if (!lastSession
      || lastSession.at !== visitAt
      || lastSession.net_worth !== snap.net_worth
      || lastSession.accounts_total !== snap.accounts_total) {
      setLastSession(snap);
    }
  }, [latest, lastSession, setLastSession]);

  const refetchAll = useCallback(() => {
    refetchHistory();
    refetchBreakdown();
    refetchPlaid();
  }, [refetchHistory, refetchBreakdown, refetchPlaid]);

  // Mirrors Setup's "Sync now" (SyncSection.syncNow): same endpoint, same
  // force-refresh of every source. The server snapshots even when one provider
  // fails (then answers 500), so new data may have been saved: always refetch, and
  // surface the failure as a banner instead of leaving the page stale. finally
  // also guarantees the spinner resets if the request throws.
  async function triggerRefresh() {
    setRefreshing(true);
    setSyncError(null);
    try {
      const res = await fetch('/api/net-worth/refresh', { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as { error?: string }));
        setSyncError(d.error || `Couldn't refresh everything (HTTP ${res.status}).`);
      }
    } catch (e) {
      console.error('Sync failed:', e);
      setSyncError("Couldn't reach the PersFin server.");
    } finally {
      refetchAll();
      setRefreshing(false);
    }
  }

  async function triggerBackfill() {
    if (!confirm('Rebuild up to 5 years of history from transactions and market prices? Daily totals will be replaced with estimates.')) return;
    setBackfilling(true);
    setBackfillNote(null);
    // finally: a thrown fetch (server down) must not leave the button stuck on "Backfilling…".
    try {
      const res = await fetch('/api/net-worth/backfill', { method: 'POST' });
      const d = await res.json().catch(() => ({} as { snapshots?: number; error?: string }));
      if (!res.ok) {
        setBackfillNote({ ok: false, text: d.error || `Backfill failed (HTTP ${res.status})` });
      } else {
        setBackfillNote({ ok: true, text: typeof d.snapshots === 'number' ? `Rebuilt ${plural(d.snapshots, 'daily point')} of history.` : 'History rebuilt.' });
      }
      refetchHistory();
    } catch (e) {
      console.error('Backfill failed:', e);
      setBackfillNote({ ok: false, text: 'Backfill failed — could not reach the server.' });
    } finally {
      setBackfilling(false);
    }
  }

  const visibleHistory = (history ?? []).filter(s => s.date >= rangeCutoff(range));

  // Apply category exclusions, recomputing the net-worth line.
  // Sort ascending so the index forward-fill below aligns correctly (the API
  // returns snapshots newest-first).
  const displayed = [...visibleHistory]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => {
      const acc = showAccounts ? s.accounts_total : 0;
      // Pass zeroed values so the area chart renders the correct height.
      return { date: s.date, accounts_total: acc, net_worth: acc };
    });

  // Overlay the index, normalized so it starts at the displayed net worth.
  let chartData: (typeof displayed[number] & { index?: number | null })[] = displayed;
  if (indexSeries.length && displayed.length) {
    const filled: number[] = [];
    let i = 0;
    let last = indexSeries[0].close;
    for (const pt of displayed) {
      while (i < indexSeries.length && indexSeries[i].date <= pt.date) { last = indexSeries[i].close; i++; }
      filled.push(last);
    }
    const factor = filled[0] ? displayed[0].net_worth / filled[0] : 1;
    chartData = displayed.map((pt, k) => ({ ...pt, index: filled[k] * factor }));
  }

  async function removePlaidItem(itemId: string, label: string) {
    if (!confirm(`Remove ${label}? Its accounts will stop syncing and be removed from your net worth.`)) return;
    await fetch(`/api/plaid/items/${itemId}`, { method: 'DELETE' });
    refetchAll();
  }

  async function recategorize(id: string, category: Category) {
    await fetch(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    refetchAll();
  }

  async function renameAccount(id: string, name: string | null) {
    await fetch(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    refetchAll();
  }

  async function hideAccount(id: string, hidden: boolean) {
    await fetch(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    refetchAll();
  }

  return (
    <div className="page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      {/* Persistent nav + icon actions */}
      <TopNav
        view="dashboard"
        onNavigate={onNavigate}
        privacy={privacy}
        onTogglePrivacy={onTogglePrivacy}
        onRefresh={triggerRefresh}
        refreshing={refreshing}
      />

      {/* Title */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>PersFin</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Net Worth Tracker</p>
      </div>

      {serverDown && (
        <div role="alert" style={{ ...bannerStyle, marginBottom: 24 }}>
          <span>Can't reach the PersFin server — check that it's running, then reload.</span>
        </div>
      )}
      {syncError && (
        <div role="alert" style={{ ...bannerStyle, marginBottom: 24 }}>
          <span>{syncError} Showing the latest data that did sync.</span>
          <button className="btn-ghost" onClick={() => setSyncError(null)} aria-label="Dismiss"
            style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* KPI cards — Accounts & assets toggles its inclusion in the graph */}
      <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginBottom: latest ? 12 : 32 }}>
        {[
          {
            // The hero follows the same composition as the chart, so say so when a
            // card is hidden instead of silently showing a partial total.
            label: !showAccounts ? 'Net Worth · nothing selected' : 'Net Worth',
            value: latest ? (showAccounts ? latest.accounts_total : 0) : null,
            color: 'var(--accent)', key: null, excluded: false, hint: undefined as string | undefined,
            // Net-worth delta follows the same composition shown above, so hiding a
            // series from the graph also drops it from the change figure.
            delta: latest && baseline && showAccounts ? latest.accounts_total - baseline.accounts_total : null,
          },
          { label: 'Accounts & assets', value: latest?.accounts_total ?? null, color: 'var(--amber)', key: 'accounts', excluded: !showAccounts,
            hint: 'Linked accounts plus manual assets, with credit cards netted out. Hidden accounts are left out.',
            delta: latest && baseline ? latest.accounts_total - baseline.accounts_total : null },
        ].map(card => {
          const isHero = card.key === null;
          const deltaText = !card.excluded && card.delta != null ? fmtDelta(card.delta) : '';
          const toggleTip = card.key ? `${card.hint} ${card.excluded ? 'Click to include in graph' : 'Click to exclude from graph'}` : undefined;
          // The two toggle cards are real <button>s (keyboard + aria-pressed); the hero
          // is a plain box. Children are spans so the markup stays valid inside a button.
          const body = (
            <>
              <span style={{ display: 'block', color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>
                {card.label}
                {card.excluded && <span style={{ fontSize: 11, marginLeft: 6 }}>(hidden)</span>}
                {isHero && !showAccounts && (
                  <button className="btn-ghost" onClick={() => setExcluded([])}
                    style={{ fontSize: 11, padding: '2px 8px', marginLeft: 8 }}>Show all</button>
                )}
              </span>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: isHero ? 30 : 26, fontWeight: 700, color: card.color,
                  textDecoration: card.excluded ? 'line-through' : 'none',
                }}>{fmt(card.value)}</span>
                {deltaText && (
                  <span
                    title={visitTip ? `Change since your last visit (${visitTip})` : 'Change since your last visit'}
                    style={{
                      fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                      color: privacy ? 'var(--muted)' : (card.delta ?? 0) > 0 ? 'var(--green)' : 'var(--red)',
                    }}
                  >
                    {deltaText}
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)', marginLeft: 4, whiteSpace: 'nowrap' }}>{sinceLabel(baseline?.at)}</span>
                  </span>
                )}
              </span>
            </>
          );
          const boxStyle: React.CSSProperties = {
            background: isHero ? 'var(--accent-dim)' : 'var(--surface)',
            border: `1px solid ${isHero ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 12, padding: '20px 24px',
            opacity: card.excluded ? 0.45 : 1,
            transition: 'opacity 0.12s',
          };
          return isHero ? (
            <div key={card.label} style={boxStyle}>{body}</div>
          ) : (
            <button
              key={card.label}
              type="button"
              aria-pressed={!card.excluded}
              onClick={() => card.key && toggleExclude(card.key)}
              title={toggleTip}
              style={{
                ...boxStyle, display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit',
              }}
            >{body}</button>
          );
        })}
      </div>

      {/* Freshness: which day the figures are for, and how recently accounts synced */}
      {latest && (
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 32 }}>
          As of {fmtDate(latest.date)}{syncedAt ? ` · synced ${relTime(syncedAt)}` : ''}
        </p>
      )}

      {/* Chart */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '24px', marginBottom: 32,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>History</h2>
            {/* Chart style: stacked composition vs zoomed trend lines */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 8, padding: 2 }}>
              {(['stacked', 'lines'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setChartMode(m)}
                  title={m === 'stacked' ? 'Stacked composition (from $0)' : 'Trend lines, zoomed to show change'}
                  style={{
                    padding: '4px 10px', fontSize: 12, borderRadius: 6,
                    background: chartMode === m ? 'var(--accent)' : 'transparent',
                    color: chartMode === m ? 'var(--on-accent)' : 'var(--muted)',
                  }}
                >{m === 'stacked' ? 'Stacked' : 'Lines'}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Range selector — scrolls sideways on a phone instead of overflowing */}
            <div className="scroll-row" style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 8, padding: 2 }}>
              {RANGES.map(r => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  style={{
                    padding: '4px 10px', fontSize: 12, borderRadius: 6, whiteSpace: 'nowrap', flexShrink: 0,
                    background: range === r ? 'var(--accent)' : 'transparent',
                    color: range === r ? 'var(--on-accent)' : 'var(--muted)',
                  }}
                >{r}</button>
              ))}
            </div>
            <select
              value={indexKey}
              onChange={e => setIndexKey(e.target.value)}
              title="Compare against an index"
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '4px 8px' }}
            >
              {INDEX_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.key === 'none' ? 'Compare…' : `vs ${o.label}`}</option>)}
            </select>
            <button className="btn-ghost" onClick={triggerBackfill} disabled={backfilling}
              style={{ fontSize: 12, padding: '4px 10px' }}
              title="Reconstruct ~5 years: cash/credit from transactions; brokerage from holdings × historical market prices">
              {backfilling ? 'Backfilling…' : '⟲ Backfill'}
            </button>
          </div>
        </div>
        {backfillNote && (
          <p role="status" style={{ fontSize: 12, marginBottom: 12, color: backfillNote.ok ? 'var(--muted)' : 'var(--red)' }}>{backfillNote.text}</p>
        )}
        {visibleHistory.length > 0
          ? <div style={{ filter: privacy ? 'blur(10px)' : 'none', transition: 'filter 0.15s', pointerEvents: privacy ? 'none' : 'auto' }}>
              <NetWorthChart
                data={chartData}
                mode={chartMode}
                showAccounts={showAccounts}
                indexLabel={indexOpt.symbol ? indexOpt.label : undefined}
                onToggleSeries={toggleSeries}
              />
            </div>
          : <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '40px 0' }}>
              {history
                ? (history.length > 0
                    ? 'No history in this range — try a wider one or click Backfill.'
                    : 'No history yet — click Backfill to reconstruct it, or use the refresh button (top right) for today.')
                : historyError ? "Can't reach the PersFin server."
                : historyLoading ? 'Loading…'
                : ''}
            </p>
        }
        {visibleHistory.length > 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10, opacity: 0.7 }}>
            Historical points reconstruct cash & credit from transactions, and brokerage from each holding's
            historical market price (untickered index funds like 529 portfolios use proxy ETFs).
            Crypto is held flat. Daily history points capture changes going forward.
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24 }}>
        {/* Institutions */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Financial Accounts</h2>
            {breakdown?.accounts && breakdown.accounts.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={byInstitution}
                  onChange={e => setByInstitution(e.target.checked)}
                  style={{ width: 'auto', cursor: 'pointer' }}
                />
                Group by institution
              </label>
            )}
          </div>

          {/* Account balances first */}
          {breakdown?.accounts && breakdown.accounts.length > 0
            ? <AccountGroups
                accounts={breakdown.accounts}
                byInstitution={byInstitution}
                onRecategorize={recategorize}
                onRename={renameAccount}
                onHide={hideAccount}
              />
            : breakdown
              ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
                  <p style={{ color: 'var(--muted)', fontSize: 14 }}>
                    No accounts yet{showConnections ? ' — connect an institution below.' : '.'}
                  </p>
                  {!showConnections && (
                    <button className="btn-primary" onClick={() => setShowConnections(true)}>Connect an account</button>
                  )}
                </div>
              )
              : <p style={{ color: 'var(--muted)', fontSize: 14 }}>
                  {breakdownError ? "Can't reach the PersFin server." : breakdownLoading ? 'Loading…' : ''}
                </p>
          }

          {/* Connections management — collapsed by default to keep the dashboard clean */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => setShowConnections(s => !s)}
              aria-expanded={showConnections}
              style={{ ...linkBtn, fontSize: 12, color: 'var(--muted)' }}
            >
              {showConnections ? '▾' : '▸'} Manage connections
              {(() => {
                const count = plaidItems?.length ?? 0;
                return count > 0 ? <span style={{ opacity: 0.6, marginLeft: 6 }}>({count})</span> : null;
              })()}
            </button>
            {showConnections && (
              <div style={{ marginTop: 12 }}>
                {/* Each Plaid item is one institution's login; one row = one thing
                    Remove disconnects. */}
                {[
                  {
                    provider: 'Plaid',
                    rows: (plaidItems ?? []).map(item => ({
                      key: `pl-${item.item_id}`,
                      title: item.institution_name,
                      detail: plural(item.account_count, 'account'),
                      onRemove: () => removePlaidItem(item.item_id, item.institution_name),
                    })),
                  },
                ].filter(g => g.rows.length > 0).map((g, gi) => (
                  <div key={g.provider} style={{ marginTop: gi > 0 ? 12 : 0 }}>
                    <p style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>
                      {g.provider}
                    </p>
                    {g.rows.map(r => (
                      <div key={r.key} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0',
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontWeight: 500, fontSize: 13 }}>{r.title}</p>
                          <p style={{ color: 'var(--muted)', fontSize: 12 }}>{r.detail}</p>
                        </div>
                        <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)', flexShrink: 0 }}
                          onClick={r.onRemove}>Remove</button>
                      </div>
                    ))}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <ConnectPlaid onSuccess={refetchAll} />
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Manual assets (Treasury bonds, cash, collectibles, etc.) */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 24, marginTop: 24,
      }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Manual Assets</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
          Anything not connected automatically — Treasury bonds, physical cash, private investments.
        </p>
        <div>
          {breakdown?.manualAssets && breakdown.manualAssets.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No manual assets added yet.</p>
          )}
          {breakdown?.manualAssets?.map(a => (
            <ManualAssetRow key={a.id} asset={a} onUpdate={refetchAll} />
          ))}
        </div>
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <AddManualAsset onAdded={refetchAll} />
        </div>
      </div>
    </div>
  );
}
