// Deterministic generated assets: 1 MB of CSS and oversized pages.

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (rand, n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');

// About as compressible as a real framework bundle's CSS, not a run of identical rules.
export function heavyCss(bytes = 1024 * 1024) {
  const rand = prng(0x5eed);
  const props = ['color', 'background-color', 'border-color', 'outline-color', 'fill'];
  const parts = ['/* fixture: generated stylesheet */\n'];
  let size = parts[0].length;
  for (let i = 0; size < bytes; i++) {
    const cls = `.c-${hex(rand, 6)}-${i}`;
    const rule =
      `${cls}, ${cls}:hover > .x-${hex(rand, 4)} { ` +
      `${props[i % props.length]}: #${hex(rand, 6)}; ` +
      `margin: ${Math.floor(rand() * 40)}px ${Math.floor(rand() * 40)}px; ` +
      `padding: ${(rand() * 3).toFixed(2)}rem; ` +
      `transform: translate(${Math.floor(rand() * 100)}px, ${Math.floor(rand() * 100)}px); }\n`;
    parts.push(rule);
    size += rule.length;
  }
  return parts.join('');
}

// A page whose DOM serialises to roughly `mb` megabytes, to exercise the snapshot cap.
export function hugePage(mb, boot) {
  const rand = prng(0xb16);
  const rows = [];
  const target = mb * 1024 * 1024;
  let size = 0;
  for (let i = 0; size < target; i++) {
    const row = `<p class="r${i % 7}">row ${i} ${hex(rand, 48)} ${hex(rand, 48)}</p>`;
    rows.push(row);
    size += row.length;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Huge page</title>${boot}</head>
<body data-fixture-page="huge"><h1>Huge page (${mb} MB)</h1><input data-testid="huge-input">
<div id="rows">${rows.join('')}</div></body></html>`;
}
