// Longest measured spec first. Portal work occupies one bucket before assigning workspace files.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function partition(seconds, count) {
  if (![6, 10, 14].includes(count)) throw new Error('Unsupported QA shard count');
  const buckets = Array.from({ length: count }, (_, i) => ({
    seconds: i === 0 ? 77 : 0,
    files: [],
  }));
  for (const [file, duration] of Object.entries(seconds).sort((a, b) => b[1] - a[1])) {
    const bucket = buckets.reduce((a, b) => (a.seconds <= b.seconds ? a : b));
    bucket.files.push(file);
    bucket.seconds += duration;
  }
  return buckets;
}

export function matrix(selected, count) {
  const entries = selected.include;
  if (!entries.some((job) => job.ws && job.mode === 'specs')) return selected;
  const portal = entries.some((job) => job.portal);
  return {
    include: [
      ...Array.from({ length: count }, (_, i) => ({
        mode: 'specs',
        id: String(i + 1),
        shard: `${i + 1}/${count}`,
        ws: true,
        list: `shard-${i + 1}`,
        portal: portal && i === 0,
      })),
      ...entries.filter((job) => job.mode === 'quarantined'),
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = Number(process.env.QA_SHARDS);
  const seconds = JSON.parse(readFileSync('.github/qa/spec-seconds.json', 'utf8'));
  const buckets = partition(seconds, count);
  if (process.argv[2] === '--matrix') {
    const result = matrix(JSON.parse(process.env.SELECTED), count);
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(result)}\n`);
  } else {
    buckets.forEach(({ files }, i) =>
      writeFileSync(`.github/qa/shard-${i + 1}.txt`, files.join('\n') + '\n'),
    );
  }
}
