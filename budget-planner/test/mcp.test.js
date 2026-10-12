// "Ask Claude about your budget": the read-only MCP server (lib/mcp.js), its
// HTTP key (lib/mcpkey.js), the stdio entry (mcp.js) and the HTTP transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emptyState } from '../lib/store.js';
import { createMcp, httpMcp } from '../lib/mcp.js';
import { McpKeys } from '../lib/mcpkey.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const HAS_ODDS = existsSync(path.join(ROOT, 'public/js/shared/odds.js'));
const TODAY = '2026-10-11';
const SECRETS = ['RO49INGB0000999901237204', '999901237204', 'RO11INGB0000999905558391', 'RO49BTRL0000123456789012', '123456789012',
  'sess-SECRET-123', 'TRASHED SECRET', 'PENDING-STATE-SECRET', 'auth-code-xyz'];

let n = 0;
const tx = (o) => ({ id: `t${++n}`, source: 'bank', accountId: 'cur', type: 'expense', createdAt: '2026-01-01T00:00:00Z', ...o });

function sampleState() {
  const s = emptyState();
  s.settings = { ...s.settings, payday: 10, spendBuffer: 100 };
  s.bank = {
    connections: [{
      sessionId: 'sess-SECRET-123', bank: 'ING', validUntil: '2027-06-01T00:00:00Z',
      accounts: [
        { uid: 'cur', iban: 'RO49INGB0000999901237204', name: 'Dan Paul Nastea', cashAccountType: 'CACC', balance: { amount: 3000, currency: 'RON' }, lastSyncAt: '2026-10-11T08:00:00Z' },
        { uid: 'card', iban: 'RO11INGB0000999905558391', cashAccountType: 'CARD', creditLimit: 5000, balance: { amount: -1200, currency: 'RON' } },
      ],
    }],
    lastSync: '2026-10-11T08:00:00Z', lastError: null, pendingAuth: { state: 'PENDING-STATE-SECRET', code: 'auth-code-xyz' },
  };
  const rows = [];
  for (const [m, pay] of [['07', '10'], ['08', '10'], ['09', '10'], ['10', '09']]) {
    rows.push(tx({ date: `2026-${m}-${pay}`, amount: 8000, type: 'income', category: 'Salary', description: 'SALARIU ACME SRL' }));
    rows.push(tx({ date: `2026-${m}-12`, amount: m === '10' ? 900 : 700, category: 'Groceries', description: 'KAUFLAND 1234' }));
    rows.push(tx({ date: `2026-${m}-11`, amount: 1500, category: 'Credit card repayment', description: 'Rambursare card credit' }));
    rows.push(tx({ date: `2026-${m}-11`, accountId: 'card', amount: 250, category: 'Eating out', description: 'GLOVO ****8391' }));
  }
  for (const m of ['07', '08', '09']) rows.push(tx({ date: `2026-${m}-15`, amount: 49.99, category: 'Subscriptions', description: 'NETFLIX.COM' }));
  rows.push(tx({ date: '2026-10-10', amount: 400, category: 'Sent to people', description: 'Transfer to RO49BTRL0000123456789012 Ion', counterpartyIban: 'RO49BTRL0000123456789012' }));
  rows.push(tx({ date: '2026-10-10', amount: 500, category: 'Savings', description: 'Goal: Vacation', goalId: 'g1', source: 'manual' }));
  s.transactions = rows;
  s.goals = [{ id: 'g1', name: 'Vacation', target: 5000, initialSaved: 1000, deadline: '2027-06-01', priority: 'high' }];
  s.budgets = { Groceries: 800, 'Eating out': 300 };
  s.assets = [{ id: 'a1', name: 'Pilon 2 pension', kind: 'pension', amount: 20000, updatedAt: '2026-09-01T00:00:00Z' }];
  s.trash = [{ tx: tx({ date: '2026-10-01', amount: 9, description: 'TRASHED SECRET item' }), reason: 'deleted', removedAt: '2026-10-02T00:00:00Z' }];
  return s;
}

