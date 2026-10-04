import type { ReplayStartOptions, ReplayHandle } from './chunk';

export type StartReplay = (o: ReplayStartOptions) => ReplayHandle;

// npm builds: the customer's bundler splits the replay chunk (and rrweb) out of the core.
// The CDN build swaps in load-record.cdn.ts.
export async function loadReplay(_recorderUrl?: string): Promise<StartReplay> {
  const { startReplay } = await import('./chunk');
  return startReplay;
}
