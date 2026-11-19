// One place that takes the browser and the network forwarders down when the driver stops early:
// Ctrl-C (SIGINT), a kill (SIGTERM) or a crash. The handlers are installed once per process, however
// many browsers a run launches.

const tasks = new Set();
let installed = false;

/**
 * Registers `fn(sync)` to run when the process stops; returns a function that unregisters it.
 * On a signal, `fn(false)` may be async and gets up to 5 s. On process exit, `fn(true)` must be
 * synchronous (a pending promise is dropped there).
 */
export function onCleanup(fn) {
  install();
  tasks.add(fn);
  return () => tasks.delete(fn);
}

function runAll(sync) {
  const all = [...tasks];
  tasks.clear();
  return all.map((fn) => {
    try {
      return Promise.resolve(fn(sync)).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  });
}

function install() {
  if (installed) return;
  installed = true;
  process.once('exit', () => void runAll(true));
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.once(signal, () => {
      console.error(`manual-run: ${signal}; closing the browser and the network forwarders`);
      const pending = Promise.all(runAll(false));
      const limit = new Promise((r) => setTimeout(r, 5000).unref());
      void Promise.race([pending, limit]).then(() => process.exit(code));
    });
  }
}