const server = (state = sampleState()) => createMcp({ getState: () => state, today: () => TODAY, log: () => {} });
let rid = 0;
const call = (mcp, method, params) => mcp.handle({ jsonrpc: '2.0', id: ++rid, method, ...(params === undefined ? {} : { params }) });
async function tool(mcp, name, args = {}) {
  const r = await call(mcp, 'tools/call', { name, arguments: args });
  assert.ok(r.result, `tools/call ${name}: ${JSON.stringify(r.error)}`);
  const text = r.result.content[0].text;
  for (const s of SECRETS) assert.ok(!text.includes(s), `${name} leaks ${s}`);
  return r.result.isError ? { error: text } : JSON.parse(text);
}

test('initialize negotiates the protocol version and describes the data', async () => {
  const mcp = server();
  const r = await call(mcp, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.capabilities, { tools: {}, prompts: {} });
  assert.equal(r.result.serverInfo.name, 'budget-planner');
  assert.equal(r.result.serverInfo.version, VERSION);
  assert.match(r.result.instructions, /read-only/i);
  assert.match(r.result.instructions, /7204/);
  assert.match(r.result.instructions, /8391/);
  for (const v of ['2025-11-25', '2025-06-18', '2024-11-05']) assert.equal((await call(mcp, 'initialize', { protocolVersion: v })).result.protocolVersion, v);
  assert.equal((await call(mcp, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.equal((await call(mcp, 'initialize', {})).result.protocolVersion, '2025-06-18');
});

test('JSON-RPC: ping, notifications, unknown methods, bad params, batches', async () => {
  const mcp = server();
  assert.deepEqual((await call(mcp, 'ping')).result, {});
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await mcp.handle({ jsonrpc: '2.0', id: 5, result: {} }), null, 'a response from the client needs no answer');
  assert.equal((await call(mcp, 'resources/list')).error.code, -32601);
  assert.equal((await call(mcp, 'tools/call', [1, 2])).error.code, -32602);
  assert.equal((await call(mcp, 'tools/call', { name: 'drop_everything' })).error.code, -32602);
  assert.equal((await call(mcp, 'tools/call', { name: 'get_overview', arguments: 'x' })).error.code, -32602);
  assert.equal((await mcp.handle('nope')).error.code, -32600);
  assert.equal((await mcp.handle({ jsonrpc: '1.0', id: 1, method: 'ping' })).error.code, -32600);
  assert.equal((await mcp.handle([])).error.code, -32600);
  const batch = await mcp.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'nope' }]);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0], { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(batch[1].error.code, -32601);
  assert.equal(await mcp.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
});

test('tools/list: read-only tools with tight schemas', async () => {
  const { result } = await call(server(), 'tools/list');
  const names = result.tools.map((t) => t.name);
  for (const name of ['get_overview', 'list_transactions', 'spending_by_category', 'period_history', 'recurring_payments', 'goals_and_budgets', 'net_worth']) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.includes('payday_odds'), HAS_ODDS, 'payday_odds only when odds.js is there');
  for (const t of result.tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.description.length > 20, t.name);
  }
  const list = result.tools.find((t) => t.name === 'list_transactions').inputSchema.properties;
  assert.equal(list.limit.maximum, 200);
  assert.deepEqual(list.account.enum, ['main', 'card', 'all']);
});

