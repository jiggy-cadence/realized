/**
 * docs.test.js — the prose must agree with the instrument, or the build fails.
 *
 * ORIGIN (2026-09-12). @cassini, reviewing this repo on Colony, asked the question we had no
 * answer to: `build-report.js` computed the Optimism nullity CORRECTLY from data, with a comment
 * explaining why quoting "5 chains" would inflate the claim — while six documents said 5 chains
 * anyway. The instrument was right before we were. So:
 *
 *   "If the build-report.js script correctly flagged the Optimism nullity, the error lies in the
 *    lack of a hard constraint between the data-layer truth and the prose-layer representation.
 *    How do you intend to implement a programmatic lock?"
 *
 * This file is the lock. It is the project's own thesis turned on the project: a measure drifts
 * off the thing it names, and the drift never announces itself. A number in a README cannot
 * announce that it went stale — so something has to ask it, every run.
 *
 * WHAT IT DOES: recomputes each headline figure from the DATA FILES, then asserts the prose
 * contains that figure and does not contain a stale one. Per @lemony's rule, stated better than
 * we had it: recompute from the served fields every round, never copy last round's gate.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: auto-rewrite the docs. A lock that silently edits prose to
 * match data would make the two agree while destroying the evidence that they disagreed — the
 * failure would stop announcing itself, which is the thing we are trying to prevent. It fails
 * loudly and names the file instead.
 *
 * Run: node test/docs.test.js
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

let failed = 0;
const pass = (name, detail) => console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
const fail = (name, detail) => { failed++; console.log(`FAIL  ${name}\n      ${detail}`); };

/** The prose surfaces a judge actually reads. Code comments are excluded on purpose: they
 *  explain reasoning and may legitimately cite a historical number. */
const PROSE = [
  'README.md', 'FOR-JUDGES.md', 'COMPOSABILITY.md', 'FEEDBACK.md',
  'SKILL.md', 'llms.txt', 'TALKING-POINTS.md', 'SHOT-LIST.md', 'DEMO-SCRIPT.md',
];

/**
 * A stale number that appears INSIDE a sentence explaining the correction is not drift — it is
 * the retraction doing its job. On this test's first run all three failures were of exactly that
 * kind: the do-not-say warning in TALKING-POINTS, the fee-uplift table in FOR-JUDGES (a different
 * measurement that legitimately reads 55.1%), and SHOT-LIST explaining why agreement fell FROM
 * 99.2%. A lock that fires on its own documentation trains you to ignore it, which is worse than
 * no lock — so the exemption is mechanical, not a judgement call each time.
 *
 * Exempt when the same LINE carries correction language, or is a table row for a different
 * measurement. Anything else is a real claim and must match the instrument.
 */
const CORRECTION_CONTEXT = /saying|do not say|don't say|never say|inflat|stale|fell from|dropped from|grew|was wrong|corrected|retract|earlier draft|previously|used to|no longer|instead of|rather than|not \d|→|->/i;

function staleHitsIn(text, s) {
  // Word-boundary-ish: avoid matching 37.3 inside 137.35
  const re = new RegExp(`(?<![\\d.])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`);
  return text.split('\n')
    .map((line, n) => ({ line, n: n + 1 }))
    .filter(({ line }) => re.test(line))
    .filter(({ line }) => !CORRECTION_CONTEXT.test(line));
}

/** Assert every prose file that mentions the topic contains `want`, and none contain `stale`. */
function assertFigure(name, { want, stale = [], onlyFilesMentioning, exemptLines = () => false }) {
  const offenders = [];
  const carriers = [];
  let exempted = 0;
  for (const f of PROSE) {
    let text;
    try { text = read(f); } catch { continue; }
    if (onlyFilesMentioning && !onlyFilesMentioning.test(text)) continue;
    for (const s of stale) {
      for (const hit of staleHitsIn(text, s)) {
        if (exemptLines(hit.line, f)) { exempted++; continue; }
        offenders.push(`${f}:${hit.n} still contains stale "${s}"\n        → ${hit.line.trim().slice(0, 110)}`);
      }
    }
    if (text.includes(want)) carriers.push(f);
  }
  if (offenders.length) return fail(name, offenders.join('\n      '));
  if (!carriers.length) return fail(name, `no prose file contains the live value "${want}" — did the docs drift, or did the data move?`);
  pass(name, `"${want}" in ${carriers.length} file(s)${exempted ? `, ${exempted} correction-context mention(s) allowed` : ''}`);
}

