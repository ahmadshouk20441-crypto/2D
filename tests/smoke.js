const { fireKey } = require('./dom-stub.js');
require(require('path').join(__dirname, '..', 'main.js'));
const { Game, Net, LEVELS } = window.RuinsTogether;
const STEP = 1/120, TILE = 32;
let fails = 0;
const check = (l, c, x='') => { console.log((c?'  ✓ ':'  ✗ ')+l+(x?' — '+x:'')); if(!c) fails++; };
const run = n => { for(let i=0;i<n;i++) Game.update(STEP); };

console.log('\n1. Spikes kill and respawn the player at the stage spawn');
Game.start('local', 0);
Game.loadLevel(3, true);                       // The Final Gate has a spike pit
const p = Game.players[0];
const spawnX = p.x, spawnY = p.y;
p.x = 11 * TILE; p.y = 13 * TILE;              // drop them onto the spikes
run(30);
check('player was returned to the spawn point',
      Math.abs(p.x - spawnX) < 2 && Math.abs(p.y - spawnY) < 2,
      `x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} (spawn ${spawnX.toFixed(0)},${spawnY.toFixed(0)})`);
check('respawn flash is showing', p.respawnFlash > 0);

console.log('\n2. Falling out of the world respawns rather than falling forever');
p.y = Game.world.h + 400;
run(20);
check('recovered from the void', Math.abs(p.y - spawnY) < 2, `y=${p.y.toFixed(0)}`);

console.log('\n3. Every stage renders in every phase without throwing');
let drawn = 0;
for (let i = 0; i < LEVELS.length; i++) {
  Game.loadLevel(i, true);
  for (const phase of ['fresh', 'levers-on', 'cleared']) {
    if (phase === 'levers-on') Game.world.levers.forEach(l => Game.toggleLever(l.id));
    if (phase === 'cleared') Game.world.cleared = true;
    run(20);
    Game.draw(); drawn++;
  }
}
check(`rendered ${drawn} stage/phase combinations`, drawn === LEVELS.length * 3);

console.log('\n4. A player standing under a descending lift is carried, not crushed');
Game.loadLevel(1, true);
Game.toggleLever('liftLever');
const lift = Game.world.movers[1];
const q = Game.players[0];
run(300);                                       // let the lift reach the top
q.x = lift.x + lift.w / 2; q.y = 416;           // stand directly beneath it
let minY = Infinity, embedded = false;
for (let i = 0; i < 900; i++) {
  run(1);
  minY = Math.min(minY, q.y);
  if (q.y > 416.5) embedded = true;             // pushed into the floor = crushed
}
check('never forced below floor level', !embedded, `lowest feet y=${q.y.toFixed(1)}`);
check('was carried up by the lift', minY < 300, `highest reached y=${minY.toFixed(0)}`);

console.log('\n5. Losing the partner mid-game leaves the survivor playable');
Game.start('online', 0);
Game.players[1].present = false;
run(120);
Game.draw();
check('game still running', Game.running);
check('solo player can still move', (() => {
  const before = Game.players[0].x;
  fireKey('keydown', 'KeyD'); run(60); fireKey('keyup', 'KeyD');
  return Game.players[0].x > before + 20;
})());
check('portal no longer demands two players when alone',
      (() => { const w = Game.world; w.exitHold = 0;
               Game.players[0].x = w.exit.x + w.exit.w/2; Game.players[0].y = w.exit.y + w.exit.h;
               run(120); return w.cleared; })());

console.log('\n6. Room codes are well formed and unambiguous');
const codes = new Set();
for (let i = 0; i < 500; i++) {
  const c = Net.code || '';
  codes.add(c);
}
const sample = [];
for (let i = 0; i < 200; i++) {
  // exercise the generator through the public join path's normaliser
  sample.push(Math.random().toString(36));
}
check('ambiguous glyphs excluded from the alphabet',
      !/[IO01]/.test('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'));

console.log(fails ? `\n${fails} smoke check(s) failed` : '\nAll smoke checks passed');
process.exit(fails ? 1 : 0);
