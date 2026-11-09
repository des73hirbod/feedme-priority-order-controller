const ATTEMPT_NS = 10_000_000_000n;
const COMMANDS = ['order normal', 'order vip', 'bot add', 'bot remove', 'status', 'help', 'quit'];

// The controller alone owns mutable business state. All exported observations
// are detached values; no time source or asynchronous callback enters this file.
export function createController() {
  const orders = new Map();
  const workers = new Map();
  const completed = [];
  const interrupted = [];
  let nowNs = 0n;
  let nextOrderId = 1001;
  let nextWorkerId = 1;
  let nextAttemptId = 1;
  let ingressSequence = 0;
  let closed = false;
  let terminalSnapshot = null;

  function checkTime(tNs) {
    if (typeof tNs !== 'bigint') throw new TypeError('Logical time must be a bigint');
    if (tNs < 0n) throw new RangeError('Logical time must be nonnegative');
    if (tNs < nowNs) throw new RangeError('Logical time cannot move backwards');
  }
  function pendingOrders() {
    return [...orders.values()].filter((order) => order.state === 'PENDING')
      .sort((a, b) => a.customerClass === b.customerClass ? a.ordinal - b.ordinal : a.customerClass === 'VIP' ? -1 : 1);
  }
  function getSnapshot() {
    if (terminalSnapshot !== null) return structuredClone(terminalSnapshot);
    const active = [...workers.keys()].sort((a, b) => a - b);
    const processing = {};
    const attempts = {};
    const idle = [];
    for (const id of active) {
      const attempt = workers.get(id).attempt;
      if (attempt === null) idle.push(id);
      else {
        processing[id] = attempt.orderId;
        attempts[id] = { attempt_id: attempt.id, order_id: attempt.orderId, start_ns: attempt.startNs.toString(), due_ns: attempt.dueNs.toString() };
      }
    }
    const pending = pendingOrders().map((order) => order.id);
    return {
      timeNs: nowNs.toString(), pending, processing,
      completed: [...completed], interrupted_history: [...interrupted],
      idle_workers: idle, active_workers: active, submitted: orders.size, closed,
      attempts,
      counts: { submitted: orders.size, pending: pending.length, processing: Object.keys(processing).length, complete: completed.length, active_bots: active.length },
    };
  }
  function dispatch(events, ingressSeq) {
    for (const worker of [...workers.values()].sort((a, b) => a.id - b.id)) {
      if (worker.attempt !== null) continue;
      const order = pendingOrders()[0];
      if (!order) break;
      const attempt = { id: `a${nextAttemptId++}`, orderId: order.id, startNs: nowNs, dueNs: nowNs + ATTEMPT_NS };
      order.state = 'PROCESSING';
      worker.attempt = attempt;
      const event = { kind: 'order-started', logicalTimeNs: nowNs, order_id: order.id, worker_id: worker.id, attempt_id: attempt.id, state: 'PROCESSING', start_ns: nowNs.toString(), due_ns: attempt.dueNs.toString() };
      if (ingressSeq !== undefined) event.ingress_seq = ingressSeq;
      events.push(event);
    }
  }
  function nextDue() {
    if (closed) return null;
    let earliest = null;
    for (const worker of workers.values()) {
      if (worker.attempt === null) continue;
      const dueNs = worker.attempt.dueNs;
      if (earliest === null || dueNs < earliest.dueNs || (dueNs === earliest.dueNs && worker.id < earliest.workerId)) earliest = { dueNs, workerId: worker.id };
    }
    return earliest;
  }
  function settleTo(tNs) {
    if (closed) return { events: [] };
    checkTime(tNs);
    const events = [];
    for (let due = nextDue(); due !== null && due.dueNs <= tNs; due = nextDue()) {
      const worker = workers.get(due.workerId);
      const attempt = worker.attempt;
      const order = orders.get(attempt.orderId);
      nowNs = due.dueNs;
      order.state = 'COMPLETE';
      completed.push(order.id);
      worker.attempt = null;
      events.push({ kind: 'order-completed', logicalTimeNs: nowNs, order_id: order.id, worker_id: worker.id, attempt_id: attempt.id, state: 'COMPLETE' });
      // Dispatch after this individual completion, before the next tied worker.
      dispatch(events);
      if (worker.attempt === null) events.push({ kind: 'worker-idle', logicalTimeNs: nowNs, worker_id: worker.id, state: 'IDLE' });
    }
    nowNs = tNs;
    return { events };
  }
  function isRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!Object.hasOwn(value, 'op') || typeof value.op !== 'string') return false;
    const expected = value.op === 'order' ? ['op', 'customerClass'] : value.op === 'invalid' ? ['op', 'reasonCode'] : ['op'];
    if (Object.keys(value).some((key) => !expected.includes(key))) return false;
    if (value.op === 'order') return Object.hasOwn(value, 'customerClass') && (value.customerClass === 'NORMAL' || value.customerClass === 'VIP');
    if (value.op === 'invalid') return Object.hasOwn(value, 'reasonCode') && typeof value.reasonCode === 'string' && value.reasonCode.trim().length > 0;
    return ['bot-add', 'bot-remove', 'status', 'help', 'quit', 'eof'].includes(value.op);
  }
  function acceptAt(tNs, input) {
    if (closed) return { events: [], snapshot: getSnapshot() };
    const { events } = settleTo(tNs);
    const ingressSeq = ++ingressSequence;
    const emit = (kind, properties = {}) => events.push({ kind, logicalTimeNs: nowNs, ...properties, ingress_seq: ingressSeq });
    if (!isRequest(input) || input.op === 'invalid') {
      emit('command-rejected', { reason_code: isRequest(input) ? input.reasonCode : 'INVALID_REQUEST' });
    } else if (input.op === 'order') {
      const id = nextOrderId++;
      orders.set(id, { id, customerClass: input.customerClass, ordinal: orders.size + 1, state: 'PENDING' });
      emit('order-created', { order_id: id, customer_class: input.customerClass, state: 'PENDING' });
    } else if (input.op === 'bot-add') {
      const id = nextWorkerId++;
      workers.set(id, { id, attempt: null });
      emit('worker-added', { worker_id: id, state: 'IDLE' });
    } else if (input.op === 'bot-remove') {
      if (workers.size === 0) {
        emit('command-noop', { reason_code: 'NO_ACTIVE_WORKERS' });
      } else {
        // Insertion order follows strictly increasing IDs; deletion never reuses one.
        const id = [...workers.keys()].at(-1);
        const worker = workers.get(id);
        if (worker.attempt !== null) {
          const attempt = worker.attempt;
          orders.get(attempt.orderId).state = 'PENDING';
          interrupted.push(attempt.orderId);
          worker.attempt = null;
          emit('order-interrupted', { order_id: attempt.orderId, worker_id: id, attempt_id: attempt.id, state: 'PENDING' });
        }
        workers.delete(id);
        emit('worker-removed', { worker_id: id, state: 'REMOVED' });
      }
    } else if (input.op === 'help') {
      emit('help', { commands: [...COMMANDS] });
    } else if (input.op === 'status') {
      emit('status', { snapshot: getSnapshot() });
    } else if (input.op === 'quit' || input.op === 'eof') {
      closed = true;
      // Preserve only detached terminal metadata, then discard live business state.
      terminalSnapshot = getSnapshot();
      orders.clear();
      workers.clear();
      completed.length = 0;
      interrupted.length = 0;
      emit('session-closed', { reason: input.op, snapshot: getSnapshot() });
    }
    if (!closed) dispatch(events, ingressSeq);
    return { events, snapshot: getSnapshot() };
  }
  return { acceptAt, settleTo, getSnapshot, nextDue };
}
