/** Live adapter. Only controller methods mutate business state. */
export function createRuntime({controller, emit, clock = () => process.hrtime.bigint(),
  setTimer = setTimeout, clearTimer = clearTimeout}) {
  const origin = clock();
  let timer = null;
  let generation = 0;
  let closed = false;
  const elapsed = () => clock() - origin;
  const publish = result => { for (const event of result.events) emit(event); };

  function schedule() {
    generation++;
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (closed) return;
    const next = controller.nextDue();
    if (next === null) return;
    const remaining = next.dueNs - elapsed();
    // Round up: a sub-millisecond remainder must not force an early completion.
    // Node's maximum delay is bounded; the controller always rechecks on wake.
    const delay = remaining <= 0n ? 1 : Number((remaining + 999_999n) / 1_000_000n);
    const ticket = generation;
    timer = setTimer(() => {
      if (closed || ticket !== generation) return;
      timer = null;
      publish(controller.settleTo(elapsed()));
      schedule();
    }, Math.min(delay, 2_147_483_647));
  }

  function accept(request) {
    if (closed) return {events:[], snapshot:controller.getSnapshot()};
    const result = controller.acceptAt(elapsed(), request);
    publish(result);
    closed = result.snapshot.closed;
    schedule();
    return result;
  }
  schedule();
  return {accept, isClosed:() => closed};
}
