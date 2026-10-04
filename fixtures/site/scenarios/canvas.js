// Animated 2D and WebGL canvases. Without canvas opt-in nothing of them may be recorded.
let frame = null;

export function render(view) {
  view.innerHTML = `<h1>Canvas</h1>
    <canvas data-testid="canvas-2d" width="480" height="240"></canvas>
    <canvas data-testid="canvas-webgl" width="240" height="240"></canvas>
    <canvas data-testid="canvas-blocked" class="rr-block" data-sq-block width="120" height="120"></canvas>`;
  const ctx = view.querySelector('[data-testid=canvas-2d]').getContext('2d');
  const gl = view.querySelector('[data-testid=canvas-webgl]').getContext('webgl');
  const blocked = view.querySelector('[data-testid=canvas-blocked]').getContext('2d');
  const draw = (t) => {
    ctx.fillStyle = `hsl(${(t / 20) % 360} 60% 50%)`;
    ctx.fillRect(0, 0, 480, 240);
    ctx.fillStyle = '#fff';
    ctx.font = '20px system-ui';
    ctx.fillText(`frame at ${Math.round(t)} ms`, 20, 40);
    ctx.beginPath();
    ctx.arc(240 + Math.sin(t / 300) * 150, 140, 30, 0, Math.PI * 2);
    ctx.fill();
    if (gl) {
      gl.clearColor((Math.sin(t / 500) + 1) / 2, 0.3, 0.6, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    blocked.fillStyle = t % 1000 < 500 ? '#c33' : '#3c3';
    blocked.fillRect(0, 0, 120, 120);
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(frame);
}
