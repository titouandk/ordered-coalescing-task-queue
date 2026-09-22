# ordered-coalescing-task-queue

An in-memory task queue in TypeScript that coalesces adjacent tasks, executes work with bounded concurrency, retries failures, handles timeouts, and delivers results in strict FIFO submission order.

https://github.com/user-attachments/assets/cba8cb87-a2c8-467d-bc86-637a15bcb3a6

## Features

- Coalesces adjacent pending and retryable tasks up to a configurable depth.
- Controlled concurrency with `maxConcurrency`.
- Guarantees FIFO delivery order of results regardless of task completion order.
- Configurable execution retries via execution credits.
- Configurable execution timeout per attempt with `AbortSignal`.
- Graceful queue clearance with abortion of in-flight executions.

## Installation

```bash
npm install ordered-coalescing-task-queue
```

## Usage

```typescript
import {
  OrderedCoalescingTaskQueue,
  type IQueueConfig,
} from "ordered-coalescing-task-queue";

type TaskId = string;
type TaskPayload = { items: string[] };
type TaskResult = { processedCount: number };

const config: IQueueConfig<TaskId, TaskPayload, TaskResult> = {
  maxConcurrency: 2,
  maxCoalescingDepth: 5,
  initialExecutionCredits: 3,
  timeoutMs: 5000,

  coalesceTaskPayloads(oldestPayload, newestPayload) {
    return {
      items: [...oldestPayload.items, ...newestPayload.items],
    };
  },

  async executeTask(task, abortSignal) {
    // task.ids contains all coalesced task IDs in order
    // abortSignal triggers on timeout or queue clearance
    const response = await fetch("https://example.com/api/batch", {
      method: "POST",
      body: JSON.stringify(task.payload),
      signal: abortSignal,
    });
    return (await response.json()) as TaskResult;
  },

  onTaskResult(outcome) {
    if (outcome.status === "succeeded") {
      console.log("Tasks succeeded:", outcome.ids, outcome.result);
    } else {
      console.error("Tasks failed permanently:", outcome.ids, outcome.error);
    }
  },

  onFailedTaskExecutionAttempt: (outcome) => {
    console.warn(
      "Attempt failed, retries left:",
      outcome.remainingExecutionCredits,
    );
  },

  onFailedTaskCoalescence: (context) => {
    console.warn("Could not coalesce tasks:", context.error);
  },
};

const queue = new OrderedCoalescingTaskQueue(config);

queue.pushTask({ id: "task-1", payload: { items: ["a"] } });
queue.pushTask({ id: "task-2", payload: { items: ["b"] } });
```

## API

### Class: `OrderedCoalescingTaskQueue<TTaskId, TTaskPayload, TTaskResult>`

Implements `IQueue<TTaskId, TTaskPayload>`.

- `constructor(config: IQueueConfig<TTaskId, TTaskPayload, TTaskResult>)`
  - Validates and creates a new queue instance.
  - Throws an `Error` if numeric bounds (`maxConcurrency`, `maxCoalescingDepth`, `initialExecutionCredits`, `timeoutMs`) are less than 1 or `NaN`.
- `pushTask(task: IAtomicTaskDescription<TTaskId, TTaskPayload>): void`
  - Enqueues an atomic task at the tail of the queue.
  - Triggers sequential coalescing and scheduling.
- `clearAllTasks(): void`
  - Aborts all running tasks immediately.
  - Removes all pending and running tasks from the queue.
  - Dispatches a failed outcome with `TaskAbortedError` for every dropped task to `onTaskResult`.
  - Resets internal state so the queue can accept new tasks.

---

### Configuration: `IQueueConfig<TTaskId, TTaskPayload, TTaskResult>`

Options passed to `OrderedCoalescingTaskQueue`:

- `executeTask(task: ICoalescedTaskDescription<TTaskId, TTaskPayload>, abortSignal: AbortSignal): Promise<TTaskResult>`
  - Mandatory function that executes a task.
  - Receives the task description (with coalesced IDs and payload) and an `AbortSignal`.
  - The signal aborts when the per-attempt timeout expires or when `clearAllTasks()` is called.
- `coalesceTaskPayloads(oldestTaskPayload: TTaskPayload, newestTaskPayload: TTaskPayload): TTaskPayload`
  - Mandatory function to combine two payloads into one.
  - Thrown errors are caught; the two tasks are then kept separate.
- `maxConcurrency: number`
  - Maximum number of tasks executed in parallel.
  - Must be `>= 1`. Set to `1` for sequential execution, or `Infinity` for unbounded concurrency.
- `maxCoalescingDepth: number`
  - Maximum total number of task IDs allowed in a single coalesced task.
  - Must be `>= 1`. Set to `1` to disable coalescing, or `Infinity` for unlimited coalescing.
