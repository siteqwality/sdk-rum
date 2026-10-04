import type { StartReplay } from './load-record';
import { VERSION } from '../version';
import { read } from '../core/util';

export const DEFAULT_RECORDER_BASE = 'https://cdn.siteqwality.com/rum/v2/';

// Read while the CDN script evaluates; null for a module script.
const CORE_SRC = read(() => (document.currentScript as HTMLScriptElement | null)?.src);

/** The recorder beside the core script, or `recorderUrl` when set. */
export function recorderUrlFor(recorderUrl?: string, coreSrc: string | undefined = CORE_SRC): string {
  const file = `recorder-${VERSION}.min.js`;
  return read(() => new URL(recorderUrl || file, recorderUrl ? document.baseURI : coreSrc || DEFAULT_RECORDER_BASE).href) ?? DEFAULT_RECORDER_BASE + file;
}

/** CDN build: imports the recorder file natively, so the core stays one classic script. */
export async function loadReplay(recorderUrl?: string): Promise<StartReplay> {
  return (await import(/* webpackIgnore: true */ /* @vite-ignore */ recorderUrlFor(recorderUrl))).startReplay as StartReplay;
}
