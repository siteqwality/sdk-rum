import type { record as rrwebRecord } from '@rrweb/record';

export type RecordFn = typeof rrwebRecord;

// npm builds: the customer's bundler splits rrweb into a lazy chunk.
// The CDN build swaps in load-record.cdn.ts.
export async function loadRecord(_recorderUrl?: string): Promise<RecordFn> {
  const { record } = await import('@rrweb/record');
  return record;
}
