/** One browser frame request for all moving cells; idle boards do no frame work. */
export type FlapFrameTask = {
  /** Layout reads are batched before any cell writes for this frame. */
  prepare?: () => void;
  /** Return false when the cell has reached its target. */
  update: (now: number) => boolean;
  onHidden: () => void;
};

const tasks = new Set<FlapFrameTask>();
const preparations = new Set<FlapFrameTask>();
let frame: number | null = null;
let ticking = false;
let listening = false;

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
  if (frame === null && !ticking && tasks.size) frame = requestAnimationFrame(tick);
}

function tick(now: number) {
  frame = null;
  ticking = true;
  try {
    const current = [...tasks];
    for (const task of current) {
      if (tasks.has(task) && preparations.delete(task)) task.prepare?.();
    }
    for (const task of current) {
      if (tasks.has(task) && !task.update(now)) tasks.delete(task);
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
  requestFrame();
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
