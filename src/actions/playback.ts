import {
  type DidReceiveSettingsEvent,
  type JsonObject,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import {
  type MetaReply,
  type PlaybackStatus,
  type TrackArt,
  type TrackMeta,
  musicHelper,
} from "../music-helper";

/** How long to wait on an iTunes Search / image download before giving up. */
const ARTWORK_FETCH_TIMEOUT_MS = 5000;
/** Cover art resolution requested from the iTunes artwork CDN. */
const ARTWORK_SIZE = "512x512bb";

/**
 * Look up cover art for a track on Apple's public iTunes Search API, used when
 * ScriptingBridge exposes no local artwork (catalog tracks not in the library).
 * Returns a data-URI, or null on no match / network error.
 */
async function lookupRemoteArtwork(meta: TrackMeta): Promise<string | null> {
  const term = `${meta.artist} ${meta.name}`.trim();
  if (!term) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARTWORK_FETCH_TIMEOUT_MS);
  try {
    const searchUrl = `https://itunes.apple.com/search?entity=song&limit=1&term=${encodeURIComponent(term)}`;
    const res = await fetch(searchUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { results?: Array<{ artworkUrl100?: string }> };
    const url100 = json.results?.[0]?.artworkUrl100;
    if (!url100) return null;

    // The CDN serves arbitrary sizes by swapping the dimensions in the path.
    const hiResUrl = url100.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${ARTWORK_SIZE}.$1`);
    const img = await fetch(hiResUrl, { signal: controller.signal });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    const mime = hiResUrl.endsWith(".png") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Base for the Apple Music keypad actions.
 *
 * Status is polled once per second while any state-aware action is visible, and
 * every visible instance is re-rendered on each update. To avoid flooding the
 * Stream Deck WebSocket (which causes UI lag), all writes are diffed per
 * context: setState / setImage / setTitle are only sent when the value actually
 * changes.
 */
abstract class PlaybackAction<S extends JsonObject = JsonObject> extends SingletonAction<S> {
  /** Whether this action polls status and re-renders on state changes. */
  protected needsStatus = true;

  // Per-context last-applied values (keyed by action id) for change detection.
  private lastState = new Map<string, number>();
  private lastTitle = new Map<string, string>();

  constructor() {
    super();
    musicHelper.on("status", (status: PlaybackStatus) => {
      void this.renderAll(status);
    });
  }

  override async onWillAppear(ev: WillAppearEvent<S>): Promise<void> {
    if (!ev.action.isKey()) return;
    if (this.needsStatus) {
      musicHelper.startPolling();
      await this.render(ev.action, musicHelper.status);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<S>): void {
    if (this.needsStatus) musicHelper.stopPolling();
    this.forget(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): Promise<void> {
    if (ev.action.isKey()) await this.render(ev.action, musicHelper.status);
  }

  override async onKeyDown(_ev: KeyDownEvent<S>): Promise<void> {
    this.onPressed();
  }

  /** Re-render every visible instance of this action. */
  protected async renderAll(status: PlaybackStatus): Promise<void> {
    if (!this.needsStatus) return;
    for (const a of this.actions) {
      if (a.isKey()) await this.render(a, status);
    }
  }

  /** Render one key. Default: drive the manifest state from `stateFor`. */
  protected async render(action: KeyAction<S>, status: PlaybackStatus): Promise<void> {
    const state = this.stateFor(status);
    if (state !== null) await this.applyState(action, state);
  }

  /** Map a status to a manifest state index, or null for static actions. */
  protected stateFor(_status: PlaybackStatus): number | null {
    return null;
  }

  /** Handle a press. */
  protected abstract onPressed(): void;

  // --- diffed setters ---------------------------------------------------

  protected async applyState(a: KeyAction<S>, state: number): Promise<void> {
    if (this.lastState.get(a.id) === state) return;
    this.lastState.set(a.id, state);
    await a.setState(state);
  }

  protected async applyTitle(a: KeyAction<S>, title: string): Promise<void> {
    if (this.lastTitle.get(a.id) === title) return;
    this.lastTitle.set(a.id, title);
    await a.setTitle(title);
  }

  protected forget(id: string): void {
    this.lastState.delete(id);
    this.lastTitle.delete(id);
  }
}

/** Settings for the play/pause button. */
interface PlaySettings extends JsonObject {
  /** Show the current track's cover art while playing. */
  showArtwork?: boolean;
}

export class PlayPauseAction extends PlaybackAction<PlaySettings> {
  override readonly manifestId = "com.timeraa.apple-music-volume.playpause";

  /** Data-URI of the cached art, or null when unavailable / not yet fetched. */
  private artData: string | null = null;
  /**
   * Track the cached `artData` belongs to, taken from the art reply itself.
   * The reply is the authority on what's current: its id and bytes are read
   * from one `currentTrack` snapshot, and replies arrive FIFO, so the latest
   * reply always wins. (Status can't be trusted here — Apple Music's async
   * `nextTrack()` makes the `status` right after a skip report the old track.)
   */
  private artTrackId: string | null = null;
  /** Last track a fetch was issued for, driven by status (dedupes requests). */
  private requestedTrack: string | null = null;
  /** Cached `showArtwork` setting per context (avoids getSettings per tick). */
  private showArt = new Map<string, boolean>();
  /** Last image signature applied per context (art covers both states). */
  private lastArt = new Map<string, string>();
  /** Online artwork cache + in-flight guard, keyed by track id. */
  private remoteArt = new Map<string, string>();
  private remotePending = new Set<string>();

  constructor() {
    super();
    musicHelper.on("art", (art: TrackArt) => {
      // Trust the reply: it tells us which track the bytes are for. Never gate
      // on status (it lags skips), or a valid fresh reply gets dropped and the
      // tile sticks on the glyph.
      this.artTrackId = art.trackId;
      if (art.data === null) {
        // No local artwork — use a cached online result or fetch metadata.
        const cached = this.remoteArt.get(art.trackId);
        this.artData = cached ?? null;
        if (!cached) musicHelper.requestMeta();
      } else {
        this.artData = `data:image/png;base64,${art.data}`;
      }
      void this.renderAll(musicHelper.status);
    });
    musicHelper.on("meta", (reply: MetaReply) => {
      if (reply.meta) void this.resolveRemoteArt(reply.trackId, reply.meta);
    });
  }

  /** Resolve cover art online for `trackId`, caching the result per track. */
  private async resolveRemoteArt(trackId: string, meta: TrackMeta): Promise<void> {
    const cached = this.remoteArt.get(trackId);
    if (cached) {
      if (this.artTrackId === trackId) {
        this.artData = cached;
        void this.renderAll(musicHelper.status);
      }
      return;
    }
    if (this.remotePending.has(trackId)) return;
    this.remotePending.add(trackId);
    try {
      const data = await lookupRemoteArtwork(meta);
      if (!data) return;
      this.remoteArt.set(trackId, data);
      // Apply only if the current art track is still this one (may have skipped).
      if (this.artTrackId === trackId) {
        this.artData = data;
        void this.renderAll(musicHelper.status);
      }
    } finally {
      this.remotePending.delete(trackId);
    }
  }

  override async onWillAppear(ev: WillAppearEvent<PlaySettings>): Promise<void> {
    if (ev.action.isKey()) {
      this.showArt.set(ev.action.id, !!ev.payload.settings.showArtwork);
    }
    await super.onWillAppear(ev);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlaySettings>): Promise<void> {
    if (ev.action.isKey()) {
      this.showArt.set(ev.action.id, !!ev.payload.settings.showArtwork);
    }
    await super.onDidReceiveSettings(ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<PlaySettings>): void {
    this.showArt.delete(ev.action.id);
    this.lastArt.delete(ev.action.id);
    super.onWillDisappear(ev);
  }

  protected override async render(
    action: KeyAction<PlaySettings>,
    status: PlaybackStatus,
  ): Promise<void> {
    const playing = status.playing === "playing";
    await this.applyState(action, playing ? 1 : 0);

    // Show art only while actively playing; fall back to the glyphs otherwise.
    const wantArt = (this.showArt.get(action.id) ?? false) && playing && status.running;

    if (wantArt) {
      // Request fresh art when status moves to a new track — but skip it if a
      // (faster) art reply already delivered this track's art, so we don't
      // clear good art and flash the glyph.
      if (status.trackId !== this.requestedTrack) {
        this.requestedTrack = status.trackId;
        if (this.artTrackId !== status.trackId) {
          this.artData = null;
          musicHelper.requestArt();
        }
      }
      // Display whatever art we currently hold, keyed by the track it's for.
      if (this.artData) {
        await this.applyArtwork(action, `art:${this.artTrackId}`, this.artData);
        return;
      }
    }
    // Disabled, stopped, or no art for this track: fall back to the glyphs.
    await this.applyArtwork(action, "glyph", undefined);
  }

  /**
   * Set both states' images at once so the art covers the tile regardless of
   * the play/pause state. Pass `undefined` to reset to the manifest glyphs.
   */
  private async applyArtwork(
    a: KeyAction<PlaySettings>,
    signature: string,
    image: string | undefined,
  ): Promise<void> {
    if (this.lastArt.get(a.id) === signature) return;
    this.lastArt.set(a.id, signature);
    await a.setImage(image, { state: 0 });
    await a.setImage(image, { state: 1 });
  }

  protected onPressed(): void {
    musicHelper.playPause();
  }
}

export class NextAction extends PlaybackAction {
  override readonly manifestId = "com.timeraa.apple-music-volume.next";
  protected override needsStatus = false;

  protected onPressed(): void {
    musicHelper.next();
  }
}

export class PreviousAction extends PlaybackAction {
  override readonly manifestId = "com.timeraa.apple-music-volume.previous";
  protected override needsStatus = false;

  protected onPressed(): void {
    musicHelper.previous();
  }
}

export class LikeAction extends PlaybackAction {
  override readonly manifestId = "com.timeraa.apple-music-volume.like";

  protected override stateFor(status: PlaybackStatus): number {
    return status.favorited ? 1 : 0;
  }

  protected onPressed(): void {
    musicHelper.toggleLove();
  }
}

export class ShuffleAction extends PlaybackAction {
  override readonly manifestId = "com.timeraa.apple-music-volume.shuffle";

  protected override stateFor(status: PlaybackStatus): number {
    return status.shuffle ? 1 : 0;
  }

  protected onPressed(): void {
    musicHelper.toggleShuffle();
  }
}

export class RepeatAction extends PlaybackAction {
  override readonly manifestId = "com.timeraa.apple-music-volume.repeat";

  protected override stateFor(status: PlaybackStatus): number {
    return status.repeat === "all" ? 1 : status.repeat === "one" ? 2 : 0;
  }

  protected onPressed(): void {
    musicHelper.cycleRepeat();
  }
}
