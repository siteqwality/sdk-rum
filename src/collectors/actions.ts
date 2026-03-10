export interface CollectedAction {
  action_type: string;
  action_target: string;
  frustration?: string;
}

export function startActionCollector(
  onAction: (action: CollectedAction) => void,
): void {
  let clickLog: { target: Element; time: number }[] = [];

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element;
      if (!target) return;

      const now = Date.now();
      clickLog.push({ target, time: now });
      // Prune entries older than 1 second
      clickLog = clickLog.filter((c) => now - c.time < 1000);

      // Detect rage clicks: 3+ clicks on same element within 1 second
      const sameTargetClicks = clickLog.filter(
        (c) => c.target === target,
      ).length;
      const frustration = sameTargetClicks >= 3 ? 'rage_click' : undefined;

      onAction({
        action_type: 'click',
        action_target: getSelector(target),
        frustration,
      });
    },
    { capture: true },
  );
}

function getSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName?.toLowerCase() || 'unknown';
  const classes = el.className
    ? `.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  const text =
    el.textContent?.trim().slice(0, 30) ||
    el.getAttribute('aria-label') ||
    '';
  const suffix = text ? `[${text}]` : '';
  return `${tag}${classes}${suffix}`;
}
