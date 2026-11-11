// @ts-check
// The tools the runner knows how to start, and how it checks them. A preset only ever starts the
// tool the owner chose when connecting: the server names a preset once, in the answer to the
// code, and never sends a command. A command of the owner's own is started exactly as typed,
// without a shell.

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { paths, privateDir, writePrivate } from './config.js';

/** @typedef {import('./config.js').AgentConfig} AgentConfig */

/**
 * Each preset: what it is called, the program to find, where its installers put that program
 * when it is not on the PATH, and the one command that fixes it being missing or signed out.
 */
export const TOOLS = /** @type {const} */ ({
  codex: {
    name: 'Codex',
    bin: 'codex',
    // The ChatGPT desktop app on macOS carries its own copy.
    places: ['/Applications', join(homedir(), 'Applications')].map((dir) => join(dir, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')),
    install: 'npm install -g @openai/codex (or install the ChatGPT desktop app, which includes it)',
    signIn: 'codex login (on a computer without a browser: codex login --device-auth)',
  },
  claude: {
    name: 'Claude Code',
    bin: 'claude',
    places: [join(homedir(), '.local', 'bin', 'claude')],
    install: 'npm install -g @anthropic-ai/claude-code',
    // The desktop app signs in only for itself.
    signIn: 'claude auth login',
  },
  antigravity: {
    name: 'Antigravity',
    bin: 'agy',
    // Its installer's default, and where the Antigravity app puts it.
    places: [join(homedir(), '.local', 'bin', 'agy'), join(homedir(), '.gemini', 'bin', 'agy')],
    install: 'the installer at https://antigravity.google/docs/getting-started',
    signIn: 'agy (run it once and sign in)',
  },
});

/** @param {AgentConfig} config */
export const toolName = (config) => (config.preset === 'custom' ? 'Your command' : TOOLS[config.preset].name);

/**
 * Find a program the way a shell would, on this PATH. @param {string} name
 * @returns {string | null} its absolute path
 */
export function which(name) {
  const candidates = isAbsolute(name) || name.includes('/') ? [resolve(name)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const path of candidates) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return null;
}

/** A preset's tool: on the PATH first, then where its installers put it. @param {keyof typeof TOOLS} preset */
export function findTool(preset) {
  return which(TOOLS[preset].bin) ?? TOOLS[preset].places.find((path) => which(path)) ?? null;
}

/** The folder a program really lives in (through symlinks), for the service's PATH. @param {string} path */
export function realDir(path) {
  try {
    return dirname(realpathSync(path));
  } catch {
    return dirname(path);
  }
}

/**
 * Run a short command and say how it went. Never throws.
 * @param {string} file @param {string[]} args
 * @returns {Promise<{ ok: boolean, out: string }>}
 */
export function check(file, args) {
  return new Promise((done) => execFile(file, args, { timeout: 20_000 }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout}${stderr}`.trim() })));
}

/**
 * Whether a folder is inside a Git repository, as Codex judges it: a .git entry here or above.
 * @param {string} dir
 */
export function insideGit(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * What to start for a run. The token is not in it: Codex and your own command find it in their
 * environment, Claude Code and Antigravity in the settings file the runner writes for them.
 * @param {AgentConfig} config
 * @returns {string[]}
 */
export function commandFor(config) {
  const [tool = ''] = config.command;
  const mcp = `${config.api_url}/mcp`;
  switch (config.preset) {
    case 'codex':
      // Zolaka's tools for this run only, the token read from the environment: Codex's own settings are not touched.
      // Codex refuses to run outside a Git repository unless told to; the owner chose this folder, and connect said so.
      return [tool, 'exec', ...(insideGit(config.cwd) ? [] : ['--skip-git-repo-check']), '-c', `mcp_servers.zolaka.url="${mcp}"`, '-c', 'mcp_servers.zolaka.bearer_token_env_var="ZOLAKA_TOKEN"', '-'];
    case 'claude':
      // -p reads the task from standard input. Allowed for this run: Zolaka's own tools, and nothing more.
      return [tool, '-p', '--mcp-config', paths.mcp(config.key), '--allowedTools', 'mcp__zolaka'];
    case 'antigravity':
      // agy reads the task from standard input. --settings applies to this run only and is never saved: it allows
      // Zolaka's tools and nothing more. --add-dir brings in the runner's own folder, whose .agents/mcp_config.json names Zolaka.
      return [tool, '--settings', JSON.stringify({ permissions: { allow: ['mcp(zolaka/*)'] } }), '--add-dir', paths.agy(config.key)];
    default:
      return config.command;
  }
}

/**
 * Before each run, write where Zolaka's tools are for the two tools that cannot be told on the
 * command line with the token left in the environment (tried: Antigravity sends `${VAR}` as
 * written). The file holds the token and only you can read it. Written every time, so that a
 * run that changed it cannot make the change last.
 * @param {AgentConfig} config
 */
export function writeMcp(config) {
  const headers = { Authorization: `Bearer ${config.token}` };
  if (config.preset === 'claude') {
    writePrivate(paths.mcp(config.key), JSON.stringify({ mcpServers: { zolaka: { type: 'http', url: `${config.api_url}/mcp`, headers } } }));
  }
  if (config.preset === 'antigravity') {
    const dir = join(paths.agy(config.key), '.agents');
    privateDir(paths.agy(config.key));
    privateDir(dir);
    writePrivate(join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: { zolaka: { serverUrl: `${config.api_url}/mcp`, headers } } }));
  }
}

/**
 * Check what a run would start: that the program and the folder are there, and that the tool is
 * signed in where that can be asked. Each problem comes with what fixes it.
 * @param {AgentConfig} config
 * @returns {Promise<string[]>} the problems, none when all is well
 */
export async function checkTool(config) {
  const [path = ''] = config.command;
  if (!existsSync(config.cwd)) return [`The folder it runs in is gone: ${config.cwd}. Paste a new line from the agent’s page in the folder it should work in.`];
  if (config.preset === 'custom') return which(path) ? [] : [`Your command was not found: ${path || '(none given)'}. Give it again, with its full path.`];
  const tool = TOOLS[config.preset];
  if (!which(path)) return [`${tool.name} is not installed, or not where this terminal looks for programs. Install it with: ${tool.install}`];
  if (!(await check(path, ['--version'])).ok) return [`${tool.name} did not start (${path} --version failed). Install it again with: ${tool.install}`];
  // Antigravity has no command that says whether it is signed in: a signed-out run fails, and the notice says why.
  const signedIn = config.preset === 'codex' ? await check(path, ['login', 'status']) : config.preset === 'claude' ? await check(path, ['auth', 'status']) : null;
  if (signedIn && (!signedIn.ok || /not logged in|"loggedIn":\s*false/i.test(signedIn.out))) return [`${tool.name} is not signed in on this computer’s command line. Sign in with: ${tool.signIn}`];
  return [];
}
