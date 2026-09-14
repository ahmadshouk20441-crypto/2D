/* Headless playthrough: drives both characters through every stage with a bot
   that can only do what a human can — walk, jump, and press E. */

const { fireKey } = require('./dom-stub.js');
require(require('path').join(__dirname, '..', 'main.js'));

const { Game, LEVELS } = window.RuinsTogether;
const TILE = 32, STEP = 1 / 120;

const KEYS = [
  { left: 'KeyA', right: 'KeyD', jump: 'KeyW', use: 'KeyE' },
  { left: 'ArrowLeft', right: 'ArrowRight', jump: 'ArrowUp', use: 'Slash' }
];

const down = [{}, {}];
function setKey(i, which, on) {
  const code = KEYS[i][which];
  if (!!down[i][code] === !!on) return;
  down[i][code] = on;
  fireKey(on ? 'keydown' : 'keyup', code);
}
function releaseAll() {
  for (let i = 0; i < 2; i++) for (const w of ['left', 'right', 'jump', 'use']) setKey(i, w, false);
}

/* --- what the bot can perceive: is there footing just ahead? --- */
function solidAt(px, py) {
  const w = Game.world;
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (ty < 0 || ty >= w.lines) return ty >= w.lines;
  if (tx < 0 || tx >= w.cols) return true;
  if (w.rows[ty][tx] === '#') return true;
  return w.movers.some(m => px >= m.x && px <= m.x + m.w && py >= m.y && py <= m.y + m.h + 2);
}
function footingAhead(p, dir) {
  for (let d = 10; d <= 30; d += 5) if (solidAt(p.x + dir * d, p.y + 5)) return true;
  return false;
}

/* --- command queue per player --- */
const queues = [[], []];
const stuck = [{ x: 0, n: 0 }, { x: 0, n: 0 }];

const goto = (x, t = 14) => ({ type: 'goto', x, timeout: t });
const use = () => ({ type: 'use', frames: 3 });
const wait = (t) => ({ type: 'wait', t });
const stay = (x, t) => ({ type: 'stay', x, t });
const hop = (x, t = 14) => ({ type: 'hop', x, timeout: t });
const waitFor = (fn, t = 20, label = '') => ({ type: 'waitFor', fn, timeout: t, label });

function drive(i) {
  const p = Game.players[i];
  const cmd = queues[i][0];
  setKey(i, 'left', false); setKey(i, 'right', false);
  setKey(i, 'jump', false); setKey(i, 'use', false);
  if (!cmd) return;

  if (cmd.type === 'wait') { cmd.t -= STEP; if (cmd.t <= 0) queues[i].shift(); return; }

  if (cmd.type === 'waitFor') {
    cmd.timeout -= STEP;
    if (cmd.fn()) { queues[i].shift(); return; }
    if (cmd.timeout <= 0) throw new Error(`waitFor timed out: ${cmd.label}`);
    return;
  }

  if (cmd.type === 'use') {
    setKey(i, 'use', true);
    cmd.frames--;
    if (cmd.frames <= 0) queues[i].shift();
    return;
  }

  // 'goto', 'hop' and 'stay' all walk toward a target x
  const dx = cmd.x - p.x;
  const dir = Math.sign(dx);
  const close = Math.abs(dx) < 7;

  if (cmd.type === 'stay') {
    cmd.t -= STEP;
    if (!close) setKey(i, dir > 0 ? 'right' : 'left', true);
    if (cmd.t <= 0) queues[i].shift();
    return;
  }

  cmd.timeout -= STEP;
  if (cmd.timeout <= 0) throw new Error(`${cmd.type}(${cmd.x}) timed out for P${i + 1} at x=${p.x.toFixed(0)} y=${p.y.toFixed(0)}`);
  if (close && (cmd.type === 'goto' || p.grounded)) { queues[i].shift(); return; }

  setKey(i, dir > 0 ? 'right' : 'left', true);

  // 'hop' = a player deliberately climbing. Hold jump through the ascent the
  // way a person does, rather than tapping it for a single frame.
  if (cmd.type === 'hop') {
    if (p.grounded) cmd.hold = 16;
    if (cmd.hold > 0) { setKey(i, 'jump', true); cmd.hold--; }
    return;
  }

  // Jump when blocked by a step, or when about to walk off into a gap.
  const s = stuck[i];
  if (Math.abs(p.x - s.x) < 0.4) s.n++; else { s.n = 0; s.x = p.x; }
  const blocked = p.grounded && s.n > 10;
  const gapAhead = p.grounded && !footingAhead(p, dir);
  if (blocked || gapAhead) { setKey(i, 'jump', true); s.n = 0; }
}

