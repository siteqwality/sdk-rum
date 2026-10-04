import { test, expect, snippet, sdkLoaded, hide, REPLAY_ALL, REPLAY_ON_ERROR, VERSION, type Intake } from './fixtures';
import { join } from 'node:path';

const config = (privacy = {}, canvas: unknown = { enabled: true }) => ({ ...REPLAY_ALL, privacy, capture: { canvas } });
const dom = `<style>canvas{width:240px;height:120px}.off{position:absolute;top:10000px}</style>
<canvas id="two" class="chosen" width="2560" height="1280"></canvas>
<canvas id="gl" class="chosen" width="240" height="120"></canvas>
<div class="private"><canvas id="blocked" class="chosen" width="10" height="10"></canvas></div>
<canvas id="off" class="chosen off" width="10" height="10"></canvas>
<script>
const two=document.getElementById('two').getContext('2d');
const gl=document.getElementById('gl').getContext('webgl');
window.__webgl=!!gl;
function draw(t){two.fillStyle=t%1000<500?'red':'blue';two.fillRect(0,0,2560,1280);if(gl){gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT)}requestAnimationFrame(draw)}requestAnimationFrame(draw);
</script>`;
const frames = (intake: Intake) => intake.segments().flatMap(s => s.events).filter((e: any) => e.type === 3 && e.data?.source === 9) as any[];
const visible = (page: any) => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
function canvasIds(intake: Intake) {
  const ids: Record<string, number> = {};
  const walk = (n: any) => { if (n?.tagName === 'canvas' && n.attributes.id) ids[n.attributes.id] = n.id; n?.childNodes?.forEach(walk); };
  for (const e of intake.segments().flatMap(s => s.events)) if (e.type === 2) walk(e.data?.node);
  return ids;
}

test('opt-in 2D and WebGL frames are WebP, bounded, and leave host drawing intact', async ({ page, intake }) => {
  intake.config = config({ block_selectors: ['.private'] }, { enabled: true, selectors: ['.chosen'], fps: 4, quality: 0.8 });
  const requested: string[] = []; page.on('request', r => requested.push(r.url()));
  await page.goto(intake.page('canvas', `<!doctype html><body>${dom}${snippet(intake)}</body>`));
  await sdkLoaded(page); await page.waitForTimeout(2_200); await hide(page);
  await expect.poll(() => frames(intake).length).toBeGreaterThan(2);
  expect(requested.filter(u => u.includes(`/canvas-${VERSION}.min.js`))).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__webgl)).toBe(true);
  const ids = canvasIds(intake);
  const all = frames(intake);
  expect(new Set(all.map(e => e.data.id))).toEqual(new Set([ids.two, ids.gl]));
  for (const id of [ids.two, ids.gl]) {
    const fs = all.filter(e => e.data.id === id);
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.length).toBeLessThanOrEqual(5);
    const encoded = fs[0].data.commands[1].args[0].args[0];
    expect(encoded.type).toBe('image/webp');
    const decoded = await page.evaluate(async ({ data, type }) => {
      const bytes = Uint8Array.from(atob(data[0].base64), c => c.charCodeAt(0));
      const b = await createImageBitmap(new Blob([bytes], { type }));
      const c = document.createElement('canvas'); c.width=b.width; c.height=b.height;
      const ctx=c.getContext('2d')!;ctx.drawImage(b,0,0);const pixel=Array.from(ctx.getImageData(0,0,1,1).data);b.close();return { width:c.width,height:c.height,pixel };
    }, encoded);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1280);
    expect(decoded.pixel[3]).toBe(255);
    if(id===ids.gl) expect(decoded.pixel[1]).toBeGreaterThan(200);
  }
  expect(JSON.stringify(intake.segments())).not.toContain('rr_dataURL');
  const n = all.length; await page.waitForTimeout(700); expect(frames(intake)).toHaveLength(n);
  await visible(page); await page.waitForTimeout(900); await hide(page);
  await expect.poll(() => frames(intake).length).toBeGreaterThan(n);
  const refs = intake.segments().flatMap(s => s.events).filter((e: any) => e.type === 5 && e.data?.tag === 'sq-canvas-ref') as any[];
  const latest = canvasIds(intake);
  expect(latest.two).not.toBe(ids.two);
  expect(refs.find(e => e.data.payload.id === latest.two).data.payload.key).toBe(refs.find(e => e.data.payload.id === ids.two).data.payload.key);
});

