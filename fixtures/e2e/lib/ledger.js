// Per-item verdicts from one session, printed as one table. With gap set, a miss is reported as a
// known gap and a hit fails ("gap closed"), so the expectation gets tightened.
export class Ledger {
  constructor(title) {
    this.title = title;
    this.rows = [];
  }

  check(id, ok, { gap = false, info = false, detail = '', why = '' } = {}) {
    let status;
    if (info) status = 'info';
    else if (gap) status = ok ? 'GAP CLOSED' : 'known gap';
    else status = ok ? 'ok' : 'FAIL';
    this.rows.push({ id, status, detail: String(detail), why });
    return ok;
  }

  get failures() {
    return this.rows
      .filter((r) => r.status === 'FAIL' || r.status === 'GAP CLOSED')
      .map((r) => `${r.id}: ${r.status}${r.detail ? ` (${r.detail})` : ''}${r.status === 'GAP CLOSED' ? ': tighten the expectation' : ''}`);
  }

  table() {
    const w = Math.max(...this.rows.map((r) => r.id.length), 4);
    const lines = this.rows.map((r) => `  ${r.id.padEnd(w)}  ${r.status.padEnd(10)}  ${r.detail}${r.why ? `  [${r.why}]` : ''}`);
    return `${this.title}\n${lines.join('\n')}`;
  }

  print(testInfo) {
    const text = this.table();
    console.log(`\n${text}\n`);
    testInfo?.attach(`${this.title}.txt`, { body: text, contentType: 'text/plain' });
    for (const r of this.rows.filter((x) => x.status === 'known gap')) {
      testInfo?.annotations.push({ type: 'known gap', description: `${r.id}: ${r.why || r.detail}` });
    }
  }
}

export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
