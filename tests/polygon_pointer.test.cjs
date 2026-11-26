'use strict';
// Execute the actual built geometry and pointer handlers. The DOM below only
// dispatches events; it does not implement snapping or the release decision.
// To prove the regression against an earlier build (expected exit 1):
// node tests/polygon_pointer.test.cjs --legacy-repro --app-root /path/to/old/build
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const args = process.argv.slice(2);
const rootArg = args.indexOf('--app-root');
const root = path.resolve(rootArg >= 0 ? args[rootArg + 1] : process.cwd());
const source = fs.readFileSync(path.join(root, 'sentlog/part09.txt'), 'utf8');
const coordinates = fs.readFileSync(path.join(root, 'sentlog/part08.txt'), 'utf8');
const start = source.indexOf('// Octilinear ("CAD-style") polygon geometry.');
const end = source.indexOf('function renderPreview(){', start);
assert(start > 0 && end > start, 'actual polygon geometry and pointer handlers found');
const pointFunction = coordinates.match(/^function point\(e\)\{[^\n]+\}$/m)?.[0];
assert(pointFunction, 'actual viewport-to-drawing coordinate conversion found');
const pointerSource = pointFunction + '\n' + source.slice(start, end);
assert.doesNotThrow(() => new vm.Script(pointerSource));

