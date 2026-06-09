import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the universal Swift helper binary inside the plugin bundle. */
const HELPER_PATH = resolve(__dirname, "music-volume");

/** Current Apple Music state as reported by the helper. */
export interface MusicState {
  /** Volume 0–100, or -1 when Automation (TCC) permission is missing. */
  volume: number;
  /** Whether Music is muted. */
  muted: boolean;
  /** Whether Music.app is currently running. */
  running: boolean;
  /** Convenience flag: true when the helper reported an auth failure. */
  needsPermission: boolean;
}

/** Current track metadata, used for the online artwork fallback. */
export interface TrackMeta {
  name: string;
  artist: string;
  album: string;
}

/** Cover art reply from the helper, tagged with the track it belongs to. */
export interface TrackArt {
  /** Persistent ID of the track the artwork is for. */
  trackId: string;
  /** Base64 PNG (no data-URI prefix), or null when the track has no artwork. */
  data: string | null;
}

/** Metadata reply from the helper, tagged with the track it belongs to. */
export interface MetaReply {
  /** Persistent ID of the track the metadata is for. */
  trackId: string;
  /** Track metadata, or null when there is no current track. */
  meta: TrackMeta | null;
}

/**
 * The live Apple Music app icon, read from the user's installed Music.app at
 * runtime (never bundled). Emitted in reply to {@link MusicHelper.requestAppIcon}.
 */
export interface AppIcon {
  /** Which variant this is: the plain icon (false) or the muted overlay (true). */
  muted: boolean;
  /** Base64 PNG (no data-URI prefix), or null when Music.app/icon is unavailable. */
  data: string | null;
}

/** Player transport state. */
export type PlayerState = "stopped" | "playing" | "paused";
/** Repeat mode. */
export type RepeatMode = "off" | "all" | "one";

/** Full Apple Music playback status as reported by the helper. */
export interface PlaybackStatus {
  volume: number;
  muted: boolean;
  running: boolean;
  needsPermission: boolean;
  playing: PlayerState;
  favorited: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Stable persistent ID of the current track ("-" when none). */
  trackId: string;
}

/**
 * Persistent wrapper around the Swift `music-volume` helper. Spawns one
 * long-lived process and talks to it over stdin/stdout, so each volume write is
 * a warm in-process Apple Event with no per-tick process spawn.
 */
