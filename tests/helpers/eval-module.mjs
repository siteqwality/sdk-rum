// Evaluates a file as module source in a fresh context; prints the globals it added.
// Needs `node --experimental-vm-modules`.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(process.argv[2], 'utf8');
const jquery = function jQuery() {};
const sandbox = { document: { currentScript: null }, $: jquery };
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
const before = new Set(Object.getOwnPropertyNames(context));

const module = new vm.SourceTextModule(source, { context });
await module.link(() => {
  throw new Error('the core imports nothing statically');
});
await module.evaluate();

const added = Object.getOwnPropertyNames(context).filter((k) => !before.has(k));
process.stdout.write(
  JSON.stringify({
    added,
    hasInit: typeof context.SiteQwalityRUM?.init === 'function',
    jqueryKept: context.$ === jquery,
  }),
);
