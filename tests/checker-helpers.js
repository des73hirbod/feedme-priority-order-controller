import { readFileSync } from 'node:fs';

// A literal, pre-product fixture authored from the frozen Stage04 oracle.
export const validText = readFileSync(new URL('./fixtures/valid-r05.jsonl', import.meta.url), 'utf8');
export const fixtureRecords = () => validText.trim().split('\n').map(line => JSON.parse(line));
export const serialize = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
export function mutateFixture(change) {
  const records = fixtureRecords();
  change(records);
  return serialize(records);
}
export function renumber(records) {
  records.forEach((record, index) => { record.event_seq = index + 1; });
}
export const completion1002 = records => records.find(record => record.kind === 'order-completed' && record.order_id === 1002);
export const summaryRecord = records => records.find(record => record.kind === 'run-summary');

// Each required mutation changes only the indicated property or inserted/deleted
// record. Sequence numbering is repaired only when a record is inserted/deleted.
export const negativeCases = [
  { id: 'LOG-N01', diagnostic: /utc/, change: records => { delete summaryRecord(records).utc; } },
  { id: 'LOG-N02', diagnostic: /elapsed_ns/, change: records => { delete records.find(r => r.kind === 'order-started').elapsed_ns; } },
  { id: 'LOG-N03', diagnostic: /anchor_utc/, change: records => { delete records[0].anchor_utc; } },
  { id: 'LOG-N04', diagnostic: /order_id/, change: records => { delete completion1002(records).order_id; } },
  { id: 'LOG-N05', diagnostic: /completion.*(deadline|early)|elapsed_ns.*(expected|completion)/i, change: records => { completion1002(records).elapsed_ns = '9000000000'; } },
  { id: 'LOG-N06', diagnostic: /utc/, change: records => { records[1].utc = '[24:60:60]'; } },
  { id: 'LOG-N07', diagnostic: /duplicate completion|extra.*order-completed|semantic.*order-completed/i, change: records => {
    const index = records.indexOf(completion1002(records));
    records.splice(index + 1, 0, { ...records[index] });
    renumber(records);
  } },
  { id: 'LOG-N08', diagnostic: /elapsed_ns.*canonical|elapsed_ns.*string/i, change: records => { records[1].elapsed_ns = 0.5; } },
  { id: 'LOG-N09', diagnostic: /mode.*SIMULATED/, change: records => { records[1].mode = 'LIVE'; } },
  { id: 'LOG-N10', diagnostic: /canceled.*attempt|invalid.*attempt|live.*attempt/i, change: records => {
    const index = records.indexOf(completion1002(records));
    records.splice(index, 0, { ...records[index], order_id: 1004, worker_id: 2, attempt_id: 'fixture-attempt-b' });
    renumber(records);
  } },
  { id: 'LOG-N11', diagnostic: /run-summary/, change: records => { records.pop(); } },
  { id: 'LOG-N12', diagnostic: /line 1.*JSON/, text: 'FeedMe demo output\n' + validText },
];
