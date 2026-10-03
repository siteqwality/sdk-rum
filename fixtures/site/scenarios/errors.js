// One button per error kind. Messages carry an fx:<id> marker the harness matches on.
const third = () => window.fixture.origins.third;
let n = 0;

function inject(tag, attrs, text) {
  const el = document.createElement(tag);
  Object.assign(el, attrs);
  if (text) el.textContent = text;
  document.body.appendChild(el);
  return el;
}

// An inline script named by sourceURL: its frames and ErrorEvent.filename carry that URL.
function extensionError(id, url) {
  inject('script', {}, `setTimeout(function fxExtension() { throw new Error("fx:${id} injected by an extension"); });\n//# sourceURL=${url}`);
}

function resizeObserverLoop() {
  const box = inject('div', {});
  box.style.cssText = 'width: 10px; height: 10px';
  let rounds = 0;
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) e.target.style.width = `${e.contentRect.width + 10}px`;
    if (++rounds > 3) {
      ro.disconnect();
      box.remove();
    }
  });
  ro.observe(box);
}

async function asyncFn() {
  await null;
  throw new Error('fx:async-fn thrown after an await');
}

function recurse(depth) {
  return recurse(depth + 1) + 1;
}

export const KINDS = {
  sync: ['Error thrown in a click handler', () => {
    throw new Error('fx:sync thrown in a click handler');
  }],
  type_error: ['TypeError from a null dereference', () => {
    const missing = null;
    return missing.fxTypeError;
  }],
  async_timeout: ['Error thrown in a timer', () => setTimeout(() => {
    throw new Error('fx:async-timeout thrown in a timer');
  })],
  promise_error: ['Unhandled rejection with an Error', () => {
    Promise.reject(new Error('fx:promise-error unhandled rejection'));
  }],
  promise_string: ['Unhandled rejection with a string', () => {
    Promise.reject('fx:promise-string unhandled rejection');
  }],
  promise_object: ['Unhandled rejection with a plain object', () => {
    Promise.reject({ code: 'fx:promise-object', detail: 42 });
  }],
  async_fn: ['Async function that throws', () => {
    asyncFn();
  }],
  throw_string: ['throw of a non-Error value', () => {
    throw 'fx:throw-string non-Error value';
  }],
  range_error: ['Stack overflow (RangeError)', () => recurse(0)],
  cause: ['Error with a cause chain', () => {
    throw new Error('fx:cause outer', { cause: new Error('fx:cause-inner root cause') });
  }],
  external: ['Error from a separate script file', () => window.fxLib.explode()],
  handled: ['addError with an Error', () => window.fixture.call('addError', new Error('fx:handled via addError'), { source: 'errors-page' })],
  handled_nonerror: ['addError with a string', () => {
    window.fixture.results.addErrorString = window.fixture.call('addError', 'fx:handled-nonerror plain string');
  }],
  console_error: ['console.error with an Error', () => console.error(new Error('fx:console-error logged, not thrown'))],
  burst: ['30 identical errors', () => {
    for (let i = 0; i < 30; i++) {
      setTimeout(() => {
        throw new Error('fx:burst identical error');
      });
    }
  }],
  resource_img: ['Image that fails to load', () => inject('img', { src: `/missing/fx-image-${++n}.png`, alt: '' })],
  resource_script: ['Script that fails to load', () => inject('script', { src: `/missing/fx-script-${++n}.js` })],
  resource_css: ['Stylesheet that fails to load', () => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/missing/fx-style-${++n}.css`;
    document.head.appendChild(link);
  }],
  script_error: ['Cross-origin script error ("Script error.")', () => inject('script', { src: `${third()}/third-party/throws.js?n=${++n}` })],
  ext_chrome: ['chrome-extension:// frames', () => extensionError('ext-chrome', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js')],
  ext_moz: ['moz-extension:// frames', () => extensionError('ext-moz', 'moz-extension://4f9a2c1e-7b3d-4e8a-9c0f-1d2e3f4a5b6c/inject.js')],
  ext_safari: ['safari-web-extension:// frames', () => extensionError('ext-safari', 'safari-web-extension://9C1F3A2B-5D4E-4F6A-8B7C-0D1E2F3A4B5C/script.js')],
  resize_observer: ['ResizeObserver loop (browser noise)', resizeObserverLoop],
};

export function render(view) {
  view.innerHTML = `<h1>Errors</h1><p class="muted">Each button raises one kind of error.</p>
    <div class="buttons">${Object.entries(KINDS)
      .map(([id, [label]]) => `<button data-testid="err-${id}">${label}</button>`)
      .join('')}</div>`;
  for (const [id, [, fire]] of Object.entries(KINDS)) {
    view.querySelector(`[data-testid=err-${id}]`).onclick = () => {
      window.fixture.results.errors.push(id);
      fire();
    };
  }
}

// Clicks the button, so the error is raised from an event handler as a user would.
export function fire(id) {
  document.querySelector(`[data-testid=err-${id}]`).click();
}
