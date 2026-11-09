import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyDemo } from './verify-demo.js';
import { validText, fixtureRecords, serialize, mutateFixture, renumber, negativeCases, summaryRecord } from './checker-helpers.js';

const checkerPath = fileURLToPath(new URL('./verify-demo.js', import.meta.url));
function runChecker(text) {
  const directory = mkdtempSync(join(tmpdir(), 'feedme-checker-'));
  try {
    const file = join(directory, 'input.jsonl');
    writeFileSync(file, text);
    return spawnSync(process.execPath, [checkerPath, file], { encoding: 'utf8', timeout: 5000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('AT-A05 / AT-A10: independent literal R05 format fixture validates with seven exact reconstructed checkpoints', () => {
  const result = verifyDemo(validText);
  assert.equal(result.records.length, 20);
  assert.equal(result.report.semantic_events, 18);
  assert.deepEqual(result.report.checkpoints, ['after_creations', 'after_two_workers', 'after_B2_removal', 'after_due_t10', 'after_due_t20', 'after_due_t30', 'after_due_t40']);
  assert.deepEqual(result.report.completed, [1002, 1004, 1001, 1003]);
  const cli = runChecker(validText);
  assert.equal(cli.status, 0, cli.stderr);
});

test('AT-A05: either inner order of the t2 removal/interruption pair is accepted', () => {
  const records = fixtureRecords();
  [records[9], records[10]] = [records[10], records[9]];
  renumber(records);
  assert.equal(verifyDemo(serialize(records)).report.semantic_events, 18);
});

for (const mutation of negativeCases) {
  test(`AT-A10 ${mutation.id}: API and independent CLI reject the prescribed corruption with a useful diagnostic`, () => {
    const text = mutation.text ?? mutateFixture(mutation.change);
    assert.throws(() => verifyDemo(text), mutation.diagnostic);
    const result = runChecker(text);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, mutation.diagnostic);
  });
}

const extraCorruptions = [
  ['false run-summary completed ordering', /snapshot.completed|run-summary.*completed/, records => { summaryRecord(records).snapshot.completed = [1001, 1002, 1003, 1004]; }],
  ['missing identity list in summary', /snapshot.pending/, records => { delete summaryRecord(records).snapshot.pending; }],
  ['malformed processing mapping', /snapshot.processing/, records => { summaryRecord(records).snapshot.processing = []; }],
  ['false summary counts', /counts.complete/, records => { summaryRecord(records).counts.complete = 3; }],
  ['snapshot order conservation failure', /snapshot.*(completed|conservation)/, records => { summaryRecord(records).snapshot.completed.push(1004); }],
  ['noncanonical exact time', /elapsed_ns.*canonical/, records => { records[1].elapsed_ns = '00'; }],
  ['event sequence gap', /event_seq/, records => { records[3].event_seq += 1; }],
  ['unknown kind', /kind/, records => { records[2].kind = 'decorative-heading'; }],
  ['wrong action ingress', /ingress_seq/, records => { records[2].ingress_seq = 9; }],
  ['false autonomous ingress', /ingress_seq/, records => { records[11].ingress_seq = 7; }],
  ['reused attempt token', /attempt_id.*(unique|reused)/, records => { records[12].attempt_id = 'fixture-attempt-a'; }],
  ['wrong completion attempt', /attempt/, records => { records[11].attempt_id = 'nonexistent'; }],
  ['incorrect start deadline', /due_ns/, records => { records[6].due_ns = '10000000001'; }],
  ['false fixed anchor', /anchor_utc/, records => { records[0].anchor_utc = '11:00:00 UTC'; }],
  ['valid clock with false simulation display', /utc.*expected/, records => { records[1].utc = '[11:00:00]'; }],
  ['extra state-changing event', /extra|semantic|order-created/, records => { records.splice(-1, 0, { ...records[1], order_id: 1005, ingress_seq: 8, elapsed_ns: '40000000000', utc: '[12:00:40]' }); renumber(records); }],
  ['missing required worker idle event', /semantic|worker-idle/, records => { records.splice(-2, 1); renumber(records); }],
  ['record after summary', /run-summary.*last|after.*run-summary/, records => { records.push({ schema_version: 1, event_seq: 21, kind: 'status', mode: 'SIMULATED', elapsed_ns: '40000000000', utc: '[12:00:40]', ingress_seq: 8, snapshot: structuredClone(summaryRecord(records).snapshot) }); renumber(records); }],
  ['unapproved extra metadata command', /unexpected.*help|extra.*help/, records => { records.splice(-1, 0, { ...records[1], kind: 'help', ingress_seq: 8, elapsed_ns: '40000000000', utc: '[12:00:40]', commands: ['order normal', 'order vip', 'bot add', 'bot remove', 'status', 'help', 'quit'] }); renumber(records); }],
];
for (const [name, diagnostic, change] of extraCorruptions) {
  test(`checker rejects ${name}`, () => assert.throws(() => verifyDemo(mutateFixture(change)), diagnostic));
}

test('checker accepts independently supplied final status metadata only when its identity snapshot agrees', () => {
  const records = fixtureRecords();
  const final = summaryRecord(records);
  records.splice(-1, 0, { schema_version: 1, event_seq: 20, kind: 'status', mode: 'SIMULATED', utc: '[12:00:40]', elapsed_ns: '40000000000', ingress_seq: 8, snapshot: structuredClone(final.snapshot) });
  renumber(records);
  assert.equal(verifyDemo(serialize(records)).report.semantic_events, 18);
  records.at(-2).snapshot.active_workers = [];
  assert.throws(() => verifyDemo(serialize(records)), /snapshot.active_workers/);
});

test('checker accepts whitespace and CRLF without weakening object-only JSONL', () => {
  assert.equal(verifyDemo('\r\n' + validText.replaceAll('\n', '\r\n') + '\r\n').report.semantic_events, 18);
  assert.throws(() => verifyDemo('[]\n' + validText), /line 1.*object/);
});

test('checker validates optional live-attempt snapshot metadata against the observed start', () => {
  const records = fixtureRecords();
  records[8].snapshot = {
    timeNs: '0', pending: [1001, 1003], processing: { 1: 1002, 2: 1004 }, completed: [], interrupted_history: [],
    idle_workers: [], active_workers: [1, 2], submitted: 4, closed: false,
    attempts: {
      1: { attempt_id: 'fixture-attempt-a', order_id: 1002, start_ns: '0', due_ns: '10000000000' },
      2: { attempt_id: 'fixture-attempt-b', order_id: 1004, start_ns: '0', due_ns: '10000000000' },
    },
  };
  assert.equal(verifyDemo(serialize(records)).report.attempts, 5);
  records[8].snapshot.attempts[2].attempt_id = 'fabricated';
  assert.throws(() => verifyDemo(serialize(records)), /snapshot.attempts/);
  records[8].snapshot.attempts = [];
  assert.throws(() => verifyDemo(serialize(records)), /snapshot.attempts/);
});

const invalidProperties = [
  ['schema_version', 0, 1, /schema_version/],
  ['event_seq', 1.5, 1, /event_seq/],
  ['kind', null, 1, /kind/],
  ['order_id', -1, 1, /order_id/],
  ['customer_class', 'VIP-ish', 1, /customer_class/],
  ['state', 'COMPLETE', 1, /state/],
  ['worker_id', 0, 5, /worker_id/],
  ['ingress_seq', -1, 5, /ingress_seq/],
  ['attempt_id', '', 6, /attempt_id/],
  ['start_ns', 0, 6, /start_ns/],
  ['due_ns', '-1', 6, /due_ns/],
  ['worker_id', -4, 9, /worker_id/],
  ['snapshot', null, 19, /snapshot/],
];
for (const [key, value, index, diagnostic] of invalidProperties) {
  test(`checker rejects invalid typed ${key} at fixture record ${index + 1}`, () => {
    assert.throws(() => verifyDemo(mutateFixture(records => { records[index][key] = value; })), diagnostic);
  });
}

function insertStatus(records, index, snapshot) {
  records.splice(index, 0, {
    schema_version: 1, event_seq: 1, kind: 'status', mode: 'SIMULATED',
    utc: snapshot.timeNs === '10000000000' ? '[12:00:10]' : '[12:00:40]',
    elapsed_ns: snapshot.timeNs, ingress_seq: 8, snapshot,
  });
  renumber(records);
  return serialize(records);
}

const unsettledStatuses = [
  ['before due completion', 11, {
    timeNs: '10000000000', pending: [1004, 1001, 1003], processing: { 1: 1002 }, completed: [],
    interrupted_history: [1004], idle_workers: [], active_workers: [1], submitted: 4, closed: false,
  }, /status.*(overdue|due attempt|settled)/],
  ['between completion and immediate pickup', 12, {
    timeNs: '10000000000', pending: [1004, 1001, 1003], processing: {}, completed: [1002],
    interrupted_history: [1004], idle_workers: [1], active_workers: [1], submitted: 4, closed: false,
  }, /status.*(pending.*idle|dispatch|settled)/],
  ['before required same-time idle event', 18, {
    timeNs: '40000000000', pending: [], processing: {}, completed: [1002, 1004, 1001, 1003],
    interrupted_history: [1004], idle_workers: [1], active_workers: [1], submitted: 4, closed: false,
  }, /autonomous.*status|status.*autonomous/],
];
for (const [name, index, snapshot, diagnostic] of unsettledStatuses) {
  test(`review regression: checker rejects status ${name} even when snapshot agrees with transient replay state`, () => {
    const text = insertStatus(fixtureRecords(), index, snapshot);
    assert.throws(() => verifyDemo(text), diagnostic);
    const result = runChecker(text);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
  });
}

test('review regression: checker accepts optional t10 status after completion and immediate dispatch settle', () => {
  const text = insertStatus(fixtureRecords(), 13, {
    timeNs: '10000000000', pending: [1001, 1003], processing: { 1: 1004 }, completed: [1002],
    interrupted_history: [1004], idle_workers: [], active_workers: [1], submitted: 4, closed: false,
  });
  assert.equal(verifyDemo(text).report.semantic_events, 18);
});

test('review regression: either nonempty session or session_id metadata is accepted', () => {
  const records = fixtureRecords();
  delete records[0].session_id;
  records[0].session = 'R05';
  assert.equal(verifyDemo(serialize(records)).report.semantic_events, 18);
});

for (const [name, property, value] of [
  ['omitted session metadata', null, null],
  ['empty session', 'session', ''],
  ['whitespace session', 'session', '  '],
  ['nonstring session', 'session', { id: 'R05' }],
  ['empty session_id', 'session_id', ''],
  ['nonstring session_id', 'session_id', 42],
]) {
  test(`review regression: checker rejects ${name} on run-started`, () => {
    const records = fixtureRecords();
    delete records[0].session_id;
    if (property) records[0][property] = value;
    assert.throws(() => verifyDemo(serialize(records)), /run-started.*session/);
  });
}
