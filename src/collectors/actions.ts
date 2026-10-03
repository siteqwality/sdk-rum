export interface CollectedAction {
  action_type: string;
  action_target: string;
  frustration?: string;
}

export const ACTION_NAME_ATTRIBUTE = 'data-sq-action-name';
const MAX_ACTION_NAME_LENGTH = 100;

/** `hideText` is read per click so a config refresh applies without a reload. */
export function startActionCollector(
  onAction: (action: CollectedAction) => void,
  hideText: () => boolean = () => false,
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
        action_target: getSelector(target, hideText()),
        frustration,
      });
    },
    { capture: true },
  );
}

/**
 * Names a click: an explicit data-sq-action-name, else `#id`, else
 * `tag.classes[text]`, with the `[text]` suffix left off when `hideText`.
 */
export function getSelector(el: Element, hideText = false): string {
  const explicit = explicitActionName(el);
  if (explicit) return explicit;
  if (el.id) return `#${el.id}`;
  const tag = el.tagName?.toLowerCase() || 'unknown';
  // getAttribute, as an SVG element's className is not a string.
  const className = el.getAttribute?.('class')?.trim();
  const classes = className
    ? `.${className.split(/\s+/).slice(0, 2).join('.')}`
    : '';
  if (hideText) return `${tag}${classes}`;
  const text =
    el.textContent?.trim().slice(0, 30) ||
    el.getAttribute?.('aria-label') ||
    '';
  const suffix = text ? `[${text}]` : '';
  return `${tag}${classes}${suffix}`;
}

// Brackets become parentheses so the ingest never reads them as a text suffix.
function explicitActionName(el: Element): string {
  const holder =
    typeof el.closest === 'function'
      ? el.closest(`[${ACTION_NAME_ATTRIBUTE}]`)
      : null;
  const raw = holder?.getAttribute(ACTION_NAME_ATTRIBUTE) ?? '';
  return raw
    .trim()
    .slice(0, MAX_ACTION_NAME_LENGTH)
    .trim()
    .replace(/\[/g, '(')
    .replace(/\]/g, ')');
}