test('get_overview: period, balance, totals, safe to spend, card, bills, alerts', async () => {
  const o = await tool(server(), 'get_overview');
  assert.equal(o.today, TODAY);
  assert.equal(o.period.key, '2026-10');
  assert.equal(o.period.start, '2026-10-09', 'salary came on Friday the 9th');
  assert.equal(o.period.end, '2026-11-09');
  assert.equal(o.period.daysLeft, 30);
  assert.equal(o.period.nextPayday, '2026-11-10');
  assert.deepEqual(o.mainAccount, { account: '7204', balance: 3000, balanceDate: '2026-10-11' });
  // Counted: salary 8000 in; repayment 1500 + transfer 400 out (groceries on the 12th are after today but in the period: 900).
  assert.equal(o.thisPeriod.income, 8000);
  assert.equal(o.thisPeriod.spent, 2800);
  assert.equal(o.thisPeriod.saved, 500);
  assert.equal(o.thisPeriod.left, 4700);
  assert.equal(o.card.owed, 1200);
  assert.equal(o.card.accounts[0].account, '8391');
  assert.equal(o.card.spentThisPeriod, 250, 'card purchases are analysis only');
  const netflix = o.billsBeforePayday.find((b) => /NETFLIX/.test(b.label));
  assert.deepEqual([netflix.date, netflix.min, netflix.max], ['2026-10-15', 49.99, 49.99]);
  assert.equal(o.safeToSpend.high, round(3000 - o.billsBeforePayday.reduce((s, b) => s + b.min, 0) - 100));
  assert.ok(o.safeToSpend.setAside.some((i) => i.kind === 'buffer' && i.min === 100));
  assert.ok(Array.isArray(o.alerts) && o.alerts.length <= 5);
  for (const a of o.alerts) assert.deepEqual(Object.keys(a).sort(), ['level', 'text', 'title']);
});
const round = (x) => Math.round(x * 100) / 100;

test('list_transactions: filters, account last 4, counted flag, limits', async () => {
  const mcp = server();
  const all = await tool(mcp, 'list_transactions', { limit: 500 });
  assert.equal(all.returned, all.matched, 'limit is clamped to 200, more than the sample');
  assert.equal(all.transactions[0].date, '2026-10-12', 'newest first');
  for (const t of all.transactions) assert.deepEqual(Object.keys(t).filter((k) => !['note', 'goal', 'splits', 'countedAs', 'currency'].includes(k)).sort(), ['account', 'amount', 'category', 'counted', 'date', 'description', 'type']);
  const transfer = all.transactions.find((t) => t.category === 'Sent to people');
  assert.equal(transfer.description, 'Transfer to …9012 Ion', 'IBANs in the text are cut to the last 4');
  assert.equal(transfer.account, '7204');
  const card = await tool(mcp, 'list_transactions', { account: 'card' });
  assert.equal(card.matched, 4);
  assert.ok(card.transactions.every((t) => t.account === '8391' && t.counted === false));
  const main = await tool(mcp, 'list_transactions', { account: 'main', type: 'income' });
  assert.ok(main.transactions.every((t) => t.type === 'income' && t.counted));
  const goal = (await tool(mcp, 'list_transactions', { category: 'savings' })).transactions[0];
  assert.deepEqual([goal.countedAs, goal.goal], ['saved', 'Vacation']);
  const sept = await tool(mcp, 'list_transactions', { from: '2026-09-01', to: '2026-09-30', search: 'kaufland' });
  assert.deepEqual(sept.transactions.map((t) => t.date), ['2026-09-12']);
  const two = await tool(mcp, 'list_transactions', { limit: 2 });
  assert.deepEqual([two.returned, two.truncated], [2, true]);
  assert.equal((await tool(mcp, 'list_transactions', { limit: 0 })).returned, 1, 'clamped up to 1');
});

test('tool arguments are validated (errors come back as isError results)', async () => {
  const mcp = server();
  assert.match((await tool(mcp, 'list_transactions', { from: '11/10/2026' })).error, /YYYY-MM-DD/);
  assert.match((await tool(mcp, 'list_transactions', { from: '2026-02-30' })).error, /real date/);
  assert.match((await tool(mcp, 'list_transactions', { from: '2026-10-02', to: '2026-10-01' })).error, /on or before/);
  assert.match((await tool(mcp, 'list_transactions', { type: 'refund' })).error, /income, expense/);
  assert.match((await tool(mcp, 'list_transactions', { account: 'savings' })).error, /main, card, all/);
  assert.match((await tool(mcp, 'list_transactions', { limit: 'lots' })).error, /number/);
  assert.match((await tool(mcp, 'list_transactions', { search: 'x'.repeat(101) })).error, /too long/);
  assert.match((await tool(mcp, 'list_transactions', { iban: 'x' })).error, /Unknown argument "iban"/);
  assert.match((await tool(mcp, 'get_overview', { x: 1 })).error, /Unknown argument/);
  assert.match((await tool(mcp, 'spending_by_category', { period: '2026-13' })).error, /period must be/);
  assert.match((await tool(mcp, 'period_history', { count: {} })).error, /number/);
  const r = await call(mcp, 'tools/call', { name: 'list_transactions', arguments: { from: 'x' } });
  assert.equal(r.result.isError, true);
});

