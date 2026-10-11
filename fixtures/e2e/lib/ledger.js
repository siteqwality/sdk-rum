// Per-item verdicts from one session, printed as one table. Info rows report without a verdict.
export class Ledger {
  constructor(title) {
    this.title = title;
    this.rows = [];
  }

  check(id, ok, { info = false, detail = '', why = '' } = {}) {
    const status = info ? 'info' : ok ? 'ok' : 'FAIL';
    this.rows.push({ id, status, detail: String(detail), why });
    return ok;
  }

  get failures() {
    return this.rows.filter((r) => r.status === 'FAIL').map((r) => `${r.id}: FAIL${r.detail ? ` (${r.detail})` : ''}`);
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
  }
}

export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
