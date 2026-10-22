import { TRADE } from "../constants.js";
import type { SavedPet } from "../db.js";

// Player-to-player pet trades inside one WorldRoom. The one server-authoritative corner of the
// game: the room keeps each player's pet list (as last saved, see WorldRoom `pets`), offers may only
// name pets on that list, and the swap itself happens here, never on a client.
//
// Flow (message names are the client/server contract, see the CLAUDE.md files):
//   A tradeRequest {to}        -> B tradeIncoming {from, name}       (expires after TRADE.requestMs)
//   B tradeRespond {from, ok}  -> A,B tradeOpen {partner, name}      (no: A tradeRequestEnded "declined")
//   tradeOffer {uids}          -> A,B tradeUpdate                    (any change clears both Accepts)
//   tradeAccept {ok}           -> both accepted: countdown, then the swap -> A,B tradeDone
//   tradeCancel / leaving      -> partner tradeClosed {reason}
// Guests (no Bloxity id) can neither send nor receive requests: their pets are never saved.

type Timer = { clear(): void };

export interface TradeHost {
  clock: { setTimeout(fn: () => void, ms: number): Timer };
  send(sessionId: string, type: string, payload: unknown): void;
  // Present and signed in.
  canTrade(sessionId: string): boolean;
  name(sessionId: string): string;
  pets(sessionId: string): SavedPet[];
  // Marks the player busy in the roster (PlayerState.trading).
  setTrading(sessionId: string, on: boolean): void;
  // Replaces both players' pet lists (and saves them); returns each one's new pets revision.
  commit(a: string, petsA: SavedPet[], b: string, petsB: SavedPet[]): { revA: number; revB: number };
}

// Why a request ended, for the sender's row: "declined" | "expired" | "busy" | "unavailable" |
// "guest" (the sender is not signed in) | "cooldown".
type EndReason = "declined" | "expired" | "busy" | "unavailable" | "guest" | "cooldown";
// A note on one side's tradeUpdate: "empty" (nothing offered on either side), "fullMe" / "fullThem"
// (the swap would push that player past PET_STORAGE).
type Note = "empty" | "fullMe" | "fullThem";

interface Request {
  to: string;
  timer: Timer;
}
interface Trade {
  a: string;
  b: string;
  offers: Map<string, number[]>; // sessionId -> offered uids, in the order they were added
  accepted: Set<string>;
  countdown: Timer | null;
  endsAt: number; // epoch ms the countdown finishes
}

export class Trades {
  private requests = new Map<string, Request>(); // keyed by sender: one open request each
  private trades = new Map<string, Trade>(); // keyed by both sides
  private lastRequest = new Map<string, number>();

  constructor(private host: TradeHost) {}

  isTrading(sessionId: string) {
    return this.trades.has(sessionId);
  }

  request(from: string, to: unknown) {
    const h = this.host;
    if (typeof to !== "string") return;
    const end = (reason: EndReason) => h.send(from, "tradeRequestEnded", { to, reason });
    if (!h.canTrade(from)) return end("guest");
    if (this.trades.has(from)) return end("busy");
    if (this.requests.get(from)?.to === to) return; // already waiting on them
    const now = Date.now();
    if (now - (this.lastRequest.get(from) ?? 0) < TRADE.requestCooldownMs) return end("cooldown");
    this.lastRequest.set(from, now);
    if (to === from || !h.canTrade(to)) return end("unavailable");
    if (this.trades.has(to)) return end("busy");
    // They already asked us: that is a yes.
    if (this.requests.get(to)?.to === from) return this.respond(from, to, true);

    this.withdraw(from);
    const timer = h.clock.setTimeout(() => {
      if (this.requests.get(from)?.timer !== timer) return;
      this.requests.delete(from);
      h.send(to, "tradeIncomingGone", { from });
      end("expired");
    }, TRADE.requestMs);
    this.requests.set(from, { to, timer });
    h.send(to, "tradeIncoming", { from, name: h.name(from) });
  }

