import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_LIMITS = {
  perfEvents: 120,
  samples: 30,
  actions: 40,
  stalls: 20,
  chatMutations: 50,
};

const ARRAY_LIMIT_KEYS = {
  perfEvents: 'perfEvents',
  samples: 'samples',
  actions: 'actions',
  runningGraphInteractions: 'actions',
  rafStalls: 'stalls',
  intervalStalls: 'stalls',
  chatMutations: 'chatMutations',
};

const cloneJson = (value) => (
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))
);

const safeSegment = (segment) => String(segment).replace(/[^a-zA-Z0-9_-]+/g, '-');

const artifactNameForPath = (pathSegments) => `${pathSegments.map(safeSegment).join('-')}.json`;

const limitForKey = (key, limits) => {
  const limitKey = ARRAY_LIMIT_KEYS[key];
  return limitKey ? limits[limitKey] : null;
};

const compactNode = (node, context) => {
  if (Array.isArray(node)) {
    return node.map((item) => compactNode(item, context));
  }
  if (!node || typeof node !== 'object') return node;

  const output = {};
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      const limit = limitForKey(key, context.limits);
      if (limit !== null && value.length > limit) {
        const artifactPath = join(context.artifactDir, artifactNameForPath([...context.path, key]));
        context.artifacts.push({ path: artifactPath, value });
        output[key] = value.slice(-limit).map((item) => compactNode(item, {
          ...context,
          path: [...context.path, key],
        }));
        output[`${key}Summary`] = {
          total: value.length,
          inline: limit,
          omitted: value.length - limit,
          artifactPath,
        };
        continue;
      }
      output[key] = value.map((item) => compactNode(item, {
        ...context,
        path: [...context.path, key],
      }));
      continue;
    }
    output[key] = compactNode(value, {
      ...context,
      path: [...context.path, key],
    });
  }
  return output;
};

export const compactPilotReport = (report, options = {}) => {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const artifactDir = options.artifactDir ?? 'artifacts';
  const artifacts = [];
  const compacted = compactNode(cloneJson(report), {
    limits,
    artifactDir,
    artifacts,
    path: [],
  });
  Object.defineProperty(compacted, '__pilotReportArtifacts', {
    value: artifacts,
    enumerable: false,
  });
  return compacted;
};

export const writeCompactPilotReport = ({ reportPath, report, limits } = {}) => {
  if (!reportPath) throw new Error('reportPath is required');
  const reportBase = basename(reportPath, '.json');
  const artifactDir = join(dirname(reportPath), `${reportBase}.artifacts`);
  const compacted = compactPilotReport(report, { artifactDir, limits });
  const artifacts = compacted.__pilotReportArtifacts ?? [];

  mkdirSync(dirname(reportPath), { recursive: true });
  if (artifacts.length > 0) {
    mkdirSync(artifactDir, { recursive: true });
    for (const artifact of artifacts) {
      writeFileSync(artifact.path, `${JSON.stringify(artifact.value, null, 2)}\n`, 'utf8');
    }
  }
  writeFileSync(reportPath, `${JSON.stringify(compacted, null, 2)}\n`, 'utf8');
  return { reportPath, artifactDir, artifacts };
};
