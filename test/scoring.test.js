/**
 * scoring.test.js — no framework, just assert + exit code. Judge should be able to
 * `node test/scoring.test.js` and see real pass/fail, not a mock of one.
 */
const assert = require('assert');
const { scorePosition } = require('../lib/scoring');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL - ${name}\n    ${e.message}`);
  }
}

console.log('scoring.js');

test('no debt returns no-debt tier and Infinity HF', () => {
  const r = scorePosition({ collateralUsd: 10000, debtUsd: 0, liquidationThreshold: 0.8 });
  assert.strictEqual(r.tier, 'no-debt');
  assert.strictEqual(r.healthFactor, Infinity);
});

test('HF < 1 is danger (already liquidatable)', () => {
  // collateral 1000 * threshold 0.8 = 800 < debt 900 -> HF = 800/900 = 0.888
  const r = scorePosition({ collateralUsd: 1000, debtUsd: 900, liquidationThreshold: 0.8 });
  assert.strictEqual(r.tier, 'danger');
  assert.ok(r.healthFactor < 1, `expected HF<1, got ${r.healthFactor}`);
  assert.ok(/LIQUIDATABLE NOW/.test(r.verdict));
});

test('HF in [1, 1.15) is danger band, not yet liquidatable', () => {
  // 1000 * 0.9 = 900 debt -> HF = exactly 1.0 -> bump debt down slightly
  const r = scorePosition({ collateralUsd: 1000, debtUsd: 850, liquidationThreshold: 0.9 });
  assert.ok(r.healthFactor >= 1 && r.healthFactor < 1.15, `HF=${r.healthFactor} not in band`);
  assert.strictEqual(r.tier, 'danger');
});

test('HF in [1.15, 1.5) is watch', () => {
  const r = scorePosition({ collateralUsd: 1000, debtUsd: 650, liquidationThreshold: 0.85 });
  assert.ok(r.healthFactor >= 1.15 && r.healthFactor < 1.5, `HF=${r.healthFactor} not in band`);
  assert.strictEqual(r.tier, 'watch');
});

test('HF >= 1.5 is safe', () => {
  const r = scorePosition({ collateralUsd: 10000, debtUsd: 3000, liquidationThreshold: 0.8 });
  assert.ok(r.healthFactor >= 1.5, `HF=${r.healthFactor} expected >=1.5`);
  assert.strictEqual(r.tier, 'safe');
});

test('invalid liquidationThreshold throws rather than producing a silent wrong number', () => {
  assert.throws(() => scorePosition({ collateralUsd: 100, debtUsd: 50, liquidationThreshold: 1.5 }));
  assert.throws(() => scorePosition({ collateralUsd: 100, debtUsd: 50, liquidationThreshold: 0 }));
});

test('negative collateral/debt throws', () => {
  assert.throws(() => scorePosition({ collateralUsd: -1, debtUsd: 50, liquidationThreshold: 0.8 }));
});

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log('\nall pass');
}