test('spending_by_category: budget, 3-period average and card purchases', async () => {
  const mcp = server();
  const cur = await tool(mcp, 'spending_by_category', {});
  assert.equal(cur.period.key, '2026-10');
  const groceries = cur.categories.find((c) => c.category === 'Groceries');
  assert.deepEqual([groceries.spent, groceries.budget, groceries.avgPrev3, groceries.vsAverage, groceries.overBudget, groceries.essential], [900, 800, 700, 200, 100, true]);
  assert.equal(cur.averageBasedOnPeriods, 3);
  assert.equal(cur.cardPurchases.byCategory['Eating out'], 250);
  const eatingOut = cur.categories.find((c) => c.category === 'Eating out');
  assert.equal(eatingOut.spent, 0, 'card purchases are not counted in the cash flow');
  const prev = await tool(mcp, 'spending_by_category', { period: 'previous' });
  assert.equal(prev.period.key, '2026-09');
  assert.equal(prev.categories.find((c) => c.category === 'Subscriptions').spent, 49.99);
  assert.equal((await tool(mcp, 'spending_by_category', { period: '2026-08' })).period.start, '2026-08-10');
});

test('period_history, recurring_payments, goals_and_budgets, net_worth', async () => {
  const mcp = server();
  const h = await tool(mcp, 'period_history', { count: 3 });
  assert.deepEqual(h.periods.map((p) => p.key), ['2026-10', '2026-09', '2026-08']);
  assert.equal(h.periods[0].inProgress, true);
  assert.deepEqual([h.periods[1].income, h.periods[1].spent, h.periods[1].left], [8000, 2249.99, 5750.01]);
  assert.equal(h.averageOfCompletedPeriods.periods, 2);
  assert.equal((await tool(mcp, 'period_history', { count: 99 })).periods.length, 24, 'count is clamped');

  const rec = await tool(mcp, 'recurring_payments');
  const netflix = rec.payments.find((p) => p.label === 'NETFLIX.COM');
  assert.deepEqual([netflix.cadence, netflix.amount, netflix.nextDate, netflix.status, netflix.account], ['monthly', 49.99, '2026-10-15', 'suggested', '7204']);
  assert.ok(rec.monthlyEquivalent >= 49.99);

  const gb = await tool(mcp, 'goals_and_budgets');
  assert.deepEqual(gb.goals[0], { name: 'Vacation', target: 5000, saved: 1500, remaining: 3500, progressPct: 30, deadline: '2027-06-01', priority: 'high', monthlyNeeded: gb.goals[0].monthlyNeeded });
  assert.ok(gb.goals[0].monthlyNeeded > 400 && gb.goals[0].monthlyNeeded < 500);
  assert.deepEqual(gb.budgets.find((b) => b.category === 'Groceries'), { category: 'Groceries', limit: 800, spentThisPeriod: 900, left: -100, pctUsed: 113 });

  const nw = await tool(mcp, 'net_worth');
  assert.deepEqual([nw.total, nw.bankCash, nw.cardOwed, nw.otherAssets], [21800, 3000, 1200, 20000]);
  assert.ok(nw.items.every((i) => !('id' in i)));
});

