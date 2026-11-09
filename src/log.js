const NS_PER_SECOND = 1_000_000_000n;
const SECONDS_PER_DAY = 86_400n;

function anchorSeconds(anchor) {
  const match = /^(\d{2}):(\d{2}):(\d{2}) UTC$/u.exec(anchor);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw new TypeError('Expected a valid HH:MM:SS UTC anchor');
  }
  return BigInt(match[1]) * 3600n + BigInt(match[2]) * 60n + BigInt(match[3]);
}

function displayClock(seconds) {
  const day = seconds % SECONDS_PER_DAY;
  const part = value => String(value).padStart(2, '0');
  return `[${part(day / 3600n)}:${part(day / 60n % 60n)}:${part(day % 60n)}]`;
}

/** Add display metadata without using wall time to infer business transitions. */
export function createFormatter({mode, anchorUtc = '12:00:00 UTC', nowUtc = () => new Date()} = {}) {
  if (mode !== 'LIVE' && mode !== 'SIMULATED') throw new TypeError('Invalid log mode');
  const anchor = anchorSeconds(anchorUtc);
  let sequence = 0;
  return event => {
    const {logicalTimeNs, ...properties} = event;
    if (typeof logicalTimeNs !== 'bigint' || logicalTimeNs < 0n) {
      throw new TypeError('Event time must be nonnegative bigint nanoseconds');
    }
    const utc = mode === 'SIMULATED'
      ? displayClock(anchor + logicalTimeNs / NS_PER_SECOND)
      : `[${nowUtc().toISOString().slice(11, 19)}]`;
    return JSON.stringify({
      ...properties, schema_version:1, event_seq:++sequence,
      mode, utc, elapsed_ns:logicalTimeNs.toString(),
    });
  };
}