  // `me` answers `from`'s request.
  respond(me: string, from: unknown, ok: unknown) {
    const h = this.host;
    if (typeof from !== "string") return;
    const req = this.requests.get(from);
    if (!req || req.to !== me) return h.send(me, "tradeIncomingGone", { from });
    req.timer.clear();
    this.requests.delete(from);
    if (ok !== true) return h.send(from, "tradeRequestEnded", { to: me, reason: "declined" });
    if (!h.canTrade(me) || !h.canTrade(from) || this.trades.has(me) || this.trades.has(from)) {
      h.send(from, "tradeRequestEnded", { to: me, reason: "busy" });
      return h.send(me, "tradeIncomingGone", { from });
    }
    this.open(from, me);
  }

  // The full offer: owned uids only, no repeats, at most TRADE.maxPets.
  offer(me: string, uids: unknown) {
    const t = this.trades.get(me);
    if (!t || !Array.isArray(uids)) return;
    const owned = new Set(this.host.pets(me).map((p) => p.uid));
    const next = [...new Set(uids.filter((u): u is number => typeof u === "number" && owned.has(u)))].slice(0, TRADE.maxPets);
    const prev = t.offers.get(me)!;
    if (next.length === prev.length && next.every((u, i) => u === prev[i])) return this.sendUpdate(t, me);
    t.offers.set(me, next);
    this.reset(t);
    this.update(t);
  }

  accept(me: string, ok: unknown) {
    const t = this.trades.get(me);
    if (!t) return;
    if (ok !== true) {
      if (!t.accepted.has(me)) return;
      this.reset(t);
      return this.update(t);
    }
    if (t.accepted.has(me)) return;
    if (!t.offers.get(t.a)!.length && !t.offers.get(t.b)!.length) return this.sendUpdate(t, me, "empty");
    const full = this.overflow(t);
    if (full) return this.sendUpdate(t, me, full === me ? "fullMe" : "fullThem");
    t.accepted.add(me);
    if (t.accepted.size === 2) {
      t.endsAt = Date.now() + TRADE.countdownMs;
      const timer = this.host.clock.setTimeout(() => t.countdown === timer && this.execute(t), TRADE.countdownMs);
      t.countdown = timer;
    }
    this.update(t);
  }

  // Withdraws my open request, or walks out of my trade.
  cancel(me: string) {
    this.withdraw(me);
    const t = this.trades.get(me);
    if (t) this.close(t, me, "cancelled");
  }

  // Leaving the room or changing identity: everything involving `me` ends.
  drop(me: string) {
    this.withdraw(me);
    for (const [from, req] of this.requests) {
      if (req.to !== me) continue;
      req.timer.clear();
      this.requests.delete(from);
      this.host.send(from, "tradeRequestEnded", { to: me, reason: "unavailable" });
    }
    const t = this.trades.get(me);
    if (t) this.close(t, me, "left");
    this.lastRequest.delete(me);
  }

  // A save changed my pet list mid-trade: pets I no longer have leave my offer.
  petsChanged(me: string) {
    const t = this.trades.get(me);
    if (!t) return;
    const owned = new Set(this.host.pets(me).map((p) => p.uid));
    const prev = t.offers.get(me)!;
    const next = prev.filter((u) => owned.has(u));
    if (next.length === prev.length) return;
    t.offers.set(me, next);
    this.reset(t);
    this.update(t);
  }

  // --- internals ---------------------------------------------------------------------------

  private withdraw(from: string) {
    const req = this.requests.get(from);
    if (!req) return;
    req.timer.clear();
    this.requests.delete(from);
    this.host.send(req.to, "tradeIncomingGone", { from });
  }

  private open(a: string, b: string) {
    const h = this.host;
    // Both are busy now: their other requests, sent or received, end.
    for (const sid of [a, b]) {
      this.withdraw(sid);
      for (const [from, req] of this.requests) {
        if (req.to !== sid) continue;
        req.timer.clear();
        this.requests.delete(from);
        h.send(from, "tradeRequestEnded", { to: sid, reason: "busy" });
        h.send(sid, "tradeIncomingGone", { from });
      }
    }
    const t: Trade = { a, b, offers: new Map([[a, []], [b, []]]), accepted: new Set(), countdown: null, endsAt: 0 };
    this.trades.set(a, t);
    this.trades.set(b, t);
    h.setTrading(a, true);
    h.setTrading(b, true);
    h.send(a, "tradeOpen", { partner: b, name: h.name(b) });
    h.send(b, "tradeOpen", { partner: a, name: h.name(a) });
    this.update(t);
  }

