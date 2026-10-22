import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  AVATAR_MAX_LEN,
  DISTANCE_MAX,
  GUEST_ID_PREFIX,
  LEADERBOARD_QUERY_LIMIT,
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_ROWS,
  NAME_MAX,
  PFP_MAX_LEN,
  POSE_MAX,
  RECONNECT_SECONDS,
  ROOM_MAX_CLIENTS,
  WORLD_BOUNDS,
} from "../constants.js";
import { getPlayers, type PlayerDoc, type SavedPet } from "../db.js";
import { sanitizeProgress, resolveTutorialStep } from "../sanitize.js";
import { Trades } from "./trades.js";
import { claimDaily, dailyView, freshDaily, sanitizeDaily, type DailyDoc } from "../daily.js";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

// Only plain http(s) URLs of sane length: the client draws it in an <img>.
function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

// One board per stat, matching the hub's three boards (COIN / TROPHIES / PLAYTIME).
const LEADERBOARD_STATS = ["coins", "trophies", "playtime"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
// `avatar` (Bloxity avatar JSON) is only set on a board's #1 row.
type LeaderboardRow = { id: string; name: string; value: number; avatar?: string };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string; avatar: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the same tick) down
// to one, keeping the higher value for the ranked stat. Guests with no id are never collapsed.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, avatar })`.
 * Relays each player's pose and Bloxity avatar to the others, broadcasts the leaderboards, and
 * saves/loads each signed-in player's progress (MongoDB, see db.ts). The game is
 * client-authoritative: no gameplay rules live here. Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();

  // Each player's owned pets as the server knows them (loaded, then every save), what trades check
  // offers against. A trade bumps the player's `petsRev`; a save carries the revision the client
  // last applied, and a save from before a trade (older revision) keeps its pets to itself, so it
  // can never bring back pets that were just traded away. Revisions restart at 0 on each load.
  private pets = new Map<string, SavedPet[]>();
  private petsRev = new Map<string, number>();

  // sessionId -> that signed-in account's daily-reward week (src/daily.ts), set once its doc has
  // loaded. Guests (and a session whose account is still loading) have none.
  private daily = new Map<string, DailyDoc>();

  trades = new Trades({
    clock: this.clock,
    send: (sid, type, payload) => this.clients.find((c) => c.sessionId === sid)?.send(type, payload),
    canTrade: (sid) => this.state.players.has(sid) && this.userIds.has(sid),
    name: (sid) => this.state.players.get(sid)?.username || "Player",
    pets: (sid) => this.pets.get(sid) ?? [],
    setTrading: (sid, on) => {
      const p = this.state.players.get(sid);
      if (p) p.trading = on;
    },
    commit: (a, petsA, b, petsB) => ({ revA: this.commitPets(a, petsA), revB: this.commitPets(b, petsB) }),
  });

  messages = {
    // Position / paddle state, throttled client-side.
    pose: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const b = WORLD_BOUNDS;
      if (finite(msg?.x)) p.x = clamp(msg.x, b.minX, b.maxX);
      if (finite(msg?.y)) p.y = clamp(msg.y, b.minY, b.maxY);
      if (finite(msg?.z)) p.z = clamp(msg.z, b.minZ, b.maxZ);
      if (finite(msg?.yaw)) p.yaw = msg.yaw;
      if (finite(msg?.speed01)) p.speed01 = clamp(msg.speed01, 0, 1);
      if (typeof msg?.grounded === "boolean") p.grounded = msg.grounded;
      if (msg?.pose === null) p.pose = "";
      else if (typeof msg?.pose === "string" && msg.pose.length <= POSE_MAX) p.pose = msg.pose;
    },
    // Bloxity avatar JSON; sent on connect and whenever the portal reports a change.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      // "" = signed out (back to the default look); an oversized or non-string payload is ignored.
      if (typeof msg?.avatar === "string" && msg.avatar.length <= AVATAR_MAX_LEN) p.avatar = msg.avatar;
      this.persistAvatar(client.sessionId, p);
    },
    // Profile picture URL (Bloxity `pfp`), "" = none.
    setPfp: (client: Client, msg: { pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.pfp !== "string") return;
      p.pfp = sanitizePfp(msg.pfp);
      this.persistAvatar(client.sessionId, p);
    },
    // A climb just reached a new height: shows the new best to everyone at once (the save follows, debounced).
    climbBest: (client: Client, msg: { distance?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !finite(msg?.distance)) return;
      p.bestDistance = Math.max(p.bestDistance, clamp(msg.distance, 0, DISTANCE_MAX));
    },
    // Debounced push of the durable half of the client state. Upserts, so a first save creates
    // the document. Also refreshes the live values the leaderboards read.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch) return;
      this.applyLive(p, patch);
      if (patch.pets) {
        const rev = (msg as { petsRev?: unknown }).petsRev ?? 0;
        if (rev === (this.petsRev.get(client.sessionId) ?? 0)) {
          this.pets.set(client.sessionId, patch.pets);
          this.trades.petsChanged(client.sessionId);
        } else {
          // Written before the latest trade landed on the client: its pets (and team) are stale.
          delete patch.pets;
          delete patch.petTeam;
        }
      }

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The tutorial step only ever moves forward ($max), so a stale or replayed save can never
      // bring a finished tutorial back.
      const { tutorialStep, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", ...(p.avatar ? { avatar: p.avatar } : {}), ...(p.pfp ? { pfp: p.pfp } : {}), updatedAt: new Date() },
            ...(tutorialStep !== undefined && { $max: { tutorialStep } }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Claims one day of this account's daily rewards. The server checks the day is open and
    // unclaimed and saves the claim before telling the client what to grant, so a reward is never
    // handed out twice -- not by a double click, a second tab or a reload.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const day = msg?.day;
      const d = this.daily.get(client.sessionId);
      if (!d) {
        client.send("dailyDenied", { day, reason: "signin" });
        return;
      }
      const now = Date.now();
      const res = claimDaily(d, day, now);
      if ("reason" in res) {
        client.send("dailyDenied", { day, reason: res.reason, daily: dailyView(d, now) });
        return;
      }
      // Recorded before any await, so a second claim racing this one sees it.
      this.daily.set(client.sessionId, res.daily);
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (userId && players) {
        try {
          await players.updateOne(
            { _id: userId },
            { $set: { daily: res.daily, updatedAt: new Date() }, $setOnInsert: { version: 1, tutorialStep: 0 } },
            { upsert: true },
          );
        } catch (err) {
          console.warn("[WorldRoom] daily claim save failed", err);
        }
      }
      client.send("dailyClaimed", { day, reward: res.reward, daily: dailyView(res.daily, Date.now()) });
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; handle?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.handle === "string") p.handle = sanitizeName(msg.handle);
      if (typeof msg?.userId === "string") this.setUserId(client, p, msg.userId);
    },

    // Pet trades (src/rooms/trades.ts).
    tradeRequest: (client: Client, msg: { to?: unknown }) => this.trades.request(client.sessionId, msg?.to),
    tradeRespond: (client: Client, msg: { from?: unknown; ok?: unknown }) => this.trades.respond(client.sessionId, msg?.from, msg?.ok),
    tradeOffer: (client: Client, msg: { uids?: unknown }) => this.trades.offer(client.sessionId, msg?.uids),
    tradeAccept: (client: Client, msg: { ok?: unknown }) => this.trades.accept(client.sessionId, msg?.ok),
    tradeCancel: (client: Client) => this.trades.cancel(client.sessionId),
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for a full
  // LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
  }

  onJoin(client: Client, options?: { username?: string; handle?: string; userId?: string; avatar?: string; pfp?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.handle = sanitizeName(options?.handle);
    p.avatar = sanitizeAvatar(options?.avatar);
    p.pfp = sanitizePfp(options?.pfp);
    this.state.players.set(client.sessionId, p);

    this.setUserId(client, p, options?.userId ?? "");
    this.persistAvatar(client.sessionId, p);
    void this.refreshLeaderboard();
  }

  // Remembers a signed-in player's look so their statue survives them logging off. "" (signed
  // out / no avatar) never overwrites a saved one.
  private persistAvatar(sessionId: string, p: PlayerState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players || !(p.avatar || p.pfp)) return;
    players
      .updateOne({ _id: userId }, { $set: { avatar: p.avatar, ...(p.pfp ? { pfp: p.pfp } : {}), username: p.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1, tutorialStep: 0 } }, { upsert: true })
      .catch((err) => console.warn("[WorldRoom] avatar save failed", err));
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    this.trades.drop(client.sessionId); // a dropped connection ends any trade at once, reconnect or not
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Server-clock "last seen" for a player who has really gone (the client's own stamp can be up to
  // a save interval old). Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Mirrors a sanitized save into the live roster entry (what the leaderboards rank and what
  // other clients draw).
  private applyLive(p: PlayerState, patch: Partial<PlayerDoc>) {
    if (patch.coins !== undefined) p.coins = patch.coins;
    if (patch.trophies !== undefined) p.trophies = patch.trophies;
    if (patch.bestDistance !== undefined) p.bestDistance = Math.max(p.bestDistance, patch.bestDistance);
    if (patch.playtime !== undefined) p.playtime = patch.playtime;
  }

  // A finished trade's new pet list: kept for the next offer check and saved straight away (not on
  // the client's debounce), so neither side can lose or keep the traded pets by leaving. Returns the
  // player's new pets revision.
  private commitPets(sessionId: string, list: SavedPet[]): number {
    this.pets.set(sessionId, list);
    const rev = (this.petsRev.get(sessionId) ?? 0) + 1;
    this.petsRev.set(sessionId, rev);
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (userId && players) {
      players
        .updateOne({ _id: userId }, { $set: { pets: list, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true })
        .catch((err) => console.warn("[WorldRoom] trade save failed", err));
    }
    return rev;
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.trades.drop(sessionId);
    this.pets.delete(sessionId);
    this.petsRev.delete(sessionId);
    this.daily.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.trades.drop(client.sessionId); // a trade belongs to the identity that started it
    this.daily.delete(client.sessionId); // until the new identity's own week has loaded
    p.signedIn = !!userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never shows
      // as two leaderboard rows / two racing Mongo writers (a crashed tab lingers up to
      // RECONNECT_SECONDS via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
    void this.refreshLeaderboard();
  }

  // Seeds this player's live roster values and sends the saved doc to just this client so it can
  // hydrate its state ("progress"), or "noProgress" when there is nothing to load (new account,
  // guest, or Mongo unset). A failed read sends "serverError" so the client does not overwrite a
  // save it could not read.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.petsRev.set(client.sessionId, 0);
    if (!doc) {
      this.pets.set(client.sessionId, []); // until the client's first save
      client.send("noProgress", { serverTime: Date.now(), petsRev: 0 });
    } else {
      // A doc with no tutorialStep is a legacy save: it reads as finished so old players never see the tutorial.
      const live = { ...(sanitizeProgress(doc) ?? {}), tutorialStep: resolveTutorialStep(doc) };
      this.applyLive(p, live);
      this.pets.set(client.sessionId, live.pets ?? []);
      client.send("progress", { ...live, serverTime: Date.now(), petsRev: 0 });
    }
    void this.loadDaily(client, userId, doc);
  }

  // The daily-reward week for this identity, sent as `daily`: null for a guest (the client keeps
  // its own calendar), the saved week for an account (a new account's starts now and is saved, so
  // it doesn't restart on the next visit), or a week for this connection only with no database.
  private async loadDaily(client: Client, userId: string, doc: PlayerDoc | null) {
    if (!userId) {
      client.send("daily", null);
      return;
    }
    const now = Date.now();
    const daily = sanitizeDaily(doc?.daily, now);
    this.daily.set(client.sessionId, daily);
    client.send("daily", dailyView(daily, now));
    const players = getPlayers();
    if (!players || doc?.daily) return;
    try {
      // Only if still missing: a claim saved meanwhile must not be overwritten.
      await players.updateOne(
        { _id: userId, daily: { $exists: false } } as any,
        { $set: { daily }, $setOnInsert: { version: 1, tutorialStep: 0 } },
        { upsert: !doc },
      );
    } catch (err) {
      console.warn("[WorldRoom] daily save failed", err);
    }
  }

  // Builds and broadcasts the merged "all-time saved + currently online" leaderboard. Only the
  // server has both the live roster and the sessionId->userId map needed to tell "this online
  // player already IS a saved account" apart from "this saved account is offline". Private so
  // tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        avatar: p.avatar,
        coins: p.coins,
        trophies: p.trophies,
        playtime: p.playtime,
      });
    });

    const players = getPlayers();
    const payload = { coins: [], trophies: [], playtime: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current than their last save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
        avatar: row.avatar,
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, avatar: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw user id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
              avatar: doc.avatar,
            });
          }
        } catch (err) {
          console.warn(`[WorldRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a different id would
      // otherwise appear twice). Keep the higher value but prefer an online row's id so the
      // client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value), avatar: existing.avatar || row.avatar });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      // Avatars are big: ship only the #1 row's, not all ten.
      payload[stat] = deduped.slice(0, LEADERBOARD_ROWS).map((row, i) => (i === 0 && row.avatar ? row : { id: row.id, name: row.name, value: row.value }));
    }

    this.broadcast("leaderboard", payload);
  }
}
