import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/controller.js';
import { at, harness, identity, normal, vip, request } from './helpers.js';

test('malformed direct requests cannot borrow inherited class or rejection payloads', () => {
  const controller=createController();
  const inheritedClass=Object.assign(Object.create({customerClass:'VIP'}),{op:'order'});
  const inheritedReason=Object.assign(Object.create({reasonCode:'INHERITED'}),{op:'invalid'});
  for(const value of [inheritedClass,inheritedReason]) {
    const result=controller.acceptAt(0n,value);
    assert.equal(result.events[0].kind,'command-rejected');
    assert.equal(result.events[0].reason_code,'INVALID_REQUEST');
    assert.equal(result.snapshot.submitted,0);
  }
  const created=controller.acceptAt(0n,{op:'order',customerClass:'NORMAL'});
  assert.equal(created.events[0].order_id,1001);
  assert.equal(created.events[0].ingress_seq,3);
});

test('R05 invariant replay accepts either atomic removal/interruption inner order', () => {
  const actual=createController();
  const adapter={...actual,acceptAt(...args) {
    const result=actual.acceptAt(...args);
    const index=result.events.findIndex(e=>e.kind==='order-interrupted');
    if(index>=0 && result.events[index+1]?.kind==='worker-removed') {
      [result.events[index],result.events[index+1]]=[result.events[index+1],result.events[index]];
    }
    return result;
  }};
  const h=harness(adapter);
  h.accept(0n,normal());h.accept(0n,request('bot-add'));
  const result=h.accept(at(2),request('bot-remove'));
  assert.deepEqual(result.events.map(e=>e.kind),['worker-removed','order-interrupted']);
  assert.deepEqual(h.events.slice(-2).map(e=>e.kind),['worker-removed','order-interrupted']);
  assert.deepEqual(h.snapshot().pending,[1001]);
});

test('AT-01 normal order awaits a worker with no deadline', () => {
  const h = harness();
  const { events, snapshot } = h.accept(0n, normal());
  assert.deepEqual(events, [{ kind: 'order-created', logicalTimeNs: 0n, order_id: 1001, customer_class: 'NORMAL', state: 'PENDING', ingress_seq: 1 }]);
  assert.deepEqual(identity(snapshot), { pending: [1001], processing: {}, completed: [], interrupted_history: [], idle_workers: [], active_workers: [] });
  assert.equal(snapshot.timeNs, '0');
  assert.equal(h.controller.nextDue(), null);
});

test('AT-02 VIP priority and per-class FIFO use exact accepted identities', () => {
  const h = harness();
  [normal(), vip(), normal(), vip()].forEach((input) => h.accept(0n, input));
  assert.deepEqual(h.snapshot().pending, [1002, 1004, 1001, 1003]);
});

test('AT-03 order and worker identities increase across cancellation', () => {
  const h = harness();
  h.accept(0n, normal()); h.accept(0n, request('bot-add'));
  h.accept(at(1), request('bot-remove')); h.accept(at(1), vip());
  h.accept(at(1), request('bot-add')); h.accept(at(1), normal());
  assert.deepEqual(h.events.filter((e) => e.kind === 'order-created').map((e) => e.order_id), [1001, 1002, 1003]);
  assert.deepEqual(h.events.filter((e) => e.kind === 'worker-added').map((e) => e.worker_id), [1, 2]);
  assert.equal(h.snapshot().submitted, 3);
});

test('AT-04 adding a worker dispatches the first VIP with exact deadline', () => {
  const h = harness(); h.accept(0n, vip()); h.accept(0n, normal());
  const { events, snapshot } = h.accept(0n, request('bot-add'));
  assert.deepEqual(events.map((e) => e.kind), ['worker-added', 'order-started']);
  assert.deepEqual(events.map((e) => e.ingress_seq), [3, 3]);
  assert.deepEqual(snapshot.processing, { 1: 1001 });
  assert.deepEqual(snapshot.pending, [1002]);
  assert.deepEqual(h.controller.nextDue(), { dueNs: at(10), workerId: 1 });
});

test('AT-07 a busy worker keeps one order when another arrives', () => {
  const h = harness(); h.accept(0n, request('bot-add')); h.accept(0n, normal());
  const result = h.accept(at(1), normal());
  assert.deepEqual(result.events.map((e) => e.kind), ['order-created']);
  assert.deepEqual(result.snapshot.processing, { 1: 1001 });
  assert.deepEqual(result.snapshot.pending, [1002]);
});

