// CDN build: the fflate fallback lives beside this recorder file, as gzip-<version>.min.js.
import { VERSION } from '../version';
import type { GzipText } from './gzip-load';

let loading: Promise<GzipText> | undefined;

export const loadGzip = (): Promise<GzipText> =>
  (loading ||= import(/* webpackIgnore: true */ /* @vite-ignore */ new URL(`gzip-${VERSION}.min.js`, import.meta.url).href).then((m) => m.gzipText as GzipText));
