import type { StartReplay } from './load-record';
import { VERSION } from '../version';

export const DEFAULT_RECORDER_BASE = 'https://cdn.siteqwality.com/rum/v2/';

// Read while the CDN script evaluates; null for a module script.
const CORE_SRC = currentScriptSrc();

function currentScriptSrc(): string | undefined {
  try {
    const script = document.currentScript as HTMLScriptElement | null;
    return script?.src || undefined;
  } catch {
    return undefined;
  }
}

/** The recorder beside the core script, or `recorderUrl` when set. */
export function recorderUrlFor(recorderUrl?: string, coreSrc: string | undefined = CORE_SRC): string {
  try {
    if (recorderUrl) return new URL(recorderUrl, document.baseURI).href;
    return new URL(`recorder-${VERSION}.min.js`, coreSrc || DEFAULT_RECORDER_BASE).href;
  } catch {
    return `${DEFAULT_RECORDER_BASE}recorder-${VERSION}.min.js`;
  }
}

/** CDN build: imports the recorder file natively, so the core stays one classic script. */
export async function loadReplay(recorderUrl?: string): Promise<StartReplay> {
  const module = await import(/* webpackIgnore: true */ /* @vite-ignore */ recorderUrlFor(recorderUrl));
  return module.startReplay as StartReplay;
}
