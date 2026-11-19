// gta6-trophy-rarity-forecast-01 entry: dilution-aware trophy earn-rate forecaster.
//
// Idea: an earn rate is a ratio, earned / players_tracked, and the two sides of
// that ratio move at different speeds. New players pour in and dilute every
// trophy they have not reached yet, while the players already in keep earning.
// A persistence forecast (the house baseline) misses both motions, and a plain
// curve fit on the rate misses the reason the rate moves. This program therefore
// forecasts each trophy two ways and blends them on the logit scale:
//
//   1. Trend: a weighted least-squares line of logit(rate) against
//      ln(1 + hours since 2026-11-19T00:00Z) over the distinct page states of
//      the last 24 hours, anchored at the last read so intercept error cannot
//      leak into the forecast, with its slope damped for the long horizon.
//   2. Counts: the same log-time fit applied to ln(earned + 0.5) and to
//      ln(players_tracked) separately; the forecast rate is the ratio of the
//      two forecasts. Per-trophy earned slopes are shrunk toward the pooled
//      slope because a trophy held by three players has a noisy slope of its
//      own. This is the part that sends the platinum down as the player pool
//      grows past the handful of players who can ever hold it in week one.
//
// The page only changes when Exophase refreshes it, so repeated identical
// reads are one observation, not many: the history is compressed to distinct
// states (players_tracked / trophies_earned changes) before any fitting. When
// the history holds a single state — launch night in the practice cases — no
// trend exists to fit, and the program instead applies the refresh the data
// has not shown yet: a dilution shift downward for every trophy short of the
// saturated one, plus a wide spread, because a stale page about to refresh is
// the least certain state there is.
//
// The spread is honest by construction: a random-walk term that grows with
// the horizon, the trend fit's own residual, and a refresh-jump term that is
// large when few distinct states have been seen and shrinks as they pile up.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Log-time origin: the release day begins here, as in the house curve baseline. */
const ORIGIN_MS = Date.parse('2026-11-19T00:00:00Z');

interface Read {
  slot: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}
interface CaseFile {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Array<{ id: number; tier: string }>;
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Hours on the log-time axis for an ISO timestamp. */
const logTime = (iso: string): number => Math.log(1 + Math.max(0, (Date.parse(iso) - ORIGIN_MS) / 3_600_000));

/** Weighted least-squares slope of ys on xs, plus the residual scale around the fit. */
function fitSlope(xs: number[], ys: number[], ws: number[]): { slope: number; resid: number } {
  const n = xs.length;
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sw += ws[i]; sx += ws[i] * xs[i]; sy += ws[i] * ys[i]; }
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; sxx += ws[i] * dx * dx; sxy += ws[i] * dx * (ys[i] - my); }
  if (sxx <= 1e-12) return { slope: 0, resid: 0 };
  const slope = sxy / sxx;
  let sr = 0;
  for (let i = 0; i < n; i++) { const r = ys[i] - (my + slope * (xs[i] - mx)); sr += ws[i] * r * r; }
  return { slope, resid: Math.sqrt(sr / sw) };
}

