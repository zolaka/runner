// @ts-check
// Where the runner keeps what it needs: one folder per connected agent, which only you can read.
//
//   ~/.zolaka/agents/<key>/config.json   the agent's settings and its token (mode 600)
//   ~/.zolaka/agents/<key>/state.json    how the last run ended, for `zolaka status`
//   ~/.zolaka/agents/<key>/run.log       the runner's own lines and every run's output
//   ~/.zolaka/agents/<key>/mcp.json      Claude Code only: where Zolaka's tools are (holds the token)
//   ~/.zolaka/agents/<key>/agy/          Antigravity only: a folder with the same, added to each run
//   ~/.zolaka/runner/                    a copy of this program, for the background service
//
// <key> is the workspace ID and the agent's address, so one computer can run several agents.
// ZOLAKA_HOME moves the folder (the tests use it).

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {'codex' | 'claude' | 'antigravity' | 'custom'} Preset
 *
 * @typedef {object} AgentConfig
 * @property {string} key          `<workspace>.<agent>`
 * @property {string} api_url      where Zolaka's API is, with no slash at the end
 * @property {string} agent_id
 * @property {string} display_name
 * @property {string} workspace    the workspace's name
 * @property {string} token        the runner's token for this agent
 * @property {Preset} preset
 * @property {string[]} command    what to start: the tool's full path, or your own command as you typed it
 * @property {string} cwd          the folder the command runs in
 * @property {number} timeout_min  a run is stopped after this long
 *
 * @typedef {{ exit_code: number | null, duration_ms: number, cause: string | null, finished_ms: number }} LastRun
 */

export const home = () => process.env.ZOLAKA_HOME || join(homedir(), '.zolaka');

export const paths = {
  agents: () => join(home(), 'agents'),
  runner: () => join(home(), 'runner'),
  /** @param {string} key */
  dir: (key) => join(home(), 'agents', key),
  /** @param {string} key */
  log: (key) => join(home(), 'agents', key, 'run.log'),
  /** @param {string} key */
  mcp: (key) => join(home(), 'agents', key, 'mcp.json'),
  /** @param {string} key */
  agy: (key) => join(home(), 'agents', key, 'agy'),
};

/**
 * Make a folder that only you can read, and everything above it inside the runner's home.
 * @param {string} dir
 */
export function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Write a file only you can read, replacing it whole.
 * @param {string} path @param {string} text
 */
export function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** @param {AgentConfig} config */
export function saveConfig(config) {
  for (const dir of [home(), paths.agents(), paths.dir(config.key)]) privateDir(dir);
  writePrivate(join(paths.dir(config.key), 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** @param {string} key @param {string} file */
function read(key, file) {
  try {
    return JSON.parse(readFileSync(join(paths.dir(key), file), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} key @returns {AgentConfig | null} */
export const loadConfig = (key) => read(key, 'config.json');

/** Every agent connected on this computer. @returns {AgentConfig[]} */
export function allConfigs() {
  if (!existsSync(paths.agents())) return [];
  return readdirSync(paths.agents())
    .map(loadConfig)
    .filter((config) => config !== null);
}

/** @param {string} key @returns {LastRun | null} */
export const loadLastRun = (key) => read(key, 'state.json');

/** Never throws: a full disk must not turn a finished run into a crash. @param {string} key @param {LastRun} run */
export function saveLastRun(key, run) {
  try {
    writePrivate(join(paths.dir(key), 'state.json'), `${JSON.stringify(run)}\n`);
  } catch {
    // `zolaka status` then shows the run before this one.
  }
}

/**
 * Remove everything kept for one agent, and once no agent is left, the copy of the runner and
 * the folders, if nothing else is in them.
 * @param {string} key
 */
export function forget(key) {
  rmSync(paths.dir(key), { recursive: true, force: true });
  if (allConfigs().length > 0) return;
  rmSync(paths.runner(), { recursive: true, force: true });
  for (const dir of [paths.agents(), home()]) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty, or not there: left as it is
    }
  }
}
