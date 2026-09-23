import type { ICoalescedTaskDescription } from "./TaskDescription.types.js";
import type { IFailedTaskOutcome, ITaskOutcome } from "./TaskOutcome.types.js";

/**
 * Configuration options of a queue instance.
 */
export interface IQueueConfig<TTaskId, TTaskPayload, TTaskResult> {
  /**
   * Executor function provided by the user to specify how to process a task.
   * The queue is responsible to call this function at the appropriate time
   * (with either an original task or a coalesced task) and to deliver the
   * results in order.
   */
  executeTask(
    this: void,
    task: ICoalescedTaskDescription<TTaskId, TTaskPayload>,
    abortSignal: AbortSignal,
  ): Promise<TTaskResult>;

  /**
   * This function is provided by the user to specify how to combine
   * two task payloads into a single one, when they are coalesced.
   */
  coalesceTaskPayloads(
    this: void,
    oldestTaskPayload: TTaskPayload,
    newestTaskPayload: TTaskPayload,
  ): TTaskPayload;

  /**
   * Predicate function to determine if two adjacent tasks are allowed
   * to coalesce together.
   *
   * If provided, the queue will only coalesce two eligible adjacent tasks if
   * this function returns `true`. If it returns `false`, the tasks remain
   * separate and will be executed individually in order.
   *
   * Provide `null` if you do not want to restrict task coalescence.
   */
  canCoalesceTasks:
    | ((
        this: void,
        oldestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>,
        newestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>,
      ) => boolean)
    | null;

  /**
   * Maximum number of tasks allowed to be processed in parallel.
   *
   * Special values:
   * - 0 or negative values are not allowed (they will throw).
   * - Provide `1` if you want to process tasks sequentially (not in parallel).
   * - Provide `Infinity` if you want to process all tasks in parallel.
   *
   * Results order is preserved, even with parallel execution. The results
   * are guaranteed to be delivered in the same order as the order in which
   * tasks were submitted, even if a later task finishes before an earlier
   * task.
   *
   * @throws {Error} if `maxConcurrency` is < 1.
   */
  maxConcurrency: number;

  /**
   * Maximum number of tasks allowed to be coalesced together.
   *
   * Special values:
   * - 0 or negative values are not allowed (they will throw).
   * - Provide `1` if you do NOT want to coalesce tasks (i.e. each task will
   *   be processed as a separate task).
   * - Provide `Infinity` if you want to coalesce all tasks together.
   *
   * @throws {Error} if `maxCoalescingDepth` is < 1.
   */
  maxCoalescingDepth: number;

  /**
   * Initial number of execution credits granted to new tasks.
   *
   * Special values:
   * - 0 and negative values are not allowed (they will throw).
   * - Provide `1` if you do NOT want to retry failed tasks (i.e. each task
   *   will only be attempted once).
   * - Provide `Infinity` if you want to retry a task forever.
   *
   * Special case: if the user clears the queue, the tasks are not retried,
   * even if they had execution credits left before the queue was cleared.
   *
   * The initial execution credit count is specified here (globally) for all the
   * tasks, rather than per task, as the tasks can be coalesced together.
   * This avoids having to manage an execution credit count merge strategy
   * (min/max/avg, etc).
   *
   * @throws {Error} if `initialExecutionCredits` is < 1.
   */
  initialExecutionCredits: number;

  /**
   * Timeout in milliseconds for executing a task.
   * The task will be retried if it times out (if retry credits left).
   *
   * Special values:
   * - 0 and negative values are not allowed (they will throw).
   * - Provide `Infinity` if you do not want to use a timeout.
   *
   * The timeout is specified here (globally) for all the tasks, rather
   * than per task, as the tasks can be coalesced together. This avoids
   * having to manage a timeout merge strategy (min/max/avg, etc).
   *
   * @throws {Error} if `timeoutMs` is < 1.
   */
  timeoutMs: number;

  /**
   * Callback invoked each time coalescing two tasks has failed.
   * If the coalescence fails, the two tasks will be kept in the queue
   * as two separate tasks, and will be processed independently.
   * Provide `null` if you do not want to handle this event.
   */
  onFailedTaskCoalescence:
    | ((this: void, context: IFailedCoalescence<TTaskId, TTaskPayload>) => void)
    | null;

  /**
   * Callback invoked immediately in real-time each time an individual execution
   * attempt fails (whether retryable or final).
   *
   * Unlike `onTaskResult`, this fires as soon as the attempt fails, without
   * waiting for predecessor tasks in the queue to complete.
   * Check `remainingExecutionCredits` on the outcome to determine whether the task
   * will be retried (`> 0`) or has exhausted its credits (`=== 0`).
   *
   * **Triggered when:**
   * - The executor (`executeTask`) throws an error or returns a rejecting promise.
   * - An attempt times out (`timeoutMs` elapsed before the executor resolves).
   *
   * **NOT triggered when:**
   * - Tasks are cleared or aborted via `clearAllTasks()` (their terminal failure
   *   is reported directly via `onTaskResult`).
   * - Task coalescence fails (triggers `onFailedTaskCoalescence` instead).
   *
   * Provide `null` if you do not want to handle this event.
   */
  onFailedTaskExecutionAttempt:
    | ((this: void, outcome: IFailedTaskOutcome<TTaskId>) => void)
    | null;

  /**
   * Callback invoked when a task has definitively finished (either successfully,
   * after exhausting all execution credits, or when aborted / cleared).
   *
   * Delivered in strict FIFO queue order: this callback is only invoked once a
   * task reaches the head of the queue and all predecessor tasks have finished.
   *
   * This handler is mandatory.
   */
  onTaskResult: (
    this: void,
    outcome: ITaskOutcome<TTaskId, TTaskResult>,
  ) => void;
}

/**
 * Context provided when coalescing two tasks has failed.
 */
export interface IFailedCoalescence<TTaskId, TTaskPayload> {
  /** The older task in the queue that was being coalesced. */
  readonly oldestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>;
  /** The newer task that was being coalesced. */
  readonly newestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>;
  /** The error that caused the coalescence to fail. */
  readonly error: unknown;
}
