// electron-builder strips `node_modules` from extraResources (hardcoded), so the
// staged server's production deps — including the Electron-ABI better-sqlite3 —
// never make it into the bundle. Copy them in ourselves after the app dir is
// assembled, before it's packaged into the .dmg. macOS is the only target.

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin') throw new Error(`[afterPack] macOS is the only supported target (got ${electronPlatformName})`);
  const resources = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');

  const src = path.join(__dirname, '..', 'staging', 'server', 'node_modules');
  const dest = path.join(resources, 'server', 'node_modules');

  if (!fs.existsSync(src)) throw new Error(`[afterPack] staged node_modules missing: ${src} (run the stage step first)`);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[afterPack] copied server node_modules -> ${dest}`);

  // Bundle the native claude CLI (if staged) at resources/claude/, where the app
  // looks for CLAUDE_BIN. Done here (not via extraResources) so the exec bit
  // survives and a missing dir doesn't fail the build.
  const claudeSrc = path.join(__dirname, '..', 'staging', 'claude');
  const claudeBin = path.join(claudeSrc, 'claude');
  if (fs.existsSync(claudeBin)) {
    const claudeDest = path.join(resources, 'claude');
    fs.rmSync(claudeDest, { recursive: true, force: true });
    fs.cpSync(claudeSrc, claudeDest, { recursive: true });
    for (const f of fs.readdirSync(claudeDest)) {
      try { fs.chmodSync(path.join(claudeDest, f), 0o755); } catch { /* ignore */ }
    }
    console.log(`[afterPack] bundled claude -> ${claudeDest}`);
  }

  // Ad-hoc sign the finished macOS bundle. We ship unsigned/un-notarized (no Apple
  // Developer cert), but an arm64 app with NO signature at all is rejected as
  // "damaged" and can't be opened. An ad-hoc signature (`-`) makes it a valid,
  // runnable bundle — Gatekeeper still quarantines the download, so users open it
  // once via right-click → Open (the normal "unidentified developer" path) instead
  // of being stuck. Must run last, after node_modules + claude are copied in.
  const { execFileSync } = require('child_process');
  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`[afterPack] ad-hoc signed ${appPath}`);
  } catch (e) {
    console.warn('[afterPack] ad-hoc codesign failed (app may show as "damaged"):', e.message);
  }
};
