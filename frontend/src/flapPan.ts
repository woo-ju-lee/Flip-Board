/** Spatial audio geometry for the board's fixed cell layout. */
type Entry = { board: Element; targets: HTMLElement[]; version: number; pan: number };

const entries = new Map<HTMLElement, Entry>();
const targets = new Map<HTMLElement, number>();
let version = 0;
let lifetime = 0;
let queued = false;
let reobserve = false;
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let fonts: FontFaceSet | undefined;

function measure(root: HTMLElement) {
  const bounds = root.getBoundingClientRect();
  return ((bounds.left + bounds.width / 2) / Math.max(1, window.innerWidth)) * 2 - 1;
}

// These classes change color only; normal page data must not invalidate layout.
function layoutClass(value: string | null) {
  return (value ?? "").split(/\s+/).filter(name => name &&
    !["delay-on_time", "delay-delayed", "delay-unknown"].includes(name)).sort().join(" ");
}

function changed(records: MutationRecord[]) {
  return records.some(record => targets.has(record.target as HTMLElement) &&
    (record.attributeName !== "class" ||
      layoutClass(record.oldValue) !== layoutClass((record.target as Element).getAttribute("class"))));
}

function observeMutations(target: HTMLElement) {
  mutationObserver?.observe(target, {
    attributes: true, attributeFilter: ["class", "style"], attributeOldValue: true,
  });
}

function queueWarm() {
  if (queued || !entries.size) return;
  queued = true;
  const currentLifetime = lifetime;
  queueMicrotask(() => {
    if (currentLifetime !== lifetime) return;
    queued = false;
    // MutationObserver has no unobserve(). Rebuild once after a batch of removals.
    if (reobserve) {
      if (changed(mutationObserver?.takeRecords() ?? [])) version++;
      mutationObserver?.disconnect();
      targets.forEach((_, target) => observeMutations(target));
      reobserve = false;
    }
    if (document.hidden) return;
    if (changed(mutationObserver?.takeRecords() ?? [])) version++;
    // All entries are measured together, with no DOM writes or audio scheduling.
    for (const [root, entry] of entries) {
      if (root.isConnected && entry.board.contains(root) && entry.version !== version) {
        entry.pan = measure(root);
        entry.version = version;
      }
    }
  });
}

function invalidate() {
  version++;
  queueWarm();
}

function start() {
  lifetime++;
  if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(invalidate);
  if (typeof MutationObserver !== "undefined") mutationObserver = new MutationObserver(records => {
    if (changed(records)) invalidate();
  });
  window.addEventListener("resize", invalidate);
  window.addEventListener("scroll", invalidate, true);
  document.addEventListener("fullscreenchange", invalidate);
  document.addEventListener("visibilitychange", invalidate);
  fonts = document.fonts;
  fonts?.addEventListener("loadingdone", invalidate);
  const currentLifetime = lifetime;
  void fonts?.ready.then(() => {
    if (currentLifetime === lifetime && entries.size) invalidate();
  });
}

function stop() {
  lifetime++;
  queued = false;
  reobserve = false;
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  resizeObserver = undefined;
  mutationObserver = undefined;
  window.removeEventListener("resize", invalidate);
  window.removeEventListener("scroll", invalidate, true);
  document.removeEventListener("fullscreenchange", invalidate);
  document.removeEventListener("visibilitychange", invalidate);
  fonts?.removeEventListener("loadingdone", invalidate);
  fonts = undefined;
}

/** Register once per mounted cell, independently of its value/animation effects. */
export function registerFlapPan(root: HTMLElement) {
  // Both observers are needed to keep cached positions accurate. Older WAAPI
  // browsers can still use the scheduler's fresh, batched geometry reads.
  if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const board = root.closest(".board-housing");
  if (!board) return () => {};
  if (!entries.size) start();
  const ancestry: HTMLElement[] = [];
  for (let target: HTMLElement | null = root; target; target = target.parentElement) {
    ancestry.push(target);
    const count = targets.get(target) ?? 0;
    targets.set(target, count + 1);
    if (!count) {
      resizeObserver?.observe(target);
      observeMutations(target);
    }
  }
  const entry: Entry = { board, targets: ancestry, version: -1, pan: 0 };
  entries.set(root, entry);
  invalidate();
  return () => {
    if (entries.get(root) !== entry) return;
    entries.delete(root);
    for (const target of entry.targets) {
      const count = targets.get(target)! - 1;
      if (count) targets.set(target, count);
      else {
        targets.delete(target);
        resizeObserver?.unobserve(target);
        reobserve = true;
      }
    }
    if (entries.size) invalidate();
    else stop();
  };
}

/** Called only in the scheduler's shared read phase; misses preserve that order. */
export function readFlapPan(root: HTMLElement) {
  if (document.hidden || !root.isConnected) return 0;
  // A layout mutation and new target can occur in the same task, before the
  // observer callback. Consume those records before trusting a cached position.
  if (changed(mutationObserver?.takeRecords() ?? [])) invalidate();
  const entry = entries.get(root);
  if (!entry || !entry.board.matches(".board-housing") || !entry.board.contains(root)) return measure(root);
  if (entry.version !== version) {
    entry.pan = measure(root);
    entry.version = version;
  }
  return entry.pan;
}