console.log('--- prose vs instrument: the numbers must be recomputed, not remembered ---');

// ---------------------------------------------------------------------------
// 1. CHAIN COUNT. The original sin. Chains we VALIDATED, not chains we queried.
// ---------------------------------------------------------------------------
{
  const hist = json('data/history.json');
  const validated = Object.entries(hist.stability || {}).filter(([, s]) => s?.tight).map(([c]) => c);
  const queried = hist.chainsMeasured || [];
  const unvalidated = queried.filter((c) => !validated.includes(c));

  // The instrument's own claim, derived here the same way build-report.js derives it.
  if (validated.length === 0) fail('chains: validated set is non-empty', 'history.json has no chain with a tight-range result');
  else pass('chains: validated set derived from data', `${validated.length} of ${queried.length} queried (${validated.join(', ')})`);

  // Every chain we exclude must be absent from prose as an indexed chain.
  for (const c of unvalidated) {
    const offenders = PROSE.filter((f) => {
      let t; try { t = read(f); } catch { return false; }
      // Allowed: naming it while explaining the exclusion. Not allowed: listing it as a chain we index.
      const listedAsIndexed = new RegExp(`(indexed|across|built on|measured across|chains?:)[^.\\n]{0,80}\\b${c}\\b`, 'i');
      return listedAsIndexed.test(t);
    });
    if (offenders.length) fail(`chains: "${c}" is unvalidated and must not be listed as indexed`, offenders.join(', '));
    else pass(`chains: unvalidated "${c}" not listed as indexed`);
  }

  assertFigure('chains: prose states the validated count', {
    want: `${validated.length} chains`,
    stale: [`${queried.length} chains`],
  });
}

// ---------------------------------------------------------------------------
// 2. POOL COUNT. Moves every time the corpus is rebuilt; drifted 256 -> 376 once already.
// ---------------------------------------------------------------------------
{
  const pools = json('api/pools.json');
  const rows = pools.pools || pools;
  const n = Array.isArray(rows) ? rows.length : null;
  if (!n) fail('pools: count readable from api/pools.json', 'no array found');
  else {
    pass('pools: count read from served artifact', `${n} pools`);
    assertFigure('pools: prose states the live pool count', {
      want: `${n} pools`,
      stale: ['256 pools', '255 pools'].filter((s) => s !== `${n} pools`),
    });
  }
}

// ---------------------------------------------------------------------------
// 3. HEADLINE DEFECT RATE + the gate denominator, both from corpus.json.
// ---------------------------------------------------------------------------
{
  const c = json('data/corpus.json');
  const pct = c.headline?.misleadingPct;
  const count = c.headline?.misleadingCount;
  const gateN = (c.byRange?.rows || [])[0]?.n;
  if (pct == null || gateN == null) fail('headline: readable from corpus.json', 'missing headline or byRange');
  else {
    const p1 = pct.toFixed(1);
    pass('headline: recomputed from corpus', `${p1}% (${count} of ${gateN})`);
    assertFigure('headline: prose states the live defect rate', {
      want: `${p1}%`,
      stale: ['48.4%', '55.1%'],
      onlyFilesMentioning: /liveness gate|defect rate|advertis/i,
      // The fee-uplift table reports a DIFFERENT measurement (defect rate after crediting
      // Uniswap's capital-efficiency multiplier), whose moderate row legitimately reads 55.1%.
      // Same digits, different quantity -- exactly the confusion this repo exists to name, so
      // the exemption is narrow: table rows only.
      exemptLines: (line) => /^\s*\|/.test(line),
    });
    assertFigure('headline: prose states the live gate denominator', {
      want: `of ${gateN}`,
      stale: ['141 of 256', 'of 256'],
      onlyFilesMentioning: /liveness gate|clearing our/i,
    });
  }
}

