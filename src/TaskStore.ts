/**
 * @file Manages the internal task collection and state transitions for the queue.
 *
 * All mutating functions in this store represent atomic state transitions performed at a single
 * point in time (strictly synchronous, no async). They must never execute user-provided code
 * (i.e. external listeners) to prevent re-entrancy during state mutations.
 */

import {
  areCoalescible,
  isExecutable,
  isRetryable,
  type ICoalescingTask,
  type IFailedTask,
  type IPendingTask,
  type IRunningTask,
  type ISucceededTask,
  type ITask,
} from "./types/Task.types.js";
import type { TaskError } from "./types/TaskError.types.js";

export { areCoalescible };

/**
 * Configuration options for TaskStore.
 */
export interface ITaskStoreConfig {
  readonly maxCoalescingDepth: number;
}

/**
 * Encapsulates the task collection and atomic operations
 * for task lifecycle transitions (push, coalescence, execution, and clearance).
 */
export class TaskStore<TTaskId, TTaskPayload, TTaskResult> {
  readonly #config: ITaskStoreConfig;

  /**
   * Internal list of tasks in order.
   */
  readonly #tasks: ITask<TTaskId, TTaskPayload, TTaskResult>[] = [];

  /**
   * Number of tasks currently in the "running" state.
   */
  #runningCount = 0;

  constructor(config: ITaskStoreConfig) {
    this.#config = config;
  }

  /**
   * Returns the number of tasks currently in the "running" state.
   */
  get runningCount(): number {
    return this.#runningCount;
  }

  /**
   * Appends a pending task to the tail of the list.
   */
  pushTask(task: IPendingTask<TTaskId, TTaskPayload>): void {
    this.#tasks.push(task);
  }

