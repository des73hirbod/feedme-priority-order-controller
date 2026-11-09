import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Expected values come exclusively from the immutable, prewritten Stage04
// oracle. This module neither imports product modules nor runs the product.
const oracle = JSON.parse(readFileSync(new URL('./fixtures/R05_DEMO_ORACLE_STAGE04.json', import.meta.url), 'utf8'));
const DURATION = 10_000_000_000n;
const NS = /^(0|[1-9][0-9]*)$/;
const UTC = /^\[(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\]$/;
const COMMANDS = ['order normal', 'order vip', 'bot add', 'bot remove', 'status', 'help', 'quit'];
const STATE_BY_KIND = {
  'order-created': 'PENDING', 'worker-added': 'IDLE', 'order-started': 'PROCESSING',
  'order-completed': 'COMPLETE', 'order-interrupted': 'PENDING',
  'worker-removed': 'REMOVED', 'worker-idle': 'IDLE',
};
const SEMANTIC_KINDS = new Set(Object.keys(STATE_BY_KIND));
const KINDS = new Set([...SEMANTIC_KINDS, 'run-started', 'run-summary', 'status', 'help', 'command-rejected', 'command-noop', 'session-closed']);
const INPUT_KINDS = new Set(['order-created', 'worker-added', 'worker-removed', 'status', 'help', 'command-rejected', 'command-noop', 'session-closed']);
const SNAPSHOT_KEYS = ['pending', 'processing', 'completed', 'interrupted_history', 'idle_workers', 'active_workers', 'submitted'];
const COUNT_KEYS = ['submitted', 'pending', 'processing', 'complete', 'active_bots'];
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
function fail(where, message) { throw new Error(`${where}: ${message}`); }
function requireAt(condition, where, message) { if (!condition) fail(where, message); }
function ns(value, where, key) {
  requireAt(typeof value === 'string' && NS.test(value), where, `${key} must be a canonical nonnegative nanosecond string`);
  return BigInt(value);
}
function identity(record, key, where) { requireAt(positive(record[key]), where, `${key} must be a positive safe integer`); }
function token(value, where, key) { requireAt(typeof value === 'string' && value.trim().length > 0, where, `${key} must be a nonempty token`); }
function same(actual, expected, where, field) {
  requireAt(isDeepStrictEqual(actual, expected), where, `${field} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function idList(value, where, field, sorted = false, unique = true) {
  requireAt(Array.isArray(value) && value.every(positive), where, `${field} must be an array of positive safe integer IDs`);
  if (unique) requireAt(new Set(value).size === value.length, where, `${field} must have unique IDs`);
  if (sorted) requireAt(value.every((id, index) => index === 0 || value[index - 1] < id), where, `${field} must be sorted by ascending ID`);
}
function countsSchema(value, where, field) {
  requireAt(object(value), where, `${field} must be an object`);
  for (const key of COUNT_KEYS) requireAt(nonnegative(value[key]), where, `${field}.${key} must be a nonnegative safe integer`);
  for (const [key, count] of Object.entries(value)) requireAt(nonnegative(count), where, `${field}.${key} must be a nonnegative safe integer`);
}
function snapshotSchema(value, where) {
  requireAt(object(value), where, 'snapshot must be an object');
  ns(value.timeNs, where, 'snapshot.timeNs');
  for (const key of ['pending', 'completed']) idList(value[key], where, `snapshot.${key}`);
  idList(value.interrupted_history, where, 'snapshot.interrupted_history', false, false);
  for (const key of ['idle_workers', 'active_workers']) idList(value[key], where, `snapshot.${key}`, true);
  requireAt(object(value.processing), where, 'snapshot.processing must be a worker-to-order object');
  for (const [worker, order] of Object.entries(value.processing)) {
    requireAt(/^[1-9][0-9]*$/.test(worker) && positive(Number(worker)) && positive(order), where, 'snapshot.processing must map canonical worker IDs to positive order IDs');
  }
  requireAt(new Set(Object.values(value.processing)).size === Object.keys(value.processing).length, where, 'snapshot.processing cannot assign one order to multiple workers');
  requireAt(nonnegative(value.submitted), where, 'snapshot.submitted must be a nonnegative safe integer');
  requireAt(typeof value.closed === 'boolean', where, 'snapshot.closed must be boolean');
  if (own(value, 'counts')) countsSchema(value.counts, where, 'snapshot.counts');
  if (own(value, 'attempts')) {
    requireAt(object(value.attempts), where, 'snapshot.attempts must be a worker-to-live-attempt object');
    for (const [worker, attempt] of Object.entries(value.attempts)) {
      requireAt(/^[1-9][0-9]*$/.test(worker) && positive(Number(worker)) && object(attempt), where, 'snapshot.attempts must use canonical worker IDs and attempt objects');
      token(attempt.attempt_id, where, 'snapshot.attempts.attempt_id');
      identity(attempt, 'order_id', `${where} snapshot.attempts`);
      const start = ns(attempt.start_ns, where, 'snapshot.attempts.start_ns');
      const due = ns(attempt.due_ns, where, 'snapshot.attempts.due_ns');
      requireAt(due - start === DURATION, where, 'snapshot.attempts.due_ns must equal start_ns plus exactly 10000000000');
    }
  }
}
function schema(record, line) {
  const where = `line ${line}${typeof record?.kind === 'string' ? ` ${record.kind}` : ''}`;
  requireAt(object(record), where, 'JSON value must be an object');
  requireAt(record.schema_version === 1, where, 'schema_version must be 1');
  requireAt(positive(record.event_seq), where, 'event_seq must be a positive safe integer');
  requireAt(KINDS.has(record.kind), where, `unknown kind ${JSON.stringify(record.kind)}`);
  requireAt(record.mode === 'SIMULATED', where, 'mode must be SIMULATED throughout R05');
  requireAt(typeof record.utc === 'string' && UTC.test(record.utc), where, 'utc must be a valid bracketed [HH:MM:SS] clock');
  ns(record.elapsed_ns, where, 'elapsed_ns');
  if (own(record, 'anchor_utc')) same(record.anchor_utc, oracle.anchor_utc, where, 'anchor_utc');
  if (INPUT_KINDS.has(record.kind) || own(record, 'ingress_seq')) identity(record, 'ingress_seq', where);
  if (own(STATE_BY_KIND, record.kind)) same(record.state, STATE_BY_KIND[record.kind], where, 'state');
  if (record.kind.startsWith('order-')) identity(record, 'order_id', where);
  if (record.kind.startsWith('worker-') || ['order-started', 'order-completed', 'order-interrupted'].includes(record.kind)) identity(record, 'worker_id', where);
  if (['order-started', 'order-completed', 'order-interrupted'].includes(record.kind)) token(record.attempt_id, where, 'attempt_id');
  if (record.kind === 'order-created') requireAt(['VIP', 'NORMAL'].includes(record.customer_class), where, 'customer_class must be VIP or NORMAL');
  if (record.kind === 'order-started') {
    const start = ns(record.start_ns, where, 'start_ns');
    const due = ns(record.due_ns, where, 'due_ns');
    requireAt(due - start === DURATION, where, 'due_ns must equal start_ns plus exactly 10000000000');
    same(record.start_ns, record.elapsed_ns, where, 'start_ns');
  }
  if (record.kind === 'run-started') {
    same(record.anchor_utc, oracle.anchor_utc, where, 'anchor_utc');
    same(record.elapsed_ns, '0', where, 'elapsed_ns');
    requireAt(own(record, 'session') || own(record, 'session_id'), where, 'session metadata requires a nonempty session or session_id string');
    for (const key of ['session', 'session_id']) if (own(record, key)) token(record[key], where, key);
  }
  if (['run-summary', 'status'].includes(record.kind) || own(record, 'snapshot')) snapshotSchema(record.snapshot, where);
  if (record.kind === 'run-summary' || own(record, 'counts')) countsSchema(record.counts, where, 'counts');
  if (record.kind === 'help') same(record.commands, COMMANDS, where, 'commands');
  if (['command-rejected', 'command-noop'].includes(record.kind)) token(record.reason_code, where, 'reason_code');
  if (record.kind === 'session-closed') {
    requireAt(['quit', 'eof'].includes(record.reason), where, 'reason must be quit or eof');
    snapshotSchema(record.snapshot, where);
    requireAt(record.snapshot.closed, where, 'terminal snapshot.closed must be true');
  }
  return where;
}
function displayAt(value) {
  let seconds = (43_200n + BigInt(value) / 1_000_000_000n) % 86_400n;
  const hour = seconds / 3600n;
  seconds %= 3600n;
  return `[${hour.toString().padStart(2, '0')}:${(seconds / 60n).toString().padStart(2, '0')}:${(seconds % 60n).toString().padStart(2, '0')}]`;
}

export function verifyDemo(text) {
  requireAt(typeof text === 'string', 'input', 'JSONL input must be text');
  const records = [];
  const places = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { fail(`line ${index + 1}`, 'invalid JSON record'); }
    places.push(schema(value, index + 1));
    requireAt(value.event_seq === records.length + 1, places.at(-1), `event_seq expected ${records.length + 1}, received ${value.event_seq}`);
    records.push(value);
  }
  requireAt(records.length > 0, 'input', 'missing run-started and run-summary');
  requireAt(records[0].kind === 'run-started', 'R05', 'run-started must be first');
  requireAt(records.filter(r => r.kind === 'run-started').length === 1, 'R05', 'exactly one run-started is required');
  requireAt(records.filter(r => r.kind === 'run-summary').length === 1, 'R05', 'exactly one run-summary is required');
  requireAt(records.at(-1).kind === 'run-summary', 'R05', 'run-summary must be last; no records may follow run-summary');
  same(records.at(-1).elapsed_ns, oracle.finish_time_ns, places.at(-1), 'run-summary elapsed_ns');

  const orders = new Map();
  const active = new Set();
  const idle = new Set();
  const processing = new Map();
  const attempts = new Map();
  const pending = [];
  const completed = [];
  const interrupted = [];
  const semantic = [];
  const checked = [];
  let previousTime = 0n;
  let nextStatusIngress = 8;
  let lastStatusTime = null;
  const sortedWorkers = workers => [...workers].sort((a, b) => a - b);
  const sortPending = () => pending.sort((a, b) => {
    const left = orders.get(a);
    const right = orders.get(b);
    return (left.customer_class === 'VIP' ? 0 : 1) - (right.customer_class === 'VIP' ? 0 : 1) || left.ordinal - right.ordinal;
  });
  const current = time => ({
    timeNs: time,
    pending: [...pending],
    processing: Object.fromEntries([...processing].sort(([a], [b]) => a - b).map(([worker, attempt]) => [worker, attempt.order_id])),
    completed: [...completed], interrupted_history: [...interrupted],
    idle_workers: sortedWorkers(idle), active_workers: sortedWorkers(active), submitted: orders.size,
    closed: false,
    counts: { submitted: orders.size, pending: pending.length, processing: processing.size, complete: completed.length, active_bots: active.size },
    attempts: Object.fromEntries([...processing].sort(([a], [b]) => a - b).map(([worker, attempt]) => [worker, {
      attempt_id: attempt.attempt_id, order_id: attempt.order_id, start_ns: attempt.start.toString(), due_ns: attempt.due.toString(),
    }])),
  });
  function compareSnapshot(actual, expected, where) {
    for (const key of ['timeNs', ...SNAPSHOT_KEYS, 'closed']) same(actual[key], expected[key], where, `snapshot.${key}`);
    if (own(actual, 'counts')) for (const key of COUNT_KEYS) same(actual.counts[key], expected.counts[key], where, `snapshot.counts.${key}`);
    if (own(actual, 'attempts')) same(actual.attempts, expected.attempts, where, 'snapshot.attempts');
  }
  const checkpointsAt = new Map([[4, 0], [8, 1], [10, 2], [12, 3], [14, 4], [16, 5], [18, 6]]);
  function checkpoint(time, where) {
    const index = checkpointsAt.get(semantic.length);
    if (index === undefined) return;
    const expected = oracle.checkpoint_snapshots[index];
    same(time, expected.time_ns, where, `checkpoint ${expected.label} time`);
    const state = current(time);
    for (const key of SNAPSHOT_KEYS) same(state[key], expected[key], where, `checkpoint ${expected.label}.${key}`);
    const all = [...state.pending, ...Object.values(state.processing), ...state.completed].sort((a, b) => a - b);
    same(all, [...orders.keys()].sort((a, b) => a - b), where, `checkpoint ${expected.label} conservation`);
    requireAt(!(pending.length && idle.size), where, `checkpoint ${expected.label} has pending orders and idle workers`);
    checked.push(expected.label);
  }
  function liveAttempt(record, where) {
    const attempt = attempts.get(record.attempt_id);
    requireAt(attempt, where, `invalid attempt_id ${JSON.stringify(record.attempt_id)} has no live start`);
    requireAt(attempt.status === 'active', where, `${attempt.status === 'canceled' ? 'canceled attempt resurrection' : 'duplicate completion or ended attempt'}: ${record.attempt_id}`);
    requireAt(attempt.order_id === record.order_id && attempt.worker_id === record.worker_id && processing.get(record.worker_id) === attempt, where, 'attempt linkage does not match live worker/order assignment');
    return attempt;
  }

  for (const [index, record] of records.entries()) {
    const where = places[index];
    const time = BigInt(record.elapsed_ns);
    // Completion linkage/deadline is checked before display agreement, so an
    // early semantic completion gets a semantic, rather than cosmetic, error.
    if (record.kind === 'order-completed') {
      const attempt = liveAttempt(record, where);
      requireAt(time === attempt.due, where, `completion deadline expected elapsed_ns ${attempt.due}, received ${time}; early/late completion is invalid`);
    }
    requireAt(time >= previousTime, where, 'elapsed_ns reverses logical event time');
    previousTime = time;
    same(record.utc, displayAt(record.elapsed_ns), where, 'utc');
    if (!SEMANTIC_KINDS.has(record.kind)) {
      requireAt(['run-started', 'run-summary', 'status'].includes(record.kind), where, `unexpected ${record.kind} record in R05 demo`);
      if (record.kind === 'status') {
        requireAt(semantic.length >= 10, where, 'status ingress_seq cannot replace or interleave frozen R05 inputs 1..7');
        requireAt([...processing.values()].every(attempt => attempt.due > time), where, 'status must follow settlement of every due attempt; overdue processing is invalid');
        requireAt(!(pending.length && idle.size), where, 'status must follow immediate dispatch; pending orders cannot coexist with idle workers');
        same(record.ingress_seq, nextStatusIngress++, where, 'status ingress_seq');
        lastStatusTime = time;
      } else requireAt(!own(record, 'ingress_seq'), where, `${record.kind} must not claim ingress_seq`);
    } else {
      requireAt(time !== lastStatusTime, where, 'same-time autonomous events must precede accepted status input');
      semantic.push(record);
      const expectedIngress = record.kind === 'order-created' ? record.order_id - 1000
        : record.kind === 'worker-added' ? record.worker_id + 4
          : ['worker-removed', 'order-interrupted'].includes(record.kind) ? 7
            : record.kind === 'order-started' && time === 0n ? record.worker_id + 4 : undefined;
      if (expectedIngress === undefined) requireAt(!own(record, 'ingress_seq'), where, 'autonomous event must not falsely claim ingress_seq');
      else same(record.ingress_seq, expectedIngress, where, 'ingress_seq');
      switch (record.kind) {
        case 'order-created':
          requireAt(!orders.has(record.order_id), where, 'order-created reuses order_id');
          same(record.order_id, 1001 + orders.size, where, 'order-created order_id');
          orders.set(record.order_id, { customer_class: record.customer_class, ordinal: orders.size + 1 });
          pending.push(record.order_id); sortPending();
          break;
        case 'worker-added':
          requireAt(!active.has(record.worker_id), where, 'worker-added reuses worker_id');
          same(record.worker_id, active.size + 1, where, 'worker-added worker_id');
          active.add(record.worker_id); idle.add(record.worker_id);
          break;
        case 'order-started': {
          requireAt(!attempts.has(record.attempt_id), where, 'attempt_id must be unique and cannot be reused');
          requireAt(active.has(record.worker_id) && idle.has(record.worker_id), where, 'start requires an active idle worker');
          same(record.worker_id, sortedWorkers(idle)[0], where, 'start worker_id');
          same(record.order_id, pending[0], where, 'start highest-priority pending order_id');
          pending.shift(); idle.delete(record.worker_id);
          const attempt = { attempt_id: record.attempt_id, order_id: record.order_id, worker_id: record.worker_id, start: time, due: BigInt(record.due_ns), status: 'active' };
          attempts.set(record.attempt_id, attempt); processing.set(record.worker_id, attempt);
          break;
        }
        case 'order-interrupted': {
          const attempt = liveAttempt(record, where);
          requireAt(time < attempt.due, where, 'interruption cannot cancel an already due attempt');
          attempt.status = 'canceled'; processing.delete(record.worker_id);
          pending.push(record.order_id); sortPending(); interrupted.push(record.order_id);
          break;
        }
        case 'worker-removed':
          same(record.worker_id, Math.max(...active), where, 'removed newest active worker_id');
          active.delete(record.worker_id); idle.delete(record.worker_id);
          break;
        case 'order-completed': {
          const attempt = liveAttempt(record, where);
          requireAt(active.has(record.worker_id), where, 'completion requires an active worker');
          requireAt(!completed.includes(record.order_id), where, 'duplicate completion for order_id');
          attempt.status = 'completed'; processing.delete(record.worker_id);
          completed.push(record.order_id); idle.add(record.worker_id);
          break;
        }
        case 'worker-idle': requireAt(active.has(record.worker_id) && idle.has(record.worker_id) && !pending.length, where, 'worker-idle does not agree with active idle state'); break;
      }
      // t2's two records form one atomic externally visible transition. Either
      // internal order is accepted; its checkpoint is tested after both.
      checkpoint(record.elapsed_ns, where);
    }
    const state = current(record.elapsed_ns);
    if (own(record, 'snapshot')) compareSnapshot(record.snapshot, state, where);
    if (own(record, 'counts')) for (const key of COUNT_KEYS) same(record.counts[key], state.counts[key], where, `counts.${key}`);
  }

  const ordered = semantic.filter(record => record.elapsed_ns !== '2000000000');
  const t2 = semantic.filter(record => record.elapsed_ns === '2000000000');
  function compareEvent(actual, expected, where) {
    requireAt(actual, where, `missing semantic ${expected.kind}`);
    same(actual.kind, expected.kind, where, 'semantic kind');
    same(actual.elapsed_ns, expected.at_ns, where, 'semantic elapsed_ns');
    for (const key of ['order_id', 'worker_id', 'state', 'customer_class']) if (own(expected, key)) same(actual[key], expected[key], where, `semantic ${key}`);
  }
  requireAt(ordered.length === oracle.ordered_semantic_events_excluding_t2.length, 'R05 semantic trace', `expected 16 ordered semantic events, received ${ordered.length}; extra or missing business event`);
  ordered.forEach((event, index) => compareEvent(event, oracle.ordered_semantic_events_excluding_t2[index], `R05 semantic event ${index + 1}`));
  requireAt(t2.length === 2, 'R05 semantic trace', 't2 requires exactly interruption and removal');
  for (const expected of oracle.unordered_t2_group) {
    const matches = t2.filter(record => record.kind === expected.kind);
    requireAt(matches.length === 1, 'R05 t2', `expected one ${expected.kind}`);
    compareEvent(matches[0], expected, 'R05 t2');
  }
  same(checked, oracle.checkpoint_snapshots.map(snapshot => snapshot.label), 'R05', 'seven reconstructed checkpoints');
  for (const key of SNAPSHOT_KEYS) same(current(oracle.finish_time_ns)[key], oracle.final[key], 'run-summary', `final ${key}`);
  same([...attempts.values()].filter(attempt => attempt.status === 'canceled').length, oracle.final.canceled_processing_attempts, 'run-summary', 'canceled_processing_attempts');
  return { records, report: { semantic_events: semantic.length, checkpoints: checked, completed: [...completed], attempts: attempts.size, canceled_processing_attempts: interrupted.length } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireAt(process.argv.length === 3, 'usage', 'node tests/verify-demo.js <JSONL-path>');
    const { report } = verifyDemo(readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(`R05 verified: ${report.semantic_events} semantic events, ${report.checkpoints.length} checkpoints\n`);
  } catch (error) {
    process.stderr.write(`R05 verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
