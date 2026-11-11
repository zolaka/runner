// @ts-check
// One run: start the agent's command, give it its task on standard input, wait for it to end.
// Its output goes to the log on this computer and nowhere else. Only the exit status, how long
// it took, and a cause from a fixed list leave the computer, and the cause is found here, by
// matching a few phrases the tools are known to print.

import { spawn } from 'node:child_process';
import { appendFileSync, renameSync, statSync } from 'node:fs';

/** How much of the end of the output is looked at for a cause. */
const TAIL_BYTES = 4000;
/** After asking a command to stop, how long before it is made to. */
const KILL_AFTER_MS = 10_000;
/** After the command has exited, how long its last output is waited for. */
const DRAIN_MS = 2000;
/** A log over this size is moved aside, keeping one older copy. */
const LOG_MAX_BYTES = 5_000_000;

/** Phrases the tools print, and what they mean. A tool that rewords one simply reports no cause. */
const CAUSES = /** @type {const} */ ([
  // Codex: "You've hit your usage limit" (from its issues; not seen in a real run). Claude Code: "usage limit reached".
  ['usage_limit', /you['’]ve hit your usage limit|usage limit (?:reached|exceeded)|reached your usage limit|\b(?:5-hour|weekly) limit reached|exceeded your current quota/i],
  // Seen in real runs on 2026-11-10. Codex 0.167 signed out: "401 Unauthorized: Missing bearer or basic authentication … api.openai.com".
  // Claude Code 2.1 signed out: "Failed to authenticate". Antigravity (its docs and log): "authentication required", "not logged into Antigravity".
  ['not_signed_in', /not logged in|not signed in|not logged into antigravity|failed to authenticate|authentication (?:failed|required)|missing bearer or basic authentication|401 unauthorized[^\n]*api\.openai\.com/i],
]);

/** @param {string} tail @returns {'usage_limit' | 'not_signed_in' | null} */
export function causeOf(tail) {
  for (const [cause, pattern] of CAUSES) if (pattern.test(tail)) return cause;
  return null;
}

/**
 * Append to a log, moving it aside when it grows large. Never throws: a full disk must not stop a run.
 * @param {string} path @param {string | Buffer} text
 */
export function logTo(path, text) {
  try {
    if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
  try {
    appendFileSync(path, text, { mode: 0o600 });
  } catch {
    // nowhere to write
  }
}

/**
 * @typedef {object} RunResult
 * @property {number | null} exit_code   null when it was stopped by a signal
 * @property {number} duration_ms
 * @property {'usage_limit' | 'not_signed_in' | 'timeout' | 'stopped' | null} cause
 */

/** How a run ended, in a few words. @param {{ exit_code: number | null, duration_ms: number, cause: string | null }} run */
export function describeRun(run) {
  const how = run.exit_code === 0 ? 'finished' : run.exit_code === null ? 'was stopped' : `failed with exit status ${run.exit_code}`;
  return `${how} after ${Math.round(run.duration_ms / 1000)} seconds${run.cause ? ` (${run.cause.replace(/_/g, ' ')})` : ''}`;
}

/**
 * @param {object} o
 * @param {string[]} o.argv              the command, started without a shell
 * @param {string} o.cwd
 * @param {Record<string, string>} o.env  added to this process's environment
 * @param {string} o.task                given on standard input, never on the command line
 * @param {number} o.timeoutMs
 * @param {string} o.log                 where the output goes
 * @param {AbortSignal} [o.stop]         the runner is stopping: end the run
 * @param {number} [o.killAfterMs]       after asking it to stop, how long before it is made to
 * @returns {Promise<RunResult>}
 */
export function runOnce({ argv, cwd, env, task, timeoutMs, log, stop, killAfterMs = KILL_AFTER_MS }) {
  const started = Date.now();
  const [file = '', ...args] = argv;
  logTo(log, `\n--- run started ${new Date(started).toISOString()}: ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
  return new Promise((done) => {
    let tail = Buffer.alloc(0);
    /** @type {'timeout' | 'stopped' | null} */
    let ended = null;
    let finished = false;
    // In a process group of its own, so that ending the run also ends whatever the tool started.
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const signal = (/** @type {NodeJS.Signals} */ name) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        // already gone
      }
    };
    const keep = (/** @type {Buffer} */ chunk) => {
      tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
      logTo(log, chunk);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.stdin.on('error', () => {}); // a command that does not read its input
    child.stdin.end(task);

    /** @type {NodeJS.Timeout | undefined} */
    let killer;
    const end = (/** @type {'timeout' | 'stopped'} */ why) => {
      if (finished || ended) return;
      ended = why;
      signal('SIGTERM');
      killer = setTimeout(() => signal('SIGKILL'), killAfterMs);
    };
    const limit = setTimeout(() => end('timeout'), timeoutMs);
    const onStop = () => end('stopped');
    if (stop?.aborted) onStop();
    else stop?.addEventListener('abort', onStop, { once: true });

    const finish = (/** @type {number | null} */ code) => {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      clearTimeout(killer);
      stop?.removeEventListener('abort', onStop);
      // Anything the tool left behind in its group goes with it: one run at a time, and nothing after it.
      signal('SIGKILL');
      /** @type {RunResult} */
      const result = { exit_code: code, duration_ms: Date.now() - started, cause: ended ?? (code === 0 ? null : causeOf(tail.toString('utf8'))) };
      logTo(log, `\n--- run ${describeRun(result)}\n`);
      done(result);
    };
    child.on('error', (/** @type {Error} */ err) => {
      logTo(log, `\n--- could not start ${file}: ${err.message}\n`);
      finish(127);
    });
    // The run ends when the command exits. Its output is given a moment to arrive, and not longer:
    // a process it left running may hold the output open for ever.
    child.on('exit', (code) => setTimeout(() => finish(code), DRAIN_MS).unref());
    child.on('close', (code) => finish(code));
  });
}