  /**
   * Finds the oldest adjacent pair of coalescible tasks, transitions both
   * to "coalescing" status, and returns the pair (or null if no coalescible pair is found).
   *
   * Only one pair (at most two tasks) may be marked as "coalescing" at a time.
   * Calling this method while a pair is already marked as coalescing returns null.
   *
   * A pair is eligible to coalesce only if both tasks are individually coalescible
   * and their combined number of IDs does not exceed maxCoalescingDepth.
   */
  claimCoalescibleTaskPair():
    | [
        ICoalescingTask<TTaskId, TTaskPayload>,
        ICoalescingTask<TTaskId, TTaskPayload>,
      ]
    | null {
    for (let i = 0; i < this.#tasks.length; i++) {
      if (this.#tasks[i].status === "coalescing") {
        return null;
      }
    }

    for (let i = 1; i < this.#tasks.length; i++) {
      const prev = this.#tasks[i - 1];
      const curr = this.#tasks[i];
      if (areCoalescible(prev, curr, this.#config.maxCoalescingDepth)) {
        const coalescingPrev: ICoalescingTask<TTaskId, TTaskPayload> = {
          status: "coalescing",
          ids: prev.ids,
          payload: prev.payload,
          remainingExecutionCredits: prev.remainingExecutionCredits,
          coalescible: prev.coalescible,
        };
        const coalescingCurr: ICoalescingTask<TTaskId, TTaskPayload> = {
          status: "coalescing",
          ids: curr.ids,
          payload: curr.payload,
          remainingExecutionCredits: curr.remainingExecutionCredits,
          coalescible: curr.coalescible,
        };

        this.#tasks[i - 1] = coalescingPrev;
        this.#tasks[i] = coalescingCurr;

        return [coalescingPrev, coalescingCurr];
      }
    }
    return null;
  }

  /**
   * Validates that both tasks in the pair are still contiguous in the list
   * and in "coalescing" status. If valid, replaces the pair with the merged task
   * and returns true. Otherwise, leaves the list untouched and returns false.
   */
  resolveTaskCoalescence(
    pair: [
      ICoalescingTask<TTaskId, TTaskPayload>,
      ICoalescingTask<TTaskId, TTaskPayload>,
    ],
    coalescedTask: IPendingTask<TTaskId, TTaskPayload>,
  ): boolean {
    const [task1, task2] = pair;
    const idx1 = this.#tasks.indexOf(task1);

    if (
      idx1 === -1 ||
      this.#tasks[idx1 + 1] !== task2 ||
      task1.status !== "coalescing" ||
      task2.status !== "coalescing"
    ) {
      return false;
    }

    this.#tasks.splice(idx1, 2, coalescedTask);
    return true;
  }

  /**
   * Validates that both tasks in the pair still exist in the list,
   * are still contiguous in the list and in "coalescing" status.
   * If valid, resets both tasks to "pending":
   * marks the predecessor task1 as uncoalescible (coalescible: false) to prevent
   * infinite coalescence retries, while leaving task2 coalescible.
   * Returns true if successful, or false otherwise.
   */
  rejectTaskCoalescence(
    pair: [
      ICoalescingTask<TTaskId, TTaskPayload>,
      ICoalescingTask<TTaskId, TTaskPayload>,
    ],
  ): boolean {
    const [task1, task2] = pair;
    const idx1 = this.#tasks.indexOf(task1);

    if (
      idx1 === -1 ||
      this.#tasks[idx1 + 1] !== task2 ||
      task1.status !== "coalescing" ||
      task2.status !== "coalescing"
    ) {
      return false;
    }

    const restored1: IPendingTask<TTaskId, TTaskPayload> = {
      status: "pending",
      ids: task1.ids,
      payload: task1.payload,
      remainingExecutionCredits: task1.remainingExecutionCredits,
      // task1 is marked as uncoalescible to prevent infinite retries.
      coalescible: false,
    };
    const restored2: IPendingTask<TTaskId, TTaskPayload> = {
      status: "pending",
      ids: task2.ids,
      payload: task2.payload,
      remainingExecutionCredits: task2.remainingExecutionCredits,
      // task2 is NOT marked as uncoalescible, because while it failed
      // to coalesce being the second task in a pair, it could still
      // be the first task in a future pair.
      coalescible: task2.coalescible,
    };

    this.#tasks.splice(idx1, 2, restored1, restored2);
    return true;
  }

  /**
   * Finds the oldest executable task, decrements its remaining execution credits,
   * transitions it to "running", and returns it.
   * Returns null if no task is currently executable.
   */
  claimExecutableTask(): IRunningTask<TTaskId, TTaskPayload> | null {
    for (let i = 0; i < this.#tasks.length; i++) {
      const task = this.#tasks[i];
      if (isExecutable(task)) {
        const runningTask: IRunningTask<TTaskId, TTaskPayload> = {
          status: "running",
          ids: task.ids,
          payload: task.payload,
          remainingExecutionCredits: task.remainingExecutionCredits - 1,
          coalescible: task.coalescible,
        };
        this.#tasks[i] = runningTask;
        this.#runningCount++;
        return runningTask;
      }
    }
    return null;
  }

  /**
   * Validates that runningTask is still present and in "running" status.
   * If valid, replaces it with a succeeded task and returns true.
   * Otherwise returns false.
   */
  resolveTaskExecution(
    task: IRunningTask<TTaskId, TTaskPayload>,
    result: TTaskResult,
  ): boolean {
    const idx = this.#tasks.indexOf(task);
    if (idx === -1 || this.#tasks[idx].status !== "running") {
      return false;
    }

    const succeededTask: ISucceededTask<TTaskId, TTaskPayload, TTaskResult> = {
      status: "succeeded",
      ids: task.ids,
      payload: task.payload,
      remainingExecutionCredits: task.remainingExecutionCredits,
      coalescible: task.coalescible,
      result,
    };
    this.#tasks[idx] = succeededTask;
    this.#runningCount--;
    return true;
  }

  /**
   * Validates that runningTask is still present and in "running" status.
   * If valid, replaces it with a failed task and returns true.
   * Otherwise returns false.
   */
  rejectTaskExecution(
    task: IRunningTask<TTaskId, TTaskPayload>,
    error: TaskError,
  ): boolean {
    const idx = this.#tasks.indexOf(task);
    if (idx === -1 || this.#tasks[idx].status !== "running") {
      return false;
    }

    const failedTask: IFailedTask<TTaskId, TTaskPayload> = {
      status: "failed",
      ids: task.ids,
      payload: task.payload,
      remainingExecutionCredits: task.remainingExecutionCredits,
      coalescible: task.coalescible,
      error,
    };
    this.#tasks[idx] = failedTask;
    this.#runningCount--;
    return true;
  }

  /**
   * Clears all tasks from the list and returns the removed tasks.
   */
  clearAllTasks(): ITask<TTaskId, TTaskPayload, TTaskResult>[] {
    this.#runningCount = 0;
    return this.#tasks.splice(0);
  }

  /**
   * Removes contiguous finished tasks (succeeded, or failed with 0 credits)
   * from the head of the list and returns them.
   */
  clearFinishedTasks(): (
    | ISucceededTask<TTaskId, TTaskPayload, TTaskResult>
    | IFailedTask<TTaskId, TTaskPayload>
  )[] {
    const finished: (
      | ISucceededTask<TTaskId, TTaskPayload, TTaskResult>
      | IFailedTask<TTaskId, TTaskPayload>
    )[] = [];

    while (this.#tasks.length > 0) {
      const head = this.#tasks[0];
      if (head.status === "succeeded") {
        this.#tasks.shift();
        finished.push(head);
      } else if (head.status === "failed" && !isRetryable(head)) {
        this.#tasks.shift();
        finished.push(head);
      } else {
        break;
      }
    }

    return finished;
  }
}
