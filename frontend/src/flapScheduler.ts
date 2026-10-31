/** One browser frame request for all moving cells; idle boards do no frame work. */
export type FlapFrameTask = {
  /** Layout reads are batched once in a microtask, before animation work. */
  prepare?: () => void;
  /** Runs after every preparation read, before the first animation frame. */
  onPrepared?: () => void;
  /** Return false when the cell has reached its target. */
  update: (now: number) => boolean;
  onHidden: () => void;
};

const tasks = new Set<FlapFrameTask>();
const preparations = new Set<FlapFrameTask>();
let frame: number | null = null;
let ticking = false;
let listening = false;
let preparationQueued = false;

function stopWhenIdle() {
  if (tasks.size) return;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  if (listening) document.removeEventListener("visibilitychange", onVisibility);
  listening = false;
}

function onVisibility() {
  if (!document.hidden) return;
  for (const task of [...tasks]) {
    tasks.delete(task);
    preparations.delete(task);
    task.onHidden();
  }
  stopWhenIdle();
}

function requestFrame() {
  if (frame === null && !ticking && tasks.size > preparations.size) frame = requestAnimationFrame(tick);
}

function requestPreparation() {
  if (preparationQueued || !preparations.size) return;
  preparationQueued = true;
  queueMicrotask(() => {
    // Keep this flag until the callback drains: cancelling all tasks cannot
    // cancel a queued microtask, and StrictMode may register new tasks meanwhile.
    try {
      if (document.hidden) { onVisibility(); return; }
      const current = [...preparations];
      for (const task of current) {
        if (tasks.has(task) && preparations.has(task)) task.prepare?.();
      }
      if (document.hidden) { onVisibility(); return; }
      for (const task of current) {
        if (tasks.has(task) && preparations.delete(task)) task.onPrepared?.();
      }
    } finally {
      preparationQueued = false;
      stopWhenIdle();
      // A callback can register more work. It gets its own complete read phase.
      requestPreparation();
      requestFrame();
    }
  });
}

function tick(now: number) {
  frame = null;
  ticking = true;
  try {
    const current = [...tasks];
    for (const task of current) {
      // New registrations never fall back to preparing inside a heavy frame.
      if (tasks.has(task) && !preparations.has(task) && !task.update(now)) tasks.delete(task);
    }
  } finally {
    ticking = false;
    stopWhenIdle();
    requestFrame();
  }
}

export function scheduleFlap(task: FlapFrameTask): () => void {
  if (document.hidden) {
    task.onHidden();
    return () => {};
  }
  tasks.add(task);
  preparations.add(task);
  if (!listening) {
    document.addEventListener("visibilitychange", onVisibility);
    listening = true;
  }
  requestPreparation();
  return () => {
    tasks.delete(task);
    preparations.delete(task);
    stopWhenIdle();
  };
}

/** Read-only diagnostics also let tests assert that teardown leaves no work. */
export function getFlapSchedulerState() {
  return { activeCells: tasks.size, framePending: frame !== null };
}