test('the pinned rrweb player renders the captured 2D and WebGL bitmap commands', async ({ page, intake, context }) => {
  intake.config = config({}, { enabled: true, selectors: ['#two', '#gl'] });
  await page.goto(intake.page('player-contract', `<!doctype html><body>${dom}${snippet(intake)}</body>`));
  await sdkLoaded(page); await page.waitForTimeout(1100); await hide(page);
  await expect.poll(() => frames(intake).length).toBeGreaterThan(0);
  const events = intake.segments().flatMap(s => s.events);
  const player = await context.newPage();
  await player.addScriptTag({ path: join(import.meta.dirname, '../node_modules/rrweb/dist/rrweb.umd.cjs') });
  await player.evaluate(events => {
    const replayer = new (window as any).rrweb.Replayer(events, { root: document.body, UNSAFE_replayCanvas: true, speed: 4 });
    replayer.play();
  }, events);
  await expect.poll(() => player.evaluate(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const pixel = (id: string) => (doc?.getElementById(id) as HTMLCanvasElement | null)?.getContext('2d')?.getImageData(0, 0, 1, 1).data;
    const two = pixel('two'), gl = pixel('gl');
    return !!two && two[3] === 255 && !!gl && gl[1] > 200 && gl[3] === 255;
  })).toBe(true);
  await player.close();
});

for (const [name, privacy, setting] of [
  ['default-off', {}, null], ['strict', { level: 'strict' }, { enabled: true }],
  ['invalid selector', {}, { enabled: true, selectors: ['['] }],
] as const) test(`canvas ${name} emits no pixels`, async ({ page, intake }) => {
  intake.config = config(privacy, setting);
  const requested: string[]=[];page.on('request',r=>requested.push(r.url()));
  await page.goto(intake.page('off', `<!doctype html><body>${dom}${snippet(intake)}</body>`));
  await sdkLoaded(page);await page.waitForTimeout(800);await hide(page);
  await expect.poll(()=>intake.segments().length).toBeGreaterThan(0);
  expect(frames(intake)).toEqual([]);expect(JSON.stringify(intake.segments())).not.toContain('rr_dataURL');
  if(name!=='invalid selector') expect(requested.filter(u=>u.includes('/canvas-'))).toEqual([]);
});

test('consent gates the canvas download and stops future frames', async ({ page, intake }) => {
  intake.config=config();const requested:string[]=[];page.on('request',r=>requested.push(r.url()));
  await page.goto(intake.page('consent-canvas', `<!doctype html><body>${dom}${snippet(intake,'/sdk/sdk.min.js',"trackingConsent:'pending',")}</body>`));
  await sdkLoaded(page);await page.waitForTimeout(700);expect(requested.filter(u=>u.includes('/canvas-'))).toEqual([]);
  await page.evaluate(()=>(window as any).SiteQwalityRUM.setTrackingConsent('granted'));
  await page.waitForTimeout(1100);await hide(page);await expect.poll(()=>frames(intake).length).toBeGreaterThan(0);
  await visible(page);await page.evaluate(()=>(window as any).SiteQwalityRUM.setTrackingConsent('not-granted'));
  const n=frames(intake).length;await page.waitForTimeout(900);await hide(page);expect(frames(intake)).toHaveLength(n);
  expect(await page.evaluate(()=>localStorage.getItem('_sq_cb'))).toBeNull();
});

for (const reason of ['GPC', 'never-record URL'] as const) test(`canvas opt-in cannot bypass ${reason}`, async ({ page, intake }) => {
  intake.config = config(reason === 'never-record URL' ? { never_record_urls: ['/page/no-pixels'] } : {});
  if (reason === 'GPC') await page.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
  const requested: string[] = []; page.on('request', r => requested.push(r.url()));
  await page.goto(intake.page('no-pixels', `<!doctype html><body>${dom}${snippet(intake)}</body>`));
  await sdkLoaded(page); await page.waitForTimeout(800); await hide(page);
  expect(requested.filter(u => u.includes('/canvas-'))).toEqual([]);
  expect(intake.segments()).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('_sq_cb'))).toBeNull();
});

