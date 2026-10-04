// The fixture SPA: a History API router over scenario pages. window.fixture is the harness API.
import { CANARIES, canary } from './canaries.js';
import * as errors from './scenarios/errors.js';
import * as network from './scenarios/network.js';
import * as consoleNoise from './scenarios/console.js';
import * as mutations from './scenarios/mutations.js';
import * as canvas from './scenarios/canvas.js';

const fixture = (window.fixture = window.fixture || {});
const view = document.getElementById('view');
fixture.results = { network: {}, errors: [], console: 0, mutations: null, counter: 0 };
fixture.canaries = CANARIES;
fixture.ready = false;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function home() {
  view.innerHTML = `
    <h1>Fixture home</h1>
    <p class="muted">Every page exercises one part of the RUM SDK. The harness drives them; you can click around too.</p>
    <div class="buttons">
      <button data-testid="home-counter">Clicked <span data-testid="counter-value">0</span> times</button>
      <button data-testid="home-cta" data-sq-action-name="Fixture CTA">Named action</button>
      <button data-testid="home-dead">Does nothing</button>
      <button data-testid="home-rage">Rage target</button>
      <button data-testid="home-custom">addAction</button>
      <button data-testid="home-slow">Slow handler (INP)</button>
    </div>
    <p><a href="/products/42" data-link data-testid="link-product">A product</a> &middot;
       <a href="/mpa/second.html" data-testid="link-mpa">Full page load</a></p>`;
  const counter = view.querySelector('[data-testid=counter-value]');
  view.querySelector('[data-testid=home-counter]').onclick = () => {
    counter.textContent = String(++fixture.results.counter);
  };
  view.querySelector('[data-testid=home-cta]').onclick = () => {};
  view.querySelector('[data-testid=home-custom]').onclick = () => fixture.call('addAction', 'fixture-custom', { source: 'home' });
  // Blocks the main thread so the interaction is slow enough to count for INP.
  view.querySelector('[data-testid=home-slow]').onclick = () => {
    const until = performance.now() + 150;
    while (performance.now() < until);
  };
}

const PRODUCT_IDS = ['42', '7', '2f6a1c3e-8b0d-4c55-9e1a-6d2f4b8c1a90', 'sess_9f8e7d6c5b4a3f2e1d0c', 'a1b2c3d4e5f60718'];

function products() {
  view.innerHTML = `
    <h1>Products</h1>
    <div class="buttons"><button data-testid="sort-price">Sort by price (replaceState)</button></div>
    <ul>${PRODUCT_IDS.map((id) => `<li><a href="/products/${id}" data-link data-testid="product-${esc(id)}">Product ${esc(id)}</a></li>`).join('')}</ul>`;
  view.querySelector('[data-testid=sort-price]').onclick = () => history.replaceState(null, '', '/products?sort=price');
}

function product(id) {
  view.innerHTML = `<h1>Product ${esc(id)}</h1><p>Route collapse fodder: numeric, UUID, prefixed and hex ids.</p>
    <p><a href="/products" data-link>Back to products</a></p>`;
}