test('payday_odds: offered only when odds.js is there', async () => {
  const mcp = server();
  const r = await call(mcp, 'tools/call', { name: 'payday_odds', arguments: { extra_spend: 100 } });
  if (!HAS_ODDS) {
    assert.equal(r.error.code, -32602);
    return;
  }
  assert.ok(!r.result.isError, r.result.content[0].text);
  const odds = JSON.parse(r.result.content[0].text);
  assert.equal(odds.extraSpend, 100);
  assert.ok(['ok', 'learning', 'unsure'].includes(odds.status));
  assert.equal(odds.threshold, 100, 'the reserve (spendBuffer) is the line to stay above, as in the app');
  assert.equal(typeof odds.summary, 'string');
  assert.match((await tool(mcp, 'payday_odds', { extra_spend: -5 })).error, /extra_spend/);
});

test('an empty or unreadable budget does not crash the tools', async () => {
  const empty = createMcp({ getState: () => ({}), today: () => TODAY, log: () => {} });
  for (const name of ['get_overview', 'list_transactions', 'spending_by_category', 'period_history', 'recurring_payments', 'goals_and_budgets', 'net_worth']) {
    const r = await tool(empty, name);
    assert.ok(!r.error, `${name}: ${r.error}`);
  }
  assert.equal((await tool(empty, 'get_overview')).mainAccount, null);
  const broken = createMcp({ getState: () => { throw new Error('disk on fire'); }, today: () => TODAY, log: () => {} });
  const r = await call(broken, 'tools/call', { name: 'get_overview', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.ok(!r.result.content[0].text.includes('disk on fire'));
  assert.ok((await call(broken, 'initialize', {})).result.instructions, 'initialize still works');
});

test('prompts: list and get, with argument checks', async () => {
  const mcp = server();
  const list = (await call(mcp, 'prompts/list')).result.prompts;
  assert.deepEqual(list.map((p) => p.name), ['monthly_review', 'can_i_afford', 'find_savings']);
  assert.deepEqual(list.find((p) => p.name === 'can_i_afford').arguments.map((a) => [a.name, a.required]), [['amount', true], ['what', false]]);
  const review = (await call(mcp, 'prompts/get', { name: 'monthly_review' })).result;
  assert.equal(review.messages[0].role, 'user');
  assert.match(review.messages[0].content.text, /get_overview/);
  assert.match(review.messages[0].content.text, /language/);
  const afford = (await call(mcp, 'prompts/get', { name: 'can_i_afford', arguments: { amount: '1.500', what: 'a phone' } })).result;
  assert.match(afford.messages[0].content.text, /1500 RON on a phone/);
  assert.match(afford.messages[0].content.text, /payday_odds/);
  assert.match((await call(mcp, 'prompts/get', { name: 'find_savings' })).result.messages[0].content.text, /recurring_payments/);
  assert.equal((await call(mcp, 'prompts/get', { name: 'can_i_afford', arguments: {} })).error.code, -32602);
  assert.equal((await call(mcp, 'prompts/get', { name: 'can_i_afford', arguments: { amount: 'free' } })).error.code, -32602);
  assert.equal((await call(mcp, 'prompts/get', { name: 'can_i_afford', arguments: { amount: '5', x: '1' } })).error.code, -32602);
  assert.equal((await call(mcp, 'prompts/get', { name: 'nope' })).error.code, -32602);
});

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bp-mcp-'));
}

test('stdio: newline-delimited JSON-RPC round trip, reading budget.json', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'budget.json'), JSON.stringify(sampleState()));
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { env: { ...process.env, DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.resume();
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'net_worth', arguments: {} } },
  ];
  child.stdin.write(`${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3, null]);
  assert.equal(replies[0].result.serverInfo.name, 'budget-planner');
  assert.ok(replies[1].result.tools.length >= 7);
  assert.equal(JSON.parse(replies[2].result.content[0].text).total, 21800);
  assert.equal(replies[3].error.code, -32700);
  for (const s of SECRETS) assert.ok(!out.includes(s), `stdio leaks ${s}`);
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['budget.json'], 'read-only: nothing written');
  await fs.rm(dir, { recursive: true, force: true });
});

test('McpKeys: create, check, revoke; only a hash on disk; CLI --new-key', async () => {
  const dir = await tempDir();
  const file = path.join(dir, '.mcp-key.json');
  const keys = await new McpKeys(file).load();
  assert.equal(keys.exists, false);
  assert.equal(keys.valid('anything'), false);
  const key = await keys.create();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(keys.exists, true);
  assert.equal(keys.valid(key), true);
  assert.equal(keys.valid(`${key}x`), false);
  assert.equal(keys.valid(undefined), false);
  assert.equal(keys.valid(''), false);
  const disk = await fs.readFile(file, 'utf8');
  assert.ok(!disk.includes(key), 'the key itself is never stored');
  assert.match(JSON.parse(disk).hash, /^[0-9a-f]{64}$/);
  assert.ok(JSON.parse(disk).createdAt);
  const again = await new McpKeys(file).load();
  assert.equal(again.valid(key), true);
  const second = await keys.create();
  assert.equal(keys.valid(key), false, 'a new key replaces the old one');
  assert.equal(again.valid(second), true, 'another instance picks up the new key from the file');
  await keys.revoke();
  assert.equal(keys.exists, false);
  assert.equal(keys.valid(second), false);
  assert.equal(again.valid(second), false);

  const printed = execFileSync(process.execPath, [path.join(ROOT, 'mcp.js'), '--new-key'], { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  assert.equal((await new McpKeys(file).load()).valid(printed), true);
  execFileSync(process.execPath, [path.join(ROOT, 'mcp.js'), '--revoke-key'], { env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore' });
  assert.equal((await new McpKeys(file).load()).exists, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('httpMcp: 401 / 405 / 403 / 202 / 200 over a tiny HTTP server', async () => {
  const dir = await tempDir();
  const keys = await new McpKeys(path.join(dir, '.mcp-key.json')).load();
  const mcp = server();
  const srv = http.createServer((req, res) => httpMcp(req, res, { mcp, keys }));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (body, { key, url = '/mcp', headers = {} } = {}) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  try {
    const off = await post(ping, { key: 'x'.repeat(43) });
    assert.equal(off.status, 401, 'no key created yet: off');
    const key = await keys.create();
    assert.equal((await post(ping)).status, 401, 'no key');
    assert.equal((await post(ping, { key: 'x'.repeat(43) })).status, 401, 'wrong key');
    assert.equal((await post(ping, { url: `/mcp/${'y'.repeat(43)}` })).status, 401, 'wrong key in the path');
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal((await post(ping, { headers: { Origin: 'https://evil.example' } })).status, 403, 'other site, no key');
    assert.equal((await post(ping, { key, headers: { Origin: 'https://claude.ai' } })).status, 200, 'web client with the key');
    assert.equal((await post(ping, { key, headers: { Origin: base } })).status, 200, 'same host is fine');
    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { key });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), '');
    const init = await post({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { key });
    assert.equal(init.status, 200);
    assert.match(init.headers.get('content-type'), /application\/json/);
    assert.equal((await init.json()).result.protocolVersion, '2025-06-18');
    const viaPath = await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'net_worth', arguments: {} } }, { url: `/mcp/${key}` });
    assert.equal(viaPath.status, 200);
    assert.equal(JSON.parse((await viaPath.json()).result.content[0].text).total, 21800);
    const batch = await post([ping, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { key });
    assert.deepEqual((await batch.json()).map((r) => r.id), [1, 2]);
    const bad = await post('{nope', { key });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, -32700);
    assert.equal((await post(ping, { key, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await post(ping, { key, headers: { 'MCP-Protocol-Version': '1999-01-01' } })).status, 400);
    assert.equal((await post(ping, { key, headers: { 'MCP-Protocol-Version': '2025-06-18' } })).status, 200);
    const newer = await post({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, { key, headers: { 'MCP-Protocol-Version': '2099-01-01' } });
    assert.equal(newer.status, 200, 'a newer client can still initialize');
    assert.equal((await newer.json()).result.protocolVersion, '2025-06-18');
  } finally {
    srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
