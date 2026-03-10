import { onLCP, onFCP, onCLS, onINP, onTTFB } from 'web-vitals';

export function startVitalsCollector(
  onVital: (name: string, value: number) => void,
): void {
  onLCP(({ value }) => onVital('lcp_ms', value));
  onFCP(({ value }) => onVital('fcp_ms', value));
  onCLS(({ value }) => onVital('cls', value));
  onINP(({ value }) => onVital('inp_ms', value));
  onTTFB(({ value }) => onVital('ttfb_ms', value));
}