test('AT-08 the oldest idle worker receives new work', () => {
  const h = harness(); h.accept(0n, request('bot-add')); h.accept(0n, request('bot-add'));
  h.accept(0n, normal());
  assert.deepEqual(h.snapshot().processing, { 1: 1001 });
  assert.deepEqual(h.snapshot().idle_workers, [2]);
});

test('AT-A06 creation PENDING event precedes immediate PROCESSING pickup', () => {
  const h = harness(); h.accept(0n, request('bot-add'));
  const result = h.accept(at(1), normal());
  assert.deepEqual(result.events.map((e) => [e.kind, e.state, e.order_id, e.ingress_seq]), [['order-created', 'PENDING', 1001, 2], ['order-started', 'PROCESSING', 1001, 2]]);
  assert.deepEqual(result.snapshot.processing, { 1: 1001 });
});

test('detached snapshots, events and nextDue cannot alter controller state', () => {
  const controller = createController();
  controller.acceptAt(0n, request('bot-add'));
  const result = controller.acceptAt(0n, normal());
  const before = controller.getSnapshot();
  assert.deepEqual(before.processing, { 1: 1001 });
  result.snapshot.processing[1] = 9999;
  result.snapshot.active_workers.push(99);
  result.snapshot.attempts[1].due_ns = '0';
  result.snapshot.counts.submitted = 99;
  result.events[1].order_id = 9999;
  controller.nextDue().dueNs = 0n;
  assert.deepEqual(controller.getSnapshot(), before);
  assert.deepEqual(controller.nextDue(), { dueNs: at(10), workerId: 1 });
});

test('malformed direct requests reject without allocating identities', () => {
  const h = harness();
  [null, [], {}, { op: 'order' }, { op: 'order', customerClass: 'vip' }, { op: 'wat' }, { op: 'invalid', reasonCode: '' }].forEach((input, index) => {
    const result = h.accept(0n, input);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].kind, 'command-rejected');
    assert.equal(result.events[0].ingress_seq, index + 1);
    assert.ok(result.events[0].reason_code.length > 0);
    assert.equal(result.snapshot.submitted, 0);
  });
  assert.equal(h.accept(0n, normal()).events[0].order_id, 1001);
  assert.equal(h.accept(0n, request('bot-add')).events[0].worker_id, 1);
});

test('invalid or reversed time is rejected atomically before ingress allocation', () => {
  const h = harness(); h.accept(at(2), normal());
  const before = h.snapshot();
  for (const value of [-1n, 1, NaN, '3', at(1)]) {
    assert.throws(() => h.controller.acceptAt(value, normal()), /time|bigint|nonnegative/i);
    assert.deepEqual(h.snapshot(), before);
    assert.throws(() => h.controller.settleTo(value), /time|bigint|nonnegative/i);
    assert.deepEqual(h.snapshot(), before);
  }
  const result = h.accept(at(2), normal());
  assert.equal(result.events[0].order_id, 1002);
  assert.equal(result.events[0].ingress_seq, 2);
});

function singleWorkingOrder() {
  const h = harness();
  h.accept(0n, normal()); h.accept(0n, request('bot-add'));
  return h;
}

test('AT-05 completes exactly at ten logical seconds and only once', () => {
  const h = singleWorkingOrder();
  assert.deepEqual(h.settle(at(10) - 1n).events, []);
  assert.deepEqual(h.snapshot().processing, { 1: 1001 });
  assert.deepEqual(h.settle(at(10)).events.map((e) => [e.kind, e.logicalTimeNs]), [['order-completed', at(10)], ['worker-idle', at(10)]]);
  assert.deepEqual(h.snapshot().completed, [1001]);
  assert.deepEqual(h.snapshot().idle_workers, [1]);
  assert.equal(h.controller.nextDue(), null);
  assert.deepEqual(h.settle(at(100)).events, []);
});

