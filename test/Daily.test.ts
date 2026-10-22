import assert from "assert";
import type { Collection } from "mongodb";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { claimDaily, DAILY_DAY_MS, DAILY_REWARDS, freshDaily, sanitizeDaily } from "../src/daily.js";
import { resolveTutorialStep } from "../src/sanitize.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { testServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Just what the daily path calls: findOne() and updateOne() (upsert, $set, $setOnInsert).
function fakePlayers(seed: PlayerDoc[] = []) {
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
      docs.set(filter._id, { ...base, ...(update.$set ?? {}) });
      return { modifiedCount: 1 };
    },
    find() {
      const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => [...docs.values()] };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

describe("daily rewards", () => {
  const T0 = 1_700_000_000_000;

  it("opens a day at a time, claims each once, and starts the next week a week on", () => {
    let d = freshDaily(T0);
    assert.deepStrictEqual(claimDaily(d, 2, T0), { ok: false, daily: d, reason: "locked" });
    assert.strictEqual((claimDaily(d, 0, T0) as any).reason, "day");
    assert.strictEqual((claimDaily(d, "1", T0) as any).reason, "day");
    const one = claimDaily(d, 1, T0) as any;
    assert.ok(one.ok);
    assert.deepStrictEqual(one.reward, DAILY_REWARDS[0]);
    assert.deepStrictEqual(one.daily.claimed, [1]);
    assert.deepStrictEqual(d.claimed, [], "pure: the input is untouched");
    d = one.daily;
    assert.strictEqual((claimDaily(d, 1, T0) as any).reason, "claimed");
    // Missed days stay claimable later, in any order.
    for (const day of [7, 2, 3, 4, 5, 6]) {
      const r = claimDaily(d, day, T0 + 6 * DAILY_DAY_MS) as any;
      assert.ok(r.ok, `day ${day}`);
      d = r.daily;
    }
    // All seven claimed: a new week whose Day 1 opens a week after the last began.
    assert.deepStrictEqual(d, { start: T0 + 7 * DAILY_DAY_MS, claimed: [] });
    assert.strictEqual((claimDaily(d, 1, T0 + 6.5 * DAILY_DAY_MS) as any).reason, "locked");
  });

  it("restarts a stale week from now rather than handing over a week at once", () => {
    let d = freshDaily(T0);
    for (let day = 1; day <= 7; day++) d = (claimDaily(d, day, T0 + 30 * DAILY_DAY_MS) as any).daily;
    assert.deepStrictEqual(d, { start: T0 + 30 * DAILY_DAY_MS, claimed: [] });
  });

  it("sanitizes a stored week", () => {
    assert.deepStrictEqual(sanitizeDaily(null, T0), freshDaily(T0));
    assert.deepStrictEqual(sanitizeDaily({ start: "x" }, T0), freshDaily(T0));
    assert.deepStrictEqual(sanitizeDaily({ start: T0 + 99, claimed: [3, 1, 3, 9, 0, 2.5, "4"] }, T0), { start: T0, claimed: [1, 3] });
  });

  describe("in the room", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    before(async () => (colyseus = await testServer()));
    beforeEach(async () => await colyseus.cleanup());
    afterEach(() => __setPlayersForTest(null));

    it("grants each day once, saves the claim, and never takes it from saveProgress", async () => {
      const fake = fakePlayers([{ _id: "d1", coins: 10, version: 1, updatedAt: new Date() }]);
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { userId: "d1" });
      c.onMessage("daily", () => {}); // sent on load (may land before this handler)
      await sleep(100);
      assert.deepStrictEqual(fake.docs.get("d1")!.daily!.claimed, [], "an older doc gets its week saved on load");

      const got: any[] = [];
      c.onMessage("dailyClaimed", (m: any) => got.push(["claimed", m]));
      c.onMessage("dailyDenied", (m: any) => got.push(["denied", m]));
      c.send("claimDaily", { day: 1 });
      c.send("claimDaily", { day: 1 }); // a double click
      c.send("claimDaily", { day: 2 }); // not open yet
      await sleep(150);
      // Exactly one grant. (The grant waits on its save, so the refusals can arrive first.)
      assert.strictEqual(got.length, 3);
      const claimed = got.filter(([k]) => k === "claimed").map(([, m]) => m);
      assert.strictEqual(claimed.length, 1);
      assert.deepStrictEqual(claimed[0].reward, DAILY_REWARDS[0]);
      assert.deepStrictEqual(claimed[0].daily.claimed, [1]);
      assert.strictEqual(claimed[0].daily.dayMs, DAILY_DAY_MS);
      const reasons = got.filter(([k]) => k === "denied").map(([, m]) => m.reason).sort();
      assert.deepStrictEqual(reasons, ["claimed", "locked"]);
      assert.deepStrictEqual(fake.docs.get("d1")!.daily!.claimed, [1]);

      // saveProgress can't touch the week.
      c.send("saveProgress", { coins: 5, daily: { start: 0, claimed: [] } });
      await sleep(100);
      assert.deepStrictEqual(fake.docs.get("d1")!.daily!.claimed, [1]);

      // A guest has no server-side calendar.
      const guest = await colyseus.connectTo(room, { userId: "guest-abc" });
      let denied: any = null;
      guest.onMessage("daily", () => {});
      guest.onMessage("dailyDenied", (m: any) => (denied = m));
      await sleep(100);
      guest.send("claimDaily", { day: 1 });
      await sleep(100);
      assert.strictEqual(denied?.reason, "signin");
    });

    it("starts and saves a week for a brand-new account without hiding its tutorial", async () => {
      const fake = fakePlayers();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      await colyseus.connectTo(room, { userId: "newbie" });
      await sleep(100);
      const doc = fake.docs.get("newbie")!;
      assert.deepStrictEqual(doc.daily!.claimed, []);
      assert.strictEqual(resolveTutorialStep(doc), 0, "still starts the tutorial from the beginning");
    });

    it("gives a signed-in player a week for the connection when there is no database", async () => {
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { userId: "nodb" });
      let claimed: any = null;
      c.onMessage("daily", () => {});
      c.onMessage("dailyClaimed", (m: any) => (claimed = m));
      await sleep(100);
      c.send("claimDaily", { day: 1 });
      await sleep(100);
      assert.deepStrictEqual(claimed?.reward, DAILY_REWARDS[0]);
    });
  });
});
