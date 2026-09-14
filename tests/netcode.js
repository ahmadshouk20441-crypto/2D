/* Two fully separate game instances, wired to each other through a fake
   DataChannel, to verify the host-authoritative sync protocol. */
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
const STUB = `
  const ctx2d = new Proxy({}, {
    get(t,k){ if(k==='createLinearGradient'||k==='createRadialGradient') return ()=>({addColorStop(){}});
              if(k==='measureText') return ()=>({width:10});
              if(k in t) return t[k]; return ()=>{}; },
    set(t,k,v){ t[k]=v; return true; }
  });
  function makeEl(){ return {
    dataset:{}, style:{}, textContent:'', value:'', offsetWidth:0,
    clientWidth:1280, clientHeight:720, width:0, height:0,
    classList:{ _s:new Set(), add(...c){c.forEach(x=>this._s.add(x));},
      remove(...c){c.forEach(x=>this._s.delete(x));},
      toggle(c,on){ if(on===undefined) on=!this._s.has(c); on?this._s.add(c):this._s.delete(c); return on; },
      contains(c){return this._s.has(c);} },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){},
    querySelector(){ return makeEl(); }, querySelectorAll(){ return []; },
    getContext(){ return ctx2d; }, focus(){}, select(){}, setAttribute(){}
  };}
  const cache = new Map();
  const q = (sel)=>{ if(!cache.has(sel)) cache.set(sel, makeEl()); return cache.get(sel); };
  const winHandlers = new Map();
  globalThis.window = globalThis;
  globalThis.document = { readyState:'complete', body:makeEl(), head:makeEl(),
    querySelector:q, querySelectorAll:()=>[], createElement:makeEl,
    addEventListener(){}, execCommand(){return true;} };
  globalThis.navigator = { userAgent:'node' };
  globalThis.location = { origin:'https://example.test', pathname:'/', search:'', href:'https://example.test/' };
  globalThis.history = { replaceState(){} };
  globalThis.devicePixelRatio = 1;
  globalThis.matchMedia = ()=>({ matches:false, addListener(){}, addEventListener(){} });
  globalThis.requestAnimationFrame = ()=>0;
  globalThis.addEventListener = (t,fn)=>{ if(!winHandlers.has(t)) winHandlers.set(t,[]); winHandlers.get(t).push(fn); };
  globalThis.removeEventListener = ()=>{};
  globalThis.__fireKey = (type, code)=> (winHandlers.get(type)||[]).forEach(fn=>fn({code, repeat:false, preventDefault(){}}));
`;

function makeClient(name) {
  const sandbox = { console, performance, URLSearchParams, Math, Date,
                    setTimeout, clearTimeout, setInterval, clearInterval,
                    crypto: require('crypto').webcrypto };
  vm.createContext(sandbox);
  vm.runInContext(STUB, sandbox, { filename: 'stub.js' });
  vm.runInContext(SRC, sandbox, { filename: 'main.js' });
  return { name, sandbox, api: sandbox.window.RuinsTogether, fire: sandbox.__fireKey };
}

const host = makeClient('host');
const guest = makeClient('guest');

// --- fake DataChannel with a few frames of latency each way ---
const wire = [];   // {toClient, msg, at}
let frame = 0;
const LATENCY = 4; // frames (~33ms at 120Hz)

function connect(a, b) {
  a.api.Net.role = a === host ? 'host' : 'guest';
  a.api.Net.connected = true;
  a.api.Net.conn = { open: true, send: (m) => wire.push({ to: b, msg: JSON.parse(JSON.stringify(m)), at: frame + LATENCY }) };
}
connect(host, guest);
connect(guest, host);

function pumpWire() {
  for (let i = wire.length - 1; i >= 0; i--) {
    if (wire[i].at > frame) continue;
    const { to, msg } = wire.splice(i, 1)[0];
    if (msg.t === 'ping' || msg.t === 'pong') continue;
    to.api.Game.onMessage(msg);
  }
}

host.api.Game.start('online', 0);
guest.api.Game.start('online', 1);
// The host tells the guest which stage to load, exactly as Flow.onConnect does.
host.api.Net.send({ t: 'go', i: host.api.Game.world.index });
host.api.Game.sendWorld();

const STEP = 1 / 120, TILE = 32;
const tx = (t) => t * TILE + TILE / 2;

function step(n) {
  for (let i = 0; i < n; i++) {
    frame++;
    pumpWire();
    host.api.Game.update(STEP);
    guest.api.Game.update(STEP);
  }
}

