import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { TRADE } from "../src/constants.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { testServer } from "./server.js";

async function until(check: () => boolean, ms = 1500) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

const TYPES = ["tradeIncoming", "tradeIncomingGone", "tradeRequestEnded", "tradeOpen", "tradeUpdate", "tradeClosed", "tradeDone", "progress", "noProgress"];

// Records every trade message a test client gets: last(type) is the newest of that type.
function inbox(c: any) {
  const got: [string, any][] = [];
  for (const type of TYPES) c.onMessage(type, (m: any) => got.push([type, m]));
  return {
    got,
    last: (type: string) => [...got].reverse().find(([t]) => t === type)?.[1],
    count: (type: string) => got.filter(([t]) => t === type).length,
  };
}

const pet = (uid: number, id = "chick", variant = "normal") => ({ uid, id, variant });

// Minimal fake `players` collection: findOne + updateOne ($set / $setOnInsert / upsert).
function fakePlayers() {
  const docs = new Map<string, any>();
  return {
    docs,
    async findOne(f: { _id: string }) {
      return docs.get(f._id) ?? null;
    },
    async updateOne(f: { _id: string }, u: any) {
      docs.set(f._id, { ...(docs.get(f._id) ?? { _id: f._id, ...u.$setOnInsert }), ...u.$set });
      return { modifiedCount: 1 };
    },
    find(): any {
      const cursor: any = { sort: () => cursor, limit: () => cursor, toArray: async (): Promise<any[]> => [] };
      return cursor;
    },
  };
}

