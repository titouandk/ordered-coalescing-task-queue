/**
 * @file This file contains the possible internal states of a task in the queue.
 *
 * Those types should not be exposed to the user.
 */

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
 * Checks if two tasks are eligible to be coalesced together.
 */
export function areCoalescible<TTaskId, TTaskPayload, TTaskResult>(
  prev: ITask<TTaskId, TTaskPayload, TTaskResult>,
  curr: ITask<TTaskId, TTaskPayload, TTaskResult>,
  maxCoalescingDepth: number,
): boolean {
  return (
    isCoalescible(prev, maxCoalescingDepth) &&
    isCoalescible(curr, maxCoalescingDepth) &&
    prev.ids.length + curr.ids.length <= maxCoalescingDepth
  );
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
