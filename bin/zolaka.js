#!/usr/bin/env node
// @ts-check
// The Zolaka runner. Everything it does is in ../src; start reading at cli.js.
import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