describe("Trades", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const countdown = TRADE.countdownMs;

  before(async () => {
    colyseus = await testServer();
    TRADE.countdownMs = 60; // keep the tests quick
  });
  after(() => {
    TRADE.countdownMs = countdown;
  });
  beforeEach(async () => colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  // Two signed-in players with saved pets, already in an open trade.
  async function openTrade(petsA = [pet(1, "chick"), pet(2, "goat")], petsB = [pet(1, "bear", "shiny")]) {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "ua", username: "Alice", handle: "alice1" });
    const b = await colyseus.connectTo(room, { userId: "ub", username: "Bob", handle: "bob2" });
    const ia = inbox(a);
    const ib = inbox(b);
    a.send("saveProgress", { pets: petsA, petsRev: 0 });
    b.send("saveProgress", { pets: petsB, petsRev: 0 });
    await until(() => (room as any).pets.get(a.sessionId)?.length === petsA.length && (room as any).pets.get(b.sessionId)?.length === petsB.length);
    a.send("tradeRequest", { to: b.sessionId });
    await until(() => !!ib.last("tradeIncoming"));
    assert.deepStrictEqual(ib.last("tradeIncoming"), { from: a.sessionId, name: "Alice" });
    b.send("tradeRespond", { from: a.sessionId, ok: true });
    await until(() => !!ia.last("tradeOpen") && !!ib.last("tradeOpen"));
    return { room, a, b, ia, ib };
  }

  it("lists the @handle and who can trade", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "ua", username: "Alice", handle: "alice1" });
    const g = await colyseus.connectTo(room, { userId: "guest-x", username: "Guest" });
    await until(() => room.state.players.get(a.sessionId)?.signedIn === true);
    assert.strictEqual(room.state.players.get(a.sessionId)!.handle, "alice1");
    assert.strictEqual(room.state.players.get(g.sessionId)!.signedIn, false);
  });

  it("keeps guests out of trades", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "ua", username: "Alice" });
    const g = await colyseus.connectTo(room, { userId: "guest-x", username: "Guest" });
    const ia = inbox(a);
    const ig = inbox(g);
    g.send("tradeRequest", { to: a.sessionId });
    a.send("tradeRequest", { to: g.sessionId });
    await until(() => !!ig.last("tradeRequestEnded") && !!ia.last("tradeRequestEnded"));
    assert.strictEqual(ig.last("tradeRequestEnded").reason, "guest");
    assert.strictEqual(ia.last("tradeRequestEnded").reason, "unavailable");
    assert.strictEqual(ia.count("tradeIncoming") + ig.count("tradeIncoming"), 0);
  });

  it("tells the sender when a request is declined", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "ua", username: "Alice" });
    const b = await colyseus.connectTo(room, { userId: "ub", username: "Bob" });
    const ia = inbox(a);
    const ib = inbox(b);
    a.send("tradeRequest", { to: b.sessionId });
    await until(() => !!ib.last("tradeIncoming"));
    b.send("tradeRespond", { from: a.sessionId, ok: false });
    await until(() => !!ia.last("tradeRequestEnded"));
    assert.deepStrictEqual(ia.last("tradeRequestEnded"), { to: b.sessionId, reason: "declined" });
    assert.strictEqual(room.state.players.get(a.sessionId)!.trading, false);
  });

  it("swaps the offered pets once both accept, and saves both sides", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake as any);
    const { room, a, b, ia, ib } = await openTrade();
    assert.strictEqual(room.state.players.get(a.sessionId)!.trading, true);

    a.send("tradeOffer", { uids: [2, 2, 99] }); // a repeat and a pet Alice doesn't own are dropped
    b.send("tradeOffer", { uids: [1] });
    await until(() => ia.last("tradeUpdate")?.theirs.length === 1 && ib.last("tradeUpdate")?.theirs.length === 1);
    assert.deepStrictEqual(ia.last("tradeUpdate").mine, [2]);
    assert.deepStrictEqual(ib.last("tradeUpdate").theirs, [pet(2, "goat")]);

    a.send("tradeAccept", { ok: true });
    await until(() => ib.last("tradeUpdate")?.accepted.them === true);
    b.send("tradeAccept", { ok: true });
    await until(() => !!ia.last("tradeDone") && !!ib.last("tradeDone"));

    // Bob's uid 1 clashes with Alice's chick, so it arrives as a fresh uid (2, free now the goat is gone).
    assert.deepStrictEqual(ia.last("tradeDone"), { gave: [2], got: [pet(2, "bear", "shiny")], petsRev: 1 });
    assert.deepStrictEqual(ib.last("tradeDone"), { gave: [1], got: [pet(2, "goat")], petsRev: 1 });
    assert.deepStrictEqual((fake.docs.get("ua") as PlayerDoc).pets, [pet(1, "chick"), pet(2, "bear", "shiny")]);
    assert.deepStrictEqual((fake.docs.get("ub") as PlayerDoc).pets, [pet(2, "goat")]);
    assert.strictEqual(room.state.players.get(a.sessionId)!.trading, false);

    // A save written before the trade landed can't bring Alice's goat back...
    a.send("saveProgress", { pets: [pet(1, "chick"), pet(2, "goat")], petsRev: 0 });
    // ...one written after it is taken as usual.
    b.send("saveProgress", { pets: [pet(2, "goat"), pet(5, "chick")], petsRev: 1 });
    await until(() => (fake.docs.get("ub") as PlayerDoc).pets?.length === 2);
    assert.deepStrictEqual((fake.docs.get("ua") as PlayerDoc).pets, [pet(1, "chick"), pet(2, "bear", "shiny")]);
    assert.deepStrictEqual((room as any).pets.get(a.sessionId), [pet(1, "chick"), pet(2, "bear", "shiny")]);
  });

  it("clears both Accepts when an offer changes", async () => {
    const { a, b, ia, ib } = await openTrade();
    a.send("tradeOffer", { uids: [1] });
    await until(() => ib.last("tradeUpdate")?.theirs.length === 1);
    b.send("tradeAccept", { ok: true });
    await until(() => ia.last("tradeUpdate")?.accepted.them === true);
    a.send("tradeOffer", { uids: [1, 2] });
    await until(() => ia.last("tradeUpdate")?.mine.length === 2);
    assert.deepStrictEqual(ia.last("tradeUpdate").accepted, { me: false, them: false });
    assert.strictEqual(ia.count("tradeDone"), 0);
  });

  it("drops a pet from the offer when a save shows it gone", async () => {
    const { a, ib } = await openTrade();
    a.send("tradeOffer", { uids: [1, 2] });
    await until(() => ib.last("tradeUpdate")?.theirs.length === 2);
    a.send("saveProgress", { pets: [pet(1, "chick")], petsRev: 0 }); // deleted the goat
    await until(() => ib.last("tradeUpdate")?.theirs.length === 1);
    assert.deepStrictEqual(ib.last("tradeUpdate").theirs, [pet(1, "chick")]);
  });

  it("won't accept an empty trade or one past the storage limit", async () => {
    const many = Array.from({ length: TRADE.storage }, (_, i) => pet(i + 1));
    const { a, b, ia, ib } = await openTrade(many, [pet(1, "bear")]);
    a.send("tradeAccept", { ok: true });
    await until(() => ia.last("tradeUpdate")?.note === "empty");
    b.send("tradeOffer", { uids: [1] });
    await until(() => ia.last("tradeUpdate")?.theirs.length === 1);
    a.send("tradeAccept", { ok: true });
    await until(() => ia.last("tradeUpdate")?.note === "fullMe");
    b.send("tradeAccept", { ok: true });
    await until(() => ib.last("tradeUpdate")?.note === "fullThem");
    assert.strictEqual(ib.last("tradeUpdate").accepted.them, false);
  });

  it("ends the trade for the partner when a player cancels or leaves", async () => {
    const t1 = await openTrade();
    t1.a.send("tradeCancel");
    await until(() => !!t1.ib.last("tradeClosed"));
    assert.deepStrictEqual(t1.ib.last("tradeClosed"), { reason: "cancelled", byMe: false });
    assert.strictEqual(t1.room.state.players.get(t1.b.sessionId)!.trading, false);

    const t2 = await openTrade();
    await t2.a.leave();
    await until(() => !!t2.ib.last("tradeClosed"));
    assert.strictEqual(t2.ib.last("tradeClosed").reason, "left");
  });

  it("refuses a request to someone already trading", async () => {
    const { room, a } = await openTrade();
    const c = await colyseus.connectTo(room, { userId: "uc", username: "Cara" });
    const ic = inbox(c);
    c.send("tradeRequest", { to: a.sessionId });
    await until(() => !!ic.last("tradeRequestEnded"));
    assert.strictEqual(ic.last("tradeRequestEnded").reason, "busy");
  });
});
