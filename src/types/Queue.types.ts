import type { IAtomicTaskDescription } from "./TaskDescription.types.js";

/**
 * Interface representing an ordered queue that coalesces incoming tasks
 * and executes them with bounded concurrency.
 */
export interface IQueue<TTaskId, TTaskPayload> {
  /**
   * Registers a new task into the queue.
   * The user provides an atomic task description.
   */
  pushTask(task: IAtomicTaskDescription<TTaskId, TTaskPayload>): void;

  // We do not allow to clear an individual task. Since tasks can be coalesced,
  // targeting a single task (via its id) may target the other tasks that were
  // coalesced with it, which may be unexpected for the caller. We only allow
  // to clear all tasks at once.

  /**
   * Clears all tasks from the queue.
   */
  clearAllTasks(): void;
}