const median = (vals: number[]): number => {
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);

  // Compress to distinct page states: a read that repeats the previous read's
  // counters is the same Exophase refresh seen again, not new information.
  const states: Read[] = [];
  for (const r of c.history) {
    const prev = states[states.length - 1];
    if (!prev || prev.players_tracked !== r.players_tracked || prev.trophies_earned !== r.trophies_earned) states.push(r);
  }
  const last = c.history[c.history.length - 1];
  const xLast = logTime(last.slot);
  const xTarget = logTime(c.target);
  const dx = Math.max(0, xTarget - xLast);
  const days = c.horizon_minutes / 1440;

  // Fitting window: distinct states from the last 24 hours of reads; widen to
  // every state when the window holds too few to fit anything.
  const lastMs = Date.parse(last.slot);
  let win = states.filter((r) => lastMs - Date.parse(r.slot) <= 24 * 3_600_000);
  if (win.length < 4) win = states;
  const wx = win.map((r) => logTime(r.slot));
  const span = wx.length > 1 ? Math.max(1e-9, wx[wx.length - 1] - wx[0]) : 1;
  const ww = wx.map((x) => 1 + (x - wx[0]) / span); // newer states weigh up to twice the oldest

  // Player-pool growth on the same axis (one fit for the whole case).
  const poolFit = win.length >= 3 ? fitSlope(wx, win.map((r) => Math.log(Math.max(1, r.players_tracked))), ww) : { slope: 0, resid: 0 };
  const poolSlope = Math.min(3, Math.max(-0.5, poolFit.slope));

  // Earned-count slopes per trophy, for the pooled shrinkage target.
  const earnedSlopes: number[] = [];
  const perTrophy: Array<{ trend: number; resid: number; countLogit: number | null }> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const pts: Array<{ x: number; l: number; e: number; w: number }> = [];
    win.forEach((r, k) => {
      const rate = r.rates[i];
      if (rate !== null && rate !== undefined) {
        pts.push({ x: wx[k], l: logit(rate), e: (rate / 100) * r.players_tracked, w: ww[k] });
      }
    });
    if (pts.length >= 3) {
      const trendFit = fitSlope(pts.map((p) => p.x), pts.map((p) => p.l), pts.map((p) => p.w));
      const earnFit = fitSlope(pts.map((p) => p.x), pts.map((p) => Math.log(p.e + 0.5)), pts.map((p) => p.w));
      earnedSlopes.push(earnFit.slope);
      perTrophy.push({ trend: trendFit.slope, resid: trendFit.resid, countLogit: null });
      // Stash the raw earned slope on the row for the blend below.
      (perTrophy[i] as unknown as { earnSlope: number }).earnSlope = earnFit.slope;
    } else {
      perTrophy.push({ trend: 0, resid: 0, countLogit: null });
      (perTrophy[i] as unknown as { earnSlope: number }).earnSlope = Number.NaN;
    }
  }
  const pooledEarnSlope = earnedSlopes.length ? median(earnedSlopes) : 0;
  for (let i = 0; i < c.trophies.length; i++) {
    const raw = (perTrophy[i] as unknown as { earnSlope: number }).earnSlope;
    const lastRate = last.rates[i];
    if (Number.isFinite(raw) && lastRate !== null && lastRate !== undefined && win.length >= 3) {
      const earnedLast = (lastRate / 100) * last.players_tracked;
      // Small counts get pulled hard toward the pooled slope; big counts keep theirs.
      const shrink = earnedLast < 3 ? 0.7 : earnedLast < 10 ? 0.4 : 0.15;
      const bE = raw * (1 - shrink) + pooledEarnSlope * shrink;
      const earnedTarget = Math.exp(Math.log(earnedLast + 0.5) + bE * dx) - 0.5;
      const poolTarget = last.players_tracked * Math.exp(poolSlope * dx);
      perTrophy[i].countLogit = logit(Math.max(0, (100 * earnedTarget) / Math.max(1, poolTarget)));
    }
  }

  // Refresh-jump uncertainty: large when the page has barely ever changed.
  const jump = states.length <= 1 ? 0.62 : 0.12 + 0.3 / Math.sqrt(states.length - 1);

  const trophies = c.trophies.map((t, i) => {
    const r = last.rates[i] ?? 0;
    const lLast = logit(r);
    const info = perTrophy[i];
    let centre: number;
    if (states.length <= 1) {
      // One stale state: expect the unseen refresh. Tracked players multiply,
      // the newcomers hold almost nothing yet, so rates dilute downward —
      // hardest for the platinum, barely at all for the saturated trophy.
      const dilution = r >= 99.9 ? 0.2 : t.tier === 'platinum' ? 0.55 : 0.38;
      centre = lLast - dilution;
    } else {
      const trendLogit = lLast + 0.75 * info.trend * dx;
      if (info.countLogit !== null) {
        const earnedLast = (r / 100) * last.players_tracked;
        const wCount = earnedLast >= 20 ? 0.5 : 0.45;
        centre = trendLogit * (1 - wCount) + info.countLogit * wCount;
      } else {
        centre = trendLogit;
      }
      // Never let the blend run away from the last read over one horizon.
      centre = lLast + Math.min(1.6, Math.max(-2.2, centre - lLast));
      if (r >= 99.9) centre = Math.max(lLast - 0.15, Math.min(centre, lLast));
    }
    let sigma = Math.sqrt((0.55 * Math.sqrt(days)) ** 2 + Math.min(0.5, 0.5 * info.resid) ** 2 + jump ** 2);
    sigma = Math.min(1.55, Math.max(0.3, sigma));
    if (r >= 99.9) sigma = Math.max(0.18, sigma * 0.5);
    return { id: t.id, q: Z.map((z) => round4(invLogit(centre + z * sigma))) };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
