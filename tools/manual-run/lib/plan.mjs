// What each selected workflow does in one invocation, decided before any browser starts, so a
// mistyped --from or --only stops the run with a clear message instead of failing mid-run.

/**
 * @param {{ name: string, stepIds: string[] | null, exploratoryIds?: string[] }[]} workflows in run
 *   order; stepIds is null for a workflow that is not implemented yet, and exploratoryIds lists any
 *   steps left unscripted on purpose (reported as SKIPPED, with a note).
 * @param {{ from?: string, only?: string }} args
 * @returns {{ name: string, mode: 'full' | 'from' | 'only' | 'skip' | 'not-implemented',
 *   from?: string, only?: string[], reason?: string }[]}
 */
export function planRuns(workflows, { from, only } = {}) {
  if (from !== undefined && typeof from !== 'string') throw new Error('--from needs a step id');
  if (only !== undefined && typeof only !== 'string') throw new Error('--only needs step ids');
  // An empty value (`--from=`, `--only "$UNSET"`) must never turn a partial run into a full,
  // record-creating one.
  if (from !== undefined && !from.trim())
    throw new Error('--from is empty; give the step to resume from, e.g. --from sales-7');
  if (only !== undefined && !only.split(',').some((id) => id.trim()))
    throw new Error('--only is empty; give the steps to run, e.g. --only sales-3,sales-4');
  if (from !== undefined && only !== undefined)
    throw new Error('Use either --from or --only, not both.');
  const known = workflows
    .filter((w) => w.stepIds?.length)
    .map((w) => `${w.name}: ${w.stepIds.join(', ')}`)
    .join('; ');

  if (from !== undefined) {
    const expOwner = workflows.find((w) => w.exploratoryIds?.includes(from));
    if (expOwner)
      throw new Error(
        `--from ${from} is an exploratory step (not scripted; runnable steps for ${expOwner.name}: ${expOwner.stepIds?.join(', ') || 'none'}).`,
      );
    const owner = workflows.findIndex((w) => w.stepIds?.includes(from));
    if (owner < 0)
      throw new Error(`--from ${from} is not a step of the selected workflows (${known}).`);
    // Resuming an invocation: workflows listed before the resume point already ran and are left
    // alone; the owner resumes at the step; the ones after it run in full.
    return workflows.map((w, i) =>
      i < owner
        ? { name: w.name, mode: 'skip', reason: `listed before --from ${from}` }
        : i === owner
          ? { name: w.name, mode: 'from', from }
          : full(w),
    );
  }

  if (only !== undefined) {
    const ids = only
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) throw new Error('--only needs at least one step id');
    const exploratory = ids.filter((id) => workflows.some((w) => w.exploratoryIds?.includes(id)));
    if (exploratory.length)
      throw new Error(
        `--only ${exploratory.join(',')}: exploratory step(s), not scripted (runnable: ${known}).`,
      );
    const unknown = ids.filter((id) => !workflows.some((w) => w.stepIds?.includes(id)));
    if (unknown.length)
      throw new Error(
        `--only ${unknown.join(',')}: not a step of the selected workflows (${known}).`,
      );
    // A workflow with none of the listed steps is not run, so its stored results stay as they are.
    return workflows.map((w) => {
      const mine = ids.filter((id) => w.stepIds?.includes(id));
      return mine.length
        ? { name: w.name, mode: 'only', only: mine }
        : { name: w.name, mode: 'skip', reason: '--only lists none of its steps' };
    });
  }

  return workflows.map(full);
}

function full(w) {
  return w.stepIds?.length
    ? { name: w.name, mode: 'full' }
    : { name: w.name, mode: 'not-implemented' };
}
