import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderedCoalescingTaskQueue } from "./OrderedCoalescingTaskQueue.js";
import type { IQueueConfig } from "./types/QueueConfig.types.js";
import {
  TaskAbortedError,
  TaskExecutionError,
  TaskTimedOutError,
} from "./types/TaskError.types.js";

type TestId = string;
type TestPayload = number;
type TestResult = string;

type TestConfig = IQueueConfig<TestId, TestPayload, TestResult>;

/**
 * Builds a valid configuration, with every handler mocked, that tests
 * can partially override.
 */
function createConfig(overrides: Partial<TestConfig> = {}): TestConfig {
  return {
    executeTask: vi.fn(async (task) => String(task.payload)),
    coalesceTaskPayloads: vi.fn(
      (oldestPayload, newestPayload) => oldestPayload + newestPayload,
    ),
    maxConcurrency: 1,
    maxCoalescingDepth: 1,
    initialExecutionCredits: 1,
    timeoutMs: Infinity,
    onFailedTaskCoalescence: null,
    onFailedTaskExecutionAttempt: vi.fn(),
    onTaskResult: vi.fn(),
    ...overrides,
  };
}

function createQueue(overrides: Partial<TestConfig> = {}) {
  return new OrderedCoalescingTaskQueue(createConfig(overrides));
}

/**
 * A promise whose settlement is controlled from the outside, so that tests
 * can decide exactly when and in which order executions finish.
 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * An executor whose every call returns a deferred promise, kept in call order
 * so that tests can settle them individually.
 */
function createControlledExecutor() {
  const deferreds: ReturnType<typeof createDeferred<TestResult>>[] = [];
  const executeTask = vi.fn(async () => {
    const deferred = createDeferred<TestResult>();
    deferreds.push(deferred);
    return deferred.promise;
  });
  return { executeTask, deferreds };
}

