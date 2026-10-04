import { VERSION } from '../version';
import type { startCanvas } from './canvas';
let loading: Promise<typeof startCanvas> | undefined;
export const loadCanvas = (): Promise<typeof startCanvas> =>
  (loading ||= import(/* webpackIgnore: true */ /* @vite-ignore */ new URL(`canvas-${VERSION}.min.js`, import.meta.url).href).then(m => m.startCanvas));
