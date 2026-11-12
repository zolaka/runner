// @ts-check
// The runner's commands. Start reading here. Most people only ever paste the first, from the
// agent's page; `HELP` below lists them all.

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { call, client, reason } from './api.js';
import { allConfigs, forget, loadConfig, loadLastRun, paths, saveConfig, saveLastRun } from './config.js';
import { listen } from './listen.js';
import { describeRun, logTo, runOnce } from './run.js';
import { install, serviceKind, serviceState, specFor, uninstall } from './service.js';
import { taskText } from './task.js';
import { TOOLS, checkTool, commandFor, findTool, insideGit, realDir, toolName, which, writeMcp } from './tools.js';
import { VERSION } from './version.js';

/** @typedef {import('./config.js').AgentConfig} AgentConfig */

const PRODUCTION_API = 'https://api.zolaka.com';
const CMD = 'npx -y @zolaka/runner@latest';

const HELP = `The Zolaka runner ${VERSION}: starts Codex, Claude Code, Antigravity or your own command on this computer when a message arrives for the agent.

  ${CMD} connect <code>              connect this computer, with the line from the agent's page
  ${CMD} connect <code> -- <command> the same, for a command of your own
  ${CMD} start [agent]               start it again from its saved settings (after fixing what connect found)
  ${CMD} status                      is it running, how did the last run end, where is the log
  ${CMD} doctor                      check the tool, the folder, the token and the background service
  ${CMD} disconnect [agent]          stop it, remove what it installed, and end its token

Options for connect and start:
  --yes            keep it running in the background without asking
  --no-service     run in this terminal only
  --timeout <min>  stop a run after this many minutes (60)
  --api <url>      the Zolaka API (the line on the agent's page adds it when needed)

It sends Zolaka the exit status of each run, how long it took and, when the run did not end well, one of a few fixed causes. Never the output, never a file.`;

