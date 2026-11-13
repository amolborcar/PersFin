// launchd agents for the always-on macOS setup (see docs/REBUILD-PLAN.md,
// Phase 3b). Pure: builds the agent definitions and their plist XML; the
// Electron main process writes them to ~/Library/LaunchAgents and loads them
// with launchctl.
//
// Agents:
//   com.persfin.server      the PersFin server. Starts at login, restarted if it
//                          stops (KeepAlive). Listens on loopback + Tailscale.
//   com.persfin.daily-sync  06:00 every day: POST /api/jobs/daily-sync
//   com.persfin.snapshot    00:00 every day: POST /api/jobs/snapshot
//   com.persfin.weekly-report  Sunday 19:00: POST /api/jobs/weekly-report
//
// The job agents use StartCalendarInterval, so a job missed while the Mac slept
// runs once when it wakes. The server makes every job idempotent per day (per
// report week for weekly-report).

const path = require('path');

const LABELS = {
  server: 'com.persfin.server',
  dailySync: 'com.persfin.daily-sync',
  snapshot: 'com.persfin.snapshot',
  weeklyReport: 'com.persfin.weekly-report',
};
const ALL_LABELS = Object.values(LABELS);

// launchd starts agents with a minimal PATH; give the server the usual tool
// locations (Homebrew on Apple silicon and Intel, then the system).
const AGENT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const JOBS = [
  { label: LABELS.dailySync, job: 'daily-sync', hour: 6, minute: 0 },
  { label: LABELS.snapshot, job: 'snapshot', hour: 0, minute: 0 },
  // Weekday 0 = Sunday. The hour matches WEEKLY_SEND_HOUR in server/src/util/weekWindow.ts.
  { label: LABELS.weeklyReport, job: 'weekly-report', weekday: 0, hour: 19, minute: 0 },
];

// --- plist serialization ---------------------------------------------------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function plistValue(v, indent) {
  const pad = '  '.repeat(indent);
  if (typeof v === 'string') return `${pad}<string>${xmlEscape(v)}</string>`;
  if (typeof v === 'boolean') return `${pad}<${v}/>`;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`plist: only integers are supported (got ${v})`);
    return `${pad}<integer>${v}</integer>`;
  }
  if (Array.isArray(v)) {
    return [`${pad}<array>`, ...v.map(x => plistValue(x, indent + 1)), `${pad}</array>`].join('\n');
  }
  if (v && typeof v === 'object') {
    const lines = [`${pad}<dict>`];
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      lines.push(`${pad}  <key>${xmlEscape(k)}</key>`, plistValue(val, indent + 1));
    }
    lines.push(`${pad}</dict>`);
    return lines.join('\n');
  }
  throw new Error(`plist: unsupported value ${String(v)}`);
}

function toPlistXml(obj) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(obj, 0),
    '</plist>',
    '',
  ].join('\n');
}

// --- agent definitions -----------------------------------------------------

// The environment the server runs with — shared by the launchd agent and the
// desktop app's own child server, so both behave the same.
function serverEnv({ port, dbPath, keysPath, claudeBin }) {
  return {
    NODE_ENV: 'production',
    PORT: String(port),
    DB_PATH: dbPath,
    PERSFIN_ENV_PATH: keysPath,
    PERSFIN_LISTEN: 'local+tailscale',
    ...(claudeBin ? { CLAUDE_BIN: claudeBin } : {}),
  };
}

// opts: { packaged, execPath, entry, port, dbPath, keysPath, claudeBin, logDir }
//  - packaged: run the server under the app's own Electron binary as Node
//    (better-sqlite3 is built for Electron's ABI there);
//  - dev: run it with the system `node` from PATH (the repo's build).
function buildAgents(opts) {
  const { packaged, execPath, entry, port, logDir } = opts;
  const program = packaged ? [execPath, entry] : ['/usr/bin/env', 'node', entry];
  const env = {
    ...serverEnv(opts),
    PERSFIN_SCHEDULER: 'launchd',
    PATH: AGENT_PATH,
    ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };

  const server = {
    Label: LABELS.server,
    ProgramArguments: program,
    EnvironmentVariables: env,
    WorkingDirectory: path.dirname(entry),
    RunAtLoad: true,
    KeepAlive: true,
    // Wait this many seconds before a restart, so a crash loop can't spin.
    ThrottleInterval: 10,
    StandardOutPath: path.join(logDir, 'server.log'),
    StandardErrorPath: path.join(logDir, 'server.err.log'),
  };

  const jobs = JOBS.map(j => ({
    Label: j.label,
    ProgramArguments: [
      '/usr/bin/curl', '--silent', '--show-error', '--fail',
      '--max-time', '900', '-X', 'POST', `http://127.0.0.1:${port}/api/jobs/${j.job}`,
    ],
    StartCalendarInterval: { ...(j.weekday !== undefined ? { Weekday: j.weekday } : {}), Hour: j.hour, Minute: j.minute },
    StandardOutPath: path.join(logDir, `${j.job}.log`),
    StandardErrorPath: path.join(logDir, `${j.job}.log`),
  }));

  return [server, ...jobs].map(def => ({
    label: def.Label,
    filename: `${def.Label}.plist`,
    xml: toPlistXml(def),
  }));
}

module.exports = { LABELS, ALL_LABELS, JOBS, AGENT_PATH, xmlEscape, toPlistXml, serverEnv, buildAgents };
