// @ts-check
// Every call the runner makes to Zolaka. It sends nothing else: no output, no files.
//
//   POST /v1/connect            the one-time code from the agent's page, for the runner's token
//   GET  /v1/wake               is there work? (every 15 seconds, or as the answer says)
//   GET  /v1/wake?check=1       does the token work? (`zolaka doctor`; not counted as asking)
//   POST /v1/wake/{id}/claim    take the work: the answer is three numbers
//   POST /v1/wake/{id}/done     how the run ended: exit status, how long, a cause from a fixed list
//   POST /v1/wake/disconnect    `zolaka disconnect`: the token stops working

import { VERSION } from './version.js';

/**
 * @typedef {{ status: number, body: any }} Reply
 * A status of 0 means no answer arrived (offline, a timeout).
 */

/**
 * @param {string} apiUrl
 * @param {string} method
 * @param {string} path
 * @param {{ token?: string, body?: unknown }} [options]
 * @returns {Promise<Reply>}
 */
export async function call(apiUrl, method, path, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'user-agent': `zolaka-runner/${VERSION}` };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(apiUrl + path, {
      method,
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } catch {
      return { status: res.status, body: { error: { message: text.slice(0, 200) } } };
    }
  } catch {
    return { status: 0, body: null };
  }
}

/** The calls for one connected agent. @param {{ api_url: string, token: string }} config */
export function client(config) {
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const send = (method, path, body) => call(config.api_url, method, path, { token: config.token, body });
  return {
    ask: () => send('GET', '/v1/wake'),
    check: () => send('GET', '/v1/wake?check=1'),
    /** @param {string} id */
    claim: (id) => send('POST', `/v1/wake/${encodeURIComponent(id)}/claim`),
    /** @param {string} id @param {{ exit_code: number | null, duration_ms: number, cause: string | null }} report */
    done: (id, report) => send('POST', `/v1/wake/${encodeURIComponent(id)}/done`, report),
    disconnect: () => send('POST', '/v1/wake/disconnect'),
  };
}

/** What a refusal says, for a person. @param {Reply} reply */
export const reason = (reply) => (reply.status === 0 ? 'no answer (are you online?)' : String(reply.body?.error?.message ?? `HTTP ${reply.status}`));