  private close(t: Trade, by: string, reason: "cancelled" | "left") {
    this.end(t);
    for (const sid of [t.a, t.b]) this.host.send(sid, "tradeClosed", { reason, byMe: sid === by });
  }

  private end(t: Trade) {
    t.countdown?.clear();
    t.countdown = null;
    for (const sid of [t.a, t.b]) {
      if (this.trades.get(sid) !== t) continue;
      this.trades.delete(sid);
      this.host.setTrading(sid, false);
    }
  }

  private reset(t: Trade) {
    t.accepted.clear();
    t.countdown?.clear();
    t.countdown = null;
  }

  private other(t: Trade, me: string) {
    return me === t.a ? t.b : t.a;
  }

  // The side the swap would push past PET_STORAGE (only when it gains pets), or null.
  private overflow(t: Trade): string | null {
    for (const me of [t.a, t.b]) {
      const give = t.offers.get(me)!.length;
      const get = t.offers.get(this.other(t, me))!.length;
      if (get > give && this.host.pets(me).length - give + get > TRADE.storage) return me;
    }
    return null;
  }

  private sendUpdate(t: Trade, me: string, note?: Note) {
    const them = this.other(t, me);
    const theirPets = new Map(this.host.pets(them).map((p) => [p.uid, p]));
    this.host.send(me, "tradeUpdate", {
      mine: t.offers.get(me),
      theirs: t.offers.get(them)!.map((uid) => theirPets.get(uid)).filter(Boolean),
      accepted: { me: t.accepted.has(me), them: t.accepted.has(them) },
      countdown: t.countdown ? Math.max(0, t.endsAt - Date.now()) : 0, // ms left
      ...(note && { note }),
    });
  }

  private update(t: Trade) {
    this.sendUpdate(t, t.a);
    this.sendUpdate(t, t.b);
  }

  private execute(t: Trade) {
    t.countdown = null;
    if (this.trades.get(t.a) !== t || this.trades.get(t.b) !== t) return;
    const h = this.host;
    // Re-check against the latest lists: a save may have landed during the countdown.
    for (const sid of [t.a, t.b]) {
      const owned = new Set(h.pets(sid).map((p) => p.uid));
      if (t.offers.get(sid)!.some((u) => !owned.has(u))) {
        t.accepted.clear();
        return this.petsChanged(sid);
      }
    }
    const full = this.overflow(t);
    if (full) {
      t.accepted.clear();
      this.sendUpdate(t, full, "fullMe");
      return this.sendUpdate(t, this.other(t, full), "fullThem");
    }

    const giveA = new Set(t.offers.get(t.a));
    const giveB = new Set(t.offers.get(t.b));
    const petsA = h.pets(t.a);
    const petsB = h.pets(t.b);
    const gotA = receive(petsA.filter((p) => !giveA.has(p.uid)), petsB.filter((p) => giveB.has(p.uid)));
    const gotB = receive(petsB.filter((p) => !giveB.has(p.uid)), petsA.filter((p) => giveA.has(p.uid)));
    this.end(t);
    const { revA, revB } = h.commit(t.a, gotA.list, t.b, gotB.list);
    h.send(t.a, "tradeDone", { gave: [...giveA], got: gotA.got, petsRev: revA });
    h.send(t.b, "tradeDone", { gave: [...giveB], got: gotB.got, petsRev: revB });
  }
}

// `kept` plus `incoming`, with every incoming pet that clashes with a kept uid given a fresh one
// (uids are per save, so two players' pets often share them).
function receive(kept: SavedPet[], incoming: SavedPet[]): { list: SavedPet[]; got: SavedPet[] } {
  const used = new Set(kept.map((p) => p.uid));
  let next = Math.max(0, ...kept.map((p) => p.uid), ...incoming.map((p) => p.uid)) + 1;
  const got = incoming.map((p) => {
    const uid = used.has(p.uid) ? next++ : p.uid;
    used.add(uid);
    return { uid, id: p.id, variant: p.variant };
  });
  return { list: [...kept, ...got], got };
}
