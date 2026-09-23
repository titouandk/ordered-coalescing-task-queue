/**
 * @file This file contains the possible internal states of a task in the queue.
 *
 * Those types should not be exposed to the user.
 */

import type { ICoalescedTaskDescription } from "./TaskDescription.types.js";
import type { TaskError } from "./TaskError.types.js";

/**
 * Base interface for an internal task. Contains the common properties
 * across all task states.
 */
interface _IBaseTask<TTaskId, TTaskPayload> {
  /**
   * Identifiers of the tasks.
   * - If no tasks were coalesced, the array will contain a single identifier.
   * - If tasks were coalesced, the array will contain the identifiers of all
   *   tasks that were coalesced to produce this task, in order.
   */
  readonly ids: TTaskId[];

  /** Task payload parameters. */
  readonly payload: TTaskPayload;

  /** The number of execution credits left for this task. */
  readonly remainingExecutionCredits: number;

  /** Whether this task is eligible to be coalesced with another task. */
  readonly coalescible: boolean;
}

/**
 * A pending task, waiting to be processed.
 */
export interface IPendingTask<TTaskId, TTaskPayload> extends _IBaseTask<
  TTaskId,
  TTaskPayload
> {
  readonly status: "pending";
}

/**
 * A task currently being coalesced with another task.
 */
export interface ICoalescingTask<TTaskId, TTaskPayload> extends _IBaseTask<
  TTaskId,
  TTaskPayload
> {
  readonly status: "coalescing";
}

/**
 * A running task, currently being processed.
 */
export interface IRunningTask<TTaskId, TTaskPayload> extends _IBaseTask<
  TTaskId,
  TTaskPayload
> {
  readonly status: "running";
}

/**
 * A successful task, containing its result.
 */
export interface ISucceededTask<
  TTaskId,
  TTaskPayload,
  TTaskResult,
> extends _IBaseTask<TTaskId, TTaskPayload> {
  readonly status: "succeeded";
  readonly result: TTaskResult;
}

/**
 * A failed task, containing the error that caused it to fail.
 */
export interface IFailedTask<TTaskId, TTaskPayload> extends _IBaseTask<
  TTaskId,
  TTaskPayload
> {
  readonly status: "failed";
  readonly error: TaskError;
}

/**
 * Discriminated union of all possible states for a task.
 */
export type ITask<TTaskId, TTaskPayload, TTaskResult> =
  | IPendingTask<TTaskId, TTaskPayload>
  | ICoalescingTask<TTaskId, TTaskPayload>
  | IRunningTask<TTaskId, TTaskPayload>
  | ISucceededTask<TTaskId, TTaskPayload, TTaskResult>
  | IFailedTask<TTaskId, TTaskPayload>;

/**
 * Checks if a task has failed but has remaining execution credits.
 */
export function isRetryable<TTaskId, TTaskPayload, TTaskResult>(
  task: ITask<TTaskId, TTaskPayload, TTaskResult>,
): boolean {
  return task.status === "failed" && task.remainingExecutionCredits > 0;
}

/**
 * Checks if a task is eligible for coalescing.
 */
function isCoalescible<TTaskId, TTaskPayload, TTaskResult>(
  task: ITask<TTaskId, TTaskPayload, TTaskResult>,
  maxCoalescingDepth: number,
): task is
  | IPendingTask<TTaskId, TTaskPayload>
  | IFailedTask<TTaskId, TTaskPayload> {
  return (
    task.coalescible &&
    (task.status === "pending" || isRetryable(task)) &&
    task.ids.length < maxCoalescingDepth
  );
}

/**
 * Options passed to `areCoalescible` to check if two tasks are eligible for coalescence.
 */
export interface IAreCoalescibleOptions<TTaskId, TTaskPayload> {
  /** Maximum number of tasks allowed to be coalesced together. */
  readonly maxCoalescingDepth: number;

  /**
   * Predicate function to determine if two adjacent tasks are allowed
   * to coalesce together.
   *
   * Provide `null` if you do not want to restrict task coalescence.
   */
  readonly canCoalesceTasks:
    | ((
        this: void,
        oldestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>,
        newestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>,
      ) => boolean)
    | null;
}

/**
 * Checks if two tasks are eligible to be coalesced together.
 */
export function areCoalescible<TTaskId, TTaskPayload, TTaskResult>(
  prev: ITask<TTaskId, TTaskPayload, TTaskResult>,
  curr: ITask<TTaskId, TTaskPayload, TTaskResult>,
  options: IAreCoalescibleOptions<TTaskId, TTaskPayload>,
): boolean {
  if (
    !isCoalescible(prev, options.maxCoalescingDepth) ||
    !isCoalescible(curr, options.maxCoalescingDepth) ||
    prev.ids.length + curr.ids.length > options.maxCoalescingDepth
  ) {
    return false;
  }

  if (options.canCoalesceTasks) {
    return options.canCoalesceTasks.call(
      undefined,
      { ids: prev.ids, payload: prev.payload },
      { ids: curr.ids, payload: curr.payload },
    );
  }

  return true;
}

/**
 * Checks if a task is eligible for execution.
 */
export function isExecutable<TTaskId, TTaskPayload, TTaskResult>(
  task: ITask<TTaskId, TTaskPayload, TTaskResult>,
): task is
  | IPendingTask<TTaskId, TTaskPayload>
  | IFailedTask<TTaskId, TTaskPayload> {
  return task.status === "pending" || isRetryable(task);
}
