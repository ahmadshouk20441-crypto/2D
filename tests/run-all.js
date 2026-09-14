#!/usr/bin/env node
/* Runs every check in sequence. Usage: node tests/run-all.js */
const { execFileSync } = require('child_process');
const path = require('path');

const suites = [
  ['validate-levels.js', 'Level geometry and entity wiring'],
  ['playthrough.js',     'Bot solves all four stages'],
  ['netcode.js',         'Two clients stay in sync'],
  ['smoke.js',           'Hazards, rendering, crush, disconnect']
];

let failed = 0;
for (const [file, title] of suites) {
  process.stdout.write(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}\n`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  } catch (e) {
    failed++;
  }
}
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nAll suites passed.');
process.exit(failed ? 1 : 0);
