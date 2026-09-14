/* ============================================================================
 * Ruins Together — a 2D co-operative puzzle platformer.
 *
 * Architecture
 * ------------
 *   Rendering   Canvas 2D, everything drawn procedurally (no image assets).
 *   Networking  PeerJS DataChannel, host-authoritative for *world* state.
 *               Each peer simulates its own character and streams the result;
 *               the host owns levers / plates / movers / stage progression and
 *               broadcasts them. Co-op has no adversarial incentive, so trusting
 *               each peer with its own avatar keeps input latency at zero.
 *   Physics     Fixed-ish timestep, swept-per-axis AABB against a tile grid plus
 *               a small list of dynamic rectangles (gates, barriers, platforms).
 * ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Tunables
   * ------------------------------------------------------------------ */

  var TILE   = 32;
  var VIEW_W = 960;
  var VIEW_H = 540;

  var PW = 22;   // player collision width
  var PH = 30;   // player collision height

  var GRAVITY        = 1900;
  var MAX_FALL       = 900;
  var RUN_SPEED      = 232;
  var RUN_ACCEL      = 2600;
  var AIR_ACCEL      = 1650;
  var GROUND_DRAG    = 2900;
  var AIR_DRAG       = 430;
  var JUMP_VEL       = 580;
  var JUMP_CUT       = 0.65;   // fraction of jump velocity kept on an early release;
                               // tuned so even a tapped jump clears a one-tile step
  var COYOTE_TIME    = 0.10;
  var JUMP_BUFFER    = 0.12;

  /* Collision skin: how much of the player box is ignored by the perpendicular
     axis so that resting-on / brushing-past never reads as a head-on hit. */
  var SKIN_X = 2;
  var SKIN_Y = 3;

  var INTERACT_RANGE = 46;
  var EXIT_HOLD      = 0.55;   // seconds both players must stand in the portal
  var NET_HZ         = 20;
  var NET_DT         = 1 / NET_HZ;
  var PEER_PREFIX    = 'ruins-together-';

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function approach(v, target, delta) {
    if (v < target) return Math.min(v + delta, target);
    if (v > target) return Math.max(v - delta, target);
    return v;
  }
  /* Frame-rate independent exponential smoothing. */
  function damp(a, b, rate, dt) { return lerp(a, b, 1 - Math.exp(-rate * dt)); }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function show(el, yes) { if (el) el.classList.toggle('hidden', !yes); }

  /* Room codes deliberately skip characters that are easy to misread aloud. */
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeRoomCode() {
    var out = '';
    var bytes = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }
  function normaliseCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  /* ------------------------------------------------------------------ *
   * Audio — tiny WebAudio synth, so there are no sound files to ship.
   * ------------------------------------------------------------------ */

  var Sfx = {
    ctx: null,
    enabled: true,

    unlock: function () {
      if (!this.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { this.ctx = new AC(); } catch (e) { return; }
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },

    tone: function (opts) {
      if (!this.enabled || !this.ctx) return;
      var t0 = this.ctx.currentTime;
      var osc = this.ctx.createOscillator();
      var gain = this.ctx.createGain();
      osc.type = opts.type || 'square';
      osc.frequency.setValueAtTime(opts.from, t0);
      if (opts.to && opts.to !== opts.from) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t0 + opts.dur);
      }
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(opts.vol || 0.08, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
      osc.connect(gain); gain.connect(this.master);
      osc.start(t0); osc.stop(t0 + opts.dur + 0.02);
    },

    noise: function (dur, vol, freq) {
      if (!this.enabled || !this.ctx) return;
      var rate = this.ctx.sampleRate;
      var len = Math.max(1, Math.floor(rate * dur));
      var buf = this.ctx.createBuffer(1, len, rate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = this.ctx.createBufferSource();
      src.buffer = buf;
      var filt = this.ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = freq || 900;
      var gain = this.ctx.createGain();
      gain.gain.value = vol || 0.05;
      src.connect(filt); filt.connect(gain); gain.connect(this.master);
      src.start();
    },

    jump:    function () { this.tone({ from: 340, to: 620, dur: 0.13, type: 'square', vol: 0.05 }); },
    land:    function () { this.noise(0.07, 0.035, 320); },
    lever:   function (on) { this.tone({ from: on ? 420 : 300, to: on ? 760 : 220, dur: 0.1, type: 'triangle', vol: 0.07 }); this.noise(0.05, 0.04, 1800); },
    plate:   function (on) { this.tone({ from: on ? 180 : 240, to: on ? 120 : 160, dur: 0.12, type: 'sine', vol: 0.09 }); },
    door:    function () { this.noise(0.34, 0.05, 260); this.tone({ from: 150, to: 90, dur: 0.35, type: 'sawtooth', vol: 0.035 }); },
    hurt:    function () { this.tone({ from: 300, to: 70, dur: 0.28, type: 'sawtooth', vol: 0.07 }); },
    join:    function () { var s = this; [523, 659, 784].forEach(function (f, i) { setTimeout(function () { s.tone({ from: f, to: f, dur: 0.12, type: 'triangle', vol: 0.07 }); }, i * 80); }); },
    win:     function () { var s = this; [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { s.tone({ from: f, to: f, dur: 0.2, type: 'triangle', vol: 0.08 }); }, i * 110); }); },
    error:   function () { this.tone({ from: 200, to: 120, dur: 0.2, type: 'sawtooth', vol: 0.06 }); }
  };

  /* ------------------------------------------------------------------ *
   * Level data
   *
   * Tile glyphs:  '#' solid   '=' one-way platform   '^' spikes   '.' empty
   * Entity coordinates are in tiles. A blocker is *open* (non-solid) while any
   * of the sources named in `openWhen` is active; a mover runs while any source
   * in `activeWhen` is active (an empty list means "always").
   * ------------------------------------------------------------------ */

  var LEVELS = [
    {
      name: 'Helping Hands',
      objective: 'One of you stands on the plate — the other slips through and finds the lever.',
      map: [
        '########################################',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#..........#######.....................#',
        '#......................................#',
        '#......................................#',
        '#......................#########.......#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '########################################',
        '########################################'
      ],
      spawn: { p1: [3, 12], p2: [6, 12] },
      exit: [35, 12],
      plates: [{ id: 'plate', tx: 9, ty: 12 }],
      levers: [{ id: 'lever', tx: 27, ty: 12 }],
      blockers: [{ kind: 'gate', tx: 20, ty: 10, w: 1, h: 3, openWhen: ['plate', 'lever'] }],
      movers: []
    },

    {
      name: 'Weight and Measure',
      objective: 'The bridge answers to either plate. Cross one at a time, then ride the lift.',
      map: [
        '########################################',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#..........................#############',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#############^^^^^^#####################',
        '########################################'
      ],
      spawn: { p1: [3, 12], p2: [6, 12] },
      exit: [36, 7],
      plates: [
        { id: 'plateA', tx: 9, ty: 12 },
        { id: 'plateB', tx: 20, ty: 12 }
      ],
      levers: [{ id: 'liftLever', tx: 27, ty: 12 }],
      blockers: [],
      movers: [
        { id: 'bridge', w: 6, h: 1, from: [13, 17], to: [13, 13], speed: 300, mode: 'toggle', activeWhen: ['plateA', 'plateB'] },
        { id: 'lift',   w: 3, h: 1, from: [24, 13], to: [24, 8],  speed: 82,  mode: 'shuttle', activeWhen: ['liftLever'] }
      ]
    },

    {
      name: 'Split Paths',
      objective: 'Separated by stone: each of you opens the other\'s way.',
      map: [
        '########################################',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#...............##############.........#',
        '#............##........................#',
        '#.........##...........................#',
        '#......##..............................#',
        '#...##.................................#',
        '###....................................#',
        '########################################',
        '########################################'
      ],
      spawn: { p1: [17, 12], p2: [19, 12] },
      exit: [35, 12],
      plates: [],
      levers: [
        { id: 'upper', tx: 20, ty: 6 },
        { id: 'lower', tx: 27, ty: 12 }
      ],
      blockers: [
        { kind: 'barrier', tx: 22, ty: 10, w: 1, h: 3, openWhen: ['upper'] },
        { kind: 'barrier', tx: 25, ty: 4,  w: 1, h: 3, openWhen: ['lower'] }
      ],
      movers: []
    },

    {
      name: 'The Final Gate',
      objective: 'Ferry across the spikes, hold the plate, throw the lever — then rise together.',
      map: [
        '########################################',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#.......#####..........................#',
        '#......................................#',
        '#......................................#',
        '#..........................#############',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '########^^^^^^^#########################',
        '########################################'
      ],
      spawn: { p1: [1, 12], p2: [3, 12] },
      exit: [34, 7],
      plates: [{ id: 'holdPlate', tx: 18, ty: 12 }],
      levers: [
        { id: 'ferryLever', tx: 6, ty: 12 },
        { id: 'gateLever',  tx: 29, ty: 12 }
      ],
      blockers: [{ kind: 'barrier', tx: 21, ty: 10, w: 1, h: 3, openWhen: ['holdPlate', 'gateLever'] }],
      movers: [
        { id: 'ferry', w: 3, h: 1, from: [8, 12], to: [12, 12], speed: 105, mode: 'shuttle', activeWhen: ['ferryLever'] },
        { id: 'lift',  w: 3, h: 1, from: [24, 13], to: [24, 8], speed: 82,  mode: 'shuttle', activeWhen: ['gateLever'] }
      ]
    }
  ];

  /* ------------------------------------------------------------------ *
   * World construction
   * ------------------------------------------------------------------ */

  function buildWorld(index) {
    var def = LEVELS[index];
    var rows = def.map;
    var world = {
      index: index,
      def: def,
      rows: rows,
      cols: rows[0].length,
      lines: rows.length,
      w: rows[0].length * TILE,
      h: rows.length * TILE,
      plates: [],
      levers: [],
      blockers: [],
      movers: [],
      exit: null,
      exitHold: 0,
      cleared: false,
      time: 0
    };

    def.plates.forEach(function (p) {
      world.plates.push({
        id: p.id,
        rect: { x: p.tx * TILE + 3, y: (p.ty + 1) * TILE - 9, w: TILE - 6, h: 9 },
        pressed: false,
        anim: 0
      });
    });

    def.levers.forEach(function (l) {
      world.levers.push({
        id: l.id,
        x: l.tx * TILE + TILE / 2,
        y: (l.ty + 1) * TILE,
        on: false,
        anim: 0
      });
    });

    def.blockers.forEach(function (b) {
      world.blockers.push({
        kind: b.kind,
        openWhen: b.openWhen,
        full: { x: b.tx * TILE, y: b.ty * TILE, w: b.w * TILE, h: b.h * TILE },
        open: false,
        anim: 0        // 0 = fully closed/solid, 1 = fully open
      });
    });

    def.movers.forEach(function (m) {
      world.movers.push({
        id: m.id,
        activeWhen: m.activeWhen,
        mode: m.mode,
        speed: m.speed,
        a: { x: m.from[0] * TILE, y: m.from[1] * TILE },
        b: { x: m.to[0] * TILE, y: m.to[1] * TILE },
        w: m.w * TILE,
        h: m.h * TILE,
        t: 0,
        dir: 1,
        x: m.from[0] * TILE,
        y: m.from[1] * TILE,
        dx: 0,
        dy: 0
      });
    });

    var ex = def.exit;
    world.exit = { x: ex[0] * TILE - 16, y: (ex[1] - 1) * TILE, w: 64, h: 64 };

    return world;
  }

  function tileAt(world, tx, ty) {
    if (ty < 0 || ty >= world.lines) return ty < 0 ? '.' : '#';
    if (tx < 0 || tx >= world.cols) return '#';
    return world.rows[ty][tx];
  }
  function isSolidTile(ch) { return ch === '#'; }
  function isOneWayTile(ch) { return ch === '='; }
  function isSpikeTile(ch) { return ch === '^'; }

  function sourceActive(world, id) {
    var i;
    for (i = 0; i < world.levers.length; i++) if (world.levers[i].id === id) return world.levers[i].on;
    for (i = 0; i < world.plates.length; i++) if (world.plates[i].id === id) return world.plates[i].pressed;
    return false;
  }
  function anyActive(world, ids) {
    if (!ids || !ids.length) return true;
    for (var i = 0; i < ids.length; i++) if (sourceActive(world, ids[i])) return true;
    return false;
  }

  /* A gate retracts into its ceiling, so its solid part shrinks as it opens.
     A barrier simply fades — it stops blocking once it is mostly gone. */
  function blockerRect(b) {
    if (b.kind === 'gate') {
      return { x: b.full.x, y: b.full.y, w: b.full.w, h: b.full.h * (1 - b.anim) };
    }
    return b.full;
  }
  function blockerBlocks(b) {
    return b.kind === 'gate' ? b.anim < 0.97 : b.anim < 0.55;
  }

  /* Every solid rectangle that is not part of the tile grid. */
  function dynamicSolids(world) {
    var out = [];
    for (var i = 0; i < world.blockers.length; i++) {
      var b = world.blockers[i];
      if (blockerBlocks(b)) {
        var r = blockerRect(b);
        if (r.h > 1) out.push(r);
      }
    }
    for (var j = 0; j < world.movers.length; j++) {
      var m = world.movers[j];
      out.push({ x: m.x, y: m.y, w: m.w, h: m.h, mover: m });
    }
    return out;
  }

  function updateMovers(world, dt, simulate) {
    for (var i = 0; i < world.movers.length; i++) {
      var m = world.movers[i];
      var px = m.x, py = m.y;

      if (simulate) {
        var active = anyActive(world, m.activeWhen);
        var span = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) || 1;
        var step = (m.speed / span) * dt;

        if (m.mode === 'toggle') {
          m.t = approach(m.t, active ? 1 : 0, step);
        } else if (active) {
          m.t += m.dir * step;
          if (m.t >= 1) { m.t = 1; m.dir = -1; }
          if (m.t <= 0) { m.t = 0; m.dir = 1; }
        }
      }

      var e = m.mode === 'toggle' ? smoothstep(m.t) : m.t;
      m.x = lerp(m.a.x, m.b.x, e);
      m.y = lerp(m.a.y, m.b.y, e);
      m.dx = m.x - px;
      m.dy = m.y - py;
    }
  }

  function updateWorldAnim(world, dt) {
    var i;
    for (i = 0; i < world.blockers.length; i++) {
      var b = world.blockers[i];
      b.anim = damp(b.anim, b.open ? 1 : 0, 7, dt);
    }
    for (i = 0; i < world.plates.length; i++) {
      var p = world.plates[i];
      p.anim = damp(p.anim, p.pressed ? 1 : 0, 18, dt);
    }
    for (i = 0; i < world.levers.length; i++) {
      var l = world.levers[i];
      l.anim = damp(l.anim, l.on ? 1 : 0, 16, dt);
    }
  }

  /* ------------------------------------------------------------------ *
   * Player
   * ------------------------------------------------------------------ */

  function makePlayer(kind) {
    return {
      kind: kind,              // 'p1' | 'p2'
      x: 0, y: 0,              // x = centre, y = feet
      vx: 0, vy: 0,
      face: 1,
      grounded: false,
      wasGrounded: false,
      coyote: 0,
      buffer: 0,
      jumpHeld: false,
      riding: null,
      animT: 0,
      anim: 'idle',            // idle | run | jump | fall
      squash: 0,
      respawnFlash: 0,
      present: true,
      // remote-only interpolation targets
      tx: 0, ty: 0
    };
  }

  function playerBox(p) {
    return { x: p.x - PW / 2, y: p.y - PH, w: PW, h: PH };
  }

  function placeAtSpawn(p, world, which) {
    var s = world.def.spawn[which];
    p.x = s[0] * TILE + TILE / 2;
    p.y = (s[1] + 1) * TILE;
    p.tx = p.x; p.ty = p.y;
    p.vx = 0; p.vy = 0;
    p.grounded = true;
    p.riding = null;
    p.anim = 'idle';
  }

  /* --- collision: one axis at a time, tiles first then dynamic rects --- */

  function resolveX(p, world, solids) {
    var b = playerBox(p);
    var x0 = Math.floor(b.x / TILE), x1 = Math.floor((b.x + b.w - 0.01) / TILE);
    var y0 = Math.floor(b.y / TILE), y1 = Math.floor((b.y + b.h - 0.01) / TILE);

    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (!isSolidTile(tileAt(world, tx, ty))) continue;
        if (p.vx > 0) p.x = tx * TILE - PW / 2;
        else if (p.vx < 0) p.x = (tx + 1) * TILE + PW / 2;
        else continue;
        p.vx = 0;
        b = playerBox(p);
        x0 = Math.floor(b.x / TILE); x1 = Math.floor((b.x + b.w - 0.01) / TILE);
      }
    }

    for (var i = 0; i < solids.length; i++) {
      var r = solids[i];
      b = playerBox(p);
      // Inset the box vertically: resting on a platform (or grazing its
      // underside) overlaps it by a hair, and that must not read as a side
      // collision — otherwise standing on a lift shoves you off it.
      var side = { x: b.x, y: b.y + SKIN_Y, w: b.w, h: b.h - SKIN_Y * 2 };
      if (!overlaps(side, r)) continue;
      // Push out along the shallower horizontal overlap.
      var fromLeft = (side.x + side.w) - r.x;
      var fromRight = (r.x + r.w) - side.x;
      if (fromLeft < fromRight) p.x -= fromLeft; else p.x += fromRight;
      p.vx = 0;
    }
  }

  /* True when the player's body currently intersects any solid tile. */
  function embeddedInSolid(p, world) {
    var b = playerBox(p);
    var x0 = Math.floor((b.x + 1) / TILE), x1 = Math.floor((b.x + b.w - 1.01) / TILE);
    var y0 = Math.floor((b.y + 1) / TILE), y1 = Math.floor((b.y + b.h - 1.01) / TILE);
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (isSolidTile(tileAt(world, tx, ty))) return true;
      }
    }
    return false;
  }

  function resolveY(p, world, solids, prevFeet) {
    p.grounded = false;
    var b = playerBox(p);
    var x0 = Math.floor(b.x / TILE), x1 = Math.floor((b.x + b.w - 0.01) / TILE);
    var y0 = Math.floor(b.y / TILE), y1 = Math.floor((b.y + b.h - 0.01) / TILE);

    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        var ch = tileAt(world, tx, ty);
        var top = ty * TILE;

        if (isOneWayTile(ch)) {
          // Only lands on the surface, and only when falling onto it from above.
          if (p.vy >= 0 && prevFeet <= top + 1 && p.y > top) {
            p.y = top; p.vy = 0; p.grounded = true;
            b = playerBox(p);
            y0 = Math.floor(b.y / TILE); y1 = Math.floor((b.y + b.h - 0.01) / TILE);
          }
          continue;
        }
        if (!isSolidTile(ch)) continue;

        if (p.vy > 0) { p.y = top; p.grounded = true; }
        else if (p.vy < 0) { p.y = (ty + 1) * TILE + PH; }
        else continue;
        p.vy = 0;
        b = playerBox(p);
        y0 = Math.floor(b.y / TILE); y1 = Math.floor((b.y + b.h - 0.01) / TILE);
      }
    }

    for (var i = 0; i < solids.length; i++) {
      var r = solids[i];
      b = playerBox(p);
      // Mirror of the inset above: brushing a platform's side by a pixel while
      // running past it must not launch the player on top of it.
      var stand = { x: b.x + SKIN_X, y: b.y, w: b.w - SKIN_X * 2, h: b.h };
      if (!overlaps(stand, r)) continue;
      var fromTop = (b.y + b.h) - r.y;
      var fromBottom = (r.y + r.h) - b.y;
      if (fromTop < fromBottom) {
        p.y -= fromTop;
        if (p.vy > 0) { p.grounded = true; if (r.mover) p.riding = r.mover; }
        p.vy = Math.min(p.vy, 0);
      } else {
        // Pushing down is only valid if there is somewhere to go. A platform
        // descending onto a player standing on solid ground would otherwise
        // grind them into the floor, so carry them on top of it instead.
        var savedY = p.y;
        p.y += fromBottom;
        if (embeddedInSolid(p, world)) {
          p.y = savedY - fromTop;
          p.grounded = true;
          if (r.mover) p.riding = r.mover;
          p.vy = Math.min(p.vy, 0);
        } else {
          p.vy = Math.max(p.vy, 0);
        }
      }
    }
  }

  /* Standing *on* a mover is resolved a frame late by the AABB pass alone, which
     looks like sliding. Re-check contact explicitly and remember what we ride. */
  function findRide(p, solids) {
    var feet = { x: p.x - PW / 2 + SKIN_X, y: p.y - 1, w: PW - SKIN_X * 2, h: 4 };
    for (var i = 0; i < solids.length; i++) {
      var r = solids[i];
      if (!r.mover) continue;
      if (overlaps(feet, r)) return r.mover;
    }
    return null;
  }

  function hitsHazard(p, world) {
    var b = playerBox(p);
    if (b.y > world.h + 120) return true;
    var x0 = Math.floor((b.x + 3) / TILE), x1 = Math.floor((b.x + b.w - 3.01) / TILE);
    var y0 = Math.floor((b.y + 6) / TILE), y1 = Math.floor((b.y + b.h - 0.01) / TILE);
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (isSpikeTile(tileAt(world, tx, ty))) return true;
      }
    }
    return false;
  }

  function updatePlayer(p, input, world, solids, dt) {
    var prevFeet = p.y;
    p.wasGrounded = p.grounded;

    // Ride whatever platform we were standing on before anything else moves.
    if (p.riding) { p.x += p.riding.dx; p.y += p.riding.dy; }

    var dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    var accel = p.grounded ? RUN_ACCEL : AIR_ACCEL;

    if (dir !== 0) {
      p.vx = approach(p.vx, dir * RUN_SPEED, accel * dt);
      p.face = dir;
    } else {
      p.vx = approach(p.vx, 0, (p.grounded ? GROUND_DRAG : AIR_DRAG) * dt);
    }

    // Jump: coyote time forgives leaving a ledge, buffering forgives early presses.
    p.coyote = p.grounded ? COYOTE_TIME : Math.max(0, p.coyote - dt);
    p.buffer = input.jump && !p.jumpHeld ? JUMP_BUFFER : Math.max(0, p.buffer - dt);

    if (p.buffer > 0 && p.coyote > 0) {
      p.vy = -JUMP_VEL;
      p.buffer = 0;
      p.coyote = 0;
      p.grounded = false;
      p.riding = null;
      p.squash = -0.35;
      if (p.local) Sfx.jump();
    }
    // Releasing jump early clips the arc once, rather than decaying per step.
    if (!input.jump && p.vy < -JUMP_VEL * JUMP_CUT) p.vy = -JUMP_VEL * JUMP_CUT;
    p.jumpHeld = input.jump;

    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);

    p.x += p.vx * dt;
    resolveX(p, world, solids);
    p.y += p.vy * dt;
    resolveY(p, world, solids, prevFeet);

    p.riding = p.grounded ? findRide(p, solids) : null;

    // Keep inside the level horizontally.
    p.x = clamp(p.x, PW / 2, world.w - PW / 2);

    if (p.grounded && !p.wasGrounded) {
      p.squash = 0.4;
      if (p.local) Sfx.land();
    }
    p.squash = damp(p.squash, 0, 11, dt);
    p.respawnFlash = Math.max(0, p.respawnFlash - dt);

    if (!p.grounded) p.anim = p.vy < 0 ? 'jump' : 'fall';
    else p.anim = Math.abs(p.vx) > 18 ? 'run' : 'idle';
    p.animT += dt * (p.anim === 'run' ? Math.abs(p.vx) / 34 : 3.2);
  }

  /* ------------------------------------------------------------------ *
   * Networking (PeerJS)
   *
   * Message shapes — kept short because they go out 20x/second:
   *   {t:'hi'}                     handshake
   *   {t:'p', x,y,vx,vy,f,a,g}     a peer's own avatar
   *   {t:'w', ...}                 host -> guest world snapshot
   *   {t:'lv', i}                  guest -> host "I pulled lever i"
   *   {t:'go', i}                  host -> guest load stage i
   *   {t:'rs'}                     guest -> host restart request
   *   {t:'dead'}                   cosmetic: the sender respawned
   *   {t:'ping'/'pong', s}         round-trip time
   * ------------------------------------------------------------------ */

  var Net = {
    peer: null,
    conn: null,
    role: 'local',        // 'host' | 'guest' | 'local'
    code: '',
    connected: false,
    ping: 0,
    lastRecv: 0,
    onMessage: null,
    onOpen: null,
    onClose: null,
    onError: null,

    available: function () { return typeof window.Peer === 'function'; },

    _peerOptions: function () {
      return { debug: 0 };
    },

    host: function (code) {
      var self = this;
      this.role = 'host';
      this.code = code;
      this.peer = new window.Peer(PEER_PREFIX + code, this._peerOptions());

      this.peer.on('open', function () { if (self.onOpen) self.onOpen(code); });
      this.peer.on('connection', function (conn) {
        // One partner at a time; politely turn away extra joiners.
        if (self.conn && self.conn.open) { conn.on('open', function () { conn.close(); }); return; }
        self._attach(conn);
      });
      this.peer.on('error', function (err) { self._error(err); });
      this.peer.on('disconnected', function () { try { self.peer.reconnect(); } catch (e) {} });
    },

    join: function (code) {
      var self = this;
      this.role = 'guest';
      this.code = code;
      this.peer = new window.Peer(this._peerOptions());

      this.peer.on('open', function () {
        var conn = self.peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        self._attach(conn);
        // PeerJS never errors on "host not listening"; time it out ourselves.
        setTimeout(function () {
          if (!self.connected) self._error({ type: 'peer-unavailable' });
        }, 15000);
      });
      this.peer.on('error', function (err) { self._error(err); });
      this.peer.on('disconnected', function () { try { self.peer.reconnect(); } catch (e) {} });
    },

    _attach: function (conn) {
      var self = this;
      this.conn = conn;

      conn.on('open', function () {
        self.connected = true;
        self.lastRecv = performance.now();
        self.send({ t: 'hi', role: self.role });
        if (self.onConnect) self.onConnect();
      });

      conn.on('data', function (msg) {
        self.lastRecv = performance.now();
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'ping') { self.send({ t: 'pong', s: msg.s }); return; }
        if (msg.t === 'pong') { self.ping = Math.round(performance.now() - msg.s); return; }
        if (self.onMessage) self.onMessage(msg);
      });

      conn.on('close', function () {
        self.connected = false;
        if (self.onClose) self.onClose();
      });

      conn.on('error', function (err) { self._error(err); });
    },

    _error: function (err) {
      if (this.onError) this.onError(err);
    },

    send: function (msg) {
      if (this.conn && this.conn.open) {
        try { this.conn.send(msg); } catch (e) { /* channel closing — drop it */ }
      }
    },

    measurePing: function () {
      this.send({ t: 'ping', s: performance.now() });
    },

    destroy: function () {
      this.connected = false;
      try { if (this.conn) this.conn.close(); } catch (e) {}
      try { if (this.peer) this.peer.destroy(); } catch (e) {}
      this.conn = null;
      this.peer = null;
      this.role = 'local';
      this.code = '';
      this.ping = 0;
    }
  };

  /* ------------------------------------------------------------------ *
   * Input
   *
   * Online, both key schemes drive the one local avatar, so a player can use
   * whichever half of the keyboard they prefer. In local co-op they are split.
   * ------------------------------------------------------------------ */

  var keys = Object.create(null);

  var SCHEME_1 = { left: ['KeyA'], right: ['KeyD'], jump: ['KeyW', 'Space'], use: ['KeyE'] };
  var SCHEME_2 = { left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['ArrowUp'], use: ['Slash', 'ShiftRight', 'Period'] };
  var SCHEME_BOTH = {
    left:  SCHEME_1.left.concat(SCHEME_2.left),
    right: SCHEME_1.right.concat(SCHEME_2.right),
    jump:  SCHEME_1.jump.concat(SCHEME_2.jump),
    use:   SCHEME_1.use.concat(SCHEME_2.use)
  };

  var touchState = { left: false, right: false, jump: false, use: false };
  var touchActive = false;

  function heldAny(codes) {
    for (var i = 0; i < codes.length; i++) if (keys[codes[i]]) return true;
    return false;
  }

  /* `use` is edge-triggered: holding E must not spam a lever. */
  var usePrev = { s1: false, s2: false };

  function readInput(scheme, slot, withTouch) {
    var useNow = heldAny(scheme.use) || (withTouch && touchState.use);
    var pressed = useNow && !usePrev[slot];
    usePrev[slot] = useNow;
    return {
      left:  heldAny(scheme.left)  || (withTouch && touchState.left),
      right: heldAny(scheme.right) || (withTouch && touchState.right),
      jump:  heldAny(scheme.jump)  || (withTouch && touchState.jump),
      usePressed: pressed
    };
  }

  var PREVENT = {
    ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Space: 1, Slash: 1
  };

  window.addEventListener('keydown', function (e) {
    if (e.repeat) { if (PREVENT[e.code]) e.preventDefault(); return; }
    keys[e.code] = true;
    if (PREVENT[e.code]) e.preventDefault();
    Sfx.unlock();
    if (e.code === 'KeyR' && Game.running) Game.requestRestart();
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  window.addEventListener('blur', function () { keys = Object.create(null); });

  function bindTouch() {
    $$('#touch .tbtn').forEach(function (btn) {
      var act = btn.dataset.act;
      var set = function (on) {
        return function (ev) {
          ev.preventDefault();
          touchState[act] = on;
          btn.classList.toggle('pressed', on);
          if (on) Sfx.unlock();
        };
      };
      btn.addEventListener('pointerdown', set(true));
      btn.addEventListener('pointerup', set(false));
      btn.addEventListener('pointercancel', set(false));
      btn.addEventListener('pointerleave', set(false));
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });

    function enableTouchUI() {
      if (touchActive) return;
      touchActive = true;
      if (Game.running) show($('#touch'), true);
    }
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) enableTouchUI();
    window.addEventListener('touchstart', enableTouchUI, { once: true, passive: true });
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  var canvas = $('#game');
  var ctx = canvas.getContext('2d');
  var dpr = 1;

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(VIEW_W * dpr);
    canvas.height = Math.round(VIEW_H * dpr);

    var stage = $('#stage');
    var availW = stage.clientWidth;
    var availH = stage.clientHeight;
    var scale = Math.min(availW / VIEW_W, availH / VIEW_H);
    canvas.style.width = Math.floor(VIEW_W * scale) + 'px';
    canvas.style.height = Math.floor(VIEW_H * scale) + 'px';

    // Publish where the letterboxed canvas actually sits so the HUD can tuck the
    // objective directly beneath it in portrait, instead of colliding with the
    // touch controls pinned to the bottom of the screen.
    if (canvas.getBoundingClientRect && stage.getBoundingClientRect) {
      var cRect = canvas.getBoundingClientRect();
      var sRect = stage.getBoundingClientRect();
      var root = document.documentElement;
      if (root && root.style && root.style.setProperty) {
        root.style.setProperty('--canvas-top', (cRect.top - sRect.top) + 'px');
        root.style.setProperty('--canvas-bottom', (cRect.bottom - sRect.top) + 'px');
      }
    }
  }
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', function () { setTimeout(resizeCanvas, 200); });

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  var cam = { x: 480, y: 240, zoom: 1.2, shake: 0 };

  function updateCamera(world, players, dt, snap) {
    var pts = players.filter(function (p) { return p.present; });
    if (!pts.length) return;

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(function (p) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });

    var minZoom = Math.max(VIEW_W / world.w, VIEW_H / world.h);
    var spreadW = (maxX - minX) + 460;
    var spreadH = (maxY - minY) + 320;
    var wantZoom = clamp(Math.min(VIEW_W / spreadW, VIEW_H / spreadH), minZoom, 1.55);

    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2 - 24;

    var halfW = VIEW_W / (2 * wantZoom);
    var halfH = VIEW_H / (2 * wantZoom);
    cx = clamp(cx, halfW, Math.max(halfW, world.w - halfW));
    cy = clamp(cy, halfH, Math.max(halfH, world.h - halfH));

    if (snap) { cam.x = cx; cam.y = cy; cam.zoom = wantZoom; }
    else {
      cam.x = damp(cam.x, cx, 7, dt);
      cam.y = damp(cam.y, cy, 6, dt);
      cam.zoom = damp(cam.zoom, wantZoom, 4, dt);
    }
    cam.shake = Math.max(0, cam.shake - dt * 2.2);
  }

  /* --- background: layered parallax drawn in screen space --- */

  function drawBackground(world, time) {
    var g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#131c33');
    g.addColorStop(0.55, '#1b2542');
    g.addColorStop(1, '#26304d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Distant sun glow
    var glow = ctx.createRadialGradient(VIEW_W * 0.72, VIEW_H * 0.22, 10, VIEW_W * 0.72, VIEW_H * 0.22, 300);
    glow.addColorStop(0, 'rgba(245,181,68,0.24)');
    glow.addColorStop(1, 'rgba(245,181,68,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Two ridges of ruins at different parallax depths
    var layers = [
      { depth: 0.14, y: VIEW_H * 0.62, h: 150, color: 'rgba(20,28,50,0.85)', step: 190 },
      { depth: 0.30, y: VIEW_H * 0.74, h: 190, color: 'rgba(15,21,39,0.9)', step: 130 }
    ];

    layers.forEach(function (L, li) {
      var off = -cam.x * L.depth;
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(0, VIEW_H);
      for (var i = -2; i < VIEW_W / L.step + 3; i++) {
        var bx = i * L.step + (off % L.step);
        var seed = Math.sin((i + li * 7.3) * 12.9898) * 43758.5453;
        var hh = L.h * (0.55 + (seed - Math.floor(seed)) * 0.75);
        ctx.rect(bx, L.y + (L.h - hh), L.step * 0.72, hh + 200);
      }
      ctx.fill();

      // Columns sitting on the ridge
      ctx.fillStyle = li === 0 ? 'rgba(26,35,60,0.8)' : 'rgba(12,18,34,0.9)';
      for (var j = -1; j < VIEW_W / (L.step * 2) + 2; j++) {
        var cxp = j * L.step * 2 + ((off * 1.15) % (L.step * 2));
        ctx.fillRect(cxp, L.y - 54, 16, 56);
        ctx.fillRect(cxp - 5, L.y - 62, 26, 9);
      }
    });

    // Drifting motes
    ctx.fillStyle = 'rgba(245,214,160,0.20)';
    for (var k = 0; k < 26; k++) {
      var fx = ((k * 137.5 + time * (9 + (k % 5) * 4) - cam.x * 0.06) % (VIEW_W + 60)) - 30;
      var fy = (Math.sin(time * 0.5 + k) * 26) + ((k * 83) % VIEW_H);
      ctx.fillRect(fx, fy, 2, 2);
    }
  }

  /* --- tiles --- */

  function drawTiles(world, time) {
    var x0 = Math.max(0, Math.floor((cam.x - VIEW_W / (2 * cam.zoom)) / TILE) - 1);
    var x1 = Math.min(world.cols - 1, Math.ceil((cam.x + VIEW_W / (2 * cam.zoom)) / TILE) + 1);
    var y0 = Math.max(0, Math.floor((cam.y - VIEW_H / (2 * cam.zoom)) / TILE) - 1);
    var y1 = Math.min(world.lines - 1, Math.ceil((cam.y + VIEW_H / (2 * cam.zoom)) / TILE) + 1);

    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        var ch = tileAt(world, tx, ty);
        var px = tx * TILE, py = ty * TILE;

        if (isSolidTile(ch)) {
          var openAbove = !isSolidTile(tileAt(world, tx, ty - 1));
          var g = ctx.createLinearGradient(0, py, 0, py + TILE);
          g.addColorStop(0, openAbove ? '#4a5f7e' : '#33415a');
          g.addColorStop(1, '#232e44');
          ctx.fillStyle = g;
          ctx.fillRect(px, py, TILE, TILE);

          ctx.strokeStyle = 'rgba(10,14,24,0.55)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);

          if (openAbove) {
            // Mossy cap on exposed surfaces
            ctx.fillStyle = 'rgba(120,190,140,0.55)';
            ctx.fillRect(px, py, TILE, 4);
            ctx.fillStyle = 'rgba(160,220,175,0.35)';
            ctx.fillRect(px, py, TILE, 1.5);
          }
          // A couple of carved specks so big walls are not flat
          ctx.fillStyle = 'rgba(255,255,255,0.045)';
          ctx.fillRect(px + 6 + ((tx * 7) % 12), py + 9 + ((ty * 5) % 12), 5, 3);

        } else if (isOneWayTile(ch)) {
          ctx.fillStyle = '#6b5136';
          roundRect(ctx, px, py, TILE, 9, 3);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,220,170,0.25)';
          ctx.fillRect(px + 2, py + 1, TILE - 4, 2);

        } else if (isSpikeTile(ch)) {
          ctx.fillStyle = '#1a2233';
          ctx.fillRect(px, py, TILE, TILE);
          var spikes = 3;
          var sw = TILE / spikes;
          for (var s = 0; s < spikes; s++) {
            var sx = px + s * sw;
            var grad = ctx.createLinearGradient(0, py + 4, 0, py + TILE);
            grad.addColorStop(0, '#f07a86');
            grad.addColorStop(1, '#8c2f3d');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(sx + 1, py + TILE);
            ctx.lineTo(sx + sw / 2, py + 3 + Math.sin(time * 3 + s) * 0.6);
            ctx.lineTo(sx + sw - 1, py + TILE);
            ctx.closePath();
            ctx.fill();
          }
        }
      }
    }
  }

  /* --- puzzle props --- */

  function drawPlate(p) {
    var r = p.rect;
    var drop = p.anim * 5;
    ctx.fillStyle = 'rgba(8,12,20,0.5)';
    roundRect(ctx, r.x - 4, r.y + r.h - 3, r.w + 8, 5, 2); ctx.fill();

    var g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, p.pressed ? '#f5b544' : '#8fa2c0');
    g.addColorStop(1, p.pressed ? '#a9761f' : '#4e5f7d');
    ctx.fillStyle = g;
    roundRect(ctx, r.x, r.y + drop, r.w, r.h - drop, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,24,0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (p.anim > 0.05) {
      ctx.fillStyle = 'rgba(245,181,68,' + (0.3 * p.anim) + ')';
      roundRect(ctx, r.x - 6, r.y - 4 + drop, r.w + 12, r.h + 6 - drop, 5);
      ctx.fill();
    }
  }

  function drawLever(l) {
    var baseY = l.y;
    // Post
    ctx.fillStyle = '#3a4761';
    roundRect(ctx, l.x - 4, baseY - 34, 8, 34, 3); ctx.fill();
    ctx.fillStyle = '#26314a';
    roundRect(ctx, l.x - 11, baseY - 6, 22, 6, 3); ctx.fill();

    // Handle rotates from -40deg (off) to +40deg (on)
    var ang = lerp(-0.7, 0.7, l.anim);
    ctx.save();
    ctx.translate(l.x, baseY - 32);
    ctx.rotate(ang);
    ctx.strokeStyle = '#cdd7ea';
    ctx.lineCap = 'round';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -20);
    ctx.stroke();
    ctx.fillStyle = l.on ? '#5fd4a0' : '#e2565f';
    ctx.beginPath();
    ctx.arc(0, -22, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Glow when on
    if (l.anim > 0.05) {
      var gl = ctx.createRadialGradient(l.x, baseY - 50, 2, l.x, baseY - 50, 30);
      gl.addColorStop(0, 'rgba(95,212,160,' + (0.35 * l.anim) + ')');
      gl.addColorStop(1, 'rgba(95,212,160,0)');
      ctx.fillStyle = gl;
      ctx.fillRect(l.x - 32, baseY - 82, 64, 64);
    }
  }

  function drawBlocker(b, time) {
    var f = b.full;
    if (b.kind === 'gate') {
      var h = f.h * (1 - b.anim);
      if (h <= 0.5) return;
      var g = ctx.createLinearGradient(f.x, 0, f.x + f.w, 0);
      g.addColorStop(0, '#5b6a88');
      g.addColorStop(0.45, '#8b9cbb');
      g.addColorStop(1, '#46546f');
      ctx.fillStyle = g;
      ctx.fillRect(f.x + 2, f.y, f.w - 4, h);
      ctx.strokeStyle = 'rgba(10,14,24,0.6)';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(f.x + 2.5, f.y + 0.5, f.w - 5, h - 1);
      // Rivet bands
      ctx.fillStyle = 'rgba(20,26,42,0.7)';
      for (var y = f.y + 8; y < f.y + h - 4; y += 16) ctx.fillRect(f.x + 3, y, f.w - 6, 3);
    } else {
      var alpha = 1 - b.anim;
      if (alpha <= 0.02) return;
      var pulse = 0.72 + Math.sin(time * 5) * 0.12;
      var bg = ctx.createLinearGradient(f.x, 0, f.x + f.w, 0);
      bg.addColorStop(0, 'rgba(120,200,255,' + (0.1 * alpha) + ')');
      bg.addColorStop(0.5, 'rgba(150,225,255,' + (0.42 * alpha * pulse) + ')');
      bg.addColorStop(1, 'rgba(120,200,255,' + (0.1 * alpha) + ')');
      ctx.fillStyle = bg;
      ctx.fillRect(f.x, f.y, f.w, f.h);

      ctx.strokeStyle = 'rgba(180,235,255,' + (0.8 * alpha) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i < 3; i++) {
        var xx = f.x + f.w * (0.25 + i * 0.25);
        ctx.moveTo(xx, f.y);
        for (var yy = f.y; yy <= f.y + f.h; yy += 7) {
          ctx.lineTo(xx + Math.sin(yy * 0.22 + time * 6 + i) * 3.5, yy);
        }
      }
      ctx.stroke();

      // Emitters top and bottom
      ctx.fillStyle = 'rgba(60,90,130,' + Math.max(0.35, alpha) + ')';
      roundRect(ctx, f.x - 2, f.y - 6, f.w + 4, 8, 3); ctx.fill();
      roundRect(ctx, f.x - 2, f.y + f.h - 2, f.w + 4, 8, 3); ctx.fill();
    }
  }

  function drawMover(m, active) {
    var g = ctx.createLinearGradient(0, m.y, 0, m.y + m.h);
    g.addColorStop(0, '#8a6a44');
    g.addColorStop(1, '#4d3a24');
    ctx.fillStyle = g;
    roundRect(ctx, m.x, m.y, m.w, m.h, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,24,0.55)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,226,180,0.28)';
    ctx.fillRect(m.x + 3, m.y + 2, m.w - 6, 2);

    // Plank seams
    ctx.strokeStyle = 'rgba(30,20,12,0.35)';
    ctx.lineWidth = 1;
    for (var x = m.x + TILE; x < m.x + m.w - 2; x += TILE) {
      ctx.beginPath(); ctx.moveTo(x, m.y + 3); ctx.lineTo(x, m.y + m.h - 3); ctx.stroke();
    }

    // Running lights so it is obvious when a platform is powered
    ctx.fillStyle = active ? '#5fd4a0' : '#5b6a88';
    ctx.beginPath(); ctx.arc(m.x + 6, m.y + m.h / 2, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(m.x + m.w - 6, m.y + m.h / 2, 2.4, 0, Math.PI * 2); ctx.fill();
  }

  function drawExit(world, time, insideCount) {
    var e = world.exit;
    var cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    var charge = world.exitHold / EXIT_HOLD;

    // Frame
    ctx.fillStyle = '#2b3550';
    roundRect(ctx, e.x - 6, e.y - 6, e.w + 12, e.h + 12, 10);
    ctx.fill();
    ctx.strokeStyle = '#46557a';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Portal field
    var pg = ctx.createRadialGradient(cx, cy, 3, cx, cy, e.w / 2);
    var warm = insideCount >= 2;
    pg.addColorStop(0, warm ? 'rgba(255,236,180,0.95)' : 'rgba(150,220,255,0.85)');
    pg.addColorStop(0.6, warm ? 'rgba(245,181,68,0.45)' : 'rgba(90,160,220,0.35)');
    pg.addColorStop(1, 'rgba(20,30,50,0)');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(cx, cy, e.w / 2, 0, Math.PI * 2);
    ctx.fill();

    // Orbiting rings
    ctx.save();
    ctx.translate(cx, cy);
    for (var i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate(time * (0.6 + i * 0.35) * (i % 2 ? -1 : 1));
      ctx.strokeStyle = 'rgba(220,240,255,' + (0.28 + 0.12 * i) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, 20 + i * 5, 26 - i * 4, 0, 0, Math.PI * 1.5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // Charge arc while both players stand inside
    if (charge > 0.01) {
      ctx.strokeStyle = '#f5b544';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, e.w / 2 + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge);
      ctx.stroke();
    }

    // Two lamps: one per player, lit when that player is in the portal
    for (var k = 0; k < 2; k++) {
      var lx = cx - 11 + k * 22;
      var lit = insideCount > k;
      ctx.fillStyle = lit ? (k === 0 ? '#5fd4a0' : '#e2565f') : 'rgba(120,135,165,0.45)';
      ctx.beginPath();
      ctx.arc(lx, e.y + e.h + 12, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* --- characters, drawn entirely from primitives --- */

  var THEMES = {
    p1: {                       // Rami — athletic explorer, dark hair and beard
      skin: '#c98d5f', skinDark: '#a9713f',
      hair: '#221913', beard: '#3d2c20',
      cloth: '#3e8f64', clothDark: '#2c6b4a',
      trim: '#e2c178', belt: '#7a4a24',
      boot: '#4b3018', accent: '#5fd4a0'
    },
    p2: {                       // Layla — agile explorer in a red hooded headscarf
      skin: '#dba372', skinDark: '#b8794a',
      hair: '#2a1d16', beard: null,
      cloth: '#c79a63', clothDark: '#9d7244',
      trim: '#f0d6a8', belt: '#6d4426',
      boot: '#51331b', accent: '#e2565f',
      hood: '#d2454f', hoodDark: '#9e2d38'
    }
  };

  function drawExplorer(p, time) {
    var th = THEMES[p.kind];
    var sq = p.squash;                       // >0 squashed on landing, <0 stretched on jump
    var sx = 1 + sq * 0.35;
    var sy = 1 - sq * 0.35;

    var walk = p.anim === 'run' ? Math.sin(p.animT) : 0;
    var walkB = p.anim === 'run' ? Math.sin(p.animT + Math.PI) : 0;
    var bob = p.anim === 'idle' ? Math.sin(time * 2.4) * 0.8 : 0;
    var airborne = p.anim === 'jump' || p.anim === 'fall';

    ctx.save();
    ctx.translate(p.x, p.y);

    // Contact shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 12 * sx, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();

    if (p.respawnFlash > 0 && Math.floor(p.respawnFlash * 14) % 2 === 0) {
      ctx.globalAlpha = 0.45;
    }

    ctx.scale(sx, sy);
    ctx.translate(0, bob);
    ctx.scale(p.face, 1);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    var OUTLINE = 'rgba(14,18,28,0.85)';

    function limb(x1, y1, x2, y2, width, color) {
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = width + 2.4;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // ---- back limbs ----
    var legSwing = airborne ? (p.anim === 'jump' ? -4 : 3) : walkB * 6;
    limb(-1, -13, -1 + legSwing, -1, 5, th.clothDark);          // back leg
    limb(-2, -21, -2 - (airborne ? 6 : walkB * 7), -13, 4.5, th.clothDark); // back arm

    // ---- torso ----
    ctx.fillStyle = OUTLINE;
    roundRect(ctx, -8.2, -25.2, 16.4, 14.4, 5.4); ctx.fill();
    var tg = ctx.createLinearGradient(0, -25, 0, -11);
    tg.addColorStop(0, th.cloth);
    tg.addColorStop(1, th.clothDark);
    ctx.fillStyle = tg;
    roundRect(ctx, -7, -24, 14, 12, 4.6); ctx.fill();

    // Tunic trim + belt
    ctx.fillStyle = th.trim;
    ctx.fillRect(-1.2, -24, 2.4, 10);
    ctx.fillStyle = th.belt;
    roundRect(ctx, -7.4, -15.6, 14.8, 3.6, 1.6); ctx.fill();
    ctx.fillStyle = th.trim;
    roundRect(ctx, -1.8, -15.4, 3.6, 3.2, 1); ctx.fill();

    // Satchel strap
    ctx.strokeStyle = 'rgba(90,60,32,0.9)';
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(-6, -23); ctx.lineTo(5, -14); ctx.stroke();

    // ---- front leg ----
    var frontSwing = airborne ? (p.anim === 'jump' ? 5 : -3) : walk * 6;
    limb(2, -13, 2 + frontSwing, -1, 5.4, th.cloth);
    ctx.fillStyle = th.boot;
    roundRect(ctx, 2 + frontSwing - 3.6, -3, 7.6, 3.4, 1.6); ctx.fill();
    ctx.fillStyle = th.boot;
    roundRect(ctx, -1 + legSwing - 3.4, -3, 7.2, 3.2, 1.6); ctx.fill();

    // ---- head ----
    var headY = -32;
    ctx.fillStyle = OUTLINE;
    ctx.beginPath(); ctx.arc(0.6, headY, 8.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = th.skin;
    ctx.beginPath(); ctx.arc(0.6, headY, 7, 0, Math.PI * 2); ctx.fill();

    if (p.kind === 'p1') {
      // Dark swept hair
      ctx.fillStyle = th.hair;
      ctx.beginPath();
      ctx.arc(0.6, headY - 0.6, 7.2, Math.PI * 1.03, Math.PI * 2.06);
      ctx.lineTo(6.5, headY - 2);
      ctx.closePath();
      ctx.fill();
      // Beard
      ctx.fillStyle = th.beard;
      ctx.beginPath();
      ctx.arc(1.2, headY + 3.1, 6.1, 0.12, Math.PI - 0.12);
      ctx.closePath();
      ctx.fill();
      // Eye. No brow: at this scale it merges with the eye into a dark bar, and
      // the hairline already reads as the top of the face.
      ctx.fillStyle = '#15202e';
      ctx.beginPath(); ctx.arc(4.2, headY - 1.2, 1.2, 0, Math.PI * 2); ctx.fill();
    } else {
      // Red hooded headscarf. The hood is built as two crescent bands around the
      // head - one over the crown and back, one wrapping under the chin - so the
      // face stays framed instead of being covered by a flat shape.
      ctx.fillStyle = th.hoodDark;                 // drape falling behind the shoulder
      ctx.beginPath();
      ctx.moveTo(-3, headY - 5);
      ctx.quadraticCurveTo(-11.5, headY + 3, -7, headY + 13);
      ctx.quadraticCurveTo(-2.5, headY + 11, -1.5, headY + 4);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = th.hood;                     // crown and back
      ctx.beginPath();
      ctx.arc(0.6, headY, 8.8, Math.PI * 0.56, Math.PI * 1.94);
      ctx.arc(0.6, headY, 5.1, Math.PI * 1.94, Math.PI * 0.56, true);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = th.hoodDark;                 // wrap under the chin
      ctx.beginPath();
      ctx.arc(0.6, headY, 8.3, Math.PI * 0.30, Math.PI * 0.80);
      ctx.arc(0.6, headY, 4.5, Math.PI * 0.80, Math.PI * 0.30, true);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(14,18,28,0.55)';     // crisp outline around the hood
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(0.6, headY, 8.8, Math.PI * 0.56, Math.PI * 1.94);
      ctx.stroke();

      ctx.fillStyle = '#15202e';                   // eye and brow
      ctx.beginPath(); ctx.arc(3.9, headY - 0.8, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#15202e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(2.4, headY - 3.4); ctx.lineTo(5.2, headY - 2.8);
      ctx.stroke();
    }

    // ---- front arm (drawn last so it reads in front of the torso) ----
    var armSwing = airborne ? -7 : walk * 7;
    limb(2, -21, 2 + armSwing, -13, 4.8, th.cloth);
    ctx.fillStyle = th.skin;
    ctx.beginPath(); ctx.arc(2 + armSwing, -12.4, 2.4, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  /* Name tag + "this one is you" marker, drawn unscaled above the head. */
  function drawPlayerTag(p, label, isLocal) {
    ctx.save();
    ctx.translate(p.x, p.y - 60);
    if (isLocal) {
      var bob = Math.sin(performance.now() / 300) * 2;
      ctx.fillStyle = THEMES[p.kind].accent;
      ctx.beginPath();
      ctx.moveTo(0, -4 + bob);
      ctx.lineTo(-5, -12 + bob);
      ctx.lineTo(5, -12 + bob);
      ctx.closePath();
      ctx.fill();
    }
    ctx.font = '600 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var w = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(8,12,20,0.6)';
    roundRect(ctx, -w / 2, -1, w, 12, 6); ctx.fill();
    ctx.fillStyle = THEMES[p.kind].accent;
    ctx.fillText(label, 0, 5.5);
    ctx.restore();
  }

  /* --- particles --- */

  var particles = [];

  function burst(x, y, count, color, power, spread) {
    for (var i = 0; i < count; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * (spread || Math.PI * 2);
      var s = power * (0.4 + Math.random() * 0.8);
      particles.push({
        x: x, y: y,
        vx: Math.cos(a) * s + (Math.random() - 0.5) * 30,
        vy: Math.sin(a) * s,
        life: 0.4 + Math.random() * 0.5,
        max: 0.9,
        color: color,
        size: 1.6 + Math.random() * 2.2
      });
    }
    if (particles.length > 260) particles.splice(0, particles.length - 260);
  }

  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var q = particles[i];
      q.life -= dt;
      if (q.life <= 0) { particles.splice(i, 1); continue; }
      q.vy += 620 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
  }

  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i];
      ctx.globalAlpha = clamp(q.life / q.max, 0, 1);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ *
   * Game controller
   * ------------------------------------------------------------------ */

  var Game = {
    running: false,
    mode: 'local',            // 'local' | 'online'
    myIndex: 0,               // 0 = P1 (host), 1 = P2 (guest)
    world: null,
    players: [makePlayer('p1'), makePlayer('p2')],
    netAcc: 0,
    pingAcc: 0,
    clearTimer: 0,
    bannerTimer: 0,
    time: 0,

    get isHost() { return this.mode === 'local' || Net.role === 'host'; },
    get local() { return this.players[this.myIndex]; },
    get remote() { return this.players[1 - this.myIndex]; },

    /* -------------------------------------------------- start / stop */

    start: function (mode, myIndex) {
      this.mode = mode;
      this.myIndex = myIndex || 0;
      this.running = true;
      this.time = 0;
      particles.length = 0;

      this.players[0].local = (mode === 'local') || this.myIndex === 0;
      this.players[1].local = (mode === 'local') || this.myIndex === 1;
      this.players[0].present = (mode === 'local') || Net.connected || this.myIndex === 0;
      this.players[1].present = (mode === 'local') || Net.connected || this.myIndex === 1;

      this.loadLevel(0, true);

      show($('#overlay'), false);
      show($('#hud'), true);
      show($('#touch'), touchActive);
      UI.refreshChips();
      resizeCanvas();
    },

    stop: function () {
      this.running = false;
      Net.destroy();
      show($('#hud'), false);
      show($('#touch'), false);
      show($('#overlay'), true);
      UI.setNet('idle');
    },

    loadLevel: function (index, snap) {
      index = clamp(index, 0, LEVELS.length - 1);
      this.world = buildWorld(index);
      this.clearTimer = 0;
      placeAtSpawn(this.players[0], this.world, 'p1');
      placeAtSpawn(this.players[1], this.world, 'p2');
      particles.length = 0;
      updateMovers(this.world, 0, false);
      updateCamera(this.world, this.players, 0, true);
      if (snap) { /* camera already snapped */ }
      $('#stage-name').textContent = 'Stage ' + (index + 1) + ' of ' + LEVELS.length + ' — ' + this.world.def.name;
      $('#objective').textContent = this.world.def.objective;
    },

    requestRestart: function () {
      if (this.isHost) {
        this.loadLevel(this.world.index, true);
        Net.send({ t: 'go', i: this.world.index });
        UI.banner('Stage reset', 0.9);
      } else {
        Net.send({ t: 'rs' });
      }
    },

    /* -------------------------------------------------- puzzle logic */

    /* Plates are driven by whichever bodies are actually in the world: the host
       sees both, a guest predicts with the interpolated remote so its own view
       stays responsive between snapshots. */
    updatePlates: function () {
      var w = this.world;
      for (var i = 0; i < w.plates.length; i++) {
        var plate = w.plates[i];
        var was = plate.pressed;
        var now = false;
        for (var j = 0; j < this.players.length; j++) {
          var p = this.players[j];
          if (!p.present) continue;
          var feet = { x: p.x - PW / 2, y: p.y - 6, w: PW, h: 10 };
          if (overlaps(feet, { x: plate.rect.x - 2, y: plate.rect.y - 6, w: plate.rect.w + 4, h: plate.rect.h + 8 })) {
            now = true;
            break;
          }
        }
        plate.pressed = now;
        if (now !== was) {
          Sfx.plate(now);
          burst(plate.rect.x + plate.rect.w / 2, plate.rect.y, 6, now ? '#f5b544' : '#8fa2c0', 90, Math.PI);
        }
      }
    },

    updateBlockers: function () {
      var w = this.world;
      for (var i = 0; i < w.blockers.length; i++) {
        var b = w.blockers[i];
        var open = anyActive(w, b.openWhen);
        if (open !== b.open) {
          b.open = open;
          Sfx.door();
          var r = b.full;
          burst(r.x + r.w / 2, r.y + r.h / 2, 10, b.kind === 'gate' ? '#8b9cbb' : '#96e1ff', 120);
          cam.shake = Math.min(1, cam.shake + 0.35);
        }
      }
    },

    tryInteract: function (p) {
      var w = this.world;
      var best = null, bestD = INTERACT_RANGE;
      for (var i = 0; i < w.levers.length; i++) {
        var l = w.levers[i];
        var d = Math.hypot(l.x - p.x, (l.y - 20) - (p.y - 15));
        if (d < bestD) { bestD = d; best = l; }
      }
      if (!best) return;
      this.toggleLever(best.id);
      if (this.mode === 'online' && !this.isHost) Net.send({ t: 'lv', i: best.id });
    },

    toggleLever: function (id) {
      var w = this.world;
      for (var i = 0; i < w.levers.length; i++) {
        if (w.levers[i].id !== id) continue;
        w.levers[i].on = !w.levers[i].on;
        Sfx.lever(w.levers[i].on);
        burst(w.levers[i].x, w.levers[i].y - 34, 8, w.levers[i].on ? '#5fd4a0' : '#e2565f', 110);
        return;
      }
    },

    nearestLever: function (p) {
      var w = this.world, best = null, bestD = INTERACT_RANGE;
      for (var i = 0; i < w.levers.length; i++) {
        var l = w.levers[i];
        var d = Math.hypot(l.x - p.x, (l.y - 20) - (p.y - 15));
        if (d < bestD) { bestD = d; best = l; }
      }
      return best;
    },

    playersInExit: function () {
      var e = this.world.exit;
      var n = 0;
      for (var i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        if (p.present && overlaps(playerBox(p), e)) n++;
      }
      return n;
    },

    updateExit: function (dt) {
      var w = this.world;
      if (w.cleared) return;
      var inside = this.playersInExit();
      var needed = (this.mode === 'local' || Net.connected) ? 2 : 1;

      if (inside >= needed) {
        w.exitHold += dt;
        if (Math.random() < 0.4) {
          burst(w.exit.x + w.exit.w / 2, w.exit.y + w.exit.h / 2, 1, '#f5b544', 60);
        }
        if (w.exitHold >= EXIT_HOLD) this.clearStage();
      } else {
        w.exitHold = Math.max(0, w.exitHold - dt * 2);
      }
    },

    clearStage: function () {
      var w = this.world;
      w.cleared = true;
      this.clearTimer = 1.7;
      Sfx.win();
      burst(w.exit.x + w.exit.w / 2, w.exit.y + w.exit.h / 2, 46, '#f5b544', 220);
      cam.shake = 1;
      var last = w.index >= LEVELS.length - 1;
      UI.banner(last ? 'The ruins are behind you' : 'Stage ' + (w.index + 1) + ' cleared', 1.6);
    },

    advance: function () {
      var next = this.world.index + 1;
      if (next >= LEVELS.length) {
        Net.send({ t: 'win' });
        this.finish();
        return;
      }
      this.loadLevel(next, true);
      Net.send({ t: 'go', i: next });
    },

    finish: function () {
      this.running = false;
      show($('#hud'), false);
      show($('#touch'), false);
      show($('#overlay'), true);
      UI.screen('victory');
    },

    respawn: function (p) {
      var which = p.kind === 'p1' ? 'p1' : 'p2';
      burst(p.x, p.y - 14, 16, '#e2565f', 160);
      placeAtSpawn(p, this.world, which);
      p.respawnFlash = 1.1;
      Sfx.hurt();
      cam.shake = Math.min(1, cam.shake + 0.5);
      if (this.mode === 'online') Net.send({ t: 'dead' });
    },

    /* -------------------------------------------------- frame */

    update: function (dt) {
      var w = this.world;
      if (!w) return;
      this.time += dt;
      w.time += dt;

      // ---- world simulation (host owns it; guests replay locally between packets)
      updateMovers(w, dt, true);
      var solids = dynamicSolids(w);

      // ---- players
      if (this.mode === 'local') {
        var i1 = readInput(SCHEME_1, 's1', false);
        var i2 = readInput(SCHEME_2, 's2', touchActive);
        this.stepPlayer(this.players[0], i1, solids, dt);
        this.stepPlayer(this.players[1], i2, solids, dt);
      } else {
        var mine = readInput(SCHEME_BOTH, 's1', true);
        this.stepPlayer(this.local, mine, solids, dt);
        this.interpolateRemote(dt);
      }

      // ---- puzzle state
      this.updatePlates();
      this.updateBlockers();
      updateWorldAnim(w, dt);
      this.updateExit(dt);

      // ---- stage advance (host decides, so both sides switch together)
      if (w.cleared) {
        this.clearTimer -= dt;
        if (this.clearTimer <= 0 && this.isHost) this.advance();
      }

      updateParticles(dt);
      updateCamera(w, this.players, dt, false);

      // ---- networking
      if (this.mode === 'online' && Net.connected) {
        this.netAcc += dt;
        if (this.netAcc >= NET_DT) {
          this.netAcc = 0;
          this.sendSelf();
          if (this.isHost) this.sendWorld();
        }
        this.pingAcc += dt;
        if (this.pingAcc >= 2) { this.pingAcc = 0; Net.measurePing(); }
      }

      UI.tick(dt);
    },

    stepPlayer: function (p, input, solids, dt) {
      if (!p.present) return;
      if (this.world.cleared) {
        // Freeze control during the clear fanfare, but keep gravity honest.
        input = { left: false, right: false, jump: false, usePressed: false };
      }
      updatePlayer(p, input, this.world, solids, dt);

      if (input.usePressed) this.tryInteract(p);

      if (hitsHazard(p, this.world)) this.respawn(p);

      if (p.grounded && !p.wasGrounded) {
        burst(p.x, p.y, 5, 'rgba(200,215,235,0.8)', 70, Math.PI * 0.7);
      }
    },

    interpolateRemote: function (dt) {
      var r = this.remote;
      if (!r.present) return;
      // Snapshots arrive at 20 Hz; ease toward them so motion stays smooth, and
      // hard-snap when the gap is large (teleport, respawn, stage change).
      var gap = Math.hypot(r.tx - r.x, r.ty - r.y);
      if (gap > 160) { r.x = r.tx; r.y = r.ty; }
      else {
        r.x = damp(r.x, r.tx, 16, dt);
        r.y = damp(r.y, r.ty, 16, dt);
      }
      r.animT += dt * (r.anim === 'run' ? Math.abs(r.vx) / 34 : 3.2);
      r.squash = damp(r.squash, 0, 11, dt);
      r.respawnFlash = Math.max(0, r.respawnFlash - dt);
    },

    /* -------------------------------------------------- net messages */

    sendSelf: function () {
      var p = this.local;
      Net.send({
        t: 'p',
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        vx: Math.round(p.vx),
        vy: Math.round(p.vy),
        f: p.face,
        a: p.anim,
        g: p.grounded ? 1 : 0
      });
    },

    sendWorld: function () {
      var w = this.world;
      Net.send({
        t: 'w',
        i: w.index,
        L: w.levers.map(function (l) { return l.on ? 1 : 0; }),
        M: w.movers.map(function (m) { return [Math.round(m.t * 1000) / 1000, m.dir]; }),
        h: Math.round(w.exitHold * 100) / 100,
        c: w.cleared ? 1 : 0
      });
    },

    onMessage: function (msg) {
      var w = this.world;
      switch (msg.t) {
        case 'hi':
          this.players[0].present = true;
          this.players[1].present = true;
          UI.refreshChips();
          break;

        case 'p': {
          var r = this.remote;
          r.tx = msg.x; r.ty = msg.y;
          r.vx = msg.vx; r.vy = msg.vy;
          r.face = msg.f;
          r.anim = msg.a;
          r.grounded = !!msg.g;
          r.present = true;
          break;
        }

        case 'w': {
          if (!w || this.isHost) break;
          if (msg.i !== w.index) { this.loadLevel(msg.i, true); w = this.world; }
          for (var i = 0; i < w.levers.length && i < msg.L.length; i++) {
            var on = !!msg.L[i];
            if (on !== w.levers[i].on) {
              w.levers[i].on = on;
              Sfx.lever(on);
            }
          }
          for (var j = 0; j < w.movers.length && j < msg.M.length; j++) {
            w.movers[j].t = msg.M[j][0];
            w.movers[j].dir = msg.M[j][1];
          }
          w.exitHold = msg.h;
          if (msg.c && !w.cleared) { w.cleared = true; this.clearTimer = 1.7; Sfx.win();
            burst(w.exit.x + w.exit.w / 2, w.exit.y + w.exit.h / 2, 46, '#f5b544', 220);
            UI.banner(w.index >= LEVELS.length - 1 ? 'The ruins are behind you' : 'Stage ' + (w.index + 1) + ' cleared', 1.6);
          }
          break;
        }

        case 'lv':
          if (this.isHost) this.toggleLever(msg.i);
          break;

        case 'rs':
          if (this.isHost) this.requestRestart();
          break;

        case 'go':
          if (!this.isHost) { this.loadLevel(msg.i, true); UI.banner('Stage ' + (msg.i + 1), 1.0); }
          break;

        case 'win':
          if (!this.isHost) this.finish();
          break;

        case 'dead': {
          var o = this.remote;
          burst(o.x, o.y - 14, 16, '#e2565f', 160);
          o.respawnFlash = 1.1;
          break;
        }
      }
    },

    /* -------------------------------------------------- draw */

    draw: function () {
      var w = this.world;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, VIEW_W, VIEW_H);
      if (!w) return;

      drawBackground(w, this.time);

      var shakeX = cam.shake ? (Math.random() - 0.5) * 10 * cam.shake : 0;
      var shakeY = cam.shake ? (Math.random() - 0.5) * 10 * cam.shake : 0;

      ctx.save();
      ctx.translate(VIEW_W / 2 + shakeX, VIEW_H / 2 + shakeY);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      drawTiles(w, this.time);

      var i;
      for (i = 0; i < w.plates.length; i++) drawPlate(w.plates[i]);
      for (i = 0; i < w.levers.length; i++) drawLever(w.levers[i]);
      for (i = 0; i < w.movers.length; i++) drawMover(w.movers[i], anyActive(w, w.movers[i].activeWhen));
      drawExit(w, this.time, this.playersInExit());
      for (i = 0; i < w.blockers.length; i++) drawBlocker(w.blockers[i], this.time);

      drawParticles();

      for (i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        if (!p.present) continue;
        drawExplorer(p, this.time);
      }
      for (i = 0; i < this.players.length; i++) {
        var q = this.players[i];
        if (!q.present) continue;
        var label = q.kind === 'p1' ? 'Rami' : 'Layla';
        drawPlayerTag(q, label, this.mode === 'online' && q === this.local);
      }

      // Off-screen partner indicator, so nobody gets lost
      this.drawOffscreenArrows();

      ctx.restore();

      // Vignette
      var vg = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.42, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.9);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    },

    drawOffscreenArrows: function () {
      var halfW = VIEW_W / (2 * cam.zoom) - 18;
      var halfH = VIEW_H / (2 * cam.zoom) - 18;
      for (var i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        if (!p.present || p === this.local && this.mode === 'online') continue;
        var dx = p.x - cam.x, dy = p.y - 16 - cam.y;
        if (Math.abs(dx) <= halfW && Math.abs(dy) <= halfH) continue;
        var ax = cam.x + clamp(dx, -halfW, halfW);
        var ay = cam.y + clamp(dy, -halfH, halfH);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.fillStyle = THEMES[p.kind].accent;
        ctx.beginPath();
        ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  var UI = {
    bannerTimer: 0,
    hintEl: null,

    init: function () {
      this.hintEl = $('#hint');

      $$('[data-goto]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (Net.peer) Net.destroy();
          if (btn.dataset.goto === 'home') Flow.clearRoomParam();
          UI.screen(btn.dataset.goto);
          UI.setNet('idle');
        });
      });

      $('#btn-host').addEventListener('click', function () { Flow.host(); });
      $('#btn-join-screen').addEventListener('click', function () {
        UI.screen('join');
        setTimeout(function () { $('#code-input').focus(); }, 60);
      });
      $('#btn-join').addEventListener('click', function () { Flow.join($('#code-input').value); });
      $('#btn-local').addEventListener('click', function () { Sfx.unlock(); Game.start('local', 0); });

      $('#code-input').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') Flow.join(this.value);
      });
      $('#code-input').addEventListener('input', function () {
        this.value = normaliseCode(this.value);
      });

      $('#btn-copy-link').addEventListener('click', function () { UI.copy(Flow.inviteLink(), 'Invite link copied'); });
      $('#btn-copy-code').addEventListener('click', function () { UI.copy(Net.code, 'Room code copied'); });
      $('#btn-share').addEventListener('click', function () {
        if (Game.mode !== 'online') { UI.toast('Local co-op — no room to share'); return; }
        var link = Flow.inviteLink();
        if (navigator.share) {
          navigator.share({ title: 'Ruins Together', text: 'Join my co-op run:', url: link }).catch(function () {});
        } else {
          UI.copy(link, 'Invite link copied');
        }
      });

      $('#btn-sound').addEventListener('click', function () {
        Sfx.enabled = !Sfx.enabled;
        this.dataset.on = Sfx.enabled ? 'true' : 'false';
        if (Sfx.enabled) { Sfx.unlock(); Sfx.lever(true); }
      });

      $('#btn-restart').addEventListener('click', function () { Game.requestRestart(); });
      $('#btn-menu').addEventListener('click', function () { Game.stop(); Flow.clearRoomParam(); UI.screen('home'); });
      $('#btn-play-again').addEventListener('click', function () {
        if (Game.mode === 'online' && Net.connected) {
          Game.start('online', Game.myIndex);
          Net.send({ t: 'go', i: 0 });
        } else {
          Game.stop();
          Game.start('local', 0);
        }
      });

      this.drawBrand();
    },

    screen: function (name) {
      $$('.screen').forEach(function (s) { show(s, s.dataset.screen === name); });
      show($('#overlay'), true);
    },

    setNet: function (state, text) {
      var dot = $('#net-dot');
      var label = $('#net-text');
      dot.classList.remove('good', 'bad');
      if (state === 'good') dot.classList.add('good');
      if (state === 'bad') dot.classList.add('bad');
      label.textContent = text || (state === 'idle' ? 'Local' : state);
      $('#peer-status').textContent =
        state === 'good' ? 'Connected — room ' + Net.code :
        state === 'bad' ? 'Connection lost' : 'Peer network idle';
    },

    refreshChips: function () {
      var c1 = $('#chip-p1'), c2 = $('#chip-p2');
      c1.classList.toggle('away', !Game.players[0].present);
      c2.classList.toggle('away', !Game.players[1].present);
      show(c1.querySelector('.you-tag'), Game.mode === 'online' && Game.myIndex === 0);
      show(c2.querySelector('.you-tag'), Game.mode === 'online' && Game.myIndex === 1);
    },

    banner: function (text, seconds) {
      $('#banner-text').textContent = text;
      var el = $('#banner');
      el.classList.remove('hidden');
      // Restart the entrance animation.
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      this.bannerTimer = seconds;
    },

    toast: function (text) {
      var el = $('#toast');
      el.textContent = text;
      el.classList.remove('hidden');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(function () { el.classList.add('hidden'); }, 2200);
    },

    copy: function (text, okMessage) {
      if (!text) return;
      var done = function () { UI.toast(okMessage); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { UI.fallbackCopy(text, done); });
      } else {
        UI.fallbackCopy(text, done);
      }
    },

    fallbackCopy: function (text, done) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { UI.toast('Copy failed — select the code manually'); }
      document.body.removeChild(ta);
    },

    tick: function (dt) {
      if (this.bannerTimer > 0) {
        this.bannerTimer -= dt;
        if (this.bannerTimer <= 0) show($('#banner'), false);
      }

      // Contextual "press E" prompt for the local player.
      var p = Game.mode === 'local' ? null : Game.local;
      var near = null;
      if (Game.mode === 'local') {
        near = Game.nearestLever(Game.players[0]) || Game.nearestLever(Game.players[1]);
      } else if (p) {
        near = Game.nearestLever(p);
      }
      show(this.hintEl, !!near && !Game.world.cleared);

      if (Game.mode === 'online') {
        if (Net.connected) this.setNet('good', 'Online · ' + (Net.ping || '–') + ' ms');
        else this.setNet('bad', 'Reconnecting…');
      }
    },

    /* Two explorers waving on the menu, drawn with the in-game renderer. */
    drawBrand: function () {
      var bc = $('#brand-canvas');
      if (!bc) return;
      var bctx = bc.getContext('2d');
      var scale = Math.min(window.devicePixelRatio || 1, 2);
      bc.width = 220 * scale;
      bc.height = 96 * scale;

      var saved = ctx;
      var poseA = makePlayer('p1');
      var poseB = makePlayer('p2');
      poseA.face = 1; poseB.face = -1;

      function frame(t) {
        // Only animate while the menu is actually on screen.
        if (!Game.running) {
          bctx.setTransform(scale, 0, 0, scale, 0, 0);
          bctx.clearRect(0, 0, 220, 96);
          ctx = bctx;                             // temporarily retarget the renderer
          poseA.x = 78; poseA.y = 84; poseA.animT = t * 2.4;
          poseB.x = 142; poseB.y = 84; poseB.animT = t * 2.4 + 1.6;
          drawExplorer(poseA, t);
          drawExplorer(poseB, t);
          ctx = saved;
        }
        requestAnimationFrame(function (ms) { frame(ms / 1000); });
      }
      requestAnimationFrame(function (ms) { frame(ms / 1000); });
    }
  };

  /* ------------------------------------------------------------------ *
   * Connection flow
   * ------------------------------------------------------------------ */

  var Flow = {
    /* Drop ?room= so a reload from the menu does not try to rejoin a dead room. */
    clearRoomParam: function () {
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
    },

    inviteLink: function () {
      var base = location.origin + location.pathname;
      return base + '?room=' + Net.code;
    },

    guardPeer: function () {
      if (Net.available()) return true;
      UI.screen('error');
      $('#error-text').textContent =
        'The PeerJS library could not be loaded, so online play is unavailable. ' +
        'Check your connection, or use Local co-op on one device.';
      return false;
    },

    host: function () {
      Sfx.unlock();
      if (!this.guardPeer()) return;

      var code = makeRoomCode();
      UI.screen('lobby');
      $('#code-display').textContent = '······';

      Net.onOpen = function (c) {
        $('#code-display').textContent = c;
        UI.setNet('idle', 'Waiting');
        // Deep-link without reloading, so a refresh keeps the room.
        try { history.replaceState(null, '', '?room=' + c); } catch (e) {}
      };

      Net.onConnect = function () {
        Sfx.join();
        Game.start('online', 0);
        Net.send({ t: 'go', i: Game.world.index });
        Game.sendWorld();
        UI.banner('Layla has joined', 1.4);
      };

      Net.onMessage = function (msg) { Game.onMessage(msg); };

      Net.onClose = function () {
        Game.players[1].present = false;
        UI.refreshChips();
        UI.banner('Layla disconnected', 2.4);
        UI.setNet('bad', 'Partner left');
      };

      Net.onError = function (err) { Flow.handleError(err, code); };

      Net.host(code);
    },

    join: function (raw) {
      Sfx.unlock();
      if (!this.guardPeer()) return;

      var code = normaliseCode(raw);
      if (code.length < 4) { UI.toast('Enter the full room code'); Sfx.error(); return; }

      UI.screen('connecting');
      $('#connect-state').textContent = 'Looking for room ' + code;

      Net.onConnect = function () {
        Sfx.join();
        Game.start('online', 1);
        UI.banner('Connected', 1.2);
      };

      Net.onMessage = function (msg) { Game.onMessage(msg); };

      Net.onClose = function () {
        Game.players[0].present = false;
        UI.refreshChips();
        UI.banner('Rami disconnected', 2.4);
        UI.setNet('bad', 'Partner left');
      };

      Net.onError = function (err) { Flow.handleError(err, code); };

      Net.join(code);
    },

    handleError: function (err, code) {
      var type = (err && err.type) || '';
      Sfx.error();

      if (type === 'unavailable-id') {
        // Someone already holds this room id — take a different one.
        Net.destroy();
        Flow.host();
        return;
      }

      // A live game shouldn't be torn down by a transient signalling hiccup.
      if (Game.running && Net.connected) { UI.toast('Network hiccup'); return; }

      var text;
      switch (type) {
        case 'peer-unavailable':
          text = 'No room named "' + code + '" is open right now. Double-check the code, ' +
                 'and make sure your partner still has their tab open.';
          break;
        case 'browser-incompatible':
          text = 'This browser does not support the WebRTC data channels the game needs.';
          break;
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          text = 'Could not reach the matchmaking server. Check your connection and try again.';
          break;
        case 'webrtc':
          text = 'The peer connection failed. Some restrictive networks block direct connections — ' +
                 'try a different network, or play local co-op.';
          break;
        default:
          text = 'Connection failed' + (type ? ' (' + type + ')' : '') + '. Please try again.';
      }
      Net.destroy();
      Game.running = false;
      show($('#hud'), false);
      show($('#touch'), false);
      UI.screen('error');
      $('#error-text').textContent = text;
    }
  };

  /* ------------------------------------------------------------------ *
   * Main loop
   * ------------------------------------------------------------------ */

  var lastTime = 0;
  var accumulator = 0;
  var STEP = 1 / 120;          // fixed physics step keeps jumps identical everywhere

  function frame(ms) {
    requestAnimationFrame(frame);
    var now = ms / 1000;
    var dt = lastTime ? now - lastTime : 0;
    lastTime = now;

    // A backgrounded tab can hand us a huge delta; never tunnel through walls.
    dt = Math.min(dt, 0.1);

    if (Game.running) {
      accumulator += dt;
      var steps = 0;
      while (accumulator >= STEP && steps < 8) {
        Game.update(STEP);
        accumulator -= STEP;
        steps++;
      }
      if (steps === 8) accumulator = 0;
      Game.draw();
    }
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    UI.init();
    bindTouch();
    resizeCanvas();
    UI.screen('home');
    requestAnimationFrame(frame);

    // ?room=CODE — drop straight into the join screen with the code filled in.
    var params = new URLSearchParams(location.search);
    var room = normaliseCode(params.get('room'));
    if (room) {
      $('#code-input').value = room;
      UI.screen('join');
      $('#connect-sub').textContent = 'Joining room ' + room;
    }

    window.addEventListener('peerjs-ready', function () {
      $('#peer-status').textContent = 'Peer network ready';
    });
    if (window.__peerLoadFailed) {
      $('#peer-status').textContent = 'Peer network unavailable — local co-op only';
    }

    // Pausing on tab-hide avoids a huge catch-up step on return.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { lastTime = 0; accumulator = 0; }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Exposed for quick console poking during development.
  window.RuinsTogether = { Game: Game, Net: Net, LEVELS: LEVELS };

})();
