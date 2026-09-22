import { createAttemptSignal } from "./OrderedCoalescingTaskQueue.utils.js";
import { TaskStore } from "./TaskStore.js";
import type { IQueue } from "./types/Queue.types.js";
import type { IQueueConfig } from "./types/QueueConfig.types.js";
import type { IPendingTask, IRunningTask } from "./types/Task.types.js";
import type {
  IAtomicTaskDescription,
  ICoalescedTaskDescription,
} from "./types/TaskDescription.types.js";
import {
  TaskAbortedError,
  TaskExecutionError,
  TaskTimedOutError,
  type TaskError,
} from "./types/TaskError.types.js";

/**
 * An ordered task queue that coalesces incoming tasks and executes them
 * with bounded concurrency, while delivering results in submission order.
 */
export class OrderedCoalescingTaskQueue<
  TTaskId,
  TTaskPayload,
  TTaskResult,
> implements IQueue<TTaskId, TTaskPayload> {
  readonly #config: IQueueConfig<TTaskId, TTaskPayload, TTaskResult>;
  readonly #store: TaskStore<TTaskId, TTaskPayload, TTaskResult>;

  /**
   * Controller used to abort every running task when the queue is cleared.
   * It is replaced by a fresh controller after each clear, so that the
   * queue can keep being used afterwards.
   */
  #abortController = new AbortController();

  /**
   * @throws {Error} if the configuration contains an invalid value.
   */
  constructor(config: IQueueConfig<TTaskId, TTaskPayload, TTaskResult>) {
    validateConfig(config);
    this.#config = config;
    this.#store = new TaskStore({
      maxCoalescingDepth: config.maxCoalescingDepth,
    });
  }

  pushTask(task: IAtomicTaskDescription<TTaskId, TTaskPayload>): void {
    const newTask: IPendingTask<TTaskId, TTaskPayload> = {
      status: "pending",
      ids: [task.id],
      payload: task.payload,
      remainingExecutionCredits: this.#config.initialExecutionCredits,
      coalescible: true,
    };

    this.#store.pushTask(newTask);
    this.#schedule();
  }

  clearAllTasks(): void {
    const clearedTasks = this.#store.clearAllTasks();
    if (clearedTasks.length === 0) {
      return;
    }

    // Abort in-flight attempts. Their `#execute` continuation will notice
    // that the task is no longer owned by the queue and stop silently, so
    // the queue state is fully reset right here, synchronously.
    const error = new TaskAbortedError({
      message: "Task aborted because the queue was cleared",
    });
    this.#abortController.abort(error);
    this.#abortController = new AbortController();

    // Every dropped task gets a final outcome, in order, so that the user
    // can account for every id they pushed. Clearing forfeits any retry
    // credits, hence the 0.
    for (const task of clearedTasks) {
      this.#config.onTaskResult({
        ids: task.ids,
        status: "failed",
        error,
        remainingExecutionCredits: 0,
      });
    }
  }

  /**
   * Repeatedly coalesces adjacent eligible tasks in the store until
   * no further pairs can be coalesced.
   *
   * Coalescence is sequential and not concurrent, to ensure that we maximize
   * the number of coalesced tasks within the `maxCoalescingDepth` constraint.
   *
   * Example of a concurrent coalescing of tasks (with `maxCoalescingDepth` = 3):
   * Step 1: [tA, tB, tC, tD]
   * Step 2: [tAB, tCD] `maxCoalescingDepth` is not reached yet for the tasks.
   * Step 3: [tABCD] `maxCoalescingDepth` is exceeded!
   *
   * Example of a sequential coalescing of tasks (with `maxCoalescingDepth` = 3):
   * Step 1: [tA, tB, tC, tD]
   * Step 2: [tAB, tC, tD] `maxCoalescingDepth` is not reached yet for the tasks.
   * Step 3: [tABC, tD] `maxCoalescingDepth` is reached.
   */
  #coalesce(): void {
    while (true) {
      // Get the next pair of tasks to coalesce. The store will mark
      // them as "being coalesced" right here to prevent re-entrant
      // coalescing calls from picking up the same tasks.
      const pair = this.#store.claimCoalescibleTaskPair();
      if (!pair) {
        break;
      }

      const [oldest, newest] = pair;

      let payload: TTaskPayload;
      try {
        payload = this.#config.coalesceTaskPayloads(
          oldest.payload,
          newest.payload,
        );
      } catch (error) {
        // First, commit new state, indicating that tasks are now ready to
        // be processed (individually, not as a single coalesced task).
        this.#store.rejectTaskCoalescence(pair);

        // Then, notify the user by executing his handler. This code is
        // potentially re-entrant, which is why we execute it AFTER committing
        // the new state.
        this.#config.onFailedTaskCoalescence?.({
          oldestTask: describe(oldest),
          newestTask: describe(newest),
          error,
        });
        continue;
      }

      const coalescedTask: IPendingTask<TTaskId, TTaskPayload> = {
        status: "pending",
        ids: [...oldest.ids, ...newest.ids],
        payload,
        remainingExecutionCredits: oldest.remainingExecutionCredits,
        coalescible: true,
      };

      this.#store.resolveTaskCoalescence(pair, coalescedTask);
    }
  }

  /**
   * Starts as many executable tasks as the concurrency limit allows,
   * oldest first.
   */
  #schedule(): void {
    this.#coalesce();
    while (this.#store.runningCount < this.#config.maxConcurrency) {
      const runningTask = this.#store.claimExecutableTask();
      if (!runningTask) {
        break;
      }
      void this.#execute(runningTask);
    }
  }

  /**
   * Runs a single attempt of a task, records its outcome, then resumes
   * delivery and scheduling.
   *
   * Never rejects: every failure path is converted into a `failed` state.
   */
  async #execute(
    runningTask: IRunningTask<TTaskId, TTaskPayload>,
  ): Promise<void> {
    const { signal, cancelTimeout } = createAttemptSignal({
      queueAbortSignal: this.#abortController.signal,
      timeoutMs: this.#config.timeoutMs,
    });

    const description = describe(runningTask);

    const abortion = rejectOnAbort(signal);
    let result: TTaskResult | undefined;
    let error: TaskError | undefined;
    let isSuccess = false;

    try {
      // Racing against the signal makes the attempt fail as soon as the
      // signal aborts, without waiting for the executor to honor it.
      result = await Promise.race([
        this.#config.executeTask(description, signal),
        abortion.promise,
      ]);
      isSuccess = true;
    } catch (cause) {
      error = toTaskError(cause, signal);
    } finally {
      cancelTimeout?.();
      abortion.dispose();
    }

    if (isSuccess) {
      const committed = this.#store.resolveTaskExecution(
        runningTask,
        result as TTaskResult,
      );
      if (!committed) {
        // The queue was cleared while this attempt was in flight. Its outcome
        // has already been reported and its slot released by `clearAllTasks`.
        return;
      }
    } else {
      const committed = this.#store.rejectTaskExecution(
        runningTask,
        error as TaskError,
      );
      if (!committed) {
        // The queue was cleared while this attempt was in flight. Its outcome
        // has already been reported and its slot released by `clearAllTasks`.
        return;
      }
    }

    if (!isSuccess) {
      this.#config.onFailedTaskExecutionAttempt?.({
        ids: runningTask.ids,
        status: "failed",
        error: error as TaskError,
        remainingExecutionCredits: runningTask.remainingExecutionCredits,
      });
    }

    this.#deliverResults();
    this.#schedule();
  }

  /**
   * Delivers the results of every terminal task at the head of the queue,
   * in order, and removes them from the queue. Stops at the first task
   * that is still pending, running, or awaiting a retry.
   */
  #deliverResults(): void {
    const finishedTasks = this.#store.clearFinishedTasks();

    for (const task of finishedTasks) {
      if (task.status === "succeeded") {
        this.#config.onTaskResult({
          ids: task.ids,
          status: "succeeded",
          result: task.result,
        });
      } else {
        this.#config.onTaskResult({
          ids: task.ids,
          status: "failed",
          error: task.error,
          remainingExecutionCredits: task.remainingExecutionCredits,
        });
      }
    }
  }
}

