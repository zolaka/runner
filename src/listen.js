// @ts-check
// The runner's loop: ask Zolaka for work at the pace it sets, take an offer when no run is in
// progress, start the command, report how it ended. It keeps asking during a run, which is how
// Zolaka knows it is still listening. One run at a time.

/**
 * @typedef {import('./api.js').Reply} Reply
 * @typedef {import('./run.js').RunResult} RunResult
 * @typedef {{ messages: number, decisions: number, changed: number }} Job
 * @typedef {{ ask: () => Promise<Reply>, claim: (id: string) => Promise<Reply>, done: (id: string, report: RunResult) => Promise<Reply> }} Client
 */

import { describeRun } from './run.js';

/** Waits after errors: longer each time, up to a minute. */
const BACKOFF_S = [15, 30, 60];
/** The pace Zolaka sets is kept within these: often enough to count as listening, never a busy loop. */
const MIN_ASK_S = 5;
const MAX_ASK_S = 120;
/** A report that does not get through is tried this many times, a little later each time. */
const REPORT_TRIES = 6;
/** However often Zolaka offers work, this runner starts no more runs than this in an hour: each one spends your plan. */
export const MAX_RUNS_PER_HOUR = 30;

/**
 * Sleep, or wake early when the runner is stopping. @param {number} ms @param {AbortSignal} stop
 * @returns {Promise<void>}
 */
export function sleep(ms, stop) {
  return new Promise((done) => {
    if (stop.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      stop.removeEventListener('abort', finish);
      done();
    }
    stop.addEventListener('abort', finish, { once: true });
  });
}

/** Whether an answer is worth asking for again: no answer, a server error, or "slow down". @param {Reply} reply */
const again = (reply) => reply.status === 0 || reply.status >= 500 || reply.status === 429 || reply.status === 408;

/** The three numbers a claim answers with, or null if it answered anything else. @param {any} body @returns {Job | null} */
function jobOf(body) {
  const count = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0;
  return body && count(body.messages) && count(body.decisions) && count(body.changed) ? { messages: body.messages, decisions: body.decisions, changed: body.changed } : null;
}

/**
 * @param {object} o
 * @param {Client} o.client
 * @param {(job: Job) => Promise<RunResult>} o.start  runs the command
 * @param {(line: string) => void} o.say
 * @param {AbortSignal} o.stop
 * @param {(ms: number, stop: AbortSignal) => Promise<void>} [o.wait]
 * @param {() => number} [o.now]
 * @returns {Promise<'stopped' | 'refused'>} refused: Zolaka no longer accepts this runner
 */
export async function listen({ client, start, say, stop, wait = sleep, now = Date.now }) {
  /** @type {Promise<void> | null} */
  let running = null;
  /** A claim whose answer never arrived: asked again before anything else, since Zolaka may have counted it. @type {string | null} */
  let unanswered = null;
  /** @type {number[]} */
  const starts = [];
  /** When the owner was last told the hourly limit was reached: said once per hour of it. */
  let saidLimitMs = -Infinity;
  let errors = 0;
  let listening = false;

  const take = async (/** @type {string} */ id) => {
    const claimed = await client.claim(id);
    unanswered = again(claimed) ? id : null;
    const job = claimed.status === 200 ? jobOf(claimed.body) : null;
    if (!job) return;
    if (stop.aborted) {
      // Taken at the moment the runner was told to stop: said so, and Zolaka offers it again.
      running = report(client, id, { exit_code: null, duration_ms: 0, cause: 'stopped' }, say, stop, wait);
      return;
    }
    starts.push(now());
    say(`Starting a run for ${job.messages} message${job.messages === 1 ? '' : 's'}.`);
    running = start(job)
      .catch(() => /** @type {RunResult} */ ({ exit_code: 127, duration_ms: 0, cause: null }))
      .then((result) => report(client, id, result, say, stop, wait))
      .finally(() => {
        running = null;
      });
  };

  while (!stop.aborted) {
    const asked = await client.ask();
    if (stop.aborted) break;
    if (asked.status === 401 || asked.status === 403) {
      // 401: the token stopped working. 403: the agent is no longer started by a runner. Either way the server's own sentence says why.
      say(
        asked.status === 401
          ? 'Zolaka refused this runner’s token: the agent was disabled, its Runner token was revoked on its page, or a runner was connected for it again elsewhere. To connect this computer again, paste a new line from the agent’s page.'
          : `Zolaka no longer gives this runner work: ${asked.body?.error?.message ?? 'refused'}`,
      );
      await running;
      return 'refused';
    }
    if (asked.status !== 200) {
      const waitS = BACKOFF_S[Math.min(errors, BACKOFF_S.length - 1)] ?? 60;
      errors += 1;
      if (errors === 1 || errors % 10 === 0) say(`Could not reach Zolaka (${asked.status === 0 ? 'no answer' : `HTTP ${asked.status}`}). Trying again in ${waitS} seconds.`);
      listening = false;
      await wait(waitS * 1000, stop);
      continue;
    }
    if (!listening) say(errors > 0 ? 'Reached Zolaka again. Listening.' : 'Listening for work.');
    listening = true;
    errors = 0;
    const offer = unanswered ?? (typeof asked.body?.offer === 'string' ? asked.body.offer : null);
    if (offer && !running) {
      while (starts.length > 0 && now() - /** @type {number} */ (starts[0]) >= 3_600_000) starts.shift();
      if (starts.length < MAX_RUNS_PER_HOUR) await take(offer);
      else if (now() - saidLimitMs >= 3_600_000) {
        saidLimitMs = now();
        say(`This runner has started ${MAX_RUNS_PER_HOUR} runs in the last hour and starts no more until that passes, whatever Zolaka offers.`);
      }
    }
    await wait(Math.min(MAX_ASK_S, Math.max(MIN_ASK_S, Number(asked.body?.next_s) || 15)) * 1000, stop);
  }
  // Stopping: a run in progress has been told to end (run.js), and its result is still reported.
  await running;
  return 'stopped';
}

/**
 * Tell Zolaka how a run ended. Tried again when the answer does not arrive or says to slow down;
 * any other refusal is final.
 * @param {Client} client @param {string} id @param {RunResult} result @param {(line: string) => void} say
 * @param {AbortSignal} stop @param {(ms: number, stop: AbortSignal) => Promise<void>} wait
 */
async function report(client, id, result, say, stop, wait) {
  say(`The run ${describeRun(result)}.`);
  for (let n = 1; n <= REPORT_TRIES; n++) {
    const sent = await client.done(id, result);
    if (sent.status === 200) return;
    if (!again(sent)) return say(`Zolaka did not take the report of this run (${sent.body?.error?.message ?? `HTTP ${sent.status}`}). It judges the run by whether the agent picked its messages up.`);
    // When stopping there is no time to wait: one try, and Zolaka judges the run itself.
    if (stop.aborted) break;
    await wait(5000 * n, stop);
  }
  say('Could not tell Zolaka how the run ended. It judges the run by whether the agent picked its messages up.');
}
