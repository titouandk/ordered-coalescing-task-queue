/**
 * @file This file contains the custom error classes used when a task fails in the queue.
 */

/**
 * Error wrapper for errors raised by the user-provided executor.
 *
 * To access the original error, use the `cause` property.
 */
export class TaskExecutionError extends Error {
  public override readonly name = "TaskExecutionError" as const;
  public override readonly cause: unknown;

  constructor(options: {
    /** Error message explaining the failure. */
    message: string;
    /** The original error thrown or rejected by the executor. */
    cause: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.cause = options.cause;
  }
}

/**
 * Error raised when a task execution is aborted (e.g. queue cleared).
 */
export class TaskAbortedError extends Error {
  public override readonly name = "TaskAbortedError" as const;

  constructor(options: {
    /** Error message explaining why the task was aborted. */
    message: string;
  }) {
    super(options.message);
  }
}

/**
 * Error raised when a task execution exceeds its configured timeout duration.
 */
export class TaskTimedOutError extends Error {
  public override readonly name = "TaskTimedOutError" as const;

  constructor(options: {
    /** Error message explaining the timeout. */
    message: string;
  }) {
    super(options.message);
  }
}

/**
 * Union of all possible errors that can cause a task to fail.
 */
export type TaskError =
  | TaskExecutionError
  | TaskAbortedError
  | TaskTimedOutError;
