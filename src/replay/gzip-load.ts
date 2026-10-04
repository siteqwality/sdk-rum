// npm builds: the customer's bundler splits the fflate fallback out. The CDN build swaps in
// gzip-load.cdn.ts.
export type GzipText = (text: string) => Blob;

let loading: Promise<GzipText> | undefined;

export const loadGzip = (): Promise<GzipText> => (loading ||= import('./gzip-fallback').then((m) => m.gzipText));
