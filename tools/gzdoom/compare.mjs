// Compares two traces tic by tic and reports where they stop agreeing.
//
//   node tools/gzdoom/compare.mjs logs/gzdoom/map01-idle.trace logs/opendle/map01-idle.trace
//   node tools/gzdoom/compare.mjs a.trace b.trace --tolerance 0.05 --fields x,y,z
//
// The point is not "identical" — OpenDLE is not GZDoom, and small float differences are
// expected — it is *where* a divergence starts and which field moves first. That first
// tic is the one worth reading in both engines.
import { readTrace } from './trace.mjs';

const DEFAULT_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'angle', 'pitch'];

/**
 * Pairs two traces by tic and tag.
 *
 * Returns `{ paired, missing, first }`, where `first` is the earliest tic whose delta for
 * a field is beyond tolerance — the tic to look at first when a game behaves differently.
 */
export function compareTraces(left, right, { fields = DEFAULT_FIELDS, tolerance = 0.01, tags = null } = {}) {
  const rightByKey = new Map(right.samples.map(sample => [`${sample.tic}/${sample.tag}`, sample]));
  const paired = [], missing = [];
  let first = null;
  let worst = { field: null, delta: 0, tic: null };

  for (const sample of left.samples) {
    if (tags && !tags.includes(sample.tag)) continue;
    const other = rightByKey.get(`${sample.tic}/${sample.tag}`);
    if (!other) { missing.push(`${sample.tic}/${sample.tag}`); continue; }
    const deltas = {};
    for (const field of fields) {
      const a = sample[field], b = other[field];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const delta = Math.abs(a - b);
      deltas[field] = delta;
      if (delta > worst.delta) worst = { field, delta, tic: sample.tic };
      if (delta > tolerance && (!first || sample.tic < first.tic)) {
        first = { tic: sample.tic, tag: sample.tag, field, left: a, right: b, delta };
      }
    }
    paired.push({ tic: sample.tic, tag: sample.tag, deltas, left: sample, right: other });
  }

  return { paired, missing, first, worst, tolerance };
}

/** A short, readable report: the first divergence and the overall worst delta. */
export function report(result) {
  const lines = [];
  lines.push(`paired ${result.paired.length} sample(s), tolerance ${result.tolerance}`);
  if (result.missing.length) lines.push(`unmatched: ${result.missing.length} (first: ${result.missing.slice(0, 3).join(', ')})`);
  if (result.first) {
    const { tic, tag, field, left, right, delta } = result.first;
    lines.push(`first divergence: tic ${tic} ${tag} ${field}=${left} (gzdoom) vs ${right} (opendle), delta ${delta.toFixed(4)}`);
  } else {
    lines.push('no divergence within tolerance');
  }
  if (result.worst.field) lines.push(`worst delta: ${result.worst.field} ${result.worst.delta.toFixed(4)} at tic ${result.worst.tic}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { tolerance: 0.01, fields: DEFAULT_FIELDS, tags: null };
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--tolerance') options.tolerance = Number(argv[++index]);
    else if (arg === '--fields') options.fields = argv[++index].split(',');
    else if (arg === '--tags') options.tags = argv[++index].split(',');
    else files.push(arg);
  }
  return { options, files };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { options, files } = parseArgs(process.argv.slice(2));
  if (files.length !== 2) {
    console.error('usage: node tools/gzdoom/compare.mjs <left.trace> <right.trace> [--tolerance n] [--fields a,b]');
    process.exit(2);
  }
  const result = compareTraces(readTrace(files[0]), readTrace(files[1]), options);
  console.log(report(result));
  process.exitCode = result.first ? 1 : 0;
}
