import assert from 'node:assert/strict';
import { createController } from '../src/controller.js';

export const SECOND = 1_000_000_000n;
export const at = (seconds) => BigInt(seconds) * SECOND;
export const normal = () => ({ op: 'order', customerClass: 'NORMAL' });
export const vip = () => ({ op: 'order', customerClass: 'VIP' });
export const request = (op) => ({ op });
export const identity = (snapshot) => Object.fromEntries(
  ['pending', 'processing', 'completed', 'interrupted_history', 'idle_workers', 'active_workers']
    .map((key) => [key, snapshot[key]]),
);

// Independent event replay checks all seven R3 invariants at each public transition.
// Expected fixed acceptance states remain literal or frozen fixture data.
export function harness(controller = createController()) {
  const events = [];
  const orders = new Map();
  const workers = new Map();
  const canceled = new Set();
  const seenAttempts = new Set();
  const completed = [];
  const interrupted = [];
  let maxWorker = 0;
  let previousTime = 0n;
  let lastIngress = 0;

  function pending() {
    return [...orders.values()].filter((order) => order.state === 'PENDING')
      .sort((a, b) => (a.customerClass === b.customerClass ? a.ordinal - b.ordinal : a.customerClass === 'VIP' ? -1 : 1))
      .map((order) => order.id);
  }
  function observe(batch, snapshot) {
    // R3 deliberately allows either emission order for the atomic busy-removal
    // pair. Normalize only its replay, retaining actual output order in events.
    const replay = [...batch];
    for (let i=0;i<replay.length-1;i++) {
      const removed=replay[i], interrupted=replay[i+1];
      if (removed.kind==='worker-removed' && interrupted.kind==='order-interrupted'
        && removed.worker_id===interrupted.worker_id && removed.logicalTimeNs===interrupted.logicalTimeNs
        && removed.ingress_seq===interrupted.ingress_seq) {
        [replay[i],replay[i+1]]=[interrupted,removed];i++;
      }
    }
    for (const event of replay) {
      assert.equal(typeof event.logicalTimeNs, 'bigint', 'I07 exact event time');
      assert.ok(event.logicalTimeNs >= previousTime, 'I07 chronological event offsets');
      previousTime = event.logicalTimeNs;
      if ('ingress_seq' in event) {
        assert.ok(Number.isSafeInteger(event.ingress_seq) && event.ingress_seq > 0);
        assert.ok(event.ingress_seq >= lastIngress, 'I05 ingress order');
        lastIngress = event.ingress_seq;
      }
      const order = orders.get(event.order_id);
      switch (event.kind) {
        case 'order-created':
          assert.equal(event.order_id, 1001 + orders.size, 'I05 monotone creation IDs');
          assert.equal(event.state, 'PENDING');
          orders.set(event.order_id, { id: event.order_id, customerClass: event.customer_class, ordinal: orders.size + 1, state: 'PENDING' });
          break;
        case 'worker-added':
          assert.ok(event.worker_id > maxWorker, 'I05 strictly increasing worker IDs');
          maxWorker = event.worker_id;
          assert.equal(event.state, 'IDLE');
          workers.set(event.worker_id, null);
          break;
        case 'order-started': {
          assert.equal(event.order_id, pending()[0], 'I03 highest priority/FIFO pickup');
          assert.equal(event.worker_id, [...workers].filter(([, value]) => value === null).map(([id]) => id).sort((a, b) => a - b)[0], 'I03 lowest idle worker');
          assert.equal(event.state, 'PROCESSING');
          assert.ok(!seenAttempts.has(event.attempt_id), 'I02 fresh attempt token');
          assert.equal(BigInt(event.start_ns), event.logicalTimeNs);
          assert.equal(BigInt(event.due_ns), event.logicalTimeNs + 10n * SECOND, 'I07 exact duration');
          seenAttempts.add(event.attempt_id);
          order.state = 'PROCESSING';
          workers.set(event.worker_id, { orderId: event.order_id, attemptId: event.attempt_id, startNs: event.logicalTimeNs, dueNs: BigInt(event.due_ns) });
          break;
        }
        case 'order-interrupted': {
          const live = workers.get(event.worker_id);
          assert.equal(live?.attemptId, event.attempt_id, 'I02 interruption live attempt');
          assert.equal(live.orderId, event.order_id);
          assert.equal(event.state, 'PENDING');
          canceled.add(event.attempt_id);
          workers.set(event.worker_id, null);
          order.state = 'PENDING';
          interrupted.push(event.order_id);
          break;
        }
        case 'worker-removed':
          assert.ok(workers.has(event.worker_id));
          assert.equal(workers.get(event.worker_id), null, 'I02 busy removal must interrupt');
          assert.equal(event.state, 'REMOVED');
          workers.delete(event.worker_id);
          break;
        case 'order-completed': {
          const live = workers.get(event.worker_id);
          assert.ok(!canceled.has(event.attempt_id), 'I04 canceled attempt inert');
          assert.equal(live?.attemptId, event.attempt_id, 'I04 live completion');
          assert.equal(live.orderId, event.order_id);
          assert.equal(event.logicalTimeNs, live.dueNs, 'I07 exact scheduled completion');
          assert.equal(event.logicalTimeNs - live.startNs, 10n * SECOND);
          assert.ok(!completed.includes(event.order_id), 'I04 at most one completion');
          assert.equal(order.state, 'PROCESSING');
          assert.equal(event.state, 'COMPLETE');
          assert.ok(!('ingress_seq' in event), 'autonomous completion is not attributed to input');
          order.state = 'COMPLETE';
          workers.set(event.worker_id, null);
          completed.push(event.order_id);
          break;
        }
        case 'worker-idle':
          assert.equal(workers.get(event.worker_id), null);
          assert.equal(event.state, 'IDLE');
          break;
      }
    }
    events.push(...batch);
    if (snapshot.closed) return;
    const processing = Object.fromEntries([...workers].filter(([, live]) => live !== null).map(([id, live]) => [id, live.orderId]));
    const idle = [...workers].filter(([, live]) => live === null).map(([id]) => id);
    const all = [...snapshot.pending, ...Object.values(snapshot.processing), ...snapshot.completed];
    assert.equal(all.length, orders.size, 'I01 count conservation');
    assert.equal(new Set(all).size, orders.size, 'I01 exclusive order partition');
    assert.deepEqual([...all].sort((a, b) => a - b), [...orders.keys()], 'I01 identities conserved');
    assert.equal(new Set(Object.values(snapshot.processing)).size, Object.keys(snapshot.processing).length, 'I02 bijection');
    assert.deepEqual(snapshot.pending, pending(), 'I03 queue priority');
    assert.deepEqual(snapshot.processing, processing, 'I02/I05 assignment history');
    assert.deepEqual(snapshot.completed, completed, 'I04/I05 terminal history');
    assert.deepEqual(snapshot.interrupted_history, interrupted, 'I05 interruption history');
    assert.deepEqual(snapshot.active_workers, [...workers.keys()], 'I05 active roster');
    assert.deepEqual(snapshot.idle_workers, idle, 'I05 idle roster');
    assert.ok(!(snapshot.pending.length && snapshot.idle_workers.length), 'I06 dispatch closure');
    assert.equal(snapshot.submitted, orders.size);
    assert.deepEqual(snapshot.counts, { submitted: orders.size, pending: snapshot.pending.length, processing: Object.keys(processing).length, complete: completed.length, active_bots: workers.size });
    for (const [workerId, live] of workers) {
      if (live === null) continue;
      assert.equal(snapshot.attempts[workerId].attempt_id, live.attemptId, 'I02 snapshot live attempt');
      assert.equal(snapshot.attempts[workerId].order_id, live.orderId);
      assert.equal(snapshot.attempts[workerId].start_ns, live.startNs.toString());
      assert.equal(snapshot.attempts[workerId].due_ns, live.dueNs.toString());
    }
    return snapshot;
  }
  return {
    controller, events,
    accept(tNs, input) {
      const result = controller.acceptAt(tNs, input);
      assert.ok(result.snapshot, 'every acceptAt returns a snapshot');
      observe(result.events, result.snapshot);
      return result;
    },
    settle(tNs) {
      const result = controller.settleTo(tNs);
      observe(result.events, controller.getSnapshot());
      return result;
    },
    snapshot: () => controller.getSnapshot(),
  };
}