/** Print for a person. Names from the server are not trusted to be plain text: control characters are dropped. @param {string} text */
const say = (text) => console.log(text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ''));

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit status
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (Number(process.versions.node.split('.')[0]) < 20) return fail(`The runner needs Node.js 20 or later; this is ${process.versions.node}. Install a newer one from https://nodejs.org and paste the line again.`);
  // Not built for Windows yet: its tools start through a shell there, which this runner does not use.
  if (process.platform === 'win32') return fail('The runner does not run on Windows yet. It runs on macOS and Linux, and on Windows inside WSL.');
  try {
    if (command === 'connect') return await connect(rest);
    if (command === 'start') return await start(rest);
    if (command === 'run') return await run(rest[0]);
    if (command === 'status') return await status();
    if (command === 'doctor') return await doctor();
    if (command === 'disconnect') return await disconnect(rest[0]);
    if (command === '--version' || command === 'version') return say(VERSION), 0;
    say(HELP);
    return command === undefined || command === 'help' || command === '--help' || command === '-h' ? 0 : 1;
  } catch (err) {
    return fail(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** @param {string} text */
const fail = (text) => (say(text), 1);

/**
 * The options of connect and start. Anything not understood is refused before a code is spent.
 * @param {string[]} args
 */
function options(args) {
  const dash = args.indexOf('--');
  const flags = dash >= 0 ? args.slice(0, dash) : args;
  /** @type {{ words: string[], api: string, yes: boolean, service: boolean, timeout: number | null, own: string[] }} */
  const o = { words: [], api: PRODUCTION_API, yes: false, service: true, timeout: null, own: dash >= 0 ? args.slice(dash + 1) : [] };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? '';
    if (flag === '--yes' || flag === '-y') o.yes = true;
    else if (flag === '--no-service') o.service = false;
    else if (flag === '--api') o.api = (flags[++i] ?? '').replace(/\/+$/, '');
    else if (flag === '--timeout') {
      o.timeout = Number(flags[++i]);
      if (!Number.isInteger(o.timeout) || o.timeout < 1 || o.timeout > 24 * 60) throw new Error('--timeout takes a whole number of minutes, from 1 to 1440.');
    } else if (flag.startsWith('-')) throw new Error(`There is no option ${flag}. Options: --yes, --no-service, --timeout <minutes>, --api <url>.`);
    else o.words.push(flag);
  }
  if (!/^https:\/\/[^/\s]+$/.test(o.api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o.api)) throw new Error('The API address must start with https:// and have nothing after its host.');
  return o;
}

/** @param {string[]} args */
async function connect(args) {
  const o = options(args);
  const code = (o.words[0] ?? '').toLowerCase();
  if (o.words.length !== 1 || !/^[ue][a-z2-7]{15}(?:-[a-z2-7]{4}){4}$/.test(code)) {
    return fail(o.words.length > 1 ? 'A command of your own goes after two dashes: connect <code> -- your-command' : 'That is not a connect code. On the agent’s page, choose Show the line to paste, and paste the whole line.');
  }
  if (o.api !== PRODUCTION_API) say(`Using the Zolaka API at ${o.api}`);

  // The code, for a token. It works once, so from here on what was received is kept whatever happens next.
  const answer = await call(o.api, 'POST', '/v1/connect', { body: { code } });
  if (answer.status !== 200) return fail(`Zolaka did not accept the line: ${reason(answer)}`);
  const got = answer.body ?? {};
  // What the server says is checked before any of it reaches a file name, a command or the screen.
  if (typeof got.agent_id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(got.agent_id) || typeof got.token !== 'string' || !/^zlk_[A-Za-z0-9_-]{20,200}$/.test(got.token)) {
    return fail('Zolaka’s answer was not what this runner expects. Nothing was saved. Is this the newest runner?');
  }
  // A tool this runner has never heard of is not guessed at.
  if (o.own.length === 0 && got.preset !== 'custom' && !Object.hasOwn(TOOLS, got.preset)) return fail('Zolaka named a tool this runner does not know. Nothing was saved. Is this the newest runner?');
  /** @type {import('./config.js').Preset} */
  const preset = o.own.length > 0 ? 'custom' : got.preset;
  /** @type {AgentConfig} */
  const config = {
    key: `${code.slice(0, 16)}.${got.agent_id}`,
    api_url: o.api,
    agent_id: got.agent_id,
    display_name: String(got.display_name ?? got.agent_id).slice(0, 100),
    workspace: String(got.workspace ?? '').slice(0, 100),
    token: got.token,
    preset,
    command: preset === 'custom' ? [which(o.own[0] ?? '') ?? o.own[0] ?? '', ...o.own.slice(1)] : [findTool(preset) ?? TOOLS[preset].bin],
    cwd: process.cwd(),
    timeout_min: o.timeout ?? 60,
  };
  saveConfig(config);
  say(`This computer now holds a token for ${config.display_name} (${config.workspace}). ${toolName(config)} will run in ${config.cwd}.`);
  if (preset === 'codex' && !insideGit(config.cwd)) say('This folder is not in a Git repository, so Codex is told to run here anyway; changes it makes here cannot be undone with Git. To run it in a project instead, paste a new line from inside that project’s folder.');
  return begin(config, o);
}

/**
 * Start a connected agent's runner from its saved settings: after fixing what connect found, or
 * after the service was removed. `-- command` gives or replaces a command of your own.
 * @param {string[]} args
 */
async function start(args) {
  const o = options(args);
  const config = one(o.words[0]);
  if (!config) return 1;
  if (o.own.length > 0) Object.assign(config, { preset: 'custom', command: [which(o.own[0] ?? '') ?? o.own[0] ?? '', ...o.own.slice(1)] });
  if (o.timeout) config.timeout_min = o.timeout;
  saveConfig(config);
  return begin(config, o);
}

/**
 * Check the tool, then keep the runner going: in the background if the owner agrees, or here.
 * @param {AgentConfig} config @param {{ yes: boolean, service: boolean }} o
 */
async function begin(config, o) {
  const again = `${CMD} start${allConfigs().length > 1 ? ` ${config.agent_id}` : ''}`;
  const problems = await checkTool(config);
  if (problems.length > 0) {
    for (const problem of problems) say(`! ${problem}`);
    return fail(`Nothing is running yet. When that is fixed, start it with: ${again}${config.preset === 'custom' ? ' -- your-command' : ''}`);
  }
  const kind = serviceKind();
  if (o.service && kind) {
    let keep = o.yes;
    try {
      keep ||= await ask('Keep it running in the background, and start it when you log in? [Y/n] ');
    } catch {
      return fail(`\nStopped before anything was started. Start it with: ${again}`);
    }
    if (keep) {
      const [tool = ''] = config.command;
      const failed = await install(specFor(config.key, realDir(tool)));
      if (!failed) {
        say(`It is running in the background. The agent’s page shows Listening within a few seconds.\nIts log: ${paths.log(config.key)}\nCheck it any time with: ${CMD} status`);
        if (kind === 'launchd') say('If macOS says that “node” can now run in the background, that is this runner.');
        if (kind === 'systemd') say('On a server you log out of, also run: loginctl enable-linger $USER');
        return 0;
      }
      say(`! It could not be set to run in the background (${failed}). Running it here instead.`);
    }
  }
  say('Running in this terminal. Keep it open; stop with Ctrl-C.');
  return listenFor(config);
}

/** Yes unless the answer starts with n. Without a terminal to ask in: no. @param {string} question @returns {Promise<boolean>} */
async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * The one agent a command is about: the one named, or the only one. Says what is wrong otherwise.
 * @param {string | undefined} name  its address, or its key
 * @returns {AgentConfig | null}
 */
function one(name) {
  const all = allConfigs();
  const found = all.filter((c) => !name || c.agent_id === name || c.key === name);
  if (found.length === 1) return found[0] ?? null;
  if (found.length === 0) say(name ? `No agent ${name} is connected on this computer.` : 'No agent is connected on this computer. Paste the line from the agent’s page.');
  else say(`Several agents are connected on this computer. Name one: ${found.map((c) => (found.filter((d) => d.agent_id === c.agent_id).length > 1 ? c.key : c.agent_id)).join(', ')}`);
  return null;
}

/** What the background service runs: listen, with no questions. @param {string | undefined} key */
async function run(key) {
  const config = key ? loadConfig(key) : null;
  // Exit status 0: the service must not start it again every 30 seconds for an agent that was disconnected.
  if (!config) return say(`No agent ${key ?? ''} is connected on this computer.`), 0;
  return listenFor(config);
}

/** Listen until stopped. @param {AgentConfig} config */
async function listenFor(config) {
  const stopper = new AbortController();
  const stop = () => stopper.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const log = paths.log(config.key);
  // The runner's own lines go to the screen and to the log, so the log is whole also when nothing shows the screen.
  const note = (/** @type {string} */ text) => {
    const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${text}`;
    say(line);
    logTo(log, `${line}\n`);
  };
  // Only Codex and a command of your own are handed the token; Claude Code and Antigravity read it from the file written for them.
  /** @type {Record<string, string>} */
  const env = config.preset === 'codex' || config.preset === 'custom' ? { ZOLAKA_TOKEN: config.token, ZOLAKA_API_URL: config.api_url, ZOLAKA_MCP_URL: `${config.api_url}/mcp` } : {};
  note(`Runner ${VERSION} for ${config.display_name} (${config.workspace}). Output of each run: ${log}`);
  const ended = await listen({
    client: client(config),
    say: note,
    stop: stopper.signal,
    start: async (job) => {
      if (!existsSync(paths.dir(config.key))) throw new Error('disconnected');
      writeMcp(config);
      const result = await runOnce({ argv: commandFor(config), cwd: config.cwd, env, task: taskText(config, job), timeoutMs: config.timeout_min * 60_000, log, stop: stopper.signal });
      saveLastRun(config.key, { ...result, finished_ms: Date.now() });
      return result;
    },
  });
  if (existsSync(paths.dir(config.key))) logTo(log, `--- runner ${ended} ${new Date().toISOString()}\n`);
  // A refused token is not a failure to start again from: the service stays stopped until this computer is connected again.
  return 0;
}

async function status() {
  const configs = allConfigs();
  if (configs.length === 0) return say('No agent is connected on this computer. Paste the line from the agent’s page.'), 0;
  for (const c of configs) {
    const last = loadLastRun(c.key);
    const service = await serviceState(c.key);
    say(`${c.display_name} (${c.workspace})`);
    say(`  Starts:     ${commandFor(c).join(' ')}`);
    say(`  In:         ${c.cwd}`);
    say(`  Background: ${service === 'running' ? 'running' : service === 'stopped' ? `installed but not running. Start it again with: ${CMD} start ${c.agent_id}` : 'not installed. If it is not running in a terminal either, start it with: ' + `${CMD} start ${c.agent_id}`}`);
    say(`  Last run:   ${last ? `${describeRun(last)}, at ${new Date(last.finished_ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'none yet'}`);
    say(`  Log:        ${paths.log(c.key)}`);
  }
  return 0;
}

async function doctor() {
  let problems = 0;
  const report = (/** @type {boolean} */ ok, /** @type {string} */ text) => {
    if (!ok) problems++;
    say(`${ok ? 'ok' : '!!'}  ${text}`);
  };
  report(true, `Node.js ${process.versions.node}`);
  const configs = allConfigs();
  if (configs.length === 0) say('No agent is connected on this computer. Paste the line from the agent’s page.');
  for (const c of configs) {
    say(`\n${c.display_name} (${c.workspace})`);
    // Exactly what a run starts, and where.
    const found = await checkTool(c);
    report(found.length === 0, found[0] ?? `${toolName(c)}: ${c.command[0]}, in ${c.cwd}`);
    const asked = await client(c).check();
    report(asked.status === 200, asked.status === 200 ? 'Zolaka accepts its token' : asked.status === 401 ? 'Zolaka refuses its token: paste a new line from the agent’s page' : `Zolaka: ${reason(asked)}`);
    const service = await serviceState(c.key);
    report(service !== 'stopped', service === 'running' ? 'Running in the background' : service === 'stopped' ? `Installed in the background but not running. Start it again with: ${CMD} start ${c.agent_id}` : 'Not installed in the background (it runs only while a terminal runs it)');
  }
  return problems === 0 ? 0 : 1;
}

/** @param {string | undefined} name */
async function disconnect(name) {
  const config = one(name);
  if (!config) return name || allConfigs().length > 0 ? 1 : 0;
  await uninstall(config.key);
  // The token is ended on Zolaka too, so a copy of it left anywhere is worth nothing.
  const ended = (await client(config).disconnect()).status === 200;
  forget(config.key);
  say(`Disconnected ${config.display_name}: its background service, settings, token and log are removed from this computer.${ended ? ' Its token no longer works.' : ` Zolaka could not be told, so the token still works there: revoke the token named Runner on the agent’s page.`}`);
  return 0;
}
