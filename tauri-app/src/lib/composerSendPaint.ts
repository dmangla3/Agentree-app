type WaitForOptimisticSendPaintOptions = {
  frameCount?: number;
  timeoutMs?: number;
};

const waitForFrame = (): Promise<void> => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
};

export async function waitForOptimisticSendPaint({
  frameCount = 2,
  timeoutMs = 280,
}: WaitForOptimisticSendPaintOptions = {}): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const waitForFrames = async () => {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      await waitForFrame();
    }
  };
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([
      waitForFrames(),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}
