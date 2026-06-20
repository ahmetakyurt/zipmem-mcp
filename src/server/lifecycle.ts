import {
  applyPendingToState,
  gitChangedFilesSync,
  newActiveSession,
  pendingHasContent,
  readSessionSync,
  writeSession,
  writeSessionSync,
  type RecoveryInfo,
} from "../core/session.js";
import {
  loadStateSync,
  saveStateSync,
  type MergeStats,
} from "../core/state.js";

/**
 * Parent-process lifecycle monitor + crash recovery.
 *
 * Durability here does NOT depend on catching the death signal (a true hard
 * kill — SIGKILL, power loss — cannot be intercepted). The reliable guarantees
 * are:
 *   1. checkpoints are written to disk continuously (see core/session.ts), and
 *   2. the next server startup folds any leftover pending buffer into state.json
 *      and surfaces a recovery banner.
 * The signal/stdin/ppid handlers below are a best-effort enhancement, kept
 * deliberately MINIMAL: on a catchable termination they do a single small
 * atomic write to mark the session interrupted and record the reason. They do
 * NOT fold into state.json or run git — heavy I/O during the narrow OS
 * termination window risks a torn write. All authoritative folding (and
 * git-changed-file capture) happens at the next calm startup in
 * runStartupRecovery.
 */

const ZERO_STATS = {
  blueprintsAdded: 0,
  anchorsAdded: 0,
  lessonsAdded: 0,
} as Pick<MergeStats, "blueprintsAdded" | "anchorsAdded" | "lessonsAdded">;

/**
 * Record an abrupt exit — deliberately MINIMAL. Marks the live session
 * interrupted and stamps the reason, then performs a single atomic write. It
 * intentionally leaves the pending buffer intact and does NOT touch state.json
 * (no heavy disk I/O during the narrow OS termination window). The authoritative
 * fold is done by {@link runStartupRecovery} at the next startup. Idempotent and
 * exception-safe — never throws.
 */
export function flushOnShutdownSync(projectDir: string, reason: string): void {
  try {
    const session = readSessionSync(projectDir);
    if (!session || session.status === "closed") return; // already clean

    session.status = "interrupted";
    session.reason = reason;
    // Pending is left intact; next-startup recovery folds it into state.json.
    writeSessionSync(projectDir, session);
  } catch {
    // Best-effort: never let shutdown handling throw.
  }
}

/**
 * On server startup, inspect the previous session. If it did not close cleanly,
 * fold any leftover pending buffer into state.json (covering the SIGKILL case
 * where no shutdown handler ran) and return a RecoveryInfo to attach to the new
 * session so `zipmem_load_memory` can surface it. Returns undefined when the
 * prior session closed cleanly or there is nothing actionable to recover.
 */
export function runStartupRecovery(projectDir: string): RecoveryInfo | undefined {
  const prev = readSessionSync(projectDir);
  if (!prev || prev.status === "closed") return undefined;

  // Case A: a shutdown handler already folded pending and recorded recovery.
  if (prev.recovery && !pendingHasContent(prev.pending)) {
    return { ...prev.recovery, acknowledged: false };
  }

  // Case B: no handler ran (hard kill) — fold leftover pending now.
  let stats = ZERO_STATS;
  if (pendingHasContent(prev.pending)) {
    try {
      const state = loadStateSync(projectDir);
      const result = applyPendingToState(
        state,
        prev.pending,
        "(interrupted session)",
      );
      saveStateSync(projectDir, result.state);
      stats = result.stats;
    } catch {
      // ignore — surface the file hints below regardless
    }
  }

  const files =
    prev.uncompacted_files && prev.uncompacted_files.length > 0
      ? prev.uncompacted_files
      : gitChangedFilesSync(projectDir);

  const recovered =
    stats.blueprintsAdded + stats.anchorsAdded + stats.lessonsAdded;
  if (recovered === 0 && files.length === 0) return undefined;

  return {
    from_session: prev.session_id,
    reason: prev.reason ?? "unclean-exit",
    recovered_blueprints: stats.blueprintsAdded,
    recovered_anchors: stats.anchorsAdded,
    recovered_lessons: stats.lessonsAdded,
    uncompacted_files: files,
    acknowledged: false,
  };
}

/**
 * Run startup recovery and open a fresh active session, carrying any recovery
 * notice forward. Call once before connecting the transport.
 */
export async function initializeSession(projectDir: string): Promise<void> {
  const recovery = runStartupRecovery(projectDir);
  await writeSession(projectDir, newActiveSession(recovery));
}

/** Installs handlers that flush the session on a catchable parent termination. */
export class LifecycleMonitor {
  private readonly projectDir: string;
  private readonly parentPid: number;
  private flushed = false;
  private watchdog?: NodeJS.Timeout;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.parentPid = process.ppid;
  }

  install(): void {
    const onSignal = (reason: string) => () => this.terminate(reason);

    // Ctrl+C, polite terminate, terminal hang-up (Unix terminal close).
    process.once("SIGINT", onSignal("SIGINT"));
    process.once("SIGTERM", onSignal("SIGTERM"));
    process.once("SIGHUP", onSignal("SIGHUP"));

    // The parent owns our stdin pipe; its EOF/close is the most reliable
    // cross-platform signal that the `claude` process went away.
    process.stdin.once("end", () => this.terminate("stdin-end"));
    process.stdin.once("close", () => this.terminate("stdin-close"));

    // Last-resort poll: detect a vanished parent even without stdin EOF.
    this.watchdog = setInterval(() => {
      if (!this.parentAlive()) this.terminate("parent-exited");
    }, 2000);
    this.watchdog.unref();

    // Catch the normal exit path too (flush is a no-op if already clean/flushed).
    process.once("beforeExit", () => this.flush("beforeExit"));
  }

  /** Is the original parent process still alive? (signal 0 = existence probe) */
  private parentAlive(): boolean {
    if (!this.parentPid || this.parentPid <= 1) return false;
    try {
      process.kill(this.parentPid, 0);
      return true;
    } catch (err) {
      // ESRCH = gone; EPERM = exists but not ours — treat as alive.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private flush(reason: string): void {
    if (this.flushed) return;
    this.flushed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    flushOnShutdownSync(this.projectDir, reason);
  }

  private terminate(reason: string): void {
    this.flush(reason);
    process.exit(0);
  }
}
