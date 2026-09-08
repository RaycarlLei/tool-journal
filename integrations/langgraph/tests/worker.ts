import { openRuntime, threadConfig, type Action } from '../graph.js';
import { ReceiptUnavailable } from '#synthetic-http';

const [directory, port, recovery, fault] = process.argv.slice(2) as [string, string, Action['recovery'], string];
const action: Action = { scope: 'process-test', key: 'append-seven', units: 7, recovery };
async function pause(): Promise<never> {
  await new Promise<void>((resolve, reject) => process.send!({ kind: 'paused' }, undefined, undefined,
    (error: Error | null) => error ? reject(error) : resolve()));
  return new Promise<never>(() => { setInterval(() => {}, 60_000); });
}

const runtime = openRuntime(directory, Number(port), {
  clock: () => 100, leaseMs: 10,
  ...(fault === 'after-journal-complete' ? { afterJournalComplete: pause } : {}),
});
try {
  try {
    await runtime.graph.invoke({ action }, threadConfig('interrupted-thread'));
    throw new Error('Expected the injected fault');
  } catch (error) {
    if (fault !== 'lost-response' || !(error instanceof ReceiptUnavailable)) throw error;
    await pause();
  }
} finally {
  runtime.close();
  if (process.connected) process.disconnect!();
}
