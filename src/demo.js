import {createController} from './controller.js';
import {parseCommand} from './cli.js';

/** Authored R05 inputs only. Expected answers belong to the external verifier. */
export function runDemo(emit) {
  const controller = createController();
  emit({kind:'run-started',logicalTimeNs:0n,anchor_utc:'12:00:00 UTC',session:'R05'});
  const actions = [
    [0n,'order normal'], [0n,'order vip'], [0n,'order normal'], [0n,'order vip'],
    [0n,'bot add'], [0n,'bot add'], [2_000_000_000n,'bot remove'],
  ];
  for (const [time, command] of actions) {
    for (const event of controller.acceptAt(time,parseCommand(command)).events) emit(event);
  }
  for (const event of controller.settleTo(40_000_000_000n).events) emit(event);
  const snapshot = controller.getSnapshot();
  emit({kind:'run-summary',logicalTimeNs:40_000_000_000n,snapshot,counts:snapshot.counts});
}
