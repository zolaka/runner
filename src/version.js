// @ts-check
// The runner's version, from its package.json: said in `zolaka --version` and in every call's User-Agent.
import { readFileSync } from 'node:fs';

/** @type {string} */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
