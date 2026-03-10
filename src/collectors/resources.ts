export interface CollectedResource {
  resource_type: string;
  resource_url: string;
  duration_ms: number;
  transfer_size: number;
}

export function startResourceCollector(
  onResource: (resource: CollectedResource) => void,
): void {
  if (typeof PerformanceObserver === 'undefined') return;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const re = entry as PerformanceResourceTiming;
      onResource({
        resource_type: re.initiatorType,
        resource_url: re.name,
        duration_ms: re.duration,
        transfer_size: re.transferSize,
      });
    }
  });

  try {
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    // PerformanceObserver resource type not supported
  }
}
