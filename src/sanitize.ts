import {
  CURRENCY_MAX, TROPHIES_MAX, PLAY_SECONDS_MAX, DISTANCE_MAX, TUTORIAL_DONE_STEP,
  COACH_SLOTS, COACHES_MAX, BOATS_MAX, PET_VARIANTS, DISCOVERED_MAX, ID_PATTERN,
  PET_STORAGE_MAX, PET_TEAM_MAX, PET_UID_MAX,
} from "./constants.js";
import type { PlayerDoc, SavedPet } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Roster ids (coaches, boats): slug strings, no duplicates, bounded count.
function sanitizeIds(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is string => typeof id === "string" && ID_PATTERN.test(id));
  return [...new Set(ids)].slice(0, max);
}
export function sanitizeCoaches(raw: unknown): string[] {
  return sanitizeIds(raw, COACHES_MAX);
}

// Pet Index entries "<petId>:<variant>", known variants only, no duplicates, bounded count.
export function sanitizeDiscovered(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ok = raw.filter((e): e is string => {
    if (typeof e !== "string") return false;
    const [id, variant, ...rest] = e.split(":");
    return rest.length === 0 && ID_PATTERN.test(id) && PET_VARIANTS.includes(variant);
  });
  return [...new Set(ok)].slice(0, DISCOVERED_MAX);
}

// Owned pets { uid, id, variant }: positive integer uids (no duplicates), slug ids, known variants,
// at most PET_STORAGE_MAX.
export function sanitizePets(raw: unknown): SavedPet[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPet[] = [];
  const uids = new Set<number>();
  for (const p of raw) {
    if (out.length >= PET_STORAGE_MAX) break;
    if (!isObject(p)) continue;
    const { uid, id, variant } = p;
    if (!Number.isInteger(uid) || (uid as number) < 1 || (uid as number) > PET_UID_MAX || uids.has(uid as number)) continue;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof variant !== "string" || !PET_VARIANTS.includes(variant)) continue;
    uids.add(uid as number);
    out.push({ uid: uid as number, id, variant });
  }
  return out;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save and their leaderboard rows.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.coins)) out.coins = clampNum(raw.coins, CURRENCY_MAX);
  if (finite(raw.trophies)) out.trophies = clampInt(raw.trophies, TROPHIES_MAX);
  if (finite(raw.bestDistance)) out.bestDistance = clampNum(raw.bestDistance, DISTANCE_MAX);
  if (finite(raw.tutorialStep)) out.tutorialStep = clampInt(raw.tutorialStep, TUTORIAL_DONE_STEP);
  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);

  if (raw.coaches !== undefined) out.coaches = sanitizeCoaches(raw.coaches);
  if (raw.equippedCoaches !== undefined) {
    // Only owned coaches can be equipped. When this save doesn't carry `coaches`, trust the ids' shape only.
    const owned = out.coaches;
    out.equippedCoaches = sanitizeCoaches(raw.equippedCoaches)
      .filter((id) => !owned || owned.includes(id))
      .slice(0, COACH_SLOTS);
  }
  if (raw.kayaks !== undefined) out.kayaks = sanitizeIds(raw.kayaks, BOATS_MAX);
  // Only an owned boat can be equipped. When this save doesn't carry `kayaks`, trust the id's shape only.
  if (typeof raw.kayak === "string" && ID_PATTERN.test(raw.kayak) && (!out.kayaks || out.kayaks.includes(raw.kayak))) out.kayak = raw.kayak;
  if (raw.discovered !== undefined) out.discovered = sanitizeDiscovered(raw.discovered);
  if (raw.pets !== undefined) out.pets = sanitizePets(raw.pets);
  if (finite(raw.petTeamSize)) out.petTeamSize = clampInt(raw.petTeamSize, PET_TEAM_MAX, 1);
  if (raw.petTeam !== undefined) {
    // Only owned pets can be in the team. When this save doesn't carry `pets`, trust the uids' shape only.
    const owned = out.pets && new Set(out.pets.map((p) => p.uid));
    const size = out.petTeamSize ?? PET_TEAM_MAX;
    const uids = Array.isArray(raw.petTeam) ? raw.petTeam.filter((u): u is number => Number.isInteger(u) && u >= 1 && u <= PET_UID_MAX) : [];
    out.petTeam = [...new Set(uids)].filter((u) => !owned || owned.has(u)).slice(0, size);
  }
  if (finite(raw.nextPetUid)) out.nextPetUid = clampInt(raw.nextPetUid, PET_UID_MAX + 1, 1);
  return out;
}

// What loadProgress sends down as tutorialStep: a doc that predates the tutorial belongs to a
// player who was never shown it, so it reads as finished. New accounts get a doc with an explicit
// step (WorldRoom.ts persistAvatar) or no doc at all (noProgress -> the client starts at 0).
export function resolveTutorialStep(doc: Partial<PlayerDoc>): number {
  return finite(doc.tutorialStep) ? clampInt(doc.tutorialStep, TUTORIAL_DONE_STEP) : TUTORIAL_DONE_STEP;
}
