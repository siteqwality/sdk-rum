export function startLongTaskCollector(
  onLongTask: (durationMs: number) => void,
): void {
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        onLongTask(entry.duration);
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // longtask observer not supported in this browser
  }
}