test('AT-06 completion immediately starts the next order at its deadline', () => {
  const h = singleWorkingOrder(); h.accept(0n, normal());
  const result = h.settle(at(10));
  assert.deepEqual(result.events.map((e) => [e.kind, e.order_id, e.worker_id]), [['order-completed', 1001, 1], ['order-started', 1002, 1]]);
  assert.ok(result.events.every((e) => !('ingress_seq' in e)));
  assert.deepEqual(h.snapshot().processing, { 1: 1002 });
  assert.deepEqual(h.controller.nextDue(), { dueNs: at(20), workerId: 1 });
});

test('AT-09 two workers process overlapping full ten-second intervals', () => {
  const h = harness(); h.accept(0n, normal()); h.accept(0n, normal());
  h.accept(0n, request('bot-add')); h.accept(0n, request('bot-add'));
  h.settle(at(5));
  assert.deepEqual(h.snapshot().processing, { 1: 1001, 2: 1002 });
  assert.deepEqual(Object.values(h.snapshot().attempts).map((attempt) => attempt.due_ns), ['10000000000', '10000000000']);
  assert.deepEqual(h.snapshot().completed, []);
});

test('AT-10 VIP arrival preserves current normal attempt and is picked next', () => {
  const h = singleWorkingOrder(); h.accept(0n, normal());
  const attempt = h.snapshot().attempts[1];
  h.accept(at(2), vip());
  assert.deepEqual(h.snapshot().attempts[1], attempt);
  assert.deepEqual(h.snapshot().pending, [1003, 1002]);
  h.settle(at(10));
  assert.deepEqual(h.snapshot().processing, { 1: 1003 });
  assert.deepEqual(h.snapshot().pending, [1002]);
});

test('AT-11 removes newest idle worker while preserving older busy attempt', () => {
  const h = singleWorkingOrder(); h.accept(0n, request('bot-add'));
  const attempt = h.snapshot().attempts[1];
  const result = h.accept(at(2), request('bot-remove'));
  assert.deepEqual(result.events.map((e) => [e.kind, e.worker_id]), [['worker-removed', 2]]);
  assert.deepEqual(result.snapshot.active_workers, [1]);
  assert.deepEqual(result.snapshot.attempts[1], attempt);
  assert.deepEqual(result.snapshot.interrupted_history, []);
});

test('AT-12 removes busy worker and cancels its old completion deadline', () => {
  const h = singleWorkingOrder();
  const old = h.snapshot().attempts[1].attempt_id;
  const result = h.accept(at(4), request('bot-remove'));
  assert.deepEqual(new Set(result.events.map((e) => e.kind)), new Set(['order-interrupted', 'worker-removed']));
  assert.ok(result.events.every((e) => e.ingress_seq === 3));
  assert.equal(result.events.find((e) => e.kind === 'order-interrupted').attempt_id, old);
  assert.deepEqual(result.snapshot.pending, [1001]);
  assert.deepEqual(result.snapshot.active_workers, []);
  assert.equal(h.controller.nextDue(), null);
  assert.deepEqual(h.settle(at(10)).events, []);
  assert.deepEqual(h.snapshot().completed, []);
});

test('AT-13 interruption restores original class and creation ordinal', () => {
  const h = singleWorkingOrder(); h.accept(0n, normal()); h.accept(0n, vip()); h.accept(0n, normal());
  h.accept(at(2), request('bot-remove'));
  assert.deepEqual(h.snapshot().pending, [1003, 1001, 1002, 1004]);
});

test('AT-14 interruption starts a new full ten-second attempt without credit', () => {
  const h = singleWorkingOrder(); const oldAttempt = h.snapshot().attempts[1].attempt_id;
  h.accept(at(4), request('bot-remove')); h.accept(at(4), request('bot-add'));
  assert.notEqual(h.snapshot().attempts[2].attempt_id, oldAttempt);
  assert.equal(h.snapshot().attempts[2].due_ns, '14000000000');
  assert.deepEqual(h.settle(at(14) - 1n).events, []);
  assert.deepEqual(h.snapshot().completed, []);
  h.settle(at(14));
  assert.deepEqual(h.snapshot().completed, [1001]);
});

test('AT-15 canceled first attempt cannot complete at its obsolete due time', () => {
  const h = singleWorkingOrder(); h.accept(at(4), request('bot-remove')); h.accept(at(4), request('bot-add'));
  assert.deepEqual(h.settle(at(10)).events, []);
  assert.deepEqual(h.snapshot().processing, { 2: 1001 });
  const completions = h.settle(at(14)).events.filter((e) => e.kind === 'order-completed');
  assert.deepEqual(completions.map((e) => [e.order_id, e.worker_id, e.logicalTimeNs]), [[1001, 2, at(14)]]);
  assert.deepEqual(h.snapshot().completed, [1001]);
});

