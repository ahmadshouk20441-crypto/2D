const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8').split('\n');
// Locate the LEVELS literal by its delimiters so edits above it cannot break this.
const start = src.findIndex(l => /^\s*var LEVELS = \[/.test(l));
if (start < 0) throw new Error('could not find "var LEVELS = [" in main.js');
const end = src.findIndex((l, i) => i > start && /^\s*\];\s*$/.test(l));
if (end < 0) throw new Error('could not find the end of the LEVELS literal');
const body = src.slice(start, end + 1).join('\n').replace(/^\s*var LEVELS =\s*/, '');
const LEVELS = eval('(' + body.replace(/;\s*$/, '') + ')');

const TILE = 32, PW = 22, PH = 30;
let problems = 0;
const fail = (m) => { console.log('  ✗ ' + m); problems++; };

LEVELS.forEach((L, li) => {
  console.log(`\nStage ${li + 1}: ${L.name}`);
  const rows = L.map, W = rows[0].length, H = rows.length;

  // 1. rectangular map, known glyphs, sealed border
  rows.forEach((r, y) => {
    if (r.length !== W) fail(`row ${y} is ${r.length} chars, expected ${W}`);
    [...r].forEach((c, x) => {
      if (!'#.=^'.includes(c)) fail(`row ${y} col ${x}: unknown glyph '${c}'`);
    });
    if (r[0] !== '#' || r[r.length - 1] !== '#') fail(`row ${y} has an open side wall`);
  });
  if ([...rows[0]].some(c => c !== '#')) fail('top row is not sealed');
  console.log(`  grid ${W}x${H} (${W * TILE}x${H * TILE}px)`);

  const at = (x, y) => (y < 0 || y >= H || x < 0 || x >= W) ? '#' : rows[y][x];
  const solid = (x, y) => at(x, y) === '#';

  // 2. spawns: standing room, solid floor underneath
  for (const who of ['p1', 'p2']) {
    const [sx, sy] = L.spawn[who];
    if (solid(sx, sy)) fail(`${who} spawns inside a wall at (${sx},${sy})`);
    if (solid(sx, sy - 1)) fail(`${who} has no headroom at (${sx},${sy})`);
    if (!solid(sx, sy + 1)) fail(`${who} spawns over empty space at (${sx},${sy})`);
  }

  // 3. every source referenced by a blocker/mover must exist
  const ids = new Set([...L.plates.map(p => p.id), ...L.levers.map(l => l.id)]);
  L.blockers.forEach((b, i) =>
    b.openWhen.forEach(s => { if (!ids.has(s)) fail(`blocker ${i} references unknown source '${s}'`); }));
  L.movers.forEach(m =>
    m.activeWhen.forEach(s => { if (!ids.has(s)) fail(`mover '${m.id}' references unknown source '${s}'`); }));
  const allIds = [...L.plates.map(p => p.id), ...L.levers.map(l => l.id), ...L.movers.map(m => m.id)];
  if (new Set(allIds).size !== allIds.length) fail('duplicate entity id');

  // 4. plates and levers need solid ground beneath and clear space at their tile
  L.plates.forEach(p => {
    if (!solid(p.tx, p.ty + 1)) fail(`plate '${p.id}' floats at (${p.tx},${p.ty})`);
    if (solid(p.tx, p.ty)) fail(`plate '${p.id}' is buried at (${p.tx},${p.ty})`);
  });
  L.levers.forEach(l => {
    if (!solid(l.tx, l.ty + 1)) fail(`lever '${l.id}' floats at (${l.tx},${l.ty})`);
    if (solid(l.tx, l.ty)) fail(`lever '${l.id}' is buried at (${l.tx},${l.ty})`);
  });

  // 5. blockers must actually sit in open space (otherwise they block nothing)
  L.blockers.forEach((b, i) => {
    let open = 0;
    for (let y = b.ty; y < b.ty + b.h; y++)
      for (let x = b.tx; x < b.tx + b.w; x++)
        if (!solid(x, y)) open++;
    if (open === 0) fail(`blocker ${i} is entirely inside solid rock`);
    if (b.kind !== 'gate' && b.kind !== 'barrier') fail(`blocker ${i} has unknown kind '${b.kind}'`);
  });

  // 6. a mover endpoint is only useful if its top surface can be stood on:
  //    the row directly above it must be clear. (A platform parked flush inside
  //    the floor is fine — that is how the lifts rest.)
  L.movers.forEach(m => {
    [['from', m.from], ['to', m.to]].forEach(([label, pos]) => {
      if (pos[1] >= H) return;                       // parked below the map on purpose
      for (let x = pos[0]; x < pos[0] + m.w; x++)
        if (solid(x, pos[1] - 1))
          fail(`mover '${m.id}' ${label} endpoint has no standing room above (${x},${pos[1] - 1})`);
    });
    if (!['toggle', 'shuttle'].includes(m.mode)) fail(`mover '${m.id}' has unknown mode '${m.mode}'`);
  });

  // 7. the exit box must be clear of rock and resting on something
  const [ex, ey] = L.exit;
  const box = { x: ex * TILE - 16, y: (ey - 1) * TILE, w: 64, h: 64 };
  for (let y = Math.floor(box.y / TILE); y < Math.ceil((box.y + box.h) / TILE); y++)
    for (let x = Math.floor(box.x / TILE); x < Math.ceil((box.x + box.w) / TILE); x++)
      if (solid(x, y)) fail(`exit box overlaps rock at (${x},${y})`);
  if (!solid(ex, ey + 1)) fail(`exit at (${ex},${ey}) has no floor`);

  console.log(`  plates=${L.plates.length} levers=${L.levers.length} blockers=${L.blockers.length} movers=${L.movers.length}`);
});

console.log(problems ? `\n${problems} problem(s) found` : '\nAll level checks passed');
process.exit(problems ? 1 : 0);
