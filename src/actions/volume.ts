import {
  type DialAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type JsonValue,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type AppIcon, type MusicState, type PlaybackStatus, musicHelper } from "../music-helper";

/** What a Volume key does when pressed. */
type VolumeMode = "up" | "down" | "mute";

/** Per-action settings persisted by the Stream Deck app. */
interface VolumeSettings {
  /** Logical volume retained on the dial (the level Music returns to when unmuted). */
  volume?: number;
  muted?: boolean;
  /** Volume change per dial tick / key press. */
  step?: number;
  /** Keypad behaviour (ignored on the dial). */
  mode?: VolumeMode;
  [key: string]: JsonValue;
}

const DEFAULT_DIAL_STEP = 2;
const DEFAULT_KEY_STEP = 5;

/** Coalesce dial helper writes to at most one per this many ms (latest-wins). */
const WRITE_INTERVAL_MS = 40;
/** How long after a key press to trust the optimistic volume over a polled value. */
const PRESS_RECONCILE_MS = 1500;
/** How often to re-read Music's volume while a dial is visible (drift correction). */
const DIAL_POLL_MS = 1000;

/**
 * Touchscreen icons (paths relative to the plugin folder). These are our own
 * bundled original art, used as the fallback until — and if — the live Apple
 * Music icon arrives from the helper.
 */
const ICON_NORMAL = "imgs/actions/volume/music.png";
const ICON_MUTED = "imgs/actions/volume/music-muted.png";

/**
 * The genuine Apple Music icon as `data:` URIs, read live from the user's
 * installed Music.app by the helper (never bundled). Cached at module scope and
 * fetched once on the first dial appearance; `null` means "fall back to the
 * bundled original above".
 */
let liveIcon: string | null = null;
let liveIconMuted: string | null = null;
/** Whether the live icon has already been requested from the helper. */
let liveIconRequested = false;

