import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// No browser dependency: exercise the real render/resize methods and count
// WebGL submissions. Pixel equivalence is a separate browser test.
const source = await readFile(new URL('../app/js/bg.js', import.meta.url), 'utf8');
const { Backdrop } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture(t) {
  for (const [key, value] of Object.entries({
    window: { devicePixelRatio: 3 }, innerWidth: 390, innerHeight: 844,
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  const calls = { draws: 0, clears: 0, uniforms: {} };
  const gl = {
    COLOR_BUFFER_BIT: 0x4000, TRIANGLES: 4,
    clearColor(...rgba) { assert.deepEqual(rgba, [0, 0, 0, 0]); },
    clear(mask) { assert.equal(mask, this.COLOR_BUFFER_BIT); calls.clears++; },
    viewport() {},
    uniform2f() {},
    uniform1f(name, value) { calls.uniforms[name] = Math.fround(value); },
    drawArrays(mode, first, count) {
      assert.deepEqual([mode, first, count], [this.TRIANGLES, 0, 3]);
      calls.draws++;
    },
  };
  // Deliberately bypass shader compilation, not the methods being tested.
  const bg = Object.assign(Object.create(Backdrop.prototype), {
    canvas: { width: 0, height: 0 }, fallback: { style: {} }, gl,
    state: { E: 0.04, kick: 0, flash: 0, reach: 0, hue: 0, cx: 195, cy: 338, theme: 0 },
    u: Object.fromEntries(['uRes', 'uCenter', 'uTime', 'uE', 'uKick', 'uFlash', 'uReach', 'uHue', 'uTheme'].map(n => [n, n])),
  });
  return { bg, calls };
}

const minFloat32 = 2 ** -149;
const zeroTie = minFloat32 / 2;
const aboveZeroTie = zeroTie * (1 + Number.EPSILON);

test('transparent idle clears once rather than rendering repeatedly', t => {
  const { bg, calls } = fixture(t);
  for (let i = 0; i < 600; i++) bg.render(i * 1000 / 60);
  assert.equal(calls.draws, 0);
  assert.equal(calls.clears, 1);
});

for (const fps of [30, 60, 120]) {
  test(`reach decay at ${fps} fps resumes idle skipping without changing simulation state`, t => {
    const { bg, calls } = fixture(t);
    const dt = Math.min(0.05, 1 / fps);
    const k = Math.min(1, dt * 5);
    let reach = 1;
    let firstSkipped = 0;
    // Same lerp expression as core.js/main.js. Time is simulated, not slept.
    // Three minutes also reaches the positive binary64 subnormal plateau.
    for (let frame = 1; frame <= fps * 180; frame++) {
      reach = reach + (0 - reach) * k;
      bg.state.reach = reach;
      const draws = calls.draws;
      bg.render(frame * 1000 / fps);
      assert.equal(bg.state.reach, reach, 'render must not clamp the simulation value');
      const zeroUniform = Math.fround(reach) === 0;
      if (zeroUniform && !firstSkipped) firstSkipped = frame;
      assert.equal(calls.draws - draws, zeroUniform ? 0 : 1, `frame ${frame}`);
      if (!zeroUniform) assert.equal(calls.uniforms.uReach, Math.fround(reach));
    }
    assert.ok(firstSkipped > 0 && firstSkipped < fps * 30);
    assert.equal(calls.draws, firstSkipped - 1);
    assert.equal(calls.clears, 1);
    assert.ok(reach > 0, 'the original JS comparison would still reject idle skipping');
    assert.equal(Math.fround(reach), 0);
    t.diagnostic(`first skipped frame=${firstSkipped}; simulated seconds=${firstSkipped / fps}`);
  });
}

test('zero-rounding boundary is not an arbitrary visual epsilon', t => {
  const { bg, calls } = fixture(t);
  for (const reach of [0, Number.MIN_VALUE, zeroTie / 2, zeroTie]) {
    assert.equal(Math.fround(reach), 0);
    bg.state.reach = reach;
    bg.render(0);
    assert.equal(bg.state.reach, reach);
  }
  assert.equal(calls.draws, 0);
  assert.equal(calls.clears, 1);
  for (const reach of [aboveZeroTie, minFloat32, 1e-8, 0.5, 1]) {
    assert.ok(Math.fround(reach) > 0);
    const draws = calls.draws;
    bg.state.reach = reach;
    bg.render(0);
    assert.equal(calls.draws, draws + 1, 'every positive float32 reach still renders');
    assert.equal(calls.uniforms.uReach, Math.fround(reach));
    assert.equal(bg.state.reach, reach);
  }
});

test('visible energy, flash and a new reach resume drawing immediately', t => {
  const { bg, calls } = fixture(t);
  for (const change of [{ E: 0.5 }, { flash: 0.25 }, { reach: 0.5 }]) {
    Object.assign(bg.state, { E: 0.04, flash: 0, reach: zeroTie });
    bg.render(0);
    const draws = calls.draws;
    Object.assign(bg.state, change);
    bg.render(16);
    assert.equal(calls.draws, draws + 1);
    assert.equal(bg._transparent, false);
    Object.assign(bg.state, { E: 0.04, flash: 0, reach: zeroTie });
    const clears = calls.clears;
    bg.render(32);
    bg.render(48);
    assert.equal(calls.clears, clears + 1);
  }
});

test('resizing invalidates the clear flag after reach underflow', t => {
  const { bg, calls } = fixture(t);
  bg.state.reach = zeroTie;
  bg.render(0);
  globalThis.innerWidth = 430;
  globalThis.innerHeight = 932;
  bg.render(16);
  bg.render(32);
  assert.equal(calls.draws, 0);
  assert.equal(calls.clears, 2);
  assert.equal(bg.canvas.width, Math.round(430 * 1.25));
  assert.equal(bg.canvas.height, Math.round(932 * 1.25));
  bg.state.reach = 1;
  bg.render(48);
  assert.equal(calls.draws, 1);
});

test('CSS fallback retains the original double-precision reach value', t => {
  const { bg, calls } = fixture(t);
  bg.gl = null;
  bg.state.reach = zeroTie;
  bg.render(500);
  assert.equal(bg.fallback.style.opacity, String(zeroTie * 0.8));
  assert.equal(bg.state.reach, zeroTie);
  assert.equal(calls.draws, 0);
  assert.equal(calls.clears, 0);
});

test('non-finite reach does not enter the transparent fast path', t => {
  const { bg, calls } = fixture(t);
  for (const reach of [NaN, Infinity]) {
    bg.state.reach = reach;
    bg.render(0);
  }
  assert.equal(calls.draws, 2);
  assert.equal(calls.clears, 0);
});