const copy = value => JSON.parse(JSON.stringify(value));
const p = (x, y) => ({x, y});
function near(actual, expected, label) {
  assert(actual && Number.isFinite(actual.x) && Number.isFinite(actual.y), label + ': finite point');
  assert(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-7,
    label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function harness() {
  function target() {
    return {
      handlers: new Map(),
      addEventListener(type, fn, options) {
        const handlers = this.handlers.get(type) || [];
        handlers.push({fn, capture: options === true || !!options?.capture});
        this.handlers.set(type, handlers);
      }
    };
  }
  const stage = target(), win = target(), document = target();
  const captured = new Set(), frames = new Map(), saved = [];
  let frameId = 0;
  const bounds = {left: 120, top: 80, width: 900, height: 700};
  stage.getBoundingClientRect = () => ({...bounds});
  stage.setPointerCapture = id => captured.add(id);
  stage.releasePointerCapture = id => captured.delete(id);
  stage.hasPointerCapture = id => captured.has(id);
  document.hidden = false;
  const context = {
    console, Math, Number, Array, Object, JSON, Map, Set,
    $: id => id === 'stageWrap' ? stage : {value: '1'},
    state: {sourceType: 'image', currentPage: 1, width: 1600, height: 1200, shapes: []},
    currentView: 'editor', activeProjectId: 'synthetic-project', activeDrawingId: 'synthetic-drawing',
    tool: 'polygon', scale: 1, tx: 37, ty: 19,
    drawing: null, labelDrag: null, panStart: null, pinchStart: null,
    gestureLock: false, activeTouches: new Map(),
    document,
    addEventListener: (...values) => win.addEventListener(...values),
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    render() {}, renderPreview() {}, applyTransform() {}, updateZoomUI() {},
    clampZoom: value => Math.max(.05, Math.min(8, value)),
    clearSelection() {}, pushHistory() {}, persist() {},
    addShape(shape) { saved.push(copy(shape)); }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(pointerSource, context);
  function event(kind, raw, options = {}) {
    return {
      type: kind, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
      clientX: bounds.left + context.tx + raw.x * context.scale,
      clientY: bounds.top + context.ty + raw.y * context.scale,
      cancelable: true, target: stage,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; },
      ...options
    };
  }
  function dispatch(kind, raw, options = {}) {
    const e = event(kind, raw, options);
    for (const [surface, capture] of [[win, true], [stage, true], [stage, false], [win, false]]) {
      for (const listener of surface.handlers.get(kind) || []) {
        if (listener.capture !== capture) continue;
        listener.fn(e);
        if (e.immediateStopped) break;
      }
      if (e.propagationStopped) break;
    }
    return e;
  }
  function windowEvent(kind) {
    for (const listener of win.handlers.get(kind) || []) listener.fn({type: kind});
  }
  function tap(raw, pointerType = 'touch', pointerId = 1) {
    dispatch('pointerdown', raw, {pointerType, pointerId});
    dispatch('pointerup', raw, {pointerType, pointerId});
  }
  function begin(raw, pointerType = 'touch', pointerId = 1) {
    dispatch('pointerdown', raw, {pointerType, pointerId});
  }
  return {
    context, saved, stage, event, dispatch, windowEvent, tap, begin,
    run: expression => vm.runInContext(expression, context),
    draft(points = [p(100, 100), p(300, 100)]) {
      context.drawing = {kind: 'polygon', points: copy(points)};
    },
    preview() { return copy(vm.runInContext('polygonDraftCursor', context)); },
    last() { return context.drawing?.points.at(-1); }
  };
}

function releaseReproduction(pointerType, scale) {
  const h = harness();
  h.context.scale = scale;
  const at = (x, y) => p(x / scale, y / scale);
  h.tap(at(100, 100), pointerType);
  h.tap(at(300, 100), pointerType);
  h.begin(at(340, 198), pointerType);
  h.dispatch('pointermove', at(341, 200), {pointerType});
  near(h.preview().points.at(-1), at(300, 200), 'second edge previews vertical');
  assert.equal(h.context.drawing.points.length, 2, 'preview does not commit a vertex');
  h.dispatch('pointerup', at(342, 200), {pointerType});
  near(h.last(), at(300, 200), pointerType + ' 1 CSS px release must preserve displayed second edge at scale ' + scale);
  assert.equal(h.context.drawing.points.length, 3, 'one release adds exactly one vertex');
  assert.equal(h.saved.length, 0, 'unfinished polygon is not persisted');
}

// This assertion intentionally also runs on --legacy-repro. A legacy build
// fails here with (371,171), despite the last displayed point being (300,200).
releaseReproduction('touch', 1);
if (args.includes('--legacy-repro') || args.includes('--repro-only')) {
  console.log('PASS actual pointer pipeline: displayed vertical second edge survives 1px release movement');
  process.exit(0);
}

for (const type of ['touch', 'pen']) {
  for (const scale of [.25, .5, 1, 2, 4]) releaseReproduction(type, scale);

  // Small release motion across each of the eight angular sector boundaries
  // must preserve the visible guide; intended diagonal guides stay diagonal.
  for (let direction = 0; direction < 8; direction++) {
    const h = harness();
    h.draft([p(100, 500), p(500, 500)]);
    const theta = direction * Math.PI / 4;
    const at = delta => p(500 + 100 * Math.cos(theta + delta * Math.PI / 180),
      500 + 100 * Math.sin(theta + delta * Math.PI / 180));
    h.begin(at(20), type);
    h.dispatch('pointermove', at(21.5), {pointerType: type});
    const visibleEnd = h.preview().points.at(-1);
    const dx = visibleEnd.x - 500, dy = visibleEnd.y - 500;
    assert(Math.abs(dx * Math.sin(theta) - dy * Math.cos(theta)) < 1e-7,
      'preview follows the intended compass direction ' + direction);
    h.dispatch('pointerup', at(23.5), {pointerType: type});
    near(h.last(), visibleEnd, type + ' displayed compass direction ' + direction);
  }
}

function prepared(type = 'touch') {
  const h = harness();
  h.draft();
  h.begin(p(340, 198), type);
  h.dispatch('pointermove', p(341, 200), {pointerType: type});
  return h;
}

for (const type of ['touch', 'pen']) {
  const edge = prepared(type);
  edge.dispatch('pointerup', p(347, 200), {pointerType: type});
  near(edge.last(), p(300, 200), type + ' exactly 6 CSS px retains preview');
  const outside = prepared(type);
  outside.dispatch('pointerup', p(347.01, 200), {pointerType: type});
  near(outside.last(), p(373.505, 173.505), type + ' movement beyond 6 CSS px uses final position');
  const deliberate = prepared(type);
  deliberate.dispatch('pointerup', p(380, 220), {pointerType: type});
  near(deliberate.last(), p(400, 200), type + ' deliberately changed final direction is respected');
  const latest = prepared(type);
  latest.dispatch('pointermove', p(380, 220), {pointerType: type});
  latest.dispatch('pointerup', p(381, 220), {pointerType: type});
  near(latest.last(), p(400, 200), type + ' most recent visible guide replaces an earlier guide');

  const first = harness();
  first.begin(p(100, 100), type);
  first.dispatch('pointerup', p(105, 100), {pointerType: type});
  near(first.last(), p(105, 100), type + ' first vertex without a guide uses release position');
  const plain = harness();
  plain.draft();
  plain.begin(p(341, 200), type);
  plain.dispatch('pointerup', p(342, 200), {pointerType: type});
  near(plain.last(), p(300, 200), type + ' down/up without move retains the guide shown on contact');
}

// A candidate from another document, target, transform or geometry cannot
// override the current event. The raw release independently projects to 45°.
const staleCases = [
  ['replacement draft', h => { h.context.drawing = copy(h.context.drawing); }, p(371, 171)],
  ['changed vertex count', h => h.context.drawing.points.push(p(300, 100)), p(371, 171)],
  ['mutated anchor coordinates', h => { h.context.drawing.points.at(-1).x = 299; }, p(370.5, 171.5)],
  ['replacement preview', h => h.run('polygonDraftCursor=JSON.parse(JSON.stringify(polygonDraftCursor))'), p(371, 171)],
  ['cleared preview', h => h.run('polygonDraftCursor=null'), p(371, 171)],
  ['changed scale', h => { h.context.scale = 1.01; }, p(371, 171)],
  ['changed horizontal pan', h => { h.context.tx += 1; }, p(371, 171)],
  ['changed vertical pan', h => { h.context.ty += 1; }, p(371, 171)],
  ['changed project', h => { h.context.activeProjectId = 'other-project'; }, p(371, 171)],
  ['changed drawing', h => { h.context.activeDrawingId = 'other-drawing'; }, p(371, 171)],
  ['changed PDF page', h => { h.context.state.currentPage = 2; }, p(371, 171)],
  ['non-editor view', h => { h.context.currentView = 'projects'; }, p(371, 171)],
  ['nonfinite sample', h => h.run('polygonTouch.raw.x=NaN'), p(371, 171)]
];
for (const [label, change, expected] of staleCases) {
  const h = prepared();
  change(h);
  h.dispatch('pointerup', p(342, 200));
  near(h.last(), expected, 'stale candidate: ' + label);
}

const wrongType = prepared('pen');
wrongType.dispatch('pointerup', p(342, 200), {pointerType: 'mouse'});
near(wrongType.last(), p(371, 171), 'release of another pointer type does not reuse a pen candidate');
const wrongPointer = prepared();
wrongPointer.context.releaseProbe = wrongPointer.event('pointerup', p(342, 200), {pointerId: 99});
near(wrongPointer.run('polygonPointerRelease(releaseProbe)'), p(342, 200), 'another pointer cannot borrow the candidate');
wrongPointer.dispatch('pointerup', p(342, 200), {pointerId: 99});
assert.equal(wrongPointer.context.drawing.points.length, 2, 'unrelated pointer ending adds no vertex');
wrongPointer.dispatch('pointerup', p(342, 200));
near(wrongPointer.last(), p(300, 200), 'the original pointer can still finish its own gesture');
const noCandidate = prepared();
noCandidate.run('polygonTouch.preview=null');
noCandidate.dispatch('pointerup', p(342, 200));
near(noCandidate.last(), p(371, 171), 'no candidate falls back to release coordinates');
const invalidRelease = prepared();
invalidRelease.dispatch('pointerup', p(NaN, 200));
assert.equal(invalidRelease.context.drawing.points.length, 2, 'nonfinite release does not borrow the last valid candidate');
assert.equal(invalidRelease.saved.length, 0);

// Mouse remains click-to-place. A previous hover must not replace a click.
const mouse = harness();
mouse.draft();
mouse.dispatch('pointermove', p(341, 200), {pointerType: 'mouse'});
near(mouse.preview().points.at(-1), p(300, 200), 'mouse hover previews vertical');
mouse.dispatch('pointerdown', p(342, 200), {pointerType: 'mouse'});
mouse.dispatch('pointerup', p(342, 200), {pointerType: 'mouse'});
near(mouse.last(), p(371, 171), 'mouse click keeps its existing final-coordinate behavior');
assert.equal(mouse.context.drawing.points.length, 3);

// Dimension input calls commitPolygonVertex directly. Even during a contact,
// its explicit 160-unit length must not be replaced by the 100-unit guide.
const dimension = prepared('pen');
dimension.context.commitPolygonVertex(p(300, 260));
near(dimension.last(), p(300, 260), 'numeric dimension endpoint is honored by direct commit');
assert.equal(dimension.context.drawing.points.length, 3);
assert.equal(dimension.saved.length, 0);

const short = harness();
short.draft();
short.begin(p(304, 100));
short.dispatch('pointermove', p(305, 100));
short.dispatch('pointerup', p(310, 100));
assert.equal(short.context.drawing.points.length, 2, 'release drift cannot turn a rejected short guide into a stray edge');

for (const type of ['touch', 'pen']) {
  const closing = harness();
  closing.draft([p(100, 100), p(300, 100), p(300, 300), p(100, 300)]);
  closing.begin(p(117, 100), type);
  assert.equal(closing.preview().closing, true);
  assert.equal(closing.preview().valid, true);
  closing.dispatch('pointerup', p(119, 100), {pointerType: type});
  assert.equal(closing.saved.length, 1, type + ' displayed closure survives crossing the 18px boundary on release');
  assert.equal(closing.context.drawing, null);
  assert.equal(closing.saved[0].points.length, 4, 'closure does not insert a duplicate first vertex');

  const invalid = harness();
  invalid.draft([p(100, 100), p(300, 100), p(200, 100)]);
  invalid.begin(p(117, 100), type);
  assert.equal(invalid.preview().closing, true);
  assert.equal(invalid.preview().valid, false);
  invalid.dispatch('pointerup', p(119, 100), {pointerType: type});
  assert.equal(invalid.saved.length, 0, type + ' invalid zero-area closure is never saved');
  assert.equal(invalid.context.drawing.points.length, 3, 'rejected closure does not unexpectedly add an edge');

  const cancelled = prepared(type);
  cancelled.dispatch('pointercancel', p(342, 200), {pointerType: type});
  assert.equal(cancelled.context.drawing.points.length, 2, type + ' cancelled contact adds nothing');
  assert.equal(cancelled.run('polygonTouch'), null);
  assert.equal(cancelled.run('polygonDraftCursor'), null);
  cancelled.begin(p(380, 220), type);
  cancelled.dispatch('pointerup', p(381, 220), {pointerType: type});
  near(cancelled.last(), p(400, 200), type + ' new gesture after cancel has no stale direction');
}

// Real capture handlers cancel the draft when a second finger starts a pinch.
const pinch = prepared();
pinch.dispatch('pointerdown', p(600, 400), {pointerId: 2, isPrimary: false});
assert.equal(pinch.context.drawing, null, 'pinch cancels the unfinished polygon');
pinch.dispatch('pointerup', p(342, 200));
pinch.dispatch('pointerup', p(600, 400), {pointerId: 2, isPrimary: false});
assert.equal(pinch.saved.length, 0, 'pinch never saves an unfinished polygon');
assert.equal(pinch.run('polygonTouch'), null);
pinch.tap(p(450, 450));
assert.equal(pinch.context.drawing.points.length, 1);
near(pinch.last(), p(450, 450), 'drawing after pinch starts with a fresh vertex');

for (const type of ['blur', 'pagehide']) {
  const h = prepared();
  h.windowEvent(type);
  h.dispatch('pointerup', p(342, 200));
  assert.equal(h.context.drawing, null, type + ' discards the old draft and pending candidate');
  assert.equal(h.saved.length, 0);
  h.tap(p(450, 450));
  near(h.last(), p(450, 450), 'fresh gesture after ' + type);
}

console.log('PASS actual polygon pointer pipeline: 1px second-edge regression; touch/pen, eight directions, five zooms, 6px limit, explicit movement, stale target/geometry/viewport, mouse and numeric dimensions, short edges, valid/invalid closure, cancellation and pinch');
