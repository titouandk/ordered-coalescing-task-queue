import { TaskTimedOutError } from "./types/TaskError.types.js";

/**
 * Creates an abort signal that combines a queue-level abort signal
 * with a per-task timeout. The resulting signal aborts if either the
 * queue is stopped or the timeout expires.
 *
 * When the timeout expires, the signal's `reason` is a `TaskTimedOutError`,
 * so that the queue can report the abort reason as-is.
 *
 * @param options Configuration options.
 * @param options.queueAbortSignal The main abort signal for the queue.
 * @param options.timeoutMs The timeout duration in milliseconds for the task.
 *                          Use `Infinity` to disable the timeout.
 *
 * @returns An object containing the combined abort signal and a function
 *          to cancel the timeout.
 *
 * @throws Error if `timeoutMs` is < 1ms.
 */
export function createAttemptSignal(options: {
  queueAbortSignal: AbortSignal;
  timeoutMs: number;
}): {
  signal: AbortSignal;
  cancelTimeout?: () => void;
} {
  const { queueAbortSignal, timeoutMs } = options;

  if (timeoutMs < 1) {
    throw new Error("Timeout must be greater than 0");
  }

  if (timeoutMs === Infinity) {
    return { signal: queueAbortSignal };
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(
      new TaskTimedOutError({
        message: `Task execution timed out after ${timeoutMs}ms`,
      }),
    );
  }, timeoutMs);

  const cancelTimeout = () => clearTimeout(timer);

  const combined = AbortSignal.any([
    queueAbortSignal,
    timeoutController.signal,
  ]);
  return { signal: combined, cancelTimeout };
}