/**
 * Returns a promise that rejects with the signal's reason as soon as the
 * signal aborts, along with a `dispose` function that detaches the
 * listener.
 *
 * Disposing matters: when no timeout is configured, the attempt signal is
 * the long-lived queue signal itself, and a listener left behind by every
 * attempt would accumulate for the whole lifetime of the queue.
 */
function rejectOnAbort(signal: AbortSignal): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let onAbort = () => {};
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * Classifies the cause of a failed attempt.
 *
 * If the attempt signal aborted, the abort reason (timeout or queue clear)
 * is the failure, whatever the executor rejected with: an executor that
 * honors the signal typically rejects with `signal.reason` itself.
 * Otherwise, the executor failed on its own and its error is wrapped.
 */
function toTaskError(cause: unknown, signal: AbortSignal): TaskError {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (
      reason instanceof TaskTimedOutError ||
      reason instanceof TaskAbortedError
    ) {
      return reason;
    }
    return new TaskAbortedError({
      message: `Task execution aborted: ${String(reason)}`,
    });
  }
  return new TaskExecutionError({
    message: "Task executor threw or rejected",
    cause,
  });
}

/**
 * Builds the public, state-free description of an internal task.
 */
function describe<TTaskId, TTaskPayload>(task: {
  ids: TTaskId[];
  payload: TTaskPayload;
}): ICoalescedTaskDescription<TTaskId, TTaskPayload> {
  return { ids: task.ids, payload: task.payload };
}

/**
 * Validates the numeric bounds of a queue configuration.
 *
 * @throws {Error} if any bound is violated.
 */
function validateConfig(
  config: Pick<
    IQueueConfig<unknown, unknown, unknown>,
    | "maxConcurrency"
    | "maxCoalescingDepth"
    | "initialExecutionCredits"
    | "timeoutMs"
  >,
): void {
  assertAtLeast("maxConcurrency", config.maxConcurrency, 1);
  assertAtLeast("maxCoalescingDepth", config.maxCoalescingDepth, 1);
  assertAtLeast("initialExecutionCredits", config.initialExecutionCredits, 1);
  assertAtLeast("timeoutMs", config.timeoutMs, 1);
}

function assertAtLeast(name: string, value: number, min: number): void {
  // The check is written as `!(value >= min)` rather than `value < min` on
  // purpose, so that `NaN` is rejected too. Every comparison involving `NaN`
  // is `false`: `NaN < 1` is `false`, but so is `NaN >= 1`. A naive
  // `if (value < min) throw` would therefore let `NaN` through silently,
  // whereas negating the "is valid" condition rejects it.
  if (!(value >= min)) {
    throw new Error(`${name} must be >= ${min}, received ${value}`);
  }
}
