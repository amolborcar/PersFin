// Reads the system sleep timer from macOS `pmset -g` output. The always-on setup
// needs the Mac to stay awake: launchd runs a missed scheduled job only once the
// Mac wakes. The relevant line is the bare "sleep" setting, e.g.
//   " sleep                10"   → sleeps after 10 idle minutes
//   " sleep                0 (sleep prevented by ...)" → never sleeps
// Lines such as "displaysleep", "disksleep" and "Sleep On Power Button" are
// different settings and are ignored. Returns null when no line matches.
export function parsePmsetSleepMinutes(output: string): number | null {
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*sleep\s+(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}
