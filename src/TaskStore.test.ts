import { describe, expect, it } from "vitest";
import { areCoalescible, TaskStore } from "./TaskStore.js";
import type { IPendingTask } from "./types/Task.types.js";
import { TaskExecutionError } from "./types/TaskError.types.js";

describe("TaskStore", () => {
  const createStore = (maxCoalescingDepth = 5) => {
    return new TaskStore<string, { val: number }, string>({
      maxCoalescingDepth,
    });
  };

  const createPendingTask = (
    id: string,
    val = 1,
    remainingExecutionCredits = 1,
    coalescible = true,
  ): IPendingTask<string, { val: number }> => ({
    status: "pending",
    ids: [id],
    payload: { val },
    remainingExecutionCredits,
    coalescible,
  });

  describe("pushTask", () => {
    it("appends a pending task to the store", () => {
      const store = createStore();
      const task = createPendingTask("t1", 1, 3);
      store.pushTask(task);

      expect(store.clearAllTasks()).toEqual([task]);
    });
  });

  describe("claimCoalescibleTaskPair", () => {
    it("returns null when store has fewer than 2 tasks", () => {
      const store = createStore();
      expect(store.claimCoalescibleTaskPair()).toBeNull();

      store.pushTask(createPendingTask("t1", 1, 1));
      expect(store.claimCoalescibleTaskPair()).toBeNull();
    });

    it("returns null when adjacent tasks are not coalescible due to depth", () => {
      const store = createStore(1); // max depth 1
      store.pushTask(createPendingTask("t1", 1, 1));
      store.pushTask(createPendingTask("t2", 2, 1));

      expect(store.claimCoalescibleTaskPair()).toBeNull();
    });

    it("transitions oldest eligible adjacent pair to coalescing and returns them", () => {
      const store = createStore(3);
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));
      store.pushTask(createPendingTask("t3", 3, 2));

      const pair = store.claimCoalescibleTaskPair();
      expect(pair).not.toBeNull();
      const [p1, p2] = pair!;
      expect(p1.status).toBe("coalescing");
      expect(p1.ids).toEqual(["t1"]);
      expect(p1.coalescible).toBe(true);
      expect(p2.status).toBe("coalescing");
      expect(p2.ids).toEqual(["t2"]);
      expect(p2.coalescible).toBe(true);

      // A second request finds no adjacent coalescible tasks because t2 is now coalescing
      expect(store.claimCoalescibleTaskPair()).toBeNull();
    });

    it("returns null while a pair is already marked as coalescing even if another adjacent pair is available", () => {
      const store = createStore(5);
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));
      store.pushTask(createPendingTask("t3", 3, 2));
      store.pushTask(createPendingTask("t4", 4, 2));

      const firstPair = store.claimCoalescibleTaskPair();
      expect(firstPair).not.toBeNull();
      expect(firstPair![0].ids).toEqual(["t1"]);
      expect(firstPair![1].ids).toEqual(["t2"]);

      // Calling claimCoalescibleTaskPair while t1 and t2 are coalescing must return null
      // even though t3 and t4 are adjacent pending tasks
      expect(store.claimCoalescibleTaskPair()).toBeNull();
    });

    it("returns null when combined IDs would exceed maxCoalescingDepth", () => {
      const store = createStore(3);
      const t1: IPendingTask<string, { val: number }> = {
        status: "pending",
        ids: ["1", "2"],
        payload: { val: 1 },
        remainingExecutionCredits: 1,
        coalescible: true,
      };
      const t2: IPendingTask<string, { val: number }> = {
        status: "pending",
        ids: ["3", "4"],
        payload: { val: 2 },
        remainingExecutionCredits: 1,
        coalescible: true,
      };
      store.pushTask(t1);
      store.pushTask(t2);

      // t1.ids.length (2) < 3 and t2.ids.length (2) < 3, but 2 + 2 = 4 > 3
      expect(store.claimCoalescibleTaskPair()).toBeNull();
    });

    it("claims adjacent pair when combined IDs equal maxCoalescingDepth", () => {
      const store = createStore(3);
      const t1: IPendingTask<string, { val: number }> = {
        status: "pending",
        ids: ["1", "2"],
        payload: { val: 1 },
        remainingExecutionCredits: 1,
        coalescible: true,
      };
      const t2: IPendingTask<string, { val: number }> = {
        status: "pending",
        ids: ["3"],
        payload: { val: 2 },
        remainingExecutionCredits: 1,
        coalescible: true,
      };
      store.pushTask(t1);
      store.pushTask(t2);

      // 2 + 1 = 3 <= 3
      const pair = store.claimCoalescibleTaskPair();
      expect(pair).not.toBeNull();
      expect(pair![0].ids).toEqual(["1", "2"]);
      expect(pair![1].ids).toEqual(["3"]);
    });
  });

  describe("resolveTaskCoalescence", () => {
    it("replaces the coalescing pair with the merged task", () => {
      const store = createStore(3);
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));
      store.pushTask(createPendingTask("t3", 3, 2));

      const pair = store.claimCoalescibleTaskPair()!;
      const merged = {
        status: "pending" as const,
        ids: ["t1", "t2"],
        payload: { val: 3 },
        remainingExecutionCredits: 2,
        coalescible: true,
      };

      const success = store.resolveTaskCoalescence(pair, merged);
      expect(success).toBe(true);

      // Now merged and t3 can be coalesced
      const nextPair = store.claimCoalescibleTaskPair();
      expect(nextPair).not.toBeNull();
      expect(nextPair![0].ids).toEqual(["t1", "t2"]);
      expect(nextPair![1].ids).toEqual(["t3"]);
    });

    it("returns false if pair is no longer present or not contiguous", () => {
      const store = createStore(3);
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));

      const pair = store.claimCoalescibleTaskPair()!;
      store.clearAllTasks();

      const merged = {
        status: "pending" as const,
        ids: ["t1", "t2"],
        payload: { val: 3 },
        remainingExecutionCredits: 2,
        coalescible: true,
      };

      expect(store.resolveTaskCoalescence(pair, merged)).toBe(false);
    });
  });

  describe("rejectTaskCoalescence", () => {
    it("resets tasks to pending and marks predecessor as coalescible: false", () => {
      const store = createStore(3);
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));

      const pair = store.claimCoalescibleTaskPair()!;
      const failed = store.rejectTaskCoalescence(pair);
      expect(failed).toBe(true);

      // t1 is uncoalescible now, so (t1, t2) will NOT be picked again (no infinite loop)
      expect(store.claimCoalescibleTaskPair()).toBeNull();
    });

    it("allows downstream tasks to coalesce when predecessor is uncoalescible", () => {
      const store = createStore(3);
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));
      store.pushTask(createPendingTask("t3", 3, 2));

      // Coalesce (t1, t2) and fail
      const pair = store.claimCoalescibleTaskPair()!;
      expect(store.rejectTaskCoalescence(pair)).toBe(true);

      // (t1, t2) cannot coalesce because t1.coalescible is false,
      // but (t2, t3) can still coalesce!
      const nextPair = store.claimCoalescibleTaskPair();
      expect(nextPair).not.toBeNull();
      expect(nextPair![0].ids).toEqual(["t2"]);
      expect(nextPair![1].ids).toEqual(["t3"]);
    });

    it("leaves predecessor executable and preserves coalescible: false across retries", () => {
      const store = createStore(3);
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));

      // Fail coalescence of (t1, t2)
      const pair = store.claimCoalescibleTaskPair()!;
      store.rejectTaskCoalescence(pair);

      // t1 is still executable!
      const running = store.claimExecutableTask();
      expect(running).not.toBeNull();
      expect(running!.ids).toEqual(["t1"]);
      expect(running!.coalescible).toBe(false);
      expect(running!.remainingExecutionCredits).toBe(1);

      // t1 fails execution attempt
      const err = new TaskExecutionError({
        message: "attempt failed",
        cause: null,
      });
      store.rejectTaskExecution(running!, err);

      // Even as a retryable failed task with 1 credit left, t1 stays coalescible: false
      // so it still does NOT attempt to coalesce with t2!
      expect(store.claimCoalescibleTaskPair()).toBeNull();

      // But t1 can be executed again for its retry attempt
      const retryRunning = store.claimExecutableTask();
      expect(retryRunning).not.toBeNull();
      expect(retryRunning!.ids).toEqual(["t1"]);
      expect(retryRunning!.remainingExecutionCredits).toBe(0);
    });
  });

  describe("claimExecutableTask", () => {
    it("finds oldest executable task, decrements credits, and transitions to running", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 3));

      const running = store.claimExecutableTask();

      expect(running).not.toBeNull();
      expect(running!.status).toBe("running");
      expect(running!.remainingExecutionCredits).toBe(2);
      expect(running!.coalescible).toBe(true);

      // Next request returns null since store has no other tasks
      expect(store.claimExecutableTask()).toBeNull();
    });

    it("skips non-executable tasks (e.g. coalescing or already running)", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 2));
      store.pushTask(createPendingTask("t2", 2, 2));
      store.pushTask(createPendingTask("t3", 3, 2));

      // Coalesce t1 and t2
      store.claimCoalescibleTaskPair();

      const running = store.claimExecutableTask();
      expect(running).not.toBeNull();
      expect(running!.ids).toEqual(["t3"]);
    });
  });

  describe("resolveTaskExecution & rejectTaskExecution", () => {
    it("commits successful execution result", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 1));
      const running = store.claimExecutableTask()!;

      const success = store.resolveTaskExecution(running, "done");
      expect(success).toBe(true);

      const finished = store.clearFinishedTasks();
      expect(finished).toHaveLength(1);
      expect(finished![0].status).toBe("succeeded");
      expect((finished![0] as { result: string }).result).toBe("done");
      expect(finished![0].coalescible).toBe(true);
    });

    it("commits failed execution result", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 1));
      const running = store.claimExecutableTask()!;

      const err = new TaskExecutionError({
        message: "execution error",
        cause: null,
      });
      const success = store.rejectTaskExecution(running, err);
      expect(success).toBe(true);

      const finished = store.clearFinishedTasks();
      expect(finished).toHaveLength(1);
      expect(finished![0].status).toBe("failed");
      expect((finished![0] as { error: unknown }).error).toBe(err);
      expect(finished![0].coalescible).toBe(true);
    });

    it("returns false if running task was cleared or not in running status", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 1));
      const running = store.claimExecutableTask()!;

      store.clearAllTasks();

      expect(store.resolveTaskExecution(running, "result")).toBe(false);
      expect(
        store.rejectTaskExecution(
          running,
          new TaskExecutionError({ message: "err", cause: null }),
        ),
      ).toBe(false);
    });
  });

  describe("runningCount", () => {
    it("tracks the number of currently running tasks through their lifecycle", () => {
      const store = createStore();
      expect(store.runningCount).toBe(0);

      store.pushTask(createPendingTask("t1", 1, 1));
      store.pushTask(createPendingTask("t2", 2, 1));
      expect(store.runningCount).toBe(0);

      const r1 = store.claimExecutableTask()!;
      expect(store.runningCount).toBe(1);

      const r2 = store.claimExecutableTask()!;
      expect(store.runningCount).toBe(2);

      store.resolveTaskExecution(r1, "result-1");
      expect(store.runningCount).toBe(1);

      store.rejectTaskExecution(
        r2,
        new TaskExecutionError({ message: "err", cause: null }),
      );
      expect(store.runningCount).toBe(0);
    });

    it("does not decrement runningCount if resolve or reject fails", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 1));
      const r1 = store.claimExecutableTask()!;
      expect(store.runningCount).toBe(1);

      store.clearAllTasks();
      expect(store.runningCount).toBe(0);

      const resolved = store.resolveTaskExecution(r1, "result-1");
      expect(resolved).toBe(false);
      expect(store.runningCount).toBe(0);

      const rejected = store.rejectTaskExecution(
        r1,
        new TaskExecutionError({ message: "err", cause: null }),
      );
      expect(rejected).toBe(false);
      expect(store.runningCount).toBe(0);
    });
  });

  describe("clearAllTasks", () => {
    it("returns null when empty and cleared tasks array when populated", () => {
      const store = createStore();
      expect(store.clearAllTasks()).toBeNull();

      store.pushTask(createPendingTask("t1", 1, 1));
      store.pushTask(createPendingTask("t2", 2, 1));

      const cleared = store.clearAllTasks();
      expect(cleared).toHaveLength(2);
      expect(store.clearAllTasks()).toBeNull();
    });
  });

  describe("clearFinishedTasks", () => {
    it("returns null when head is not terminal", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 1));
      expect(store.clearFinishedTasks()).toBeNull();
    });

    it("returns null when head failed task still has remaining retry credits", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 2));
      const running = store.claimExecutableTask()!;
      store.rejectTaskExecution(
        running,
        new TaskExecutionError({ message: "retryable", cause: null }),
      );

      // Remaining credits = 1, so it is retryable and NOT finished
      expect(store.clearFinishedTasks()).toBeNull();
    });

    it("shifts contiguous terminal tasks and stops at first non-terminal task", () => {
      const store = createStore();
      store.pushTask(createPendingTask("t1", 1, 1));
      store.pushTask(createPendingTask("t2", 2, 1));
      store.pushTask(createPendingTask("t3", 3, 1));

      // t1 running -> succeeded
      const r1 = store.claimExecutableTask()!;
      store.resolveTaskExecution(r1, "res1");

      // t2 running -> failed with 0 credits
      const r2 = store.claimExecutableTask()!;
      store.rejectTaskExecution(
        r2,
        new TaskExecutionError({ message: "fail2", cause: null }),
      );

      // t3 remains pending
      const finished = store.clearFinishedTasks();
      expect(finished).toHaveLength(2);
      expect(finished![0].ids).toEqual(["t1"]);
      expect(finished![1].ids).toEqual(["t2"]);

      // Next call returns null because t3 is pending
      expect(store.clearFinishedTasks()).toBeNull();

      // Clear all returns t3
      const remaining = store.clearAllTasks();
      expect(remaining).toHaveLength(1);
      expect(remaining![0].ids).toEqual(["t3"]);
    });
  });

  describe("areCoalescible", () => {
    it("returns true when both tasks are eligible and combined length <= maxCoalescingDepth", () => {
      const t1 = createPendingTask("t1", 1, 1, true);
      const t2 = createPendingTask("t2", 2, 1, true);
      expect(areCoalescible(t1, t2, 2)).toBe(true);
    });

    it("returns false when combined length exceeds maxCoalescingDepth", () => {
      const t1: IPendingTask<string, { val: number }> = {
        status: "pending",
        ids: ["1", "2"],
        payload: { val: 1 },
        remainingExecutionCredits: 1,
        coalescible: true,
      };
      const t2: IPendingTask<string, { val: number }> = {
        status: "pending",
        ids: ["3", "4"],
        payload: { val: 2 },
        remainingExecutionCredits: 1,
        coalescible: true,
      };
      expect(areCoalescible(t1, t2, 3)).toBe(false);
    });

    it("returns false when prev task is not coalescible", () => {
      const t1 = createPendingTask("t1", 1, 1, false);
      const t2 = createPendingTask("t2", 2, 1, true);
      expect(areCoalescible(t1, t2, 5)).toBe(false);
    });

    it("returns false when curr task is not coalescible", () => {
      const t1 = createPendingTask("t1", 1, 1, true);
      const t2 = createPendingTask("t2", 2, 1, false);
      expect(areCoalescible(t1, t2, 5)).toBe(false);
    });

    it("returns false when a task is not in pending or retryable failed status", () => {
      const t1 = createPendingTask("t1", 1, 1, true);
      const runningTask = {
        ...createPendingTask("t2", 2, 1, true),
        status: "running" as const,
      };
      expect(areCoalescible(t1, runningTask, 5)).toBe(false);
      expect(areCoalescible(runningTask, t1, 5)).toBe(false);
    });
  });
});
