#!/usr/bin/env node
// "Ask Claude about your budget": the read-only MCP server over stdio, for
// Claude Desktop and Claude Code on this computer (they start it themselves).
//
// Usage:
//   node mcp.js               serve MCP on stdin/stdout (newline-delimited JSON-RPC)
//   node mcp.js --new-key     make the key for the HTTP endpoint /mcp (claude.ai / phone); shown once
//   node mcp.js --revoke-key  turn the HTTP endpoint off again
//
// Reads <DATA_DIR>/budget.json (DATA_DIR from .env, default ./data) fresh on
// every call — re-parsed only when the file changed — and never writes it.
// Logs go to stderr only: stdout carries the protocol.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createMcp, normalizeState } from './lib/mcp.js';
import { McpKeys, MCP_KEY_FILE } from './lib/mcpkey.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file */ }
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'budget.json');
console.log = console.error; // nothing may write to stdout but the protocol

let cache = { mtimeMs: null, size: null, state: null };
async function getState() {
  let st;
  try {
    st = await fs.stat(FILE);
  } catch (err) {
    if (err.code === 'ENOENT') return normalizeState({}); // not set up yet: an empty budget
    throw err;
  }
  if (st.mtimeMs !== cache.mtimeMs || st.size !== cache.size) {
    const state = normalizeState(JSON.parse(await fs.readFile(FILE, 'utf8')));
    cache = { mtimeMs: st.mtimeMs, size: st.size, state };
  }
  return cache.state;
}

// One message per line, answered in order. The process ends when stdin closes.
function serve() {
  const mcp = createMcp({ getState });
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  let queue = Promise.resolve();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const reply = await mcp.handle(msg);
      if (reply) send(reply);
    }).catch((err) => process.stderr.write(`[mcp] ${err.message}\n`));
  });
  process.stderr.write(`[mcp] budget-planner MCP server (read-only) on stdio, data: ${FILE}\n`);
}

const arg = process.argv[2];
if (arg === '--new-key' || arg === '--revoke-key') {
  const keys = await new McpKeys(path.join(DATA_DIR, MCP_KEY_FILE)).load();
  if (arg === '--revoke-key') {
    await keys.revoke();
    process.stderr.write('MCP key removed: the HTTP endpoint /mcp is off.\n');
  } else {
    const key = await keys.create();
    process.stderr.write('New MCP key (shown once; it replaces any previous key). Use it as\n'
      + '  Authorization: Bearer <key>   or the URL  https://<your host>/mcp/<key>\n');
    process.stdout.write(`${key}\n`);
  }
} else {
  serve();
}