test('tainted canvas is dropped without a page error or loss of DOM replay', async ({ page, intake }) => {
  intake.config=config();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(intake.page('taint', `<!doctype html><body><canvas id="tainted" width="20" height="20"></canvas>
<script>window.__taintedReady=false;const image=new Image();image.onload=()=>{document.querySelector('canvas').getContext('2d').drawImage(image,0,0);window.__taintedReady=true};image.src='${intake.crossOrigin}/slow.png';</script>${snippet(intake)}</body>`));
  await sdkLoaded(page);await page.waitForFunction(()=>(window as any).__taintedReady);
  await page.waitForTimeout(1100);await hide(page);await expect.poll(()=>intake.segments().length).toBeGreaterThan(0);
  expect(frames(intake)).toEqual([]);expect(errors).toEqual([]);
});

test('the session byte cap stops only canvas and survives a reload and another tab', async ({ page, intake, context }) => {
  intake.config=config();
  await page.goto(intake.page('cap', `<!doctype html><body>${dom}${snippet(intake)}</body>`));
  await sdkLoaded(page);await expect.poll(()=>intake.segments().length).toBeGreaterThan(0);
  await page.evaluate(()=>{const sid=(window as any).SiteQwalityRUM.getStatus().session_id;localStorage.setItem('_sq_cb',JSON.stringify([[sid,{bytes:19999999,capped:false,expires:Date.now()+14400000}]]))});
  await page.waitForTimeout(1100);await hide(page);
  await expect.poll(()=>intake.segments().some(s=>s.events.some((e:any)=>e.type===5&&e.data.tag==='sq-canvas-cap'))).toBe(true);
  const n=frames(intake).length;await page.reload();await sdkLoaded(page);await page.waitForTimeout(1100);await hide(page);
  expect(frames(intake)).toHaveLength(n);
  expect(await page.evaluate(()=>(window as any).SiteQwalityRUM.getStatus().recording)).toBe('paused');
  const sibling = await context.newPage();
  await sibling.goto(page.url()); await sdkLoaded(sibling);
  await sibling.waitForTimeout(1100); await hide(sibling);
  expect(frames(intake)).toHaveLength(n);
  expect(await sibling.evaluate(() => JSON.parse(localStorage.getItem('_sq_cb')!)[0][1].capped)).toBe(true);
  await sibling.close();
  await visible(page);
  await page.evaluate(()=>{
    const parts=/(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)![1].split('|');
    document.cookie=`_sq_s=0199a6b2-7c3e-7f00-8a1b-00000000d0d0|${Number(parts[1])-1000}|${Date.now()}|0;path=/`;
  });
  await page.waitForTimeout(1100);
  await page.evaluate(()=>(window as any).SiteQwalityRUM.addAction('new canvas session'));
  await expect.poll(()=>page.evaluate(()=>(window as any).SiteQwalityRUM.getStatus().session_id)).toBe('0199a6b2-7c3e-7f00-8a1b-00000000d0d0');
  await page.waitForTimeout(1100);await hide(page);
  await expect.poll(()=>frames(intake).length).toBeGreaterThan(n);
});

test('canvas frames stay in the error ring until a rule matches', async ({ page, intake }) => {
  intake.config={...config(),rules:REPLAY_ON_ERROR.rules};
  await page.goto(intake.page('canvas-ring', `<!doctype html><body>${dom}${snippet(intake)}</body>`));
  await sdkLoaded(page);await page.waitForTimeout(1100);expect(intake.segments()).toHaveLength(0);
  await page.evaluate(()=>(window as any).SiteQwalityRUM.addError(new Error('match')));
  await expect.poll(()=>frames(intake).length).toBeGreaterThan(0);
  expect(intake.segments()[0].events[0].type).toBe(4);
});