function forms() {
  document.cookie = `fx_session=${canary('cookie_value')}; path=/; SameSite=Lax`;
  try {
    localStorage.setItem('fx_token', canary('storage_value'));
  } catch {}
  view.innerHTML = `
    <h1>Sign up</h1>
    <p>Questions? Write to <span data-testid="text-email">${canary('page_text_email')}</span>.
       Card on file <span data-testid="text-card">${canary('page_text_card')}</span>,
       order reference <span data-testid="text-digits">${canary('page_text_digits')}</span>.</p>
    <p><a data-testid="reset-link" href="/reset?token=${canary('dom_href_token')}">Reset password</a>
       <img alt="" width="16" height="16" src="/assets/pixel.svg?sig=${canary('dom_src_sig')}"></p>
    <div class="rr-block sq-block" data-sq-block data-testid="blocked">Internal note: ${canary('blocked_text')}</div>
    <p>Signed in as <button type="button" data-testid="account-chip">${canary('action_text_email')}</button></p>
    <form data-testid="signup-form" autocomplete="off">
      <label>Name <input name="name" data-testid="in-text"></label>
      <label>Email <input type="email" name="email" data-testid="in-email"></label>
      <label>Password <input type="password" name="password" data-testid="in-password" autocomplete="new-password"></label>
      <label>Card number <input name="cc" data-testid="in-card" autocomplete="cc-number" inputmode="numeric"></label>
      <label>Notes <textarea name="notes" data-testid="in-textarea"></textarea></label>
      <label>Promo code <input name="promo" data-testid="in-prefilled" value="${canary('prefilled_input')}"></label>
      <input type="hidden" name="csrf" value="${canary('hidden_input')}">
      <button type="submit" data-testid="signup-submit">Create account</button>
    </form>
    <div class="buttons">
      <button data-testid="forms-profile">Load profile</button>
      <button data-testid="forms-search">Search</button>
      <button data-testid="forms-error-url">Reset error</button>
      <button data-testid="forms-error-email">Lookup error</button>
      <button data-testid="forms-console-email">Lookup log</button>
    </div>
    <p data-testid="form-result" class="muted"></p>`;
  const result = view.querySelector('[data-testid=form-result]');
  view.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${canary('auth_header')}` },
      body: JSON.stringify({ email: form.get('email'), password: canary('body_password') }),
    });
    result.textContent = `Signed up (${res.status})`;
  };
  view.querySelector('[data-testid=forms-profile]').onclick = () => network.loadProfile();
  view.querySelector('[data-testid=forms-search]').onclick = () => network.search();
  view.querySelector('[data-testid=forms-error-url]').onclick = () =>
    setTimeout(() => {
      throw new Error(`fx:url-token reset failed for ${location.origin}/reset?token=${canary('error_url_token')}`);
    });
  view.querySelector('[data-testid=forms-error-email]').onclick = () =>
    setTimeout(() => {
      throw new Error(`fx:email no account for ${canary('error_email')}`);
    });
  view.querySelector('[data-testid=forms-console-email]').onclick = () =>
    console.error('fx:console-email lookup failed for', canary('console_email'));
}

function iframes() {
  view.innerHTML = `
    <h1>Iframes</h1>
    <p>Same origin</p><iframe data-testid="frame-same" src="/frames/same.html" title="same origin"></iframe>
    <p>Cross origin</p><iframe data-testid="frame-cross" src="${fixture.origins.third}/frames/cross.html" title="cross origin"></iframe>
    <p>srcdoc</p><iframe data-testid="frame-srcdoc" title="srcdoc" srcdoc="<p>srcdoc frame</p><input>"></iframe>`;
}

let heavyLink = null;
function heavyCss() {
  heavyLink = document.createElement('link');
  heavyLink.rel = 'stylesheet';
  heavyLink.href = '/assets/heavy.css';
  heavyLink.dataset.testid = 'heavy-css';
  document.head.appendChild(heavyLink);
  view.innerHTML = `<h1>Heavy CSS</h1><p>This page links 1 MB of CSS. Every full snapshot carries it unless CSS is sent once.</p>
    <div class="cells">${Array.from({ length: 300 }, (_, i) => `<span class="c-${i}">${i}</span>`).join('')}</div>`;
  return () => {
    heavyLink?.remove();
    heavyLink = null;
  };
}

function hash() {
  const show = () => {
    const out = view.querySelector('[data-testid=hash-current]');
    if (out) out.textContent = location.hash || '(none)';
  };
  view.innerHTML = `<h1>Hash routes</h1>
    <p><a href="#/inbox" data-testid="hash-inbox">#/inbox</a> &middot; <a href="#/inbox/123" data-testid="hash-item">#/inbox/123</a>
    &middot; <a href="#/settings?tab=privacy" data-testid="hash-settings">#/settings</a></p>
    <p>Current: <span data-testid="hash-current"></span></p>`;
  window.addEventListener('hashchange', show);
  show();
  return () => window.removeEventListener('hashchange', show);
}

const ROUTES = [
  [/^\/$/, 'home', home],
  [/^\/products$/, 'products', products],
  [/^\/products\/([^/]+)$/, 'product', product],
  [/^\/forms$/, 'forms', forms],
  [/^\/network$/, 'network', () => network.render(view)],
  [/^\/errors$/, 'errors', () => errors.render(view)],
  [/^\/console$/, 'console', () => consoleNoise.render(view)],
  [/^\/mutations$/, 'mutations', () => mutations.render(view)],
  [/^\/canvas$/, 'canvas', () => canvas.render(view)],
  [/^\/iframes$/, 'iframes', iframes],
  [/^\/heavy-css$/, 'heavy-css', heavyCss],
  [/^\/hash$/, 'hash', hash],
];

let cleanup = null;
function render() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  const path = location.pathname;
  for (const [re, name, fn] of ROUTES) {
    const m = re.exec(path);
    if (!m) continue;
    view.dataset.fixturePage = name;
    document.title = `RUM fixture: ${name}`;
    cleanup = fn(...m.slice(1)) || null;
    return;
  }
  view.dataset.fixturePage = 'not-found';
  view.innerHTML = `<h1>Not found</h1><p>${esc(path)}</p>`;
}

fixture.navigate = (url) => {
  history.pushState(null, '', url);
  render();
};

document.addEventListener('click', (event) => {
  const a = event.target.closest?.('a[data-link]');
  if (!a || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  fixture.navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

// Simulated page visibility: headless browsers keep pages visible, and the SDK flushes on hide.
fixture.setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
};

fixture.errors = errors;
fixture.network = network;
fixture.console = consoleNoise;
fixture.mutations = mutations;
render();
fixture.ready = true;