/** Key glyphs for the up / down modes (mute uses the manifest state images). */
const KEY_GLYPH: Record<"up" | "down", string> = {
  up: "imgs/playback/volup.png",
  down: "imgs/playback/voldown.png",
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Apple Music output volume.
 *
 * On a Stream Deck + dial: rotate to change volume, press / touch to mute. On a
 * key: a Property Inspector dropdown picks the behaviour — raise volume, lower
 * volume, or toggle mute — so a single "Volume" action covers users with and
 * without dials (mirroring Elgato's first-party plugin).
 *
 * Mute is volume-based (Music sits at 0 while muted), so the dial keeps the
 * pre-mute volume in memory / settings and writes `0` or the logical volume to
 * the helper — mute survives reloads and a rotate resumes from the real level.
 *
 * Dial rotation updates the touchscreen immediately (cheap WebSocket messages)
 * while helper writes are coalesced through a latest-wins throttle. Keys poll
 * status once per second while visible and diff every write so they never flood
 * the Stream Deck socket.
 */
export class VolumeAction extends SingletonAction<VolumeSettings> {
  override readonly manifestId = "com.timeraa.apple-music-volume.volume";

  // --- dial state (one dial instance is visible at a time) ----------------

  /** Logical volume (the level Music returns to when unmuted). */
  private volume = 50;
  private muted = false;
  private dialStep = DEFAULT_DIAL_STEP;

  /** When true, adopt Music's live volume on the next helper state (first run). */
  private adoptLiveVolume = false;
  /** Mute state last reflected in the touchscreen icon (avoids redundant writes). */
  private lastIconMuted: boolean | null = null;
  /** The dial currently showing this action. */
  private current: DialAction<VolumeSettings> | null = null;

  // Dial coalescing throttle state.
  private pendingVolume: number | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private lastWrite = 0;
  /** Periodic re-read of Music's volume while the dial is visible. */
  private dialPollTimer: NodeJS.Timeout | null = null;

  // --- key state (many key instances may be visible) ----------------------

  /** Per-context mode / step. */
  private keyMode = new Map<string, VolumeMode>();
  private keyStep = new Map<string, number>();

  // Optimistic volume so rapid presses accumulate without waiting for a poll.
  // Music's volume is global, so one shared value is correct across all keys.
  private optimisticVolume = 0;
  private lastPressAt = 0;

  // Per-context last-applied values (keyed by action id) for change detection.
  private lastState = new Map<string, number>();
  private lastImage = new Map<string, string>();
  private lastTitle = new Map<string, string>();

  constructor() {
    super();
    musicHelper.on("state", (state: MusicState) => {
      void this.onHelperState(state);
    });
    musicHelper.on("status", (status: PlaybackStatus) => {
      void this.renderKeys(status);
    });
    musicHelper.on("appicon", (icon: AppIcon) => {
      void this.onAppIcon(icon);
    });
  }

  /**
   * Cache a live Apple Music icon as it arrives from the helper. When one lands
   * after the dial has already rendered the bundled fallback, force the next
   * `refreshIcon()` to push it by clearing the icon-state cache.
   */
  private async onAppIcon(icon: AppIcon): Promise<void> {
    if (icon.data === null) return; // unavailable — keep the bundled fallback
    const uri = `data:image/png;base64,${icon.data}`;
    if (icon.muted) {
      if (liveIconMuted === uri) return;
      liveIconMuted = uri;
    } else {
      if (liveIcon === uri) return;
      liveIcon = uri;
    }
    this.lastIconMuted = null;
    await this.refreshIcon();
  }

  // --- lifecycle ----------------------------------------------------------

  override async onWillAppear(ev: WillAppearEvent<VolumeSettings>): Promise<void> {
    if (ev.action.isDial()) {
      await this.dialAppear(ev.action, ev.payload.settings);
    } else if (ev.action.isKey()) {
      this.adoptKeySettings(ev.action.id, ev.payload.settings);
      musicHelper.startPolling();
      await this.renderKey(ev.action, musicHelper.status);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<VolumeSettings>): void {
    if (ev.payload.controller === "Encoder") {
      this.stopDialPoll();
      this.current = null;
    } else {
      musicHelper.stopPolling();
      this.keyMode.delete(ev.action.id);
      this.keyStep.delete(ev.action.id);
      this.lastState.delete(ev.action.id);
      this.lastImage.delete(ev.action.id);
      this.lastTitle.delete(ev.action.id);
    }
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<VolumeSettings>): Promise<void> {
    if (ev.action.isDial()) {
      this.dialStep = ev.payload.settings.step ?? DEFAULT_DIAL_STEP;
    } else if (ev.action.isKey()) {
      this.adoptKeySettings(ev.action.id, ev.payload.settings);
      // Mode may have changed: drop cached image/state so the new glyph applies.
      this.lastImage.delete(ev.action.id);
      this.lastState.delete(ev.action.id);
      this.lastTitle.delete(ev.action.id);
      await this.renderKey(ev.action, musicHelper.status);
    }
  }

  // --- dial ---------------------------------------------------------------

  private async dialAppear(
    action: DialAction<VolumeSettings>,
    settings: VolumeSettings,
  ): Promise<void> {
    this.current = action;
    this.dialStep = settings.step ?? DEFAULT_DIAL_STEP;
    this.muted = settings.muted ?? false;

    // Fetch the genuine Music.app icon once (both variants); it swaps in via the
    // `appicon` handler when it arrives. Until then the bundled original shows.
    if (!liveIconRequested) {
      liveIconRequested = true;
      musicHelper.requestAppIcon(false);
      musicHelper.requestAppIcon(true);
    }

    if (settings.volume === undefined) {
      // First time on this dial: adopt whatever Music is currently at.
      this.adoptLiveVolume = true;
      this.volume = 50;
    } else {
      this.adoptLiveVolume = false;
      this.volume = clamp(settings.volume, 0, 100);
    }

    this.lastIconMuted = null;
    await this.refreshIcon();
    await this.refreshFeedback();
    // Query for running / permission status (and live volume on first run), then
    // keep polling so changes made directly in Apple Music reconcile onto the dial.
    musicHelper.query();
    this.startDialPoll();
  }

  /** Begin (or keep) the periodic volume re-read used for drift correction. */
  private startDialPoll(): void {
    if (this.dialPollTimer) return;
    this.dialPollTimer = setInterval(() => musicHelper.query(), DIAL_POLL_MS);
  }

  /** Stop the periodic volume re-read (no dial visible). */
  private stopDialPoll(): void {
    if (this.dialPollTimer) {
      clearInterval(this.dialPollTimer);
      this.dialPollTimer = null;
    }
  }

  override async onDialRotate(ev: DialRotateEvent<VolumeSettings>): Promise<void> {
    const wasMuted = this.muted;
    this.volume = clamp(this.volume + ev.payload.ticks * this.dialStep, 0, 100);
    // Rotation implicitly unmutes.
    this.muted = false;
    this.adoptLiveVolume = false;

    await this.refreshFeedback();
    if (wasMuted) await this.refreshIcon();
    this.scheduleWrite(this.volume);
    await this.persistDial(ev.action);
  }

  override async onDialDown(ev: DialDownEvent<VolumeSettings>): Promise<void> {
    await this.dialToggleMute(ev.action);
  }

  override async onTouchTap(ev: TouchTapEvent<VolumeSettings>): Promise<void> {
    await this.dialToggleMute(ev.action);
  }

  /** Toggle mute from the dial (volume-based, shared with the mute key mode). */
  private async dialToggleMute(action: DialAction<VolumeSettings>): Promise<void> {
    this.muted = !this.muted;
    this.adoptLiveVolume = false;

    await this.refreshFeedback();
    await this.refreshIcon();
    musicHelper.setMute(this.muted);
    await this.persistDial(action);
  }

  /** Apply the latest pending volume to the helper, throttled latest-wins. */
  private scheduleWrite(volume: number): void {
    this.pendingVolume = volume;
    if (this.writeTimer) return;

    const elapsed = Date.now() - this.lastWrite;
    const delay = Math.max(0, WRITE_INTERVAL_MS - elapsed);

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.pendingVolume === null) return;
      musicHelper.setVolume(this.pendingVolume);
      this.pendingVolume = null;
      this.lastWrite = Date.now();
    }, delay);
  }

  /** React to helper state: drive permission/running display and first-run seed. */
  private async onHelperState(state: MusicState): Promise<void> {
    if (!this.current) return;

    if (state.needsPermission) {
      this.lastIconMuted = false;
      await this.current.setFeedback({
        icon: liveIcon ?? ICON_NORMAL,
        title: "Apple Music",
        value: "Allow access",
        indicator: 0,
      });
      return;
    }

    if (!state.running) {
      this.lastIconMuted = false;
      await this.current.setFeedback({
        icon: liveIcon ?? ICON_NORMAL,
        title: "Apple Music",
        value: "Not running",
        indicator: 0,
      });
      return;
    }

    // Running and authorized: adopt Music's live volume on first run, and keep
    // reconciling it afterwards so a change made directly in Apple Music doesn't
    // drift from the dial. Never adopt while the user is actively turning the dial
    // (a pending or very recent local write would otherwise be clobbered by a
    // stale read), nor while muted (Music sits at 0 but we keep the logical level).
    const turning = this.pendingVolume !== null || Date.now() - this.lastWrite < PRESS_RECONCILE_MS;
    if (!this.muted && (this.adoptLiveVolume || !turning)) {
      this.volume = clamp(state.volume, 0, 100);
    }
    this.adoptLiveVolume = false;
    // Keep mute in sync with the helper (e.g. a mute key toggled it).
    this.muted = state.muted;
    await this.refreshFeedback();
    await this.refreshIcon();
  }

  /** Push current volume/mute value + indicator to the touchscreen. */
  private async refreshFeedback(): Promise<void> {
    if (!this.current) return;
    await this.current.setFeedback({
      title: "Apple Music",
      value: this.muted ? "Muted" : `${this.volume}%`,
      indicator: this.muted ? 0 : this.volume,
    });
  }

  /** Update the touchscreen icon only when the mute state actually changes. */
  private async refreshIcon(): Promise<void> {
    if (!this.current) return;
    if (this.lastIconMuted === this.muted) return;
    this.lastIconMuted = this.muted;
    await this.current.setFeedback({
      icon: this.muted ? (liveIconMuted ?? ICON_MUTED) : (liveIcon ?? ICON_NORMAL),
    });
  }

  /** Persist current dial state to action settings so it survives reload. */
  private async persistDial(action: DialAction<VolumeSettings>): Promise<void> {
    await action.setSettings({
      volume: this.volume,
      muted: this.muted,
      step: this.dialStep,
    });
  }

  // --- keys ---------------------------------------------------------------

  private adoptKeySettings(id: string, settings: VolumeSettings): void {
    this.keyMode.set(id, settings.mode ?? "up");
    this.keyStep.set(id, clamp(settings.step ?? DEFAULT_KEY_STEP, 1, 50));
  }

  private recentlyPressed(): boolean {
    return Date.now() - this.lastPressAt < PRESS_RECONCILE_MS;
  }

  /** Re-render every visible key instance on a status update. */
  private async renderKeys(status: PlaybackStatus): Promise<void> {
    for (const a of this.actions) {
      if (a.isKey()) await this.renderKey(a, status);
    }
  }

  private async renderKey(
    action: KeyAction<VolumeSettings>,
    status: PlaybackStatus,
  ): Promise<void> {
    const mode = this.keyMode.get(action.id) ?? "up";

    if (mode === "mute") {
      // Use the manifest state images (sound / muted); clear any glyph override.
      await this.applyImage(action, "mute-managed", undefined, 0);
      await this.applyState(action, status.muted ? 1 : 0);
      await this.applyTitle(action, "");
      return;
    }

    // up / down: fixed glyph, show the live volume as the title.
    await this.applyState(action, 0);
    await this.applyImage(action, `glyph:${mode}`, KEY_GLYPH[mode], 0);
    if (!this.recentlyPressed()) this.optimisticVolume = status.volume;
    await this.applyTitle(
      action,
      status.needsPermission || !status.running ? "" : `${this.optimisticVolume}%`,
    );
  }

  override async onKeyDown(ev: KeyDownEvent<VolumeSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const mode = this.keyMode.get(ev.action.id) ?? "up";

    if (mode === "mute") {
      musicHelper.toggleMute();
      return;
    }

    const step = this.keyStep.get(ev.action.id) ?? DEFAULT_KEY_STEP;
    const direction = mode === "up" ? 1 : -1;
    const base = this.recentlyPressed() ? this.optimisticVolume : musicHelper.status.volume;
    const next = clamp(base + direction * step, 0, 100);
    this.optimisticVolume = next;
    this.lastPressAt = Date.now();
    musicHelper.setVolume(next);
    await this.applyTitle(ev.action, `${next}%`);
  }

  // --- diffed key setters -------------------------------------------------

  private async applyState(a: KeyAction<VolumeSettings>, state: number): Promise<void> {
    if (this.lastState.get(a.id) === state) return;
    this.lastState.set(a.id, state);
    await a.setState(state);
  }

  private async applyTitle(a: KeyAction<VolumeSettings>, title: string): Promise<void> {
    if (this.lastTitle.get(a.id) === title) return;
    this.lastTitle.set(a.id, title);
    await a.setTitle(title);
  }

  /**
   * Set the image only when `signature` changes. `image` is the actual payload
   * (a path, or undefined to reset to the manifest state image).
   */
  private async applyImage(
    a: KeyAction<VolumeSettings>,
    signature: string,
    image: string | undefined,
    state: number,
  ): Promise<void> {
    if (this.lastImage.get(a.id) === signature) return;
    this.lastImage.set(a.id, signature);
    await a.setImage(image, { state });
  }
}
