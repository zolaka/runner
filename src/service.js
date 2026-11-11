// @ts-check
// Keeping the runner going after the terminal closes and the computer restarts: a launchd agent
// on macOS, a systemd user service on Linux. Both start a copy of this program kept in
// ~/.zolaka/runner (npx's own copy can be cleaned away at any time), by the full path of Node,
// with the PATH of the terminal it was connected from: a service starts with a short PATH, and
// would not find the tool otherwise. The service holds no token and writes no log of its own:
// the runner reads its settings and writes its log itself.

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, paths } from './config.js';
import { which } from './tools.js';

/** Where this program's own files are. */
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {'launchd' | 'systemd' | null} */
export function serviceKind() {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux' && existsSync('/run/systemd/system')) return 'systemd';
  return null;
}

const label = (/** @type {string} */ key) => `com.zolaka.runner.${key}`;
const unitName = (/** @type {string} */ key) => `zolaka-${key}.service`;
export const servicePath = (/** @type {string} */ key) =>
  serviceKind() === 'launchd' ? join(homedir(), 'Library', 'LaunchAgents', `${label(key)}.plist`) : join(homedir(), '.config', 'systemd', 'user', unitName(key));

/** @typedef {{ key: string, node: string, script: string, path: string, home: string }} ServiceSpec */

const xml = (/** @type {string} */ text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd agent. It restarts the runner if it fails, not if it stopped on purpose (a refused token, `disconnect`). @param {ServiceSpec} s */
export function plist(s) {
  const string = (/** @type {string} */ v) => `<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label(s.key))}
  <key>ProgramArguments</key>
  <array>${string(s.node)}${string(s.script)}${string('run')}${string(s.key)}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${string(s.path)}<key>ZOLAKA_HOME</key>${string(s.home)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
`;
}

/** A value in a unit file: quoted, with systemd's own escapes for backslash, quote and percent. */
const quote = (/** @type {string} */ v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

/** The systemd user unit. @param {ServiceSpec} s */
export function unit(s) {
  return `[Unit]
Description=Zolaka runner

[Service]
ExecStart=${quote(s.node)} ${quote(s.script)} run ${quote(s.key)}
Environment=${quote(`PATH=${s.path}`)} ${quote(`ZOLAKA_HOME=${s.home}`)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

/** @param {string} file @param {string[]} args @returns {Promise<{ ok: boolean, out: string }>} */
const run = (file, args) => new Promise((done) => execFile(file, args, { timeout: 20_000 }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout}${stderr}`.trim() })));
const pause = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/**
 * What the service runs. Node by the path the terminal finds it at when that is the Node running
 * now (a path such as /opt/homebrew/bin/node outlives an upgrade; the version's own folder does
 * not), and a copy of this program.
 * @param {string} key @param {string | null} toolDir  the folder the tool really lives in, added to the PATH
 * @returns {ServiceSpec}
 */
export function specFor(key, toolDir) {
  const onPath = which('node');
  const node = onPath && realpathSync(onPath) === realpathSync(process.execPath) ? onPath : process.execPath;
  const dirs = [dirname(node), ...(toolDir ? [toolDir] : []), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
  return { key, node, script: join(paths.runner(), 'bin', 'zolaka.js'), path: [...new Set(dirs)].join(delimiter), home: home() };
}

/**
 * Copy the program, write the service and start it, and see that it is running. Returns what
 * went wrong, or null; when it fails, nothing of the service is left behind.
 * @param {ServiceSpec} s
 */
export async function install(s) {
  const kind = serviceKind();
  if (!kind) return 'this system has no service manager the runner knows';
  // Copied over what is there, not removed first: another agent's service may be starting from it.
  for (const part of ['bin', 'src', 'package.json']) cpSync(join(PACKAGE, part), join(paths.runner(), part), { recursive: true });
  const file = servicePath(s.key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, kind === 'launchd' ? plist(s) : unit(s));
  let failed = '';
  if (kind === 'launchd') {
    const domain = `gui/${userInfo().uid}`;
    await run('launchctl', ['bootout', `${domain}/${label(s.key)}`]);
    // The one that was running may take a moment to go: loading again too soon fails.
    for (let n = 0; n < 5; n++) {
      const loaded = await run('launchctl', ['bootstrap', domain, file]);
      failed = loaded.ok ? '' : loaded.out || 'launchctl could not load it';
      if (loaded.ok) break;
      await pause(1000);
    }
  } else {
    await run('systemctl', ['--user', 'daemon-reload']);
    const started = await run('systemctl', ['--user', 'enable', '--now', unitName(s.key)]);
    failed = started.ok ? '' : started.out || 'systemctl could not start it';
  }
  for (let n = 0; !failed && n < 10 && (await serviceState(s.key)) !== 'running'; n++) await pause(500);
  if (!failed && (await serviceState(s.key)) !== 'running') failed = 'it was installed but did not start';
  if (failed) await uninstall(s.key);
  return failed || null;
}

/** Stop and remove the service, if there is one. @param {string} key */
export async function uninstall(key) {
  const file = servicePath(key);
  if (!existsSync(file)) return;
  if (serviceKind() === 'launchd') await run('launchctl', ['bootout', `gui/${userInfo().uid}/${label(key)}`]);
  else await run('systemctl', ['--user', 'disable', '--now', unitName(key)]);
  rmSync(file, { force: true });
  if (serviceKind() === 'systemd') await run('systemctl', ['--user', 'daemon-reload']);
}

/** Whether the service is installed and running. @param {string} key @returns {Promise<'running' | 'stopped' | 'none'>} */
export async function serviceState(key) {
  if (!existsSync(servicePath(key))) return 'none';
  if (serviceKind() === 'launchd') {
    const printed = await run('launchctl', ['print', `gui/${userInfo().uid}/${label(key)}`]);
    return printed.ok && /state = running/.test(printed.out) ? 'running' : 'stopped';
  }
  return (await run('systemctl', ['--user', 'is-active', unitName(key)])).out === 'active' ? 'running' : 'stopped';
}