- `initialExecutionCredits: number`
  - Number of execution attempts granted to each task.
  - Must be `>= 1`. Set to `1` for no retries, or `Infinity` to retry indefinitely.
- `timeoutMs: number`
  - Execution timeout in milliseconds per attempt.
  - Must be `>= 1`. Set to `Infinity` to disable timeout.
- `onTaskResult: (outcome: ITaskOutcome<TTaskId, TTaskResult>) => void`
  - Mandatory callback invoked when a task definitively finishes (either succeeded, or failed with 0 credits left, or aborted/cleared).
  - Guaranteed to be called in the exact order tasks were submitted (FIFO head-of-line delivery).
- `onFailedTaskExecutionAttempt: ((outcome: IFailedTaskOutcome<TTaskId>) => void) | null`
  - Optional callback invoked immediately in real-time after each failed attempt, whether retryable or final.
  - Unlike `onTaskResult`, it is not delayed by head-of-line blocking behind slower predecessor tasks.
  - Triggered by executor rejections and timeouts; not triggered by queue clearance via `clearAllTasks()` (reported directly to `onTaskResult`) or coalescence failures.
  - Set to `null` to ignore.
- `onFailedTaskCoalescence: ((context: IFailedCoalescence<TTaskId, TTaskPayload>) => void) | null`
  - Optional callback invoked when `coalesceTaskPayloads` throws.
  - Set to `null` to ignore.

---

### Task Descriptions

- `IAtomicTaskDescription<TTaskId, TTaskPayload>`
  - Input object for `pushTask`.
  - `id: TTaskId`: User-defined task identifier.
  - `payload: TTaskPayload`: Task payload data.
- `ICoalescedTaskDescription<TTaskId, TTaskPayload>`
  - Object passed to `executeTask`.
  - `ids: TTaskId[]`: Array of task IDs coalesced into this task, in submission order.
  - `payload: TTaskPayload`: Combined payload data.

---

### Task Outcomes

- `ITaskOutcome<TTaskId, TTaskResult>`
  - Union of `ISuccessfulTaskOutcome` and `IFailedTaskOutcome`.
- `ISuccessfulTaskOutcome<TTaskId, TTaskResult>`
  - `ids: TTaskId[]`: Task IDs associated with the result.
  - `status: "succeeded"`
  - `result: TTaskResult`: Output returned by `executeTask`.
- `IFailedTaskOutcome<TTaskId>`
  - `ids: TTaskId[]`: Task IDs associated with the failure.
  - `status: "failed"`
  - `error: TaskError`: Error that caused the failure.
  - `remainingExecutionCredits: number`: Credits remaining after this attempt.

---

### Error Types

- `TaskError`
  - Union of `TaskExecutionError | TaskAbortedError | TaskTimedOutError`.
- `TaskExecutionError`
  - Extends `Error`.
  - Emitted when `executeTask` throws or returns a rejected Promise.
  - `cause: unknown`: The underlying error thrown or rejected by the executor.
- `TaskAbortedError`
  - Extends `Error`.
  - Emitted when a task is aborted due to `clearAllTasks()` or signal abortion.
- `TaskTimedOutError`
  - Extends `Error`.
  - Emitted when task execution exceeds `timeoutMs`.

---

### Additional Types

- `IFailedCoalescence<TTaskId, TTaskPayload>`
  - Passed to `onFailedTaskCoalescence`.
  - `oldestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>`: Older task in the pair.
  - `newestTask: ICoalescedTaskDescription<TTaskId, TTaskPayload>`: Newer task in the pair.
  - `error: unknown`: Exception thrown by `coalesceTaskPayloads`.
- `IQueue<TTaskId, TTaskPayload>`
  - Interface implemented by `OrderedCoalescingTaskQueue`.
  - Defines `pushTask(task)` and `clearAllTasks()`.

## Behavior Details

- Coalescence Ordering: Coalescing is applied sequentially from oldest to newest adjacent tasks in the queue.
- Coalescence Error Recovery: If `coalesceTaskPayloads` throws, the older task is marked uncoalescible to prevent infinite coalescing loops; both tasks remain in the queue and are executed separately.
- Result Delivery Order: Results are buffered until all preceding tasks have finished. Even if a later task finishes before an earlier one due to concurrency, outcomes are emitted via `onTaskResult` strictly in submission order.
- Attempt Failure Observability: Unlike `onTaskResult`, `onFailedTaskExecutionAttempt` is invoked immediately in real-time as soon as an attempt fails (e.g. error or timeout), providing immediate visibility without waiting for preceding tasks to complete.
- Queue Clearance: Calling `clearAllTasks()` aborts in-flight attempts and synchronously delivers a terminal `TaskAbortedError` for all dropped tasks via `onTaskResult`, bypassing `onFailedTaskExecutionAttempt`.
- Retries: When an attempt fails and execution credits remain, the task stays in the queue to be retried by the scheduler.
