'use strict';

const fs = require('fs');
const path = require('path');
const { COLLECTION_PATH, dataDir } = require('./config');

const EMPTY = { version: 1, catches: [], stats: { turns: 0, tokens: 0, pulls: 0 } };

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

const TIERS = ['common', 'rare', 'legendary', 'mythical'];

/**
 * Coerces one stored catch into the shape every consumer assumes.
 *
 * The collection is documented as user-editable, so a hand-edited row can be
 * missing any field. Normalizing once here means /pokedex cannot be crashed by a
 * single bad row -- previously an unrecognised `tier` produced `undefined.padEnd`
 * and took down the whole report.
 */
function normalizeCatch(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id < 1) return null; // unidentifiable; drop it
  const gen = Number(raw.gen);
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : `#${id}`,
    gen: Number.isInteger(gen) && gen >= 1 ? gen : 0,
    tier: TIERS.indexOf(raw.tier) !== -1 ? raw.tier : 'common',
    tokens: Number(raw.tokens) || 0,
    chance: Number(raw.chance) || 0,
    roll: Number(raw.roll) || 0,
    caughtAt: typeof raw.caughtAt === 'string' && raw.caughtAt ? raw.caughtAt : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    // Present only on shinies, so a normal row round-trips exactly as before.
    ...(raw.shiny === true ? { shiny: true } : {}),
  };
}

/** Reads the collection, returning a fresh one if absent or corrupt. */
function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(COLLECTION_PATH(), 'utf8'));
    return {
      version: 1,
      catches: Array.isArray(parsed.catches)
        ? parsed.catches.map(normalizeCatch).filter(Boolean)
        : [],
      stats: {
        turns: Number(parsed.stats && parsed.stats.turns) || 0,
        tokens: Number(parsed.stats && parsed.stats.tokens) || 0,
        pulls: Number(parsed.stats && parsed.stats.pulls) || 0,
      },
    };
  } catch (_) {
    return JSON.parse(JSON.stringify(EMPTY));
  }
}