/** Lets every already-settled promise continuation run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("OrderedCoalescingTaskQueue", () => {
  describe("constructor", () => {
    it("accepts a valid configuration", () => {
      expect(() => createQueue()).not.toThrow();
    });

    it("accepts Infinity for unbounded options", () => {
      expect(() =>
        createQueue({
          maxConcurrency: Infinity,
          maxCoalescingDepth: Infinity,
          initialExecutionCredits: Infinity,
          timeoutMs: Infinity,
        }),
      ).not.toThrow();
    });

    it("accepts 1 execution credit", () => {
      expect(() => createQueue({ initialExecutionCredits: 1 })).not.toThrow();
    });

    // `NaN` is included in every invalid-value list below: see the comment
    // in `assertAtLeast` for why it is the classic blind spot of bound checks.
    it.each([0, -1, NaN])("rejects maxConcurrency = %s", (value) => {
      expect(() => createQueue({ maxConcurrency: value })).toThrow(
        /maxConcurrency/,
      );
    });

    it.each([0, -1, NaN])("rejects maxCoalescingDepth = %s", (value) => {
      expect(() => createQueue({ maxCoalescingDepth: value })).toThrow(
        /maxCoalescingDepth/,
      );
    });

    it.each([0, -1, NaN])("rejects initialExecutionCredits = %s", (value) => {
      expect(() => createQueue({ initialExecutionCredits: value })).toThrow(
        /initialExecutionCredits/,
      );
    });

    it.each([0, -1, NaN])("rejects timeoutMs = %s", (value) => {
      expect(() => createQueue({ timeoutMs: value })).toThrow(/timeoutMs/);
    });
  });

  describe("execution", () => {
    it("executes a pushed task and delivers its result", async () => {
      const onTaskResult = vi.fn();
      const queue = createQueue({ onTaskResult });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith({
        ids: ["a"],
        status: "succeeded",
        result: "1",
      });
    });

    it("passes a coalesced description and an abort signal to the executor", async () => {
      const executeTask = vi.fn(async () => "ok");
      const queue = createQueue({ executeTask });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      expect(executeTask).toHaveBeenCalledExactlyOnceWith(
        { ids: ["a"], payload: 1 },
        expect.any(AbortSignal),
      );
    });

    it("processes tasks sequentially when maxConcurrency is 1", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const queue = createQueue({ executeTask, maxConcurrency: 1 });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      await flush();
      expect(executeTask).toHaveBeenCalledTimes(1);

      deferreds[0].resolve("A");
      await flush();
      expect(executeTask).toHaveBeenCalledTimes(2);
    });

    it("runs at most maxConcurrency tasks in parallel", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const queue = createQueue({ executeTask, maxConcurrency: 2 });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      queue.pushTask({ id: "c", payload: 3 });
      await flush();
      expect(executeTask).toHaveBeenCalledTimes(2);

      deferreds[1].resolve("B");
      await flush();
      expect(executeTask).toHaveBeenCalledTimes(3);
    });

    it("runs every task at once when maxConcurrency is Infinity", async () => {
      const { executeTask } = createControlledExecutor();
      const queue = createQueue({ executeTask, maxConcurrency: Infinity });

      for (let i = 0; i < 10; i++) {
        queue.pushTask({ id: String(i), payload: i });
      }
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(10);
    });

    it("delivers results in submission order even if a later task finishes first", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onTaskResult,
        maxConcurrency: Infinity,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      queue.pushTask({ id: "c", payload: 3 });
      await flush();

      deferreds[2].resolve("C");
      deferreds[1].resolve("B");
      await flush();
      // "a" is still running, so nothing can be delivered yet.
      expect(onTaskResult).not.toHaveBeenCalled();

      deferreds[0].resolve("A");
      await flush();
      expect(onTaskResult.mock.calls.map(([outcome]) => outcome.ids)).toEqual([
        ["a"],
        ["b"],
        ["c"],
      ]);
    });

    it("frees a concurrency slot as soon as a task settles, before its result is deliverable", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const queue = createQueue({ executeTask, maxConcurrency: 2 });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      queue.pushTask({ id: "c", payload: 3 });
      await flush();

      // "b" finishes while "a" is still running: "b" cannot be delivered,
      // but "c" must start anyway.
      deferreds[1].resolve("B");
      await flush();
      expect(executeTask).toHaveBeenCalledTimes(3);
    });
  });

  describe("failure (no retries)", () => {
    it("reports a rejected executor as a TaskExecutionError", async () => {
      const cause = new Error("boom");
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask: vi.fn(async () => {
          throw cause;
        }),
        onFailedTaskExecutionAttempt,
        onTaskResult,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      const expectedOutcome = {
        ids: ["a"],
        status: "failed",
        error: expect.any(TaskExecutionError),
        remainingExecutionCredits: 0,
      };
      expect(onFailedTaskExecutionAttempt).toHaveBeenCalledExactlyOnceWith(
        expectedOutcome,
      );
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(expectedOutcome);
      expect(onTaskResult.mock.calls[0][0].error.cause).toBe(cause);
    });

    it("treats a synchronous throw from the executor like a rejection", async () => {
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask: vi.fn(() => {
          throw new Error("sync boom");
        }),
        onTaskResult,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: "failed",
          error: expect.any(TaskExecutionError),
        }),
      );
    });

    it("tolerates onFailedTaskExecutionAttempt being null", async () => {
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask: vi.fn(async () => {
          throw new Error("boom");
        }),
        onFailedTaskExecutionAttempt: null,
        onTaskResult,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ids: ["a"],
          status: "failed",
        }),
      );
    });

    it("keeps delivering in order when failures and successes are mixed", async () => {
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask: vi.fn(async (task) => {
          if (task.payload % 2 === 0) throw new Error("even");
          return String(task.payload);
        }),
        onTaskResult,
        maxConcurrency: Infinity,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      queue.pushTask({ id: "c", payload: 3 });
      await flush();

      expect(
        onTaskResult.mock.calls.map(([outcome]) => [
          outcome.ids,
          outcome.status,
        ]),
      ).toEqual([
        [["a"], "succeeded"],
        [["b"], "failed"],
        [["c"], "succeeded"],
      ]);
    });
  });

  describe("retries", () => {
    it("retries a failed task while it has credits, then delivers the success", async () => {
      const executeTask = vi
        .fn<TestConfig["executeTask"]>()
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("second"))
        .mockResolvedValueOnce("third time lucky");
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        initialExecutionCredits: 3,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(3);
      // After each failure, the reported credits are the retries still
      // possible: 2 before the first retry, 1 before the second.
      expect(
        onFailedTaskExecutionAttempt.mock.calls.map(
          ([outcome]) => outcome.remainingExecutionCredits,
        ),
      ).toEqual([2, 1]);
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith({
        ids: ["a"],
        status: "succeeded",
        result: "third time lucky",
      });
    });

    it("gives up once credits are exhausted and reports the last error", async () => {
      const executeTask = vi
        .fn<TestConfig["executeTask"]>()
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("last"));
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        initialExecutionCredits: 2,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(2);
      expect(onFailedTaskExecutionAttempt).toHaveBeenCalledTimes(2);
      expect(onTaskResult).toHaveBeenCalledOnce();
      const outcome = onTaskResult.mock.calls[0][0];
      expect(outcome.status).toBe("failed");
      expect(outcome.remainingExecutionCredits).toBe(0);
      expect(outcome.error.cause).toEqual(new Error("last"));
    });

    it("keeps the retried task at its position so later results wait for it", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onTaskResult,
        initialExecutionCredits: 2,
        maxConcurrency: Infinity,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      await flush();

      deferreds[1].resolve("B");
      deferreds[0].reject(new Error("first"));
      await flush();
      // "a" is being retried (third executor call): "b" must still wait.
      expect(executeTask).toHaveBeenCalledTimes(3);
      expect(onTaskResult).not.toHaveBeenCalled();

      deferreds[2].resolve("A");
      await flush();
      expect(onTaskResult.mock.calls.map(([outcome]) => outcome.ids)).toEqual([
        ["a"],
        ["b"],
      ]);
    });

    it("retries forever with Infinity credits", async () => {
      let attempts = 0;
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask: vi.fn(async () => {
          attempts++;
          if (attempts < 50) throw new Error("not yet");
          return "done";
        }),
        onTaskResult,
        initialExecutionCredits: Infinity,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      expect(attempts).toBe(50);
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: "succeeded", result: "done" }),
      );
    });
  });

  describe("coalescence", () => {
    /**
     * Pushes a first task that occupies the single concurrency slot so that
     * the following pushes queue up and become coalescing candidates.
     */
    function createBlockedQueue(overrides: Partial<TestConfig> = {}) {
      const { executeTask, deferreds } = createControlledExecutor();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onTaskResult,
        maxConcurrency: 1,
        maxCoalescingDepth: Infinity,
        ...overrides,
      });
      queue.pushTask({ id: "blocker", payload: 0 });
      return { queue, executeTask, deferreds, onTaskResult };
    }

    it("never coalesces when maxCoalescingDepth is 1", async () => {
      const { queue, executeTask, deferreds, onTaskResult } =
        createBlockedQueue({ maxCoalescingDepth: 1 });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      deferreds[0].resolve("blocker");
      await flush();
      deferreds[1].resolve("A");
      await flush();
      deferreds[2].resolve("B");
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(3);
      expect(onTaskResult.mock.calls.map(([outcome]) => outcome.ids)).toEqual([
        ["blocker"],
        ["a"],
        ["b"],
      ]);
    });

    it("merges a new task into a pending tail task", async () => {
      const { queue, executeTask, deferreds, onTaskResult } =
        createBlockedQueue();

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      deferreds[0].resolve("blocker");
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(2);
      expect(executeTask).toHaveBeenLastCalledWith(
        { ids: ["a", "b"], payload: 3 },
        expect.any(AbortSignal),
      );

      deferreds[1].resolve("AB");
      await flush();
      expect(onTaskResult).toHaveBeenLastCalledWith({
        ids: ["a", "b"],
        status: "succeeded",
        result: "AB",
      });
    });

    it("does not merge into a running task", async () => {
      const { queue, executeTask, deferreds } = createBlockedQueue();

      // "blocker" is running: "a" must be queued as a separate task.
      queue.pushTask({ id: "a", payload: 1 });
      deferreds[0].resolve("blocker");
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(2);
      expect(executeTask).toHaveBeenLastCalledWith(
        { ids: ["a"], payload: 1 },
        expect.any(AbortSignal),
      );
    });

    it("stops merging once maxCoalescingDepth is reached", async () => {
      const { queue, executeTask, deferreds } = createBlockedQueue({
        maxCoalescingDepth: 2,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      queue.pushTask({ id: "c", payload: 3 });
      queue.pushTask({ id: "d", payload: 4 });
      deferreds[0].resolve("blocker");
      await flush();
      deferreds[1].resolve("AB");
      await flush();

      const descriptions = executeTask.mock.calls.map(([task]) => task);
      expect(descriptions).toEqual([
        { ids: ["blocker"], payload: 0 },
        { ids: ["a", "b"], payload: 3 },
        { ids: ["c", "d"], payload: 7 },
      ]);
    });

    it("does not merge retryable task and pending task when their combined IDs exceed maxCoalescingDepth", async () => {
      const { queue, executeTask, deferreds } = createBlockedQueue({
        maxCoalescingDepth: 3,
        initialExecutionCredits: 2,
      });

      // Blocker is running (deferreds[0])
      // Push "a" and "b" -> coalesce into task AB (ids: ["a", "b"], payload: 3)
      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });

      // Unblock blocker -> task AB starts executing (deferreds[1])
      deferreds[0].resolve("blocker");
      await flush();

      // While task AB is running, push "c" and "d" -> coalesce into task CD (ids: ["c", "d"], payload: 7)
      queue.pushTask({ id: "c", payload: 3 });
      queue.pushTask({ id: "d", payload: 4 });

      // Task AB fails its first attempt. Since initialExecutionCredits = 2, it is retryable
      // (status: "failed", remainingExecutionCredits: 1, ids: ["a", "b"]).
      // It is now adjacent to task CD (ids: ["c", "d"]).
      // Combined depth would be 2 + 2 = 4 > maxCoalescingDepth (3).
      // They must NOT coalesce!
      deferreds[1].reject(new Error("fail AB attempt 1"));
      await flush();

      // Task AB is retried as its own attempt (deferreds[2])
      expect(executeTask).toHaveBeenCalledTimes(3);
      expect(executeTask).toHaveBeenLastCalledWith(
        { ids: ["a", "b"], payload: 3 },
        expect.any(AbortSignal),
      );

      // Task AB retry succeeds
      deferreds[2].resolve("AB retry success");
      await flush();

      // Now task CD executes as its own attempt (deferreds[3])
      expect(executeTask).toHaveBeenCalledTimes(4);
      expect(executeTask).toHaveBeenLastCalledWith(
        { ids: ["c", "d"], payload: 7 },
        expect.any(AbortSignal),
      );
    });

    it("merges everything into a single task when maxCoalescingDepth is Infinity", async () => {
      const { queue, executeTask, deferreds } = createBlockedQueue();

      for (let i = 1; i <= 10; i++) {
        queue.pushTask({ id: String(i), payload: i });
      }
      deferreds[0].resolve("blocker");
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(2);
      expect(executeTask).toHaveBeenLastCalledWith(
        {
          ids: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          payload: 55,
        },
        expect.any(AbortSignal),
      );
    });

    it("invokes coalesceTaskPayloads with the right context", () => {
      const calls: unknown[] = [];
      const { queue } = createBlockedQueue({
        coalesceTaskPayloads: (oldestPayload, newestPayload) => {
          calls.push(["coalesce", oldestPayload, newestPayload]);
          return oldestPayload + newestPayload;
        },
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });

      expect(calls).toEqual([["coalesce", 1, 2]]);
    });

    it("keeps both tasks separate when the payload coalescer throws", async () => {
      const error = new Error("cannot merge");
      const onFailedTaskCoalescence = vi.fn();
      const { queue, executeTask, deferreds } = createBlockedQueue({
        coalesceTaskPayloads: () => {
          throw error;
        },
        onFailedTaskCoalescence,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });

      expect(onFailedTaskCoalescence).toHaveBeenCalledExactlyOnceWith({
        oldestTask: { ids: ["a"], payload: 1 },
        newestTask: { ids: ["b"], payload: 2 },
        error,
      });

      deferreds[0].resolve("blocker");
      await flush();
      deferreds[1].resolve("A");
      await flush();
      expect(executeTask.mock.calls.map(([task]) => task.ids)).toEqual([
        ["blocker"],
        ["a"],
        ["b"],
      ]);
    });

    it("merges into a failed task awaiting retry, keeping its remaining credits", async () => {
      // A task awaiting retry is only observable from within the failure
      // callback, before the scheduler restarts it. Pushing from there
      // exercises the merge as well as callback re-entrancy.
      const executeTask = vi
        .fn<TestConfig["executeTask"]>()
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("second"))
        .mockRejectedValueOnce(new Error("third"));
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        initialExecutionCredits: 2,
        maxCoalescingDepth: Infinity,
      });
      onFailedTaskExecutionAttempt.mockImplementationOnce(() => {
        queue.pushTask({ id: "b", payload: 2 });
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      // The merged task inherits the single remaining credit and executes
      // once using that credit.
      expect(executeTask.mock.calls.map(([task]) => task)).toEqual([
        { ids: ["a"], payload: 1 },
        { ids: ["a", "b"], payload: 3 },
      ]);
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ids: ["a", "b"],
          status: "failed",
          remainingExecutionCredits: 0,
        }),
      );
    });
  });

  describe("clearAllTasks", () => {
    it("is a no-op on an empty queue", () => {
      const onTaskResult = vi.fn();
      const queue = createQueue({ onTaskResult });

      expect(() => queue.clearAllTasks()).not.toThrow();
      expect(onTaskResult).not.toHaveBeenCalled();
    });

    it("synchronously reports every dropped task as aborted, in order", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onTaskResult,
        maxConcurrency: 2,
        maxCoalescingDepth: 2,
      });

      queue.pushTask({ id: "a", payload: 1 }); // running
      queue.pushTask({ id: "b", payload: 2 }); // running
      queue.pushTask({ id: "c", payload: 3 }); // pending
      queue.pushTask({ id: "d", payload: 4 }); // coalesced into "c"
      queue.pushTask({ id: "e", payload: 5 }); // pending
      await flush();
      deferreds[1].resolve("B"); // settled but not deliverable
      await flush();

      queue.clearAllTasks();

      const expectedOutcome = {
        status: "failed",
        error: expect.any(TaskAbortedError),
        remainingExecutionCredits: 0,
      };
      expect(onTaskResult.mock.calls.map(([outcome]) => outcome)).toEqual([
        { ids: ["a"], ...expectedOutcome },
        { ids: ["b"], ...expectedOutcome },
        { ids: ["c", "d"], ...expectedOutcome },
        { ids: ["e"], ...expectedOutcome },
      ]);
    });

    it("aborts the signal of running tasks with a TaskAbortedError", async () => {
      const signals: AbortSignal[] = [];
      const queue = createQueue({
        executeTask: vi.fn((_task, signal) => {
          signals.push(signal);
          return new Promise<never>(() => {});
        }),
        maxConcurrency: Infinity,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      expect(signals.map((s) => s.aborted)).toEqual([false, false]);

      queue.clearAllTasks();
      expect(signals.map((s) => s.aborted)).toEqual([true, true]);
      expect(signals[0].reason).toBeInstanceOf(TaskAbortedError);
    });

    it("does not report a cleared running task a second time when it settles", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.clearAllTasks();
      await flush();
      deferreds[0].resolve("too late");
      await flush();

      expect(onFailedTaskExecutionAttempt).not.toHaveBeenCalled();
      expect(onTaskResult).toHaveBeenCalledOnce();
    });

    it("does not retry cleared tasks even if they had credits left", async () => {
      const { executeTask } = createControlledExecutor();
      const queue = createQueue({ executeTask, initialExecutionCredits: 5 });

      queue.pushTask({ id: "a", payload: 1 });
      queue.clearAllTasks();
      await flush();

      expect(executeTask).toHaveBeenCalledTimes(1);
    });

    it("releases concurrency slots immediately", () => {
      const { executeTask } = createControlledExecutor();
      const queue = createQueue({ executeTask, maxConcurrency: 1 });

      queue.pushTask({ id: "a", payload: 1 });
      queue.clearAllTasks();
      // Same tick, before the aborted attempt's continuation has run.
      queue.pushTask({ id: "b", payload: 2 });

      expect(executeTask).toHaveBeenCalledTimes(2);
    });

    it("keeps the queue fully usable afterwards", async () => {
      const onTaskResult = vi.fn();
      const { executeTask, deferreds } = createControlledExecutor();
      const queue = createQueue({ executeTask, onTaskResult });

      queue.pushTask({ id: "a", payload: 1 });
      queue.clearAllTasks();
      onTaskResult.mockClear();

      queue.pushTask({ id: "b", payload: 2 });
      queue.pushTask({ id: "c", payload: 3 });
      await flush();
      deferreds[1].resolve("B");
      await flush();
      deferreds[2].resolve("C");
      await flush();

      expect(onTaskResult.mock.calls.map(([outcome]) => outcome)).toEqual([
        { ids: ["b"], status: "succeeded", result: "B" },
        { ids: ["c"], status: "succeeded", result: "C" },
      ]);
    });

    it("hands a fresh, non-aborted signal to tasks pushed after a clear", () => {
      const signals: AbortSignal[] = [];
      const queue = createQueue({
        executeTask: vi.fn((_task, signal) => {
          signals.push(signal);
          return new Promise<never>(() => {});
        }),
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.clearAllTasks();
      queue.pushTask({ id: "b", payload: 2 });

      expect(signals[1].aborted).toBe(false);
    });

    it("does not decrement runningCount below 0 when in-flight attempt finishes after clear", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const queue = createQueue({ executeTask, maxConcurrency: 1 });

      queue.pushTask({ id: "a", payload: 1 });
      expect(executeTask).toHaveBeenCalledTimes(1);

      queue.clearAllTasks();
      // Wait for the aborted attempt's #execute continuation to run
      await flush();

      // Push two tasks with maxConcurrency: 1
      queue.pushTask({ id: "b", payload: 2 });
      queue.pushTask({ id: "c", payload: 3 });

      // If runningCount had been decremented below 0 (to -1), BOTH b and c would have started.
      // Since runningCount is 0, only b starts (total 2 calls so far).
      expect(executeTask).toHaveBeenCalledTimes(2);

      // Once b resolves, c starts (total 3 calls).
      deferreds[1].resolve("B");
      await flush();
      expect(executeTask).toHaveBeenCalledTimes(3);
    });
  });

  describe("abort listener hygiene", () => {
    it("detaches its abort listener from the queue signal after each attempt", async () => {
      // With no timeout, the signal handed to the executor is the queue's own
      // long-lived signal, shared by every attempt.
      const signals: AbortSignal[] = [];
      const queue = createQueue({
        executeTask: vi.fn(async (_task, signal) => {
          signals.push(signal);
          return "ok";
        }),
        timeoutMs: Infinity,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();
      const queueSignal = signals[0];
      const add = vi.spyOn(queueSignal, "addEventListener");
      const remove = vi.spyOn(queueSignal, "removeEventListener");

      queue.pushTask({ id: "b", payload: 2 });
      await flush();

      expect(signals[1]).toBe(queueSignal);
      expect(add).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
    });
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails an attempt with TaskTimedOutError when the executor is too slow", async () => {
      const { executeTask } = createControlledExecutor();
      const onTaskResult = vi.fn();
      const queue = createQueue({ executeTask, onTaskResult, timeoutMs: 100 });

      queue.pushTask({ id: "a", payload: 1 });
      await vi.advanceTimersByTimeAsync(99);
      expect(onTaskResult).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ids: ["a"],
          status: "failed",
          error: expect.any(TaskTimedOutError),
        }),
      );
    });

    it("aborts the signal handed to the executor on timeout", async () => {
      let receivedSignal: AbortSignal | undefined;
      const queue = createQueue({
        executeTask: vi.fn((_task, signal) => {
          receivedSignal = signal;
          return new Promise<never>(() => {});
        }),
        timeoutMs: 100,
      });

      queue.pushTask({ id: "a", payload: 1 });
      expect(receivedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(receivedSignal?.aborted).toBe(true);
      expect(receivedSignal?.reason).toBeInstanceOf(TaskTimedOutError);
    });

    it("does not wait for the executor to settle before failing the attempt", async () => {
      const { executeTask } = createControlledExecutor();
      const onFailedTaskExecutionAttempt = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        timeoutMs: 100,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await vi.advanceTimersByTimeAsync(100);

      // The executor promise is still pending, yet the failure is reported.
      expect(onFailedTaskExecutionAttempt).toHaveBeenCalledOnce();
    });

    it("ignores the executor result once the attempt has timed out", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onTaskResult = vi.fn();
      const queue = createQueue({ executeTask, onTaskResult, timeoutMs: 100 });

      queue.pushTask({ id: "a", payload: 1 });
      await vi.advanceTimersByTimeAsync(100);
      deferreds[0].resolve("too late");
      await vi.advanceTimersByTimeAsync(0);

      expect(onTaskResult).toHaveBeenCalledOnce();
      expect(onTaskResult.mock.calls[0][0].status).toBe("failed");
    });

    it("reports a timeout even if the executor rejects with the signal reason", async () => {
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask: vi.fn(
          (_task, signal) =>
            new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            }),
        ),
        onTaskResult,
        timeoutMs: 100,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await vi.advanceTimersByTimeAsync(100);

      expect(onTaskResult.mock.calls[0][0].error).toBeInstanceOf(
        TaskTimedOutError,
      );
    });

    it("retries after a timeout when credits remain", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onTaskResult,
        timeoutMs: 100,
        initialExecutionCredits: 2,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(executeTask).toHaveBeenCalledTimes(2);

      deferreds[1].resolve("A");
      await vi.advanceTimersByTimeAsync(0);
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: "succeeded", result: "A" }),
      );
    });

    it("cancels the timeout once the executor settles", async () => {
      const onTaskResult = vi.fn();
      const queue = createQueue({ onTaskResult, timeoutMs: 100 });

      queue.pushTask({ id: "a", payload: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(onTaskResult).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1000);
      expect(onTaskResult).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("call patterns: onFailedTaskExecutionAttempt vs onTaskResult", () => {
    it("reports an attempt failure in real time while onTaskResult is head-of-line blocked", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        maxConcurrency: 2,
        initialExecutionCredits: 1,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      expect(executeTask).toHaveBeenCalledTimes(2);

      // Task B fails immediately while Task A is still in flight
      deferreds[1].reject(new Error("B failed"));
      await flush();

      // onFailedTaskExecutionAttempt is invoked in real time for B
      expect(onFailedTaskExecutionAttempt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ids: ["b"],
          status: "failed",
          remainingExecutionCredits: 0,
        }),
      );

      // onTaskResult is blocked behind Task A at the head of the queue
      expect(onTaskResult).not.toHaveBeenCalled();

      // Task A finishes
      deferreds[0].resolve("result A");
      await flush();

      // Results are delivered in strict FIFO queue order: A first, then B
      expect(onTaskResult).toHaveBeenCalledTimes(2);
      expect(onTaskResult.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          ids: ["a"],
          status: "succeeded",
          result: "result A",
        }),
      );
      expect(onTaskResult.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          ids: ["b"],
          status: "failed",
          remainingExecutionCredits: 0,
        }),
      );
    });

    it("invokes onFailedTaskExecutionAttempt on every retry attempt but onTaskResult once on final success", async () => {
      const executeTask = vi
        .fn<TestConfig["executeTask"]>()
        .mockRejectedValueOnce(new Error("attempt 1 failed"))
        .mockRejectedValueOnce(new Error("attempt 2 failed"))
        .mockResolvedValueOnce("success on attempt 3");
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        initialExecutionCredits: 3,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      // onFailedTaskExecutionAttempt fires on attempt 1 and 2
      expect(onFailedTaskExecutionAttempt).toHaveBeenCalledTimes(2);
      expect(
        onFailedTaskExecutionAttempt.mock.calls.map(
          ([outcome]) => outcome.remainingExecutionCredits,
        ),
      ).toEqual([2, 1]);

      // onTaskResult fires once with the eventual success
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith({
        ids: ["a"],
        status: "succeeded",
        result: "success on attempt 3",
      });
    });

    it("invokes onFailedTaskExecutionAttempt on every attempt including the final failure, then onTaskResult", async () => {
      const executeTask = vi
        .fn<TestConfig["executeTask"]>()
        .mockRejectedValueOnce(new Error("attempt 1 failed"))
        .mockRejectedValueOnce(new Error("attempt 2 failed"));
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        initialExecutionCredits: 2,
      });

      queue.pushTask({ id: "a", payload: 1 });
      await flush();

      // onFailedTaskExecutionAttempt fires for both failed attempts
      expect(onFailedTaskExecutionAttempt).toHaveBeenCalledTimes(2);
      expect(
        onFailedTaskExecutionAttempt.mock.calls.map(
          ([outcome]) => outcome.remainingExecutionCredits,
        ),
      ).toEqual([1, 0]);

      // onTaskResult fires once with the definitive failure
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ids: ["a"],
          status: "failed",
          remainingExecutionCredits: 0,
        }),
      );
    });

    it("delivers onTaskResult for in-flight and pending tasks on clearAllTasks, bypassing onFailedTaskExecutionAttempt", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        maxConcurrency: 1,
      });

      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      expect(executeTask).toHaveBeenCalledTimes(1);

      // Clearing aborts all tasks synchronously
      queue.clearAllTasks();

      expect(onTaskResult).toHaveBeenCalledTimes(2);
      expect(onTaskResult.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          ids: ["a"],
          status: "failed",
          error: expect.any(TaskAbortedError),
          remainingExecutionCredits: 0,
        }),
      );
      expect(onTaskResult.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          ids: ["b"],
          status: "failed",
          error: expect.any(TaskAbortedError),
          remainingExecutionCredits: 0,
        }),
      );

      // In-flight attempt rejects after the clear
      deferreds[0].reject(new Error("late rejection"));
      await flush();

      // onFailedTaskExecutionAttempt is never called
      expect(onFailedTaskExecutionAttempt).not.toHaveBeenCalled();
    });

    it("routes payload merge errors to onFailedTaskCoalescence without calling onFailedTaskExecutionAttempt", async () => {
      const { executeTask, deferreds } = createControlledExecutor();
      const coalescenceError = new Error("cannot coalesce");
      const onFailedTaskCoalescence = vi.fn();
      const onFailedTaskExecutionAttempt = vi.fn();
      const onTaskResult = vi.fn();
      const queue = createQueue({
        executeTask,
        coalesceTaskPayloads: vi.fn(() => {
          throw coalescenceError;
        }),
        onFailedTaskCoalescence,
        onFailedTaskExecutionAttempt,
        onTaskResult,
        maxConcurrency: 1,
        maxCoalescingDepth: 2,
      });

      // Blocker task occupies the concurrency slot so that a and b are queued as pending
      queue.pushTask({ id: "blocker", payload: 0 });
      queue.pushTask({ id: "a", payload: 1 });
      queue.pushTask({ id: "b", payload: 2 });
      await flush();

      // onFailedTaskCoalescence received the merge error
      expect(onFailedTaskCoalescence).toHaveBeenCalledExactlyOnceWith({
        oldestTask: { ids: ["a"], payload: 1 },
        newestTask: { ids: ["b"], payload: 2 },
        error: coalescenceError,
      });

      // No execution attempt failed
      expect(onFailedTaskExecutionAttempt).not.toHaveBeenCalled();

      // Resolve blocker, then task a, then task b
      deferreds[0].resolve("blocker done");
      await flush();
      deferreds[1].resolve("a done");
      await flush();
      deferreds[2].resolve("b done");
      await flush();

      // All tasks executed individually and delivered results
      expect(onTaskResult).toHaveBeenCalledTimes(3);
      expect(onTaskResult.mock.calls[0][0].ids).toEqual(["blocker"]);
      expect(onTaskResult.mock.calls[1][0].ids).toEqual(["a"]);
      expect(onTaskResult.mock.calls[2][0].ids).toEqual(["b"]);
    });
  });
});
