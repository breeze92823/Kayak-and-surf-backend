// Daily rewards: a 7-day calendar per signed-in account (client src/daily.js and the Daily Rewards
// window, src/hud/daily.js), after Paper-plane-backend's. Day N opens (N - 1) days after the week's
// `start` and stays claimable until claimed, in any order. Claiming the last unclaimed day starts
// the next week a full week after this one began (or now, if that is already past), so a returning
// player never banks a whole week at once.
//
// The SERVER decides here: whether a day is open, whether it was already claimed, and what it
// grants. The client only applies the reward it is handed. Guests have no account to hold this, so
// the client keeps theirs in localStorage and this never sees them.

// One reward, as the client applies it (client daily.js grant()). Coins / trophies are added to the
// counters, spins to the spin wheel, a boost runs `time` s (client boosts.js), a pet (client
// petIndex.js id) joins the inventory.
export type DailyReward =
  | { kind: "coins" | "trophies" | "spins"; amount: number }
  | { kind: "boost"; boost: "speed" | "stamina" | "win"; pct: number; time: number }
  | { kind: "pet"; pet: string };

// Day 1 first. Mirrors the client's DAILY_REWARDS.days (src/config.js), which only draws them.
export const DAILY_REWARDS: readonly DailyReward[] = [
  { kind: "coins", amount: 5e3 },
  { kind: "spins", amount: 1 },
  { kind: "boost", boost: "speed", pct: 50, time: 600 },
  { kind: "coins", amount: 25e3 },
  { kind: "trophies", amount: 15 },
  { kind: "spins", amount: 3 },
  { kind: "pet", pet: "pegasus" },
];
export const DAILY_DAYS = DAILY_REWARDS.length;

// Real days in production; DAILY_DAY_MS (env) shortens them for local testing.
export const DAILY_DAY_MS = Number(process.env.DAILY_DAY_MS) > 0 ? Number(process.env.DAILY_DAY_MS) : 86_400_000;

// Saved on the player's doc as `daily`.
export interface DailyDoc {
  start: number; // epoch ms the current week's Day 1 opened
  claimed: number[]; // days (1..DAILY_DAYS) claimed this week
}

export const freshDaily = (now: number): DailyDoc => ({ start: now, claimed: [] });

// A stored (or hand-edited) doc made safe: a finite start no later than now, and unique in-range
// claimed days. Anything unusable starts a fresh week.
export function sanitizeDaily(raw: unknown, now: number): DailyDoc {
  const src = raw as Partial<DailyDoc> | null;
  if (!src || typeof src.start !== "number" || !Number.isFinite(src.start)) return freshDaily(now);
  const claimed = Array.isArray(src.claimed)
    ? [...new Set(src.claimed.filter((d) => Number.isInteger(d) && d >= 1 && d <= DAILY_DAYS))].sort((a, b) => a - b)
    : [];
  return { start: Math.min(src.start, now), claimed };
}

export const dailyOpensAt = (d: DailyDoc, day: number) => d.start + (day - 1) * DAILY_DAY_MS;

// What the client is sent: the week plus the server's clock and day length, so its countdowns run
// on server time whatever the device clock says.
export const dailyView = (d: DailyDoc, now: number) => ({ start: d.start, claimed: d.claimed, now, dayMs: DAILY_DAY_MS });

export type ClaimResult =
  | { ok: true; daily: DailyDoc; reward: DailyReward }
  | { ok: false; daily: DailyDoc; reason: "day" | "claimed" | "locked" };

// Pure: claims `day` on `d` at `now`, returning the new doc (never mutating `d`).
export function claimDaily(d: DailyDoc, day: unknown, now: number): ClaimResult {
  if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > DAILY_DAYS) return { ok: false, daily: d, reason: "day" };
  const n = day as number;
  if (d.claimed.includes(n)) return { ok: false, daily: d, reason: "claimed" };
  if (now < dailyOpensAt(d, n)) return { ok: false, daily: d, reason: "locked" };
  const claimed = [...d.claimed, n].sort((a, b) => a - b);
  const daily = claimed.length >= DAILY_DAYS ? { start: Math.max(d.start + DAILY_DAYS * DAILY_DAY_MS, now), claimed: [] } : { start: d.start, claimed };
  return { ok: true, daily, reward: DAILY_REWARDS[n - 1] };
}
