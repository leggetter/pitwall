// The short ids this pitwall started with `claude --bg` in the last 30
// seconds. Spawn (actions.ts) records each one Claude Code reports; attach
// (attach.ts) reads them, so a session that's only starting is never mistaken
// for one that crashed, even when Claude Code's startedAt for it is older
// than the spawn (see STARTING_GRACE_MS in attach.ts). Resume records the
// short id it reports here too, and, in a second instance, the session id it
// resumed, which attach checks for a session the snapshot still shows as
// ended (W66).

/** How long a spawned short id counts as just spawned. */
export const RECENT_SPAWN_MS = 30_000;

export class RecentSpawns {
  private readonly started = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = RECENT_SPAWN_MS,
  ) {}

  /** Records a short id `claude --bg` just reported. */
  add(shortId: string): void {
    this.prune();
    this.started.set(shortId, this.now());
  }

  /** True when this pitwall spawned `shortId` within the window. */
  has(shortId: string): boolean {
    const at = this.started.get(shortId);
    return at !== undefined && this.now() - at < this.windowMs;
  }

  /** Spawns are rate-limited (actions.ts), so this stays a handful of entries. */
  private prune(): void {
    const now = this.now();
    for (const [shortId, at] of this.started) if (now - at >= this.windowMs) this.started.delete(shortId);
  }
}
