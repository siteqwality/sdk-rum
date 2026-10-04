// gzip where CompressionStream is missing (Safari before 16.4): a lazy chunk of its own.
import { gzipSync } from 'fflate';

export const gzipText = (text: string): Blob => new Blob([gzipSync(new TextEncoder().encode(text), { level: 6 }) as BlobPart]);