function run(label, maxSeconds = 90) {
  const deadline = maxSeconds / STEP;
  let frames = 0;
  const startLevel = Game.world.index;
  const dump = (why) => {
    const w = Game.world;
    console.log(`\n--- ${label}: ${why} @ ${(frames * STEP).toFixed(1)}s ---`);
    Game.players.forEach((p, i) => console.log(
      `  P${i + 1} x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} vx=${p.vx.toFixed(0)} grounded=${p.grounded} queue=${queues[i].length} head=${JSON.stringify(queues[i][0] && queues[i][0].type)}`));
    console.log('  levers :', w.levers.map(l => `${l.id}=${l.on}`).join(' '));
    console.log('  plates :', w.plates.map(l => `${l.id}=${l.pressed}`).join(' '));
    console.log('  blocks :', w.blockers.map((b, i) => `#${i}(${b.kind})open=${b.open}`).join(' '));
    console.log('  movers :', w.movers.map(m => `${m.id} t=${m.t.toFixed(2)} x=${m.x.toFixed(0)} y=${m.y.toFixed(0)}`).join(' '));
  };
  try {
  while (frames++ < deadline) {
    drive(0); drive(1);
    Game.update(STEP);
    if (frames % 37 === 0) Game.draw();          // exercise the renderer too
    if (Game.world.index !== startLevel || !Game.running) return true;
    if (queues[0].length === 0 && queues[1].length === 0) {
      // let the stage-clear fanfare play out
      if (Game.world.cleared) continue;
      if (frames > deadline - 1) break;
    }
  }
  } catch (e) { dump(e.message); throw e; }
  dump('ran out of time');
  throw new Error(`stage "${label}" did not complete within ${maxSeconds}s of simulated time`);
}

const tx = (t) => t * TILE + TILE / 2;
const exitX = () => Game.world.exit.x + Game.world.exit.w / 2;

Game.start('local', 0);
console.log('Booted. Stage 1 loaded:', Game.world.def.name);

/* ---------------- Stage 1 — plate holds the gate, lever locks it open ------- */
queues[0] = [goto(tx(9)), stay(tx(9), 6.5), waitFor(() => Game.world.levers[0].on, 12, 'lever thrown'),
             goto(exitX(), 22)];
queues[1] = [goto(tx(14), 8), waitFor(() => Game.world.blockers[0].open, 10, 'gate open'),
             goto(tx(27), 14), use(), wait(0.4), goto(exitX(), 22)];
run('Helping Hands');
console.log('✓ Stage 1 cleared →', Game.world.def.name);

/* ---------------- Stage 2 — twin plates raise the bridge, then the lift ----- */
queues[0] = [goto(tx(9)), waitFor(() => Game.world.plates[1].pressed, 40, 'P2 reached plate B'),
             goto(tx(22), 20), goto(tx(25), 14),
             waitFor(() => Game.world.levers[0].on, 30, 'lift lever on'),
             waitFor(() => Game.players[0].y <= 8 * TILE + 2, 40, 'P1 rode the lift'),
             goto(exitX(), 25)];
queues[1] = [waitFor(() => Game.world.movers[0].t > 0.9, 15, 'bridge up'),
             goto(tx(20), 20), stay(tx(20), 8),
             goto(tx(27), 16), use(), wait(0.4),
             goto(tx(25), 16),
             waitFor(() => Game.players[1].y <= 8 * TILE + 2, 40, 'P2 rode the lift'),
             goto(exitX(), 25)];
run('Weight and Measure', 140);
console.log('✓ Stage 2 cleared →', Game.world.def.name);

/* ---------------- Stage 3 — each player opens the other's barrier ---------- */
queues[0] = [waitFor(() => Game.world.levers[0].on, 60, 'upper lever on'),
             goto(tx(27), 25), use(), wait(0.4), goto(exitX(), 25)];
queues[1] = [goto(108, 16),                       // walk left to the foot of the climb
             hop(tx(1) + 16, 12),                 // L1 — block on the floor
             hop(tx(4) + 16, 12),                 // L2
             hop(tx(7) + 16, 12),                 // L3
             hop(tx(10) + 16, 12),                // L4
             hop(tx(13) + 16, 12),                // L5
             hop(tx(17), 14),                     // up onto the divider
             goto(tx(20), 16), use(), wait(0.4),
             waitFor(() => Game.world.blockers[1].open, 50, 'upper barrier open'),
             goto(tx(32), 25), goto(exitX(), 25)];
run('Split Paths', 160);
console.log('✓ Stage 3 cleared →', Game.world.def.name);

/* ---------------- Stage 4 — ferry, plate, lever, lift --------------------- */
queues[0] = [goto(tx(6)), use(), wait(0.4), goto(tx(7), 10),
             waitFor(() => Game.world.movers[0].x <= 8.4 * TILE, 25, 'ferry arrived'),
             goto(tx(10), 12),
             waitFor(() => Game.world.movers[0].t > 0.9, 25, 'ferry crossed'),
             goto(tx(16), 14), goto(tx(18), 10), stay(tx(18), 12),
             waitFor(() => Game.world.levers[1].on, 45, 'gate lever on'),
             goto(tx(25), 22),
             waitFor(() => Game.players[0].y <= 8 * TILE + 2, 45, 'P1 rode the lift'),
             goto(exitX(), 25)];
queues[1] = [wait(2),
             waitFor(() => Game.world.movers[0].t < 0.05, 30, 'ferry returned'),
             goto(tx(9), 14),
             waitFor(() => Game.world.movers[0].t > 0.9, 25, 'ferry crossed again'),
             goto(tx(15), 14),
             waitFor(() => Game.world.blockers[0].open, 35, 'barrier open'),
             goto(tx(26), 20), goto(tx(29), 14), use(), wait(0.4),
             goto(tx(25), 18),
             waitFor(() => Game.players[1].y <= 8 * TILE + 2, 45, 'P2 rode the lift'),
             goto(exitX(), 25)];
run('The Final Gate', 220);

console.log('\n✓ All ' + LEVELS.length + ' stages completed by the bot.');
console.log('Game.running =', Game.running, '(false means the victory screen was reached)');
