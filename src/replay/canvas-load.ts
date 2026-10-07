import type { startCanvas } from './canvas';
let loading: Promise<typeof startCanvas> | undefined;
export const loadCanvas = (): Promise<typeof startCanvas> =>
  (loading ||= import('./canvas').then(m => m.startCanvas));