export class MusicHelper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private restartTimer: NodeJS.Timeout | null = null;

  // Ref-counted status polling (active while playback actions are visible).
  private pollTimer: NodeJS.Timeout | null = null;
  private pollRefs = 0;
  private static readonly POLL_INTERVAL_MS = 1000;

  /** Latest known state, updated on every `state` line from the helper. */
  public state: MusicState = {
    volume: 0,
    muted: false,
    running: false,
    needsPermission: false,
  };

  /** Latest full playback status, updated on every `status` line. */
  public status: PlaybackStatus = {
    volume: 0,
    muted: false,
    running: false,
    needsPermission: false,
    playing: "stopped",
    favorited: false,
    shuffle: false,
    repeat: "off",
    trackId: "-",
  };

  /** Ensure the helper process is running, spawning it on first use. */
  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;

    const proc = spawn(HELPER_PATH, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    proc.on("exit", () => {
      this.proc = null;
      this.scheduleRestart();
    });
    proc.on("error", (err) => {
      this.emit("error", err);
      this.proc = null;
      this.scheduleRestart();
    });

    return proc;
  }

  /** Restart the helper shortly after an unexpected exit. */
  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.query();
    }, 500);
  }

  /** Accumulate stdout and dispatch complete lines. */
  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  /** Parse a `state` or `status` line from the helper. */
  private onLine(line: string): void {
    // meta <trackId> <name>\t<artist>\t<album> | meta <trackId> none — handled
    // before the generic whitespace split because the fields contain spaces
    // (they are tab-framed). The trackId (no spaces) is the first token.
    if (line.startsWith("meta ")) {
      const rest = line.slice(5);
      const sp = rest.indexOf(" ");
      const trackId = sp < 0 ? rest : rest.slice(0, sp);
      const payload = sp < 0 ? "" : rest.slice(sp + 1);
      if (payload === "none" || payload === "") {
        this.emit("meta", { trackId, meta: null } satisfies MetaReply);
        return;
      }
      const [name = "", artist = "", album = ""] = payload.split("\t");
      this.emit("meta", { trackId, meta: { name, artist, album } } satisfies MetaReply);
      return;
    }

    const parts = line.split(/\s+/);

    if (parts[0] === "state" && parts.length >= 4) {
      const volume = Number.parseInt(parts[1]!, 10);
      this.state = {
        volume,
        muted: parts[2] === "1",
        running: parts[3] === "1",
        needsPermission: volume < 0,
      };
      this.emit("state", this.state);
      return;
    }

    // status <volume> <mute> <running> <playing 0|1|2> <fav> <shuffle> <repeat 0|1|2>
    if (parts[0] === "status" && parts.length >= 8) {
      const volume = Number.parseInt(parts[1]!, 10);
      const playingCode = Number.parseInt(parts[4]!, 10);
      const repeatCode = Number.parseInt(parts[7]!, 10);
      this.status = {
        volume,
        muted: parts[2] === "1",
        running: parts[3] === "1",
        needsPermission: volume < 0,
        playing: playingCode === 1 ? "playing" : playingCode === 2 ? "paused" : "stopped",
        favorited: parts[5] === "1",
        shuffle: parts[6] === "1",
        repeat: repeatCode === 1 ? "all" : repeatCode === 2 ? "one" : "off",
        trackId: parts[8] ?? "-",
      };
      this.emit("status", this.status);
      return;
    }

    // art <trackId> <base64png|none>
    if (parts[0] === "art" && parts.length >= 3) {
      const trackId = parts[1]!;
      const payload = parts[2]!;
      this.emit("art", {
        trackId,
        data: payload === "none" ? null : payload,
      } satisfies TrackArt);
      return;
    }

    // appicon <0|1> <base64png|none>
    if (parts[0] === "appicon" && parts.length >= 3) {
      const payload = parts[2]!;
      this.emit("appicon", {
        muted: parts[1] === "1",
        data: payload === "none" ? null : payload,
      } satisfies AppIcon);
    }
  }

  /** Write a single command line to the helper. */
  private send(command: string): void {
    const proc = this.ensure();
    proc.stdin.write(`${command}\n`);
  }

  /** Set Music's output volume (0–100). */
  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    this.send(`v ${clamped}`);
  }

  /** Toggle mute. */
  toggleMute(): void {
    this.send("m");
  }

  /** Force mute on/off. */
  setMute(muted: boolean): void {
    this.send(`m ${muted ? 1 : 0}`);
  }

  /** Query current state; helper replies with a `state` line. */
  query(): void {
    this.send("g");
  }

  /** Query full playback status; helper replies with a `status` line. */
  queryStatus(): void {
    this.send("s");
  }

  /** Toggle play / pause. */
  playPause(): void {
    this.send("pp");
  }

  /** Skip to the next track. */
  next(): void {
    this.send("next");
  }

  /** Return to the previous track. */
  previous(): void {
    this.send("prev");
  }

  /** Toggle "favorited" (like) on the current track. */
  toggleLove(): void {
    this.send("love");
  }

  /** Toggle shuffle. */
  toggleShuffle(): void {
    this.send("shuffle");
  }

  /** Cycle repeat mode (off → all → one → off). */
  cycleRepeat(): void {
    this.send("repeat");
  }

  /** Request the current track's artwork; helper replies with an `art` line. */
  requestArt(): void {
    this.send("art");
  }

  /** Request current track metadata; helper replies with a `meta` line. */
  requestMeta(): void {
    this.send("meta");
  }

  /**
   * Request the live Apple Music app icon (read from the installed Music.app at
   * runtime, never bundled); helper replies with an `appicon` line. Pass
   * `muted: true` for the variant with the muted stripe overlaid.
   */
  requestAppIcon(muted: boolean): void {
    this.send(muted ? "appicon muted" : "appicon");
  }

  /**
   * Start status polling. Ref-counted: the first caller starts a 1 s poll, the
   * last `stopPolling()` stops it. Use while playback actions are visible.
   */
  startPolling(): void {
    this.pollRefs++;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.queryStatus(), MusicHelper.POLL_INTERVAL_MS);
    this.queryStatus();
  }

  /** Release one polling reference; stops polling when none remain. */
  stopPolling(): void {
    this.pollRefs = Math.max(0, this.pollRefs - 1);
    if (this.pollRefs === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Stop the helper process (e.g. on plugin shutdown). */
  dispose(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.proc) {
      this.proc.removeAllListeners("exit");
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

/** Shared singleton — one helper process for the whole plugin. */
export const musicHelper = new MusicHelper();
