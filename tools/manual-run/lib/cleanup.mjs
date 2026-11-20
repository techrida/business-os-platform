// One place that takes the browser and the network forwarders down when the driver stops early:
// Ctrl-C (SIGINT), a kill (SIGTERM) or a crash. The handlers are installed once per process, however
// many browsers a run launches.
//
// Callbacks run in REVERSE registration order, one at a time: what was set up last is taken down
// first. run.mjs registers the folder lock before anything else, so it is released last, after the
// checkpoint is saved and the browser and forwarders are down.

const tasks = [];
let installed = false;
let stopping = false;
const limits = { taskMs: 10_000, ignoreMs: 5_000, forceMs: 30_000 };

/** Tests shorten the time limits. */
export function configureCleanup(next) {
  Object.assign(limits, next);
}

/** True once a signal started the cleanup: the run must not save over the checkpoint any more. */
export const isStopping = () => stopping;

/**
 * Registers `fn(sync)` to run when the process stops; returns a function that unregisters it.
 * On a signal, `fn(false)` may be async; it gets up to 10 s before the next callback runs. On
 * process exit, `fn(true)` must be synchronous (a pending promise is dropped there).
 */
export function onCleanup(fn) {
  install();
  const entry = { fn };
  tasks.push(entry);
  return () => {
    const i = tasks.indexOf(entry);
    if (i >= 0) tasks.splice(i, 1);
  };
}

/** Process exit: whatever is still registered runs synchronously, newest first. */
function runSync() {
  for (let t = tasks.pop(); t; t = tasks.pop()) {
    try {
      t.fn(true);
    } catch {
      // the next callback still runs
    }
  }
}

/** A signal: each callback is awaited (up to taskMs) before the next one starts, newest first. */
async function runAsync() {
  for (let t = tasks.pop(); t; t = tasks.pop()) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => t.fn(false)),
        new Promise((resolve) => (timer = setTimeout(resolve, limits.taskMs))),
      ]);
    } catch {
      // the next callback still runs
    } finally {
      clearTimeout(timer);
    }
  }
}

function install() {
  if (installed) return;
  installed = true;
  process.once('exit', runSync);
  let startedAt = 0;
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.on(signal, () => {
      if (stopping) {
        // A second Ctrl-C right away must not cut the cleanup short; a later one insists.
        if (Date.now() - startedAt < limits.ignoreMs) {
          console.error(`manual-run: ${signal} ignored; still closing down`);
          return;
        }
        console.error(`manual-run: ${signal} again; exiting now`);
        process.exit(code); // the exit hook still runs the synchronous rest (records, lock)
      }
      stopping = true;
      startedAt = Date.now();
      console.error(
        `manual-run: ${signal}; saving results, closing the browser and the forwarders`,
      );
      // Kept referenced: the process must not drop out with exit code 0 while cleanup waits.
      setTimeout(() => {
        console.error('manual-run: cleanup took too long; exiting');
        process.exit(code);
      }, limits.forceMs);
      void runAsync().then(() => process.exit(code));
    });
  }
}
