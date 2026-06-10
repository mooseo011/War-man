'use strict';
/* Headless verification of world generation and the war simulation.
 * Run: node test/headless.js
 */
const assert = require('assert');
const game = require('../main.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

console.log('# world generation');
const world = game.newWorld('test-seed-1');

check('generates multiple countries', () => {
  assert.ok(world.countries.length >= 2, `got ${world.countries.length}`);
});

check('all countries have territory and loops', () => {
  for (const c of world.countries) {
    assert.ok(c.cellCount > 0, `country ${c.name} has no cells`);
    assert.ok(c.loops.length > 0, `country ${c.name} has no outline`);
    assert.ok(c.area > 0, `country ${c.name} has no area`);
  }
});

check('borders are valid polylines of shared vertices', () => {
  assert.ok(world.borders.length > 0);
  for (const b of world.borders) {
    assert.ok(b.verts.length >= 2, `border ${b.id} too short`);
    for (const vi of b.verts) {
      const v = world.verts[vi];
      assert.ok(v && isFinite(v.x) && isFinite(v.y), `border ${b.id} bad vertex`);
    }
    for (let i = 1; i < b.verts.length; i++) {
      assert.notStrictEqual(b.verts[i], b.verts[i - 1], `border ${b.id} repeated vertex`);
    }
  }
});

check('country loops reference the same vertex objects as borders', () => {
  const loopVids = new Set();
  for (const c of world.countries) for (const lp of c.loops) for (const vi of lp) loopVids.add(vi);
  let shared = 0, total = 0;
  for (const b of world.borders) for (const vi of b.verts) { total++; if (loopVids.has(vi)) shared++; }
  assert.strictEqual(shared, total, 'every border vertex must appear in a country outline');
});

console.log('# war simulation');

// find an adjacent land-land pair
const landBorder = world.borders.find(b => b.a >= 0 && b.b >= 0);
assert.ok(landBorder, 'world has at least one land-land border');
const A = landBorder.a, B = landBorder.b;

game.toggleAlleg(A);                       // -> red
game.toggleAlleg(B); game.toggleAlleg(B);  // -> red -> blue

check('war can start with one nation per side sharing a border', () => {
  const chk = game.canStartWar();
  assert.ok(chk.ok, chk.why);
});

// snapshot identities & geometry before the war
const borderRefsBefore = world.borders.slice();
const frontBefore = game.computeFronts();
assert.ok(frontBefore.length > 0);
const watch = frontBefore[0];
const watchVertObjsBefore = watch.verts.map(vi => world.verts[vi]);
const posBefore = watch.verts.map(vi => ({ x: world.verts[vi].x, y: world.verts[vi].y }));
const areaABefore = game.loopsArea(world.countries[A].loops, world.verts);
const areaBBefore = game.loopsArea(world.countries[B].loops, world.verts);

assert.ok(game.startWar(), 'war should start');

check('fronts are flagged on the existing border objects (no new objects)', () => {
  assert.ok(watch.isFront, 'watched border should be a front');
  assert.strictEqual(world.borders.length, borderRefsBefore.length);
  for (let i = 0; i < world.borders.length; i++) {
    assert.strictEqual(world.borders[i], borderRefsBefore[i], `border ${i} was replaced`);
  }
});

let steps = 0;
const MAX_STEPS = 400000; // up to 20000 sim-days >> armistice day
let movedDuringWar = false;
while (game.state.war && steps < MAX_STEPS) {
  game.stepSim();
  steps++;
  if (!movedDuringWar && steps % 100 === 0) {
    movedDuringWar = watch.verts.some((vi, i) => {
      const v = world.verts[vi];
      return Math.hypot(v.x - posBefore[i].x, v.y - posBefore[i].y) > 0.5;
    });
  }
}

check('war resolves on its own', () => {
  assert.ok(!game.state.war, `war still running after ${steps} steps`);
  assert.ok(game.state.lastWar && game.state.lastWar.result, 'war has a result');
  console.log(`      result: ${JSON.stringify(game.state.lastWar.result)} after ${steps} steps`);
});

check('border fluctuated during the war', () => {
  assert.ok(movedDuringWar, 'front vertices should have moved while fighting');
});

check('same border object before, during and after the war', () => {
  assert.ok(world.borders.includes(watch), 'watched border object still in the world');
  watch.verts.forEach((vi, i) => {
    assert.strictEqual(world.verts[vi], watchVertObjsBefore[i], 'vertex objects must be identical');
  });
  assert.ok(!watch.isFront, 'border is calm again after the war');
});

check('no NaN / non-finite vertices anywhere', () => {
  for (const v of world.verts) {
    assert.ok(isFinite(v.x) && isFinite(v.y), 'vertex positions must stay finite');
  }
});

check('territory actually changed hands', () => {
  const areaA = game.loopsArea(world.countries[A].loops, world.verts);
  const areaB = game.loopsArea(world.countries[B].loops, world.verts);
  const delta = Math.abs(areaA - areaABefore) + Math.abs(areaB - areaBBefore);
  console.log(`      area change: A ${areaABefore.toFixed(0)} -> ${areaA.toFixed(0)}, B ${areaBBefore.toFixed(0)} -> ${areaB.toFixed(0)}`);
  assert.ok(delta > 50, 'some territory should have been exchanged');
});

check('allegiances cleared after the war', () => {
  assert.strictEqual(game.state.alleg.size, 0);
  assert.strictEqual(game.state.phase, 'pick');
});

console.log('# second war on the same (now deformed) world');

const landBorder2 = world.borders.find(b => b.a >= 0 && b.b >= 0
  && world.countries[b.a].cellCount > 0 && world.countries[b.b].cellCount > 0);
assert.ok(landBorder2, 'still has land borders');
game.toggleAlleg(landBorder2.a);
game.toggleAlleg(landBorder2.b); game.toggleAlleg(landBorder2.b);

check('a second war can be fought after the first', () => {
  const chk = game.canStartWar();
  assert.ok(chk.ok, chk.why);
  assert.ok(game.startWar());
  let s = 0;
  while (game.state.war && s < MAX_STEPS) { game.stepSim(); s++; }
  assert.ok(!game.state.war, 'second war resolves');
  console.log(`      result: ${JSON.stringify(game.state.lastWar.result)} after ${s} steps`);
  for (const v of world.verts) assert.ok(isFinite(v.x) && isFinite(v.y));
});

console.log('# multi-nation alliances');
const w2 = game.newWorld('test-seed-2');
// put two adjacent countries on red, one of their neighbors on blue
const lb = w2.borders.filter(b => b.a >= 0 && b.b >= 0);
assert.ok(lb.length >= 2);
const red1 = lb[0].a, blue1 = lb[0].b;
let red2 = -1;
for (const b of lb) {
  if (b.a === blue1 && b.b !== red1) { red2 = b.b; break; }
  if (b.b === blue1 && b.a !== red1) { red2 = b.a; break; }
}
game.toggleAlleg(red1);
if (red2 >= 0) game.toggleAlleg(red2);
game.toggleAlleg(blue1); game.toggleAlleg(blue1);

check('alliance war (3 nations) resolves', () => {
  const chk = game.canStartWar();
  assert.ok(chk.ok, chk.why);
  assert.ok(game.startWar());
  let s = 0;
  while (game.state.war && s < MAX_STEPS) { game.stepSim(); s++; }
  assert.ok(!game.state.war);
  console.log(`      result: ${JSON.stringify(game.state.lastWar.result)} after ${s} steps`);
});

console.log(`\n${passed} checks passed`);
