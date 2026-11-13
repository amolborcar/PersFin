// Run with: node --test desktop/launchd.test.js  (no dependencies needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgents, toPlistXml, xmlEscape, LABELS } = require('./launchd.js');

const base = {
  execPath: '/Applications/PersFin.app/Contents/MacOS/PersFin',
  entry: '/Applications/PersFin.app/Contents/Resources/server/dist/index.js',
  port: 3001,
  dbPath: '/Users/me/Library/Application Support/PersFin/persfin.db',
  keysPath: '/Users/me/Library/Application Support/PersFin/persfin.env',
  claudeBin: '/Applications/PersFin.app/Contents/Resources/claude/claude',
  logDir: '/Users/me/Library/Logs/PersFin',
};

const byLabel = (agents, label) => agents.find(a => a.label === label);

test('builds the server agent and one agent per scheduled job', () => {
  const agents = buildAgents({ ...base, packaged: true });
  assert.deepEqual(agents.map(a => a.label), [LABELS.server, LABELS.dailySync, LABELS.snapshot]);
  for (const a of agents) assert.equal(a.filename, `${a.label}.plist`);
});

test('packaged: runs the server under the app binary as Node, kept alive, launchd-scheduled', () => {
  const xml = byLabel(buildAgents({ ...base, packaged: true }), LABELS.server).xml;
  assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Applications\/PersFin\.app\/Contents\/MacOS\/PersFin<\/string>\s*<string>[^<]*server\/dist\/index\.js<\/string>/);
  assert.match(xml, /<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/);
  assert.match(xml, /<key>PERSFIN_SCHEDULER<\/key>\s*<string>launchd<\/string>/);
  assert.match(xml, /<key>PERSFIN_LISTEN<\/key>\s*<string>local\+tailscale<\/string>/);
  assert.match(xml, /<key>PORT<\/key>\s*<string>3001<\/string>/);
  assert.match(xml, /<key>DB_PATH<\/key>\s*<string>\/Users\/me\/Library\/Application Support\/PersFin\/persfin\.db<\/string>/);
  assert.match(xml, /<key>CLAUDE_BIN<\/key>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/PersFin\/server\.err\.log<\/string>/);
});

test('dev: runs the server with the system node and without ELECTRON_RUN_AS_NODE', () => {
  const xml = byLabel(buildAgents({ ...base, packaged: false, claudeBin: null }), LABELS.server).xml;
  assert.match(xml, /<array>\s*<string>\/usr\/bin\/env<\/string>\s*<string>node<\/string>/);
  assert.doesNotMatch(xml, /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(xml, /CLAUDE_BIN/);
});

test('job agents POST the job endpoint on the configured port at the scheduled time', () => {
  const agents = buildAgents({ ...base, port: 3105, packaged: true });
  const sync = byLabel(agents, LABELS.dailySync).xml;
  assert.match(sync, /<string>http:\/\/127\.0\.0\.1:3105\/api\/jobs\/daily-sync<\/string>/);
  assert.match(sync, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>6<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(sync, /<string>\/usr\/bin\/curl<\/string>/);
  assert.doesNotMatch(sync, /RunAtLoad|KeepAlive/);
  const snap = byLabel(agents, LABELS.snapshot).xml;
  assert.match(snap, /\/api\/jobs\/snapshot<\/string>/);
  assert.match(snap, /<key>Hour<\/key>\s*<integer>0<\/integer>/);
});

test('escapes XML special characters in paths', () => {
  assert.equal(xmlEscape(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  const xml = byLabel(buildAgents({ ...base, packaged: true, dbPath: '/Users/me/R&D <data>/persfin.db' }), LABELS.server).xml;
  assert.match(xml, /<string>\/Users\/me\/R&amp;D &lt;data&gt;\/persfin\.db<\/string>/);
});

test('writes a complete plist document', () => {
  const xml = toPlistXml({ Label: 'x', Flag: false, N: 2, L: ['a'] });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist'));
  assert.match(xml, /<plist version="1.0">\n<dict>[\s\S]*<\/dict>\n<\/plist>\n$/);
  assert.match(xml, /<key>Flag<\/key>\s*<false\/>/);
  assert.throws(() => toPlistXml({ X: 1.5 }));
});
