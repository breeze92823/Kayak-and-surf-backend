import { MongoClient, type Collection } from "mongodb";
import type { DailyDoc } from "./daily.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted half of the client state (what `saveProgress` carries).
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  // Display name as of the last save, so an offline leaderboard row still has something to show.
  username?: string;
  // Bloxity avatar JSON as last reported, so a board's top row can still be dressed offline.
  avatar?: string;
  pfp?: string; // Bloxity profile picture URL as last reported
  tutorialStep?: number; // new-player tutorial progress; a doc without it predates the tutorial (client treats it as finished)
  coins?: number;
  trophies?: number;
  bestDistance?: number; // highest climb, metres
  playtime?: number; // s
  coaches?: string[]; // owned coach ids
  equippedCoaches?: string[]; // equipped coach ids (at most COACH_SLOTS)
  kayaks?: string[]; // owned Kayak Shop boat ids (client kayaks.js)
  kayak?: string; // the equipped boat (an owned one); its coach slots decide how many coaches stay equipped
  discovered?: string[]; // Pet Index entries, "<petId>:<variant>"
  pets?: SavedPet[]; // owned pets (client petInventory.js), at most PET_STORAGE_MAX
  petTeam?: number[]; // equipped pets' uids (owned ones, at most petTeamSize)
  petTeamSize?: number; // team slots bought (client PET_TEAM.team .. maxTeam)
  nextPetUid?: number; // the next uid the client hands out
  lastSeen?: number; // epoch ms of the last activity
  // Daily rewards (src/daily.ts): this week's start and the days claimed. Written by the server
  // only (claimDaily, and on first load), never by saveProgress. Older docs lack it.
  daily?: DailyDoc;
  version: number;
  updatedAt: Date;
}

// One owned pet: a per-save uid, the pet's id (client petIndex.js PETS) and its variant.
export interface SavedPet {
  uid: number;
  id: string;
  variant: string;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent. A failure only
    // means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ coins: -1 });
      await players.createIndex({ trophies: -1 });
      await players.createIndex({ playtime: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the leaderboard/save logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
