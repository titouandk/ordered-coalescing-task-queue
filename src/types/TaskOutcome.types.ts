/**
 * @file This file contains the public interfaces for task outcomes.
 *
 * When a task is executed, its possible outcomes (success/failure) are
 * communicated to the caller using the following interfaces.
 */

import type { TaskError } from "./TaskError.types.js";

/**
 * Format of a successful task outcome.
 */
export interface ISuccessfulTaskOutcome<TTaskId, TTaskResult> {
  /**
   * Identifiers of the tasks.
   * - If no tasks were coalesced, the array will contain a single identifier.
   * - If tasks were coalesced, the array will contain the identifiers of all
   *   tasks that were coalesced to produce this task, in order.
   */
  readonly ids: TTaskId[];
  readonly status: "succeeded";
  readonly result: TTaskResult;
}

/**
 * Format of a failed task outcome.
 */
export interface IFailedTaskOutcome<TTaskId> {
  /**
   * Identifiers of the tasks.
   * - If no tasks were coalesced, the array will contain a single identifier.
   * - If tasks were coalesced, the array will contain the identifiers of all
   *   tasks that were coalesced to produce this task, in order.
   */
  readonly ids: TTaskId[];
  readonly status: "failed";
  readonly error: TaskError;
  /** For information, we share the remaining execution credits. */
  readonly remainingExecutionCredits: number;
}

/**
 * Discriminated union of all possible task outcomes.
 */
export type ITaskOutcome<TTaskId, TTaskResult> =
  | ISuccessfulTaskOutcome<TTaskId, TTaskResult>
  | IFailedTaskOutcome<TTaskId>;
