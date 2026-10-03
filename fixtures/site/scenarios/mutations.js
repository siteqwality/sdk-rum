// Mutation flood: text, attribute and child-list churn every animation frame, the shape of a
// live dashboard or a game HUD. Results report how much churn ran and how smoothly.
let running = null;

function grid(root, cells) {
  root.textContent = '';
  const nodes = [];
  for (let i = 0; i < cells; i++) {
    const cell = document.createElement('span');
    cell.textContent = '0';
    root.appendChild(cell);
    nodes.push(cell);
  }
  return nodes;
}

// perFrame mutations each frame for seconds; resolves with what ran.
export function flood({ perFrame = 200, seconds = 5 } = {}) {
  stop();
  const root = document.querySelector('[data-testid=mut-grid]');
  const list = document.querySelector('[data-testid=mut-list]');
  const cells = grid(root, 400);
  const started = performance.now();
  let frames = 0;
  let mutations = 0;
  let worstFrameMs = 0;
  let last = started;
  return new Promise((resolve) => {
    const tick = (now) => {
      worstFrameMs = Math.max(worstFrameMs, now - last);
      last = now;
      frames++;
      for (let i = 0; i < perFrame; i++) {
        const cell = cells[(frames * perFrame + i) % cells.length];
        switch (i % 4) {
          case 0:
            cell.textContent = String(frames + i);
            break;
          case 1:
            cell.setAttribute('data-v', String(frames));
            break;
          case 2:
            cell.style.opacity = String((frames % 10) / 10);
            break;
          default: {
            const li = document.createElement('li');
            li.textContent = `row ${frames}.${i}`;
            list.appendChild(li);
            if (list.childElementCount > 50) list.firstElementChild.remove();
          }
        }
        mutations++;
      }
      if (now - started < seconds * 1000 && running) {
        running = requestAnimationFrame(tick);
      } else {
        running = null;
        const result = { frames, mutations, ms: Math.round(now - started), worstFrameMs: Math.round(worstFrameMs) };
        window.fixture.results.mutations = result;
        resolve(result);
      }
    };
    running = requestAnimationFrame(tick);
  });
}

export function stop() {
  if (running) cancelAnimationFrame(running);
  running = null;
}

export function render(view) {
  view.innerHTML = `<h1>Mutation flood</h1>
    <div class="buttons"><button data-testid="mut-start">Flood for 5 s</button><button data-testid="mut-stop">Stop</button></div>
    <p data-testid="mut-result" class="muted"></p>
    <div class="cells" data-testid="mut-grid"></div><ul data-testid="mut-list"></ul>`;
  view.querySelector('[data-testid=mut-start]').onclick = () =>
    flood().then((r) => (view.querySelector('[data-testid=mut-result]').textContent = JSON.stringify(r)));
  view.querySelector('[data-testid=mut-stop]').onclick = stop;
  return stop;
}
