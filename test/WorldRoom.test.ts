import assert from "assert";
import type { Collection } from "mongodb";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { SPAWN, WORLD_BOUNDS } from "../src/constants.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { testServer } from "./server.js";

// waitForNextPatch() resolves on the server's tick, which can be before a
// connected client has decoded it; poll the client's view instead.
async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

// Hand-rolled fake `players` collection implementing only the subset WorldRoom.ts calls:
// find().sort().limit().toArray(), updateOne() (upsert, $set), findOne().
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return { modifiedCount: 0 };
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      const next: any = { ...base, ...(update.$set ?? {}) };
      docs.set(filter._id, next as PlayerDoc);
      return { modifiedCount: 1 };
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

describe("WorldRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });
  afterEach(() => __setPlayersForTest(null));

  it("starts a joining player at the spawn, with their name and avatar", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const avatar = JSON.stringify({ equipped: { hatId: "3" }, proportions: { height: 1.2 } });
    const c1 = await colyseus.connectTo(room, { username: "Striker", avatar });
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    const s = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s.username, "Striker");
    assert.strictEqual(s.avatar, avatar);
    assert.strictEqual(s.x, SPAWN.x);
    assert.strictEqual(s.z, SPAWN.z);
  });

  it("relays pose to other players and sanitises it", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("pose", { x: -60.5, y: 2, z: -3, yaw: 0.5, speed01: 7, grounded: false, pose: "paddle" });
    await room.waitForNextPatch();
    const s = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s.x, -60.5);
    assert.strictEqual(s.y, 2);
    assert.strictEqual(s.z, -3);
    assert.strictEqual(s.yaw, 0.5);
    assert.strictEqual(s.speed01, 1); // clamped to 0..1
    assert.strictEqual(s.grounded, false);
    assert.strictEqual(s.pose, "paddle");

    // NaN is ignored, null clears the pose, out-of-world positions are clamped.
    c1.send("pose", { x: NaN, z: 99999, pose: null });
    await room.waitForNextPatch();
    const s2 = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s2.x, -60.5);
    assert.strictEqual(s2.z, WORLD_BOUNDS.maxZ);
    assert.strictEqual(s2.pose, "");
  });

  it("relays avatar changes and rejects oversized ones", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room, { avatar: "{}" });
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("setAvatar", { avatar: '{"equipped":{"backId":"9"}}' });
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, '{"equipped":{"backId":"9"}}');

    c1.send("setAvatar", { avatar: "x".repeat(3500) });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, '{"equipped":{"backId":"9"}}'); // ignored

    c1.send("setAvatar", { avatar: "" }); // signing out clears it
    await until(() => c2.state.players.get(c1.sessionId)!.avatar === "");
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, "");
  });

  it("removes a player who leaves", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.size, 2);

    await c1.leave();
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.size, 1);
    assert.strictEqual(c2.state.players.has(c1.sessionId), false);
  });

  it("saves a signed-in player's progress", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Striker" });

    c.send("saveProgress", { coins: 500, trophies: 7, bestDistance: 120, coaches: ["duck", "shark"], equippedCoaches: ["duck"], discovered: ["chick:normal", "goat:shiny"] });
    // (A new account's daily week is saved on load too, so wait for the save itself.)
    await until(() => fake.docs.get("u1")?.coins !== undefined);
    const doc = fake.docs.get("u1")!;
    assert.strictEqual(doc.coins, 500);
    assert.strictEqual(doc.username, "Striker");
    assert.deepStrictEqual(doc.coaches, ["duck", "shark"]);
    assert.deepStrictEqual(doc.discovered, ["chick:normal", "goat:shiny"]);
    const live = room.state.players.get(c.sessionId)!;
    assert.strictEqual(live.coins, 500);
    assert.strictEqual(live.trophies, 7);
    assert.strictEqual(live.bestDistance, 120);
  });

  it("sends a returning account its saved progress, and noProgress to a new one", async () => {
    const fake = fakePlayersCollection([
      { _id: "u2", username: "Back", coins: 900, trophies: 3, coaches: ["duck"], version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});

    // The reply can land before a client handler is registered, so capture it server-side.
    const sent: [string, any][] = [];
    const orig = (room as any).loadProgress.bind(room);
    (room as any).loadProgress = (c: any, ...rest: any[]) => {
      const send = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        sent.push([type, msg]);
        send(type, msg);
      };
      return orig(c, ...rest);
    };

    const back = await colyseus.connectTo(room, { userId: "u2", username: "Back" });
    await colyseus.connectTo(room, { userId: "u-new", username: "Fresh" });
    await until(() => sent.length >= 2);

    const progress = sent.find(([t]) => t === "progress")![1];
    assert.strictEqual(progress.coins, 900);
    assert.deepStrictEqual(progress.coaches, ["duck"]);
    assert.ok(sent.some(([t]) => t === "noProgress"));

    const p = room.state.players.get(back.sessionId)!;
    assert.strictEqual(p.trophies, 3);
    assert.strictEqual(p.coins, 900);
  });

  it("never persists guests", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-abc", username: "Guest" });
    c.send("saveProgress", { coins: 5, trophies: 9 });
    await until(() => room.state.players.get(c.sessionId)?.trophies === 9);
    assert.strictEqual(fake.docs.size, 0);
    assert.strictEqual(room.state.players.get(c.sessionId)!.trophies, 9); // still on the live board
  });

  it("broadcasts leaderboards merging saved and online players", async () => {
    const fake = fakePlayersCollection([
      { _id: "old", username: "Veteran", trophies: 50, coins: 4, playtime: 7200, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u3", username: "Newbie" });
    let boards: any = null;
    c.onMessage("leaderboard", (m) => (boards = m));
    c.send("saveProgress", { trophies: 10, coins: 1, playtime: 60 });
    await until(() => room.state.players.get(c.sessionId)?.trophies === 10);
    boards = null;
    await (room as any).refreshLeaderboard();
    await until(() => boards !== null);
    assert.deepStrictEqual(boards.trophies.map((r: any) => r.name), ["Veteran", "Newbie"]);
    assert.deepStrictEqual(boards.coins.map((r: any) => r.value), [4, 1]);
    assert.deepStrictEqual(boards.playtime.map((r: any) => r.value), [7200, 60]);
  });
});
