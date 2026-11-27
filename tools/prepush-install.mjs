// Run by the root `prepare` script. Points git at .githooks so the pre-push public-repo check is on
// without any setup. Does nothing, and never fails, outside a git work tree (CI, Docker, tarballs).
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const HOOKS = '.githooks';

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function install(cwd = process.cwd()) {
  try {
    process.chdir(cwd);
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(cwd)) return 'skipped';
    let current = '';
    try {
      current = git(['config', '--local', 'core.hooksPath']);
    } catch {
      // unset
    }
    if (current === HOOKS) return 'already-installed';
    if (current) {
      console.warn(`pre-push guard not installed: core.hooksPath is already "${current}".`);
      return 'conflict';
    }
    git(['config', '--local', 'core.hooksPath', HOOKS]);
    return 'installed';
  } catch {
    return 'skipped';
  }
}