test('AT-16 exact-deadline removal follows autonomous completion', () => {
  const h = singleWorkingOrder();
  const result = h.accept(at(10), request('bot-remove'));
  assert.deepEqual(result.events.map((e) => e.kind), ['order-completed', 'worker-idle', 'worker-removed']);
  assert.ok(!('ingress_seq' in result.events[0]));
  assert.equal(result.events[2].ingress_seq, 3);
  assert.deepEqual(result.snapshot.completed, [1001]);
  assert.deepEqual(result.snapshot.pending, []);
  assert.deepEqual(result.snapshot.interrupted_history, []);
});

test('AT-17 zero-worker removal is informative and consumes no identities', () => {
  const h = harness();
  for (let index = 1; index <= 2; index++) {
    const result = h.accept(0n, request('bot-remove'));
    assert.equal(result.events[0].kind, 'command-noop');
    assert.ok(result.events[0].reason_code.length);
    assert.equal(result.events[0].ingress_seq, index);
    assert.deepEqual(identity(result.snapshot), { pending: [], processing: {}, completed: [], interrupted_history: [], idle_workers: [], active_workers: [] });
  }
  assert.equal(h.accept(0n, normal()).events[0].order_id, 1001);
  assert.equal(h.accept(0n, request('bot-add')).events[0].worker_id, 1);
});

test('AT-18 tied completions dispatch immediately in lower worker ID order', () => {
  const h = harness(); h.accept(0n, normal()); h.accept(0n, normal());
  h.accept(0n, request('bot-add')); h.accept(0n, request('bot-add'));
  h.accept(0n, vip()); h.accept(0n, normal());
  const result = h.settle(at(10));
  assert.deepEqual(result.events.map((e) => [e.kind, e.worker_id, e.order_id]), [
    ['order-completed', 1, 1001], ['order-started', 1, 1003],
    ['order-completed', 2, 1002], ['order-started', 2, 1004],
  ]);
  assert.deepEqual(h.snapshot().processing, { 1: 1003, 2: 1004 });
});

test('AT-20 invalid input settles deadline before rejection with no business mutation', () => {
  const testRun = singleWorkingOrder(); const control = singleWorkingOrder();
  const result = testRun.accept(at(10), { op: 'invalid', reasonCode: 'BAD_COMMAND' });
  control.settle(at(10));
  assert.deepEqual(result.events.map((e) => e.kind), ['order-completed', 'worker-idle', 'command-rejected']);
  assert.deepEqual(result.snapshot, control.snapshot());
  assert.equal(testRun.accept(at(10), normal()).events[0].order_id, 1002);
  assert.equal(testRun.accept(at(10), request('bot-add')).events[0].worker_id, 2);
});

test('AT-A01 overdue settlement catches all cascading deadlines at scheduled times', () => {
  const h = harness(); [normal(), normal(), normal()].forEach((input) => h.accept(0n, input));
  h.accept(0n, request('bot-add'));
  const result = h.accept(at(100), request('status'));
  assert.deepEqual(result.events.filter((e) => e.kind === 'order-completed').map((e) => [e.order_id, e.logicalTimeNs]), [[1001, at(10)], [1002, at(20)], [1003, at(30)]]);
  assert.equal(result.events.at(-1).kind, 'status');
  assert.equal(result.events.at(-1).logicalTimeNs, at(100));
  assert.deepEqual(result.snapshot.completed, [1001, 1002, 1003]);
  assert.deepEqual(result.snapshot.idle_workers, [1]);
});

test('AT-A02 equal-time input order is repeatable and ingress-sensitive', () => {
  function branch(inputs) {
    const h = harness(); h.accept(0n, request('bot-add'));
    inputs.forEach((input) => h.accept(0n, input));
    assert.deepEqual(h.events.filter((e) => e.kind === 'order-created').map((e) => e.ingress_seq), [2, 3]);
    return h;
  }
  const a = branch([normal(), vip()]); const b = branch([vip(), normal()]);
  assert.deepEqual(a.snapshot().processing, { 1: 1001 });
  assert.deepEqual(a.snapshot().pending, [1002]);
  assert.deepEqual(b.snapshot().processing, { 1: 1001 });
  assert.deepEqual(b.snapshot().pending, [1002]);
  assert.equal(a.events.find((e) => e.kind === 'order-created').customer_class, 'NORMAL');
  assert.equal(b.events.find((e) => e.kind === 'order-created').customer_class, 'VIP');
  assert.deepEqual(branch([normal(), vip()]).events, a.events);
});

