// Count visible non-completed jobs in active organization runs, excluding this workflow run.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function shardCount(busy, ceiling = 14) {
  if (!Number.isInteger(busy) || busy < 0) return 4;
  return Math.max(1, Math.min(ceiling, 14, 20 - busy - 2));
}

function pages(path) {
  return JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', path], {
      encoding: 'utf8',
      timeout: 20000,
    }),
  );
}

export function busyJobs(org, currentRun) {
  let busy = 0;
  const repos = pages(`orgs/${org}/repos?per_page=100`)
    .flat()
    .filter((r) => !r.archived && !r.disabled);
  for (const repo of repos) {
    const runs = new Set();
    for (const status of ['in_progress', 'queued']) {
      for (const page of pages(
        `repos/${repo.full_name}/actions/runs?status=${status}&per_page=100`,
      ))
        for (const run of page.workflow_runs) if (String(run.id) !== currentRun) runs.add(run.id);
    }
    for (const run of runs) {
      for (const page of pages(`repos/${repo.full_name}/actions/runs/${run}/jobs?per_page=100`))
        busy += page.jobs.filter((job) => job.status !== 'completed').length;
    }
  }
  return busy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let busy;
  try {
    busy = busyJobs(process.env.GITHUB_REPOSITORY_OWNER, process.env.GITHUB_RUN_ID);
  } catch {
    console.error('Organization job count unavailable. Using four shards.');
  }
  console.log(shardCount(busy, Number(process.env.QA_SHARD_CEILING || 14)));
}
