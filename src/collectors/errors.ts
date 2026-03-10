export interface CollectedError {
  message: string;
  source: string;
  stack: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

export function startErrorCollector(
  onError: (error: CollectedError) => void,
): void {
  window.addEventListener('error', (event) => {
    onError({
      message: event.message,
      source: 'source',
      stack: event.error?.stack || '',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    onError({
      message: event.reason?.message || String(event.reason),
      source: 'console',
      stack: event.reason?.stack || '',
    });
  });
}
