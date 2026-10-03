// Console noise: bursts, repeats, awkward objects. fixture.results.console counts every call made,
// so the harness can check a console wrapper neither swallows nor duplicates output.
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const count = (n = 1) => (window.fixture.results.console += n);

function awkwardObjects() {
  const circular = { name: 'fx circular' };
  circular.self = circular;
  let deep = { level: 0 };
  for (let i = 1; i < 12; i++) deep = { level: i, child: deep };
  return [
    circular,
    deep,
    'x'.repeat(50_000),
    new Map([['k', { v: 1 }]]),
    new Set([1, 2, 3]),
    document.body,
    Symbol('fx'),
    10n ** 20n,
    function fxNamed() {},
    Object.create(null),
    [1, [2, [3, [4, [5]]]]],
  ];
}

export const NOISE = {
  burst: () => {
    for (let i = 0; i < 200; i++) console[LEVELS[i % LEVELS.length]]('fx:console burst line', i);
    count(200);
  },
  repeat: () => {
    for (let i = 0; i < 100; i++) console.warn('fx:console repeated line');
    count(100);
  },
  objects: () => {
    const values = awkwardObjects();
    for (const value of values) console.log('fx:console object', value);
    count(values.length);
  },
  error_object: () => {
    console.error(new Error('fx:console error object'));
    count();
  },
  extras: () => {
    console.table([{ a: 1, b: 2 }]);
    console.group('fx:console group');
    console.info('fx:console inside group');
    console.groupEnd();
    console.assert(false, 'fx:console assert failed');
    console.trace('fx:console trace');
    console.count('fx:console count');
    console.dir({ fx: 'dir' });
    count(8);
  },
};

export function runAll() {
  for (const fn of Object.values(NOISE)) fn();
  return window.fixture.results.console;
}

export function render(view) {
  view.innerHTML = `<h1>Console</h1>
    <div class="buttons">${Object.keys(NOISE).map((id) => `<button data-testid="con-${id}">${id}</button>`).join('')}
      <button data-testid="con-all">All</button></div>`;
  for (const [id, fn] of Object.entries(NOISE)) view.querySelector(`[data-testid=con-${id}]`).onclick = fn;
  view.querySelector('[data-testid=con-all]').onclick = runAll;
}
