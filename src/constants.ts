// Keep in step with the client's src/config.js by hand.
export const ROOM_MAX_CLIENTS = 50;

// Where a player appears for everyone else before their first `pose` arrives (client SPAWN).
export const SPAWN = { x: 0, y: 0, z: 10 };

// Playable area (client WORLD_BOUNDS: x +-90, z -215..115, northZ -75013 up the 75 km slide, whose top
// is ~27.3 km up), with a little slack: a forged pose cannot put a player outside the world for
// everyone else to see.
export const WORLD_BOUNDS = { minX: -100, maxX: 100, minZ: -75100, maxZ: 125, minY: -40, maxY: 27500 };

// Longest accepted strings.
export const NAME_MAX = 64;
export const POSE_MAX = 32;
// Bloxity avatar JSON, relayed as-is. Kept under the 4 KB cap of the join request's options.
export const AVATAR_MAX_LEN = 3000;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// Leaderboards: how often WorldRoom re-queries Mongo for the all-time top players per stat, how
// many rows it fetches per stat before merging with the live roster, and how many it sends.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;
export const LEADERBOARD_ROWS = 10;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot push a bogus number onto the
// leaderboards. Generous ceilings, not game rules.
export const CURRENCY_MAX = 1e24; // coins
export const TROPHIES_MAX = 1e12;
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year
// Longest climb the slide allows (client SLIDE.run = 75000 m) with slack; bestDistance is metres.
export const DISTANCE_MAX = 76000;
// Onboarding runs steps 0..TUTORIAL_DONE_STEP (the finished marker). Keep in step with the client tutorial.
export const TUTORIAL_DONE_STEP = 10;

// Coach window (client COACH_TRAINING): up to `slots` coaches equipped at once, out of a roster of ~30.
export const COACH_SLOTS = 3;
export const COACHES_MAX = 64;
// Kayak Shop boats (client KAYAK_SHOP.boats, ~17): owned ids, one of them equipped.
export const BOATS_MAX = 64;
// Pet Index discoveries are "<petId>:<variant>" (client petIndex.js PETS x VARIANTS).
export const PET_VARIANTS: readonly string[] = ["normal", "big", "huge", "shiny", "rainbow"];
export const DISCOVERED_MAX = 1024;
// Owned pets (client petInventory.js snapshot): { uid, id, variant }, at most PET_STORAGE_MAX of
// them (client PET_TEAM.storage, with slack), and a team of at most PET_TEAM_MAX uids (client PET_TEAM.maxTeam).
export const PET_STORAGE_MAX = 200;
export const PET_TEAM_MAX = 6;
export const PET_UID_MAX = 1e9;
// Pet trades (src/rooms/trades.ts): at most `maxPets` per side, and a swap may not push anyone past
// `storage` pets (client PET_TEAM.storage). A request waits `requestMs` for an answer; a player may
// send one every `requestCooldownMs`; once both accept, the swap happens after `countdownMs`.
export const TRADE = { maxPets: 9, storage: 50, requestMs: 15_000, requestCooldownMs: 1_000, countdownMs: 3_000 };
// Ids from the client's rosters (coaches, pets): lowercase slug, so nothing odd is stored or relayed.
export const ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
