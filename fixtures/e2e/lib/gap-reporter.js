// Prints the known gaps of the SDK under test after a run: expected failures and ledger rows.
export default class GapReporter {
  constructor() {
    this.gaps = new Map();
  }

  onTestEnd(test, result) {
    for (const a of [...test.annotations, ...(result.annotations || [])]) {
      if (a.type === 'known gap') this.gaps.set(`${test.title}: ${a.description}`, true);
    }
  }

  onEnd() {
    if (!this.gaps.size) return;
    console.log(`\nKnown gaps of the SDK under test (${this.gaps.size}), expected to close by the version named:`);
    for (const gap of this.gaps.keys()) console.log(`  - ${gap}`);
  }

  printsToStdio() {
    return false;
  }
}