// ---------------------------------------------------------------------------
// 4. SENSITIVITY ROW. The four range widths, which moved when the corpus grew.
// ---------------------------------------------------------------------------
{
  const rows = json('data/corpus.json').byRange?.rows || [];
  const live = rows.map((r) => `${r.misleadingPct.toFixed(1)}%`);
  if (live.length !== 4) fail('sensitivity: four range rows present', `got ${live.length}`);
  else {
    pass('sensitivity: recomputed from corpus', live.join(' · '));
    const stale = ['62.1% · 55.1%', '55.1% · 46.9%', '46.9% · 37.1%'];
    const offenders = [];
    for (const f of PROSE) {
      let t; try { t = read(f); } catch { continue; }
      for (const s of stale) if (t.includes(s)) offenders.push(`${f}: "${s}"`);
    }
    if (offenders.length) fail('sensitivity: no stale range row in prose', offenders.join(', '));
    else pass('sensitivity: no stale range row in prose');
  }
}

// ---------------------------------------------------------------------------
// 5. 1INCH CROSS-CHECK. Independent price audit; agreement fell 99.2 -> 97.3 on rebuild.
// ---------------------------------------------------------------------------
{
  const pc = json('data/pricecheck.json');
  const agree = pc.agreementPct?.toFixed(1);
  const med = pc.medianAbsDivergencePct?.toFixed(3);
  const compared = pc.counts?.compared;
  if (!agree) fail('1inch: readable from pricecheck.json', 'missing agreementPct');
  else {
    pass('1inch: recomputed from pricecheck', `${agree}% over ${compared}, median ${med}%`);
    assertFigure('1inch: prose states live agreement', {
      want: `${agree}%`,
      stale: ['99.2%'],
      onlyFilesMentioning: /1inch/i,
    });
    assertFigure('1inch: prose states live median divergence', {
      want: `${med}%`,
      stale: ['0.078%'],
      onlyFilesMentioning: /divergence/i,
    });
  }
}

// ---------------------------------------------------------------------------
// 6. CANARY STATE. If the corpus shipped with a failing canary, no number is publishable.
// ---------------------------------------------------------------------------
{
  const canary = json('data/corpus.json').canary;
  if (!canary?.passed) fail('canary: corpus shipped with a passing stable-pair canary', JSON.stringify(canary));
  else pass('canary: corpus canary passed', `${canary.stablePairsFound} stable pairs, worst |IL| ${canary.worstAbsIlPct.toExponential(1)}%`);
}

// ---------------------------------------------------------------------------
// 7. FRESHNESS. The failure Grok caught: a live-measurement claim on a 45-hour-old corpus.
//    Warns rather than fails — staleness is an ops problem, not a wrong number.
// ---------------------------------------------------------------------------
{
  const gen = json('api/pools.json').generatedAt;
  const ageH = (Date.now() - new Date(gen).getTime()) / 3.6e6;
  if (!isFinite(ageH)) fail('freshness: generatedAt parseable', String(gen));
  else if (ageH > 48) fail('freshness: served corpus is older than 48h', `${ageH.toFixed(1)}h old (${gen}) — rebuild: node scripts/build-pools.js`);
  else if (ageH > 24) { console.log(`WARN  freshness: corpus is ${ageH.toFixed(1)}h old — consider rebuilding before submission`); pass('freshness: under the 48h hard bound'); }
  else pass('freshness: corpus is current', `${ageH.toFixed(1)}h old`);
}

// ---------------------------------------------------------------------------
// 8. TRACK CLAIMS. We entered three; "submitted to 1inch" was true for about a day.
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const f of PROSE) {
    let t; try { t = read(f); } catch { continue; }
    if (/submitted to 1inch|1inch track/i.test(t) && !/not.{0,12}1inch|would be a claim/i.test(t)) {
      offenders.push(f);
    }
  }
  if (offenders.length) fail('tracks: no stale "submitted to 1inch" claim', offenders.join(', '));
  else pass('tracks: no stale 1inch submission claim');
}

console.log(`\n${failed ? `${failed} FAILED` : 'all doc assertions passed'} — prose and instrument agree`);
process.exit(failed ? 1 : 0);