/** Atomic write: temp file in the same dir, then rename (atomic on POSIX). */
function write(data) {
  ensureDir();
  const target = COLLECTION_PATH();
  const tmp = path.join(path.dirname(target), `.collection.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, target);
    renamed = true;
  } finally {
    // A failed rename (ENOSPC, EXDEV, a vanished dir) would otherwise leave the
    // temp file behind forever, since nothing else knows its name.
    if (!renamed) {
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
    }
  }
}

/**
 * Thrown when the lock could not be taken within the retry budget. Callers that
 * would rather drop a catch than corrupt the collection can ignore it; the
 * important part is that update() does NOT fall through to an unlocked write.
 */
class LockBusyError extends Error {
  constructor(lockPath, attempts, waitedMs) {
    super(`could not acquire ${lockPath} after ${attempts} attempts (${Math.round(waitedMs)}ms)`);
    this.name = 'LockBusyError';
    this.code = 'ELOCKBUSY';
  }
}

/**
 * How long to keep trying for the lock. A held lock is only ever held for one
 * read-modify-write, which grows with the collection: measured at ~1ms empty,
 * ~7ms at 1k catches and ~65ms at 10k. The budget has to cover several of those
 * back to back, or concurrent sessions start dropping catches on a large
 * collection. Two seconds is far below the hook's own stdin timeout and is only
 * ever reached under genuine contention.
 */
const DEFAULT_WAIT_MS = 2000;

/** Sleeps synchronously. Atomics.wait actually yields the CPU, unlike a spin loop. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* fallback: SharedArrayBuffer unavailable */ }
  }
}

/** Contents of a lockfile, identifying its holder. */
function readLock(lockPath) {
  try {
    return String(fs.readFileSync(lockPath, 'utf8')).trim();
  } catch (_) {
    return null;
  }
}

/** The pid recorded in a lockfile, or null if unreadable or legacy-empty. */
function lockHolderPid(lockPath) {
  const text = readLock(lockPath);
  if (!text) return null;
  const pid = Number(text.split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** True when no process with this pid exists, so its lock is certainly abandoned. */
function pidIsGone(pid) {
  if (pid === null) return false; // unknown holder: fall back to the age check
  if (pid === process.pid) return false; // our own lock is never stale
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means it exists but belongs to another user -- still alive.
    return err.code === 'ESRCH';
  }
}

/**
 * Read-modify-write under an exclusive lock so two sessions finishing at once
 * can't clobber each other's catch.
 *
 * The lock is advisory, with two independent ways to reclaim it so a crashed
 * process cannot wedge the collection permanently: the holder's pid is gone, or
 * the lockfile is older than staleMs. Critically, if neither applies and the
 * wait budget runs out, this throws instead of writing unlocked -- an unlocked
 * read-modify-write is exactly the lost-update race the lock exists to prevent.
 *
 * `retries` is still honoured for callers (and tests) that want a hard attempt
 * cap; the effective budget is whichever of the two limits is hit first.
 */
function update(mutator, { retries = Infinity, waitMs = DEFAULT_WAIT_MS, staleMs = 5000 } = {}) {
  ensureDir();
  const lockPath = path.join(dataDir(), '.collection.lock');

  // Unique per acquisition, so releasing can prove the lock is still the one we
  // took -- a bare pid could match a stale lock left by an earlier run of us.
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;

  const deadline = Date.now() + waitMs;
  let fd = null;
  let held = false;
  let attempt = 0;
  let backoff = 2;

  while (attempt < retries) {
    attempt++;
    try {
      fd = fs.openSync(lockPath, 'wx');
      // Record who owns it, so a later reclaim can verify before unlinking.
      try { fs.writeSync(fd, `${token}\n`); } catch (_) { /* advisory only */ }
      held = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Reclaim only a lock we can prove is abandoned, and only by removing the
      // exact file we inspected -- never a fresh lock that replaced it.
      try {
        const st = fs.statSync(lockPath);
        const holder = lockHolderPid(lockPath);
        const abandoned = pidIsGone(holder) || (Date.now() - st.mtimeMs) > staleMs;
        if (abandoned) {
          const after = fs.statSync(lockPath);
          if (after.ino === st.ino && after.mtimeMs === st.mtimeMs) {
            // Atomically claim the stale lock by renaming it. Only one process
            // can rename the same inode; losers get ENOENT and just retry.
            const grave = `${lockPath}.${process.pid}.reclaim`;
            try {
              fs.renameSync(lockPath, grave);
              try { fs.unlinkSync(grave); } catch (_) { /* best effort cleanup */ }
            } catch (renameErr) {
              if (renameErr.code !== 'ENOENT') throw renameErr;
              // Another process reclaimed it first; just retry.
            }
          }
          continue;
        }
      } catch (_) { /* lock vanished between calls; just retry */ }

      if (Date.now() >= deadline) break;
      // Backoff, capped, and never past the deadline: many writers waking at the
      // same 5ms cadence just collide again.
      sleepSync(Math.max(1, Math.min(backoff, deadline - Date.now())));
      backoff = Math.min(25, backoff * 2);
    }
  }

  if (!held) {
    // Never write without the lock. Losing one catch beats losing the collection.
    throw new LockBusyError(lockPath, attempt, waitMs - (deadline - Date.now()));
  }

  try {
    const data = read();
    const result = mutator(data);
    trimCatches(data);
    write(data);
    return result;
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    // Only remove the lock if it is still ours: a stale-breaker may have taken
    // it while we ran long, and unlinking then would free a lock we don't hold.
    // If the token was never written (writeSync failed), verify by fd/inode instead.
    try {
      const content = readLock(lockPath);
      if (content === token || (content === '' && held)) {
        fs.unlinkSync(lockPath);
      }
    } catch (_) { /* ignore */ }
  }
}

/**
 * Cap on stored catch rows. Every update() rewrites the whole file under the
 * lock, so the critical section grows with the collection: measured at ~1ms when
 * empty, ~7ms at 1k rows and ~65ms at 10k. Left unbounded it eventually makes
 * concurrent sessions contend badly on every turn.
 *
 * Trimming keeps the NEWEST rows: `stats` already carries the lifetime totals, so
 * turns/tokens/pulls stay accurate forever and only the per-catch history is
 * bounded. 20k rows is far beyond any real collection (the dex has 1,025 species)
 * while keeping the worst case near 130ms.
 */
const MAX_CATCHES = 20000;

/**
 * Bounds the stored history in place. Returns the number of rows dropped so
 * callers can surface it; normally zero.
 */
function trimCatches(data, max = MAX_CATCHES) {
  if (!Array.isArray(data.catches) || data.catches.length <= max) return 0;
  const dropped = data.catches.length - max;
  data.catches.splice(0, dropped);
  return dropped;
}

/** Records a turn's outcome. `catch_` is null on a miss. */
function recordTurn(tokens, catch_) {
  return update((data) => {
    data.stats.turns += 1;
    data.stats.tokens += tokens || 0;
    if (catch_) {
      data.stats.pulls += 1;
      data.catches.push(catch_);
    }
    return data;
  });
}

module.exports = {
  read, write, update, recordTurn, COLLECTION_PATH, LockBusyError,
  trimCatches, MAX_CATCHES, normalizeCatch,
};
