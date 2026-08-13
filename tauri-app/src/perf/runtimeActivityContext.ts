export type RuntimeActivityCategory = 'cache-refresh' | 'runtime' | 'host';

export interface RuntimeActivityInput {
  category: RuntimeActivityCategory;
  name: string;
  details?: Record<string, unknown>;
}

export interface RuntimeActivitySnapshot {
  id: number;
  category: RuntimeActivityCategory;
  name: string;
  ageMs: number;
  depth: number;
  details?: Record<string, unknown>;
}

interface RuntimeActivityEntry extends RuntimeActivityInput {
  id: number;
  startedAt: number;
}

let nextRuntimeActivityId = 1;
const activityStack: RuntimeActivityEntry[] = [];

const now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const cloneDetails = (details?: Record<string, unknown>) => (
  details ? { ...details } : undefined
);

export const startRuntimeActivity = (input: RuntimeActivityInput) => {
  const entry: RuntimeActivityEntry = {
    ...input,
    details: cloneDetails(input.details),
    id: nextRuntimeActivityId++,
    startedAt: now(),
  };
  activityStack.push(entry);
  let ended = false;

  return {
    id: entry.id,
    end: () => {
      if (ended) return;
      ended = true;
      const index = activityStack.findIndex((activity) => activity.id === entry.id);
      if (index >= 0) {
        activityStack.splice(index, 1);
      }
    },
  };
};

export const getRuntimeActivitySnapshot = (): RuntimeActivitySnapshot | null => {
  const current = activityStack[activityStack.length - 1];
  if (!current) return null;
  return {
    id: current.id,
    category: current.category,
    name: current.name,
    ageMs: Number(Math.max(0, now() - current.startedAt).toFixed(2)),
    depth: activityStack.length,
    details: cloneDetails(current.details),
  };
};

export const withRuntimeActivity = async <Result>(
  input: RuntimeActivityInput,
  operation: () => Promise<Result> | Result,
): Promise<Result> => {
  const activity = startRuntimeActivity(input);
  try {
    return await operation();
  } finally {
    activity.end();
  }
};

export const resetRuntimeActivitiesForTest = () => {
  activityStack.splice(0, activityStack.length);
  nextRuntimeActivityId = 1;
};