test('AT-A03 help status and invalid requests settle first without further mutation', () => {
  for (const input of [request('help'), request('status'), { op: 'invalid', reasonCode: 'BAD_COMMAND' }]) {
    const h = singleWorkingOrder(); const control = singleWorkingOrder();
    const result = h.accept(at(10), input); control.settle(at(10));
    assert.equal(result.events[0].kind, 'order-completed');
    assert.equal(result.events.at(-1).ingress_seq, 3);
    assert.deepEqual(result.snapshot, control.snapshot());
    if (input.op === 'help') assert.deepEqual(result.events.at(-1).commands, ['order normal', 'order vip', 'bot add', 'bot remove', 'status', 'help', 'quit']);
    if (input.op === 'status') assert.deepEqual(result.events.at(-1).snapshot, result.snapshot);
  }
});

test('repeated rapid interruptions never revive attempts or worker IDs', () => {
  const h = singleWorkingOrder();
  for (let second = 1; second <= 7; second++) {
    h.accept(at(second), request('bot-remove'));
    h.accept(at(second), request('bot-add'));
  }
  assert.deepEqual(h.snapshot().processing, { 8: 1001 });
  assert.equal(h.snapshot().attempts[8].due_ns, '17000000000');
  h.settle(at(17) - 1n);
  assert.deepEqual(h.snapshot().completed, []);
  h.settle(at(17));
  assert.deepEqual(h.events.filter((e) => e.kind === 'order-completed').map((e) => [e.worker_id, e.order_id, e.logicalTimeNs]), [[8, 1001, at(17)]]);
  assert.deepEqual(h.snapshot().interrupted_history, [1001, 1001, 1001, 1001, 1001, 1001, 1001]);
});

test('AT-A07 quit and EOF settle exact boundary then close once permanently', () => {
  for (const op of ['quit', 'eof']) {
    for (const boundary of [at(10) - 1n, at(10)]) {
      const h = singleWorkingOrder();
      const result = h.accept(boundary, request(op));
      const expectedKinds = boundary === at(10) ? ['order-completed', 'worker-idle', 'session-closed'] : ['session-closed'];
      assert.deepEqual(result.events.map((e) => e.kind), expectedKinds, `${op} at ${boundary}`);
      assert.equal(result.events.at(-1).reason, op);
      assert.equal(result.events.at(-1).ingress_seq, 3);
      assert.equal(result.snapshot.closed, true);
      assert.deepEqual(result.snapshot.completed, boundary === at(10) ? [1001] : []);
      assert.deepEqual(result.events.at(-1).snapshot, result.snapshot);
      assert.equal(h.controller.nextDue(), null);
      const terminal = h.snapshot();
      assert.deepEqual(h.controller.settleTo(at(1000)), { events: [] });
      for (const later of [request(op), normal(), request('bot-add'), request('status')]) {
        const postClose = h.controller.acceptAt(at(1000), later);
        assert.deepEqual(postClose.events, []);
        assert.deepEqual(postClose.snapshot, terminal);
      }
      assert.deepEqual(h.snapshot(), terminal);
      result.snapshot.pending.push(9999);
      result.events.at(-1).snapshot.processing[1] = 9999;
      assert.deepEqual(h.snapshot(), terminal);
    }
  }
});

test('time reversal after settlement cannot mutate work or consume request identity', () => {
  const h = singleWorkingOrder(); h.accept(0n, normal()); h.settle(at(11));
  const before = h.snapshot();
  assert.throws(() => h.controller.acceptAt(at(10), vip()), /time/i);
  assert.throws(() => h.controller.settleTo(at(10)), /time/i);
  assert.deepEqual(h.snapshot(), before);
  const result = h.accept(at(11), vip());
  assert.equal(result.events[0].ingress_seq, 4);
  assert.equal(result.events[0].order_id, 1003);
});
