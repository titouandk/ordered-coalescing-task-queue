export { OrderedCoalescingTaskQueue } from "./OrderedCoalescingTaskQueue.js";

export type { IQueue } from "./types/Queue.types.js";
export type {
  IQueueConfig,
  IFailedCoalescence,
} from "./types/QueueConfig.types.js";
export type {
  IAtomicTaskDescription,
  ICoalescedTaskDescription,
} from "./types/TaskDescription.types.js";
export type {
  ITaskOutcome,
  ISuccessfulTaskOutcome,
  IFailedTaskOutcome,
} from "./types/TaskOutcome.types.js";
export {
  TaskExecutionError,
  TaskAbortedError,
  TaskTimedOutError,
  type TaskError,
} from "./types/TaskError.types.js";
