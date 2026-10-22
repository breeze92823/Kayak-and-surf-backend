import { schema, t, type SchemaType } from "@colyseus/schema";
import { SPAWN } from "../../constants.js";

// The live roster: everything other clients need to draw this player. The server stores and
// relays it; the game is client-authoritative. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a character, add a field here and accept it in WorldRoom's
// `pose` / `set*` handlers.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    handle: t.string().default(""), // client-reported Bloxity @username ("" = none), shown in the Trade list
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players can trade
    trading: t.boolean().default(false), // in a trade right now (the Trade list shows "Busy")
    x: t.float64().default(SPAWN.x),
    y: t.float64().default(SPAWN.y),
    z: t.float64().default(SPAWN.z),
    yaw: t.float64().default(0),
    speed01: t.float64().default(0), // 0..1 paddle/surf speed factor -- purely cosmetic
    grounded: t.boolean().default(true),
    pose: t.string().default(""), // client animation name ("" = none), e.g. "paddle", "surf"
    // The player's Bloxity avatar { equipped, proportions } as an opaque JSON string,
    // stored and relayed as-is (length-capped, never parsed here).
    avatar: t.string().default(""),
    // What the leaderboards rank (mirrored from saves).
    coins: t.float64().default(0),
    trophies: t.float64().default(0),
    playtime: t.float64().default(0),
    bestDistance: t.float64().default(0), // highest climb (m), mirrored from saves / live `climbBest`
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