function keys(client, set) {
  for (const [code, on] of Object.entries(set)) client.fire(on ? 'keydown' : 'keyup', code);
}

function walkTo(client, idx, targetX, seconds) {
  const p = client.api.Game.players[idx];
  const frames = Math.round(seconds / STEP);
  for (let i = 0; i < frames; i++) {
    const d = targetX - p.x;
    if (Math.abs(d) < 7) break;
    keys(client, { KeyD: d > 0, KeyA: d < 0 });
    step(1);
  }
  keys(client, { KeyD: false, KeyA: false });
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
};

console.log('\n1. Both clients load the same stage');
step(30);
check('host on stage ' + host.api.Game.world.index, host.api.Game.world.index === 0);
check('guest on stage ' + guest.api.Game.world.index, guest.api.Game.world.index === 0);

console.log('\n2. Remote avatar position propagates');
walkTo(host, 0, tx(12), 6);
step(30);
const hostP1 = host.api.Game.players[0];
const guestViewOfP1 = guest.api.Game.players[0];
check('guest sees P1 near its true x', Math.abs(guestViewOfP1.x - hostP1.x) < 20,
      `host x=${hostP1.x.toFixed(0)} guest sees x=${guestViewOfP1.x.toFixed(0)}`);

console.log('\n3. A plate pressed by the host opens the gate on both clients');
walkTo(host, 0, tx(9), 6);
step(60);
check('host: plate pressed', host.api.Game.world.plates[0].pressed);
check('host: gate open', host.api.Game.world.blockers[0].open);
check('guest: gate open too', guest.api.Game.world.blockers[0].open);

console.log('\n4. Guest walks through the open gate, then throws the lever');
walkTo(guest, 1, tx(27), 14);
step(30);
guest.fire('keydown', 'KeyE'); step(2); guest.fire('keyup', 'KeyE');
step(40);
check('host applied the guest\'s lever intent', host.api.Game.world.levers[0].on);
check('guest sees the lever on', guest.api.Game.world.levers[0].on);
check('gate stays open after host leaves the plate (host)', host.api.Game.world.blockers[0].open);

console.log('\n5. Both reach the portal and the stage advances on both clients');
walkTo(host, 0, host.api.Game.world.exit.x + 32, 22);
walkTo(guest, 1, guest.api.Game.world.exit.x + 32, 22);
// hold both inside the portal
for (let i = 0; i < 400; i++) {
  const hp = host.api.Game.players[0], gp = guest.api.Game.players[1];
  keys(host, { KeyD: host.api.Game.world.exit.x + 32 - hp.x > 7, KeyA: false });
  keys(guest, { KeyD: guest.api.Game.world.exit.x + 32 - gp.x > 7, KeyA: false });
  step(1);
}
keys(host, { KeyD: false }); keys(guest, { KeyD: false });
step(400);
check('host advanced to stage ' + host.api.Game.world.index, host.api.Game.world.index === 1);
check('guest advanced to stage ' + guest.api.Game.world.index, guest.api.Game.world.index === 1);

console.log('\n6. Host-owned mover state stays in sync (drift must stay bounded)');
host.api.Game.toggleLever('liftLever');
let maxDrift = 0, earlyDrift = 0;
for (let i = 0; i < 2400; i++) {          // 20 seconds — many full lift cycles
  step(1);
  const d = Math.abs(host.api.Game.world.movers[1].y - guest.api.Game.world.movers[1].y);
  maxDrift = Math.max(maxDrift, d);
  if (i === 240) earlyDrift = maxDrift;
}
// One snapshot interval plus the wire latency, at the lift's speed, is the
// irreducible offset: 82 px/s * (50ms + 33ms) ~= 7px.
check('drift stays within one snapshot interval', maxDrift < 9, `max ${maxDrift.toFixed(1)}px`);
check('drift does not accumulate over 20s', maxDrift <= earlyDrift + 1.5,
      `after 2s: ${earlyDrift.toFixed(1)}px, after 20s: ${maxDrift.toFixed(1)}px`);

console.log('\n7. Guest keeps following the host across a stage restart');
host.api.Game.requestRestart();
step(60);
check('both back on the same stage', host.api.Game.world.index === guest.api.Game.world.index,
      `host=${host.api.Game.world.index} guest=${guest.api.Game.world.index}`);
check('guest levers reset with the host', guest.api.Game.world.levers.every(l => !l.on));

console.log(failures ? `\n${failures} networking check(s) failed` : '\nAll networking checks passed');
process.exit(failures ? 1 : 0);
