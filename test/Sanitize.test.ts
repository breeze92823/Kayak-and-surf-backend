import assert from "assert";

import { DISTANCE_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ coins: 1e40, trophies: -5, playtime: NaN, bestDistance: 999999, hack: "x" })!;
    assert.strictEqual(out.coins, 1e24);
    assert.strictEqual(out.trophies, 0);
    assert.strictEqual(out.playtime, undefined);
    assert.strictEqual(out.bestDistance, DISTANCE_MAX);
    assert.ok(!("hack" in out));
  });

  it("keeps well-formed coach ids, only equips owned ones, and caps the slots", () => {
    const out = sanitizeProgress({
      coaches: ["duck", "duck", "shark", "Bad Id!", 4, "torrent", "watermelon"],
      equippedCoaches: ["shark", "ghost", "duck", "torrent", "watermelon"],
    })!;
    assert.deepStrictEqual(out.coaches, ["duck", "shark", "torrent", "watermelon"]);
    assert.deepStrictEqual(out.equippedCoaches, ["shark", "duck", "torrent"]);
  });

  it("keeps well-formed boat ids and only equips an owned one", () => {
    const out = sanitizeProgress({ kayaks: ["raft", "canoe", "canoe", "Bad Id!", 7], kayak: "canoe" })!;
    assert.deepStrictEqual(out.kayaks, ["raft", "canoe"]);
    assert.strictEqual(out.kayak, "canoe");
    assert.strictEqual(sanitizeProgress({ kayaks: ["raft"], kayak: "shadow" })!.kayak, undefined);
    assert.strictEqual(sanitizeProgress({ kayak: "Bad Id!" })!.kayak, undefined);
    assert.strictEqual(sanitizeProgress({ kayak: "shadow" })!.kayak, "shadow");
  });

  it("keeps only valid pet index entries", () => {
    const out = sanitizeProgress({ discovered: ["chick:normal", "chick:normal", "goat:shiny", "goat:gold", "a:b:c", "Bad:big", 3] })!;
    assert.deepStrictEqual(out.discovered, ["chick:normal", "goat:shiny"]);
  });

  it("keeps well-formed owned pets and a team of owned ones", () => {
    const out = sanitizeProgress({
      pets: [
        { uid: 1, id: "chick", variant: "normal" },
        { uid: 1, id: "goat", variant: "normal" }, // duplicate uid
        { uid: 2, id: "goat", variant: "gold" }, // unknown variant
        { uid: 3, id: "Bad Id!", variant: "big" },
        { uid: 4.5, id: "bear", variant: "shiny" },
        { uid: 5, id: "bear", variant: "shiny" },
        "x",
      ],
      petTeam: [5, 5, 99, 1, "1"],
      petTeamSize: 40,
      nextPetUid: -3,
    })!;
    assert.deepStrictEqual(out.pets, [{ uid: 1, id: "chick", variant: "normal" }, { uid: 5, id: "bear", variant: "shiny" }]);
    assert.deepStrictEqual(out.petTeam, [5, 1]);
    assert.strictEqual(out.petTeamSize, 6);
    assert.strictEqual(out.nextPetUid, 1);
  });

  it("caps the team at its saved size", () => {
    const out = sanitizeProgress({ pets: [1, 2, 3, 4].map((uid) => ({ uid, id: "chick", variant: "normal" })), petTeam: [1, 2, 3, 4], petTeamSize: 3 })!;
    assert.deepStrictEqual(out.petTeam, [1, 2, 3]);
  });

  it("clamps the tutorial step and last-seen timestamp", () => {
    const out = sanitizeProgress({ tutorialStep: 999, lastSeen: Date.now() + 1e12 })!;
    assert.strictEqual(out.tutorialStep, 10);
    assert.ok(out.lastSeen! <= Date.now() + 25 * 60 * 1000);
  });
});
