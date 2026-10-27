export interface ComposerSendAcceptanceQueueState {
  acceptingId: string | null;
  queuedCount: number;
}

export interface ComposerSendAcceptanceHandle<TResult> {
  id: string;
  queued: boolean;
  completion: Promise<TResult>;
}

export type ComposerSendAcceptanceHandler<TSnapshot, TResult> = (
  snapshot: TSnapshot,
  accepted: () => void,
) => Promise<TResult>;

interface QueuedComposerSend<TSnapshot, TResult> {
  id: string;
  snapshot: TSnapshot;
  handler: ComposerSendAcceptanceHandler<TSnapshot, TResult>;
  resolve: (value: TResult) => void;
  reject: (reason: unknown) => void;
}

const createQueueId = () => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `composer-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
);

/**
 * Serializes only the acceptance phase of composer sends.
 *
 * A send calls `accepted()` as soon as its user/assistant nodes are durably
 * visible. The next queued send may then begin while the previous runtime
 * launch continues in the background. This keeps repeated Enter presses
 * responsive without serializing independent agent runs.
 */
export class ComposerSendAcceptanceQueue<TSnapshot, TResult = void> {
  private acceptingId: string | null = null;
  private readonly queue: Array<QueuedComposerSend<TSnapshot, TResult>> = [];
  private readonly listeners = new Set<(state: ComposerSendAcceptanceQueueState) => void>();

  getState(): ComposerSendAcceptanceQueueState {
    return {
      acceptingId: this.acceptingId,
      queuedCount: this.queue.length,
    };
  }

  subscribe(listener: (state: ComposerSendAcceptanceQueueState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  submit(
    snapshot: TSnapshot,
    handler: ComposerSendAcceptanceHandler<TSnapshot, TResult>,
    id = createQueueId(),
  ): ComposerSendAcceptanceHandle<TResult> {
    const queued = this.acceptingId !== null || this.queue.length > 0;
    let resolveCompletion!: (value: TResult) => void;
    let rejectCompletion!: (reason: unknown) => void;
    const completion = new Promise<TResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    this.queue.push({
      id,
      snapshot,
      handler,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    });
    this.emit();
    void this.drain();

    return { id, queued, completion };
  }

  private emit() {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private async drain(): Promise<void> {
    if (this.acceptingId !== null) return;
    const next = this.queue.shift();
    if (!next) {
      this.emit();
      return;
    }

    this.acceptingId = next.id;
    this.emit();
    let released = false;
    const accepted = () => {
      if (released) return;
      released = true;
      if (this.acceptingId === next.id) this.acceptingId = null;
      this.emit();
      void this.drain();
    };

    try {
      const result = await next.handler(next.snapshot, accepted);
      next.resolve(result);
    } catch (error) {
      next.reject(error);
    } finally {
      accepted();
    }
  }
}

