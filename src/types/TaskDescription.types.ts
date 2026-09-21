/**
 * @file Public interfaces to describe tasks not yet executed. Those
 * interfaces avoid exposing internal task states to the user.
 *
 * Used:
 * - To receive new atomic tasks from the user.
 * - To share coalesced tasks with the user.
 */

/**
 * Data to provide when pushing a new task into the task queue.
 */
export interface IAtomicTaskDescription<TTaskId, TTaskPayload> {
  /**
   * Unique identifier for the task to be provided by the user.
   *
   * The queue does not use this ID internally. It is meant to be used
   * by the user himself, to link a result to a task if needed.
   *
   * Because task payloads can contain large objects in memory (such as raw audio
   * buffers), using a lightweight ID allows results to be correlated to a
   * task without using the large task payload as the identifier (the payload
   * is not present anymore in the emitted results).
   */
  readonly id: TTaskId;

  /**
   * The payload contains the necessary data to accomplish the task.
   */
  readonly payload: TTaskPayload;

  // Since the tasks can be coalesced together, we do not support the concept of
  // individual abort signals per task by the user (as the user would not be sure
  // which task would be targeted by the abort signal).
  // The user can abort all the remaining tasks by clearing the queue.
  //
  // readonly signal?: AbortSignal;
}

/**
 * Data provided when inspecting a task already in the queue.
 * A task in the queue may be the result of multiple coalesced tasks.
 * Thus, each task in the queue has an array of IDs associated with it,
 * in case it would be coalesced with other tasks in the future.
 */
export interface ICoalescedTaskDescription<TTaskId, TTaskPayload> {
  /**
   * Identifiers of the tasks.
   * - If no tasks were coalesced, the array will contain a single identifier.
   * - If tasks were coalesced, the array will contain the identifiers of all
   *   tasks that were coalesced to produce this task, in order.
   */
  readonly ids: TTaskId[];

  /**
   * The payload contains the necessary data to accomplish the task.
   */
  readonly payload: TTaskPayload;
}
