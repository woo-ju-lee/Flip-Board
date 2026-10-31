import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFlapPan, registerFlapPan } from "../flapPan";

let dispose: Array<() => void>;
let resize: ResizeObserverCallback;
let observer: { observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
let fonts: EventTarget & { ready: Promise<void> };
let ready: () => void;
let fontDescriptor: PropertyDescriptor | undefined;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  dispose = [];
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) { resize = callback; observer = this; }
  });
  fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(resolve => { ready = resolve; }) });
  fontDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
});

afterEach(async () => {
  dispose.forEach(cleanup => cleanup());
  document.body.replaceChildren();
  await flush();
  if (fontDescriptor) Object.defineProperty(document, "fonts", fontDescriptor);
  else Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
});

function board() {
  const outer = document.createElement("main");
  outer.innerHTML = '<section class="board-housing"><div class="display-table"><div class="board-row"><span class="delay-cell delay-on_time"><span class="flap-word"><span class="flap"></span><span class="flap flap-panel"></span></span></span></div></div></section>';
  document.body.append(outer);
  const roots = [...outer.querySelectorAll<HTMLElement>(".flap")];
  const positions = [100, 750];
  const reads = roots.map((root, index) => vi.spyOn(root, "getBoundingClientRect").mockImplementation(() =>
    ({ left: positions[index], width: 100 } as DOMRect)));
  return { outer, roots, positions, reads, register() { roots.forEach(root => dispose.push(registerFlapPan(root))); } };
}

describe("board spatial audio geometry", () => {
  it("prewarms all mounted positions in one read batch and reuses left/right pan without an idle frame", async () => {
    const view = board();
    view.register();
    view.reads.forEach(read => expect(read).not.toHaveBeenCalled());
    await flush();
    for (let page = 0; page < 3; page++) {
      expect(readFlapPan(view.roots[0])).toBeCloseTo(-.7);
      expect(readFlapPan(view.roots[1])).toBeCloseTo(.6);
    }
    view.reads.forEach(read => expect(read).toHaveBeenCalledOnce());
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    for (const target of [view.roots[0], view.outer, document.body, document.documentElement,
      view.outer.querySelector(".board-housing"), view.outer.querySelector(".display-table")]) {
      expect(observer.observe).toHaveBeenCalledWith(target);
    }
  });

  it.each(["resize", "scroll", "fullscreen", "font loading", "fonts ready"])("remeasures once after %s", async event => {
    const view = board();
    view.register();
    await flush();
    view.positions[0] = 300;
    if (event === "resize") window.dispatchEvent(new Event("resize"));
    if (event === "scroll") view.roots[0].dispatchEvent(new Event("scroll")); // non-bubbling capture
    if (event === "fullscreen") document.dispatchEvent(new Event("fullscreenchange"));
    if (event === "font loading") fonts.dispatchEvent(new Event("loadingdone"));
    if (event === "fonts ready") ready();
    await flush();
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.3);
    view.reads.forEach(read => expect(read).toHaveBeenCalledTimes(2));
  });

  it.each([".board-housing", ".display-table", ".flap-word", ".flap", "outer"])("sees same-task layout style changes on %s before its observer callback", async selector => {
    const view = board();
    view.register();
    await flush();
    view.positions[0] = 400;
    const target = selector === "outer" ? view.outer : view.outer.querySelector<HTMLElement>(selector)!;
    target.style.paddingLeft = "20px";
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.1);
    await flush();
    view.reads.forEach(read => expect(read).toHaveBeenCalledTimes(2));
  });

  it("invalidates layout classes but ignores page values, moving faces and delay colors", async () => {
    const view = board();
    view.register();
    await flush();
    const delay = view.outer.querySelector(".delay-cell")!;
    delay.className = "delay-cell delay-delayed";
    view.roots[0].dataset.flipping = "true";
    view.roots[0].dataset.value = "9";
    view.roots[0].textContent = "9";
    await flush();
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.7);
    view.reads.forEach(read => expect(read).toHaveBeenCalledOnce());
    view.positions[0] = 200;
    delay.classList.add("wider-columns");
    await flush();
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.5);
    view.reads.forEach(read => expect(read).toHaveBeenCalledTimes(2));
  });

  it("responds to shared ResizeObserver notifications for root/container size changes", async () => {
    const view = board();
    view.register();
    await flush();
    view.positions[1] = 500;
    resize([], observer as unknown as ResizeObserver);
    await flush();
    expect(readFlapPan(view.roots[1])).toBeCloseTo(.1);
    view.reads.forEach(read => expect(read).toHaveBeenCalledTimes(2));
  });

  it("defers hidden geometry reads until visible and skips disconnected roots", async () => {
    const view = board();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    view.register();
    await flush();
    expect(readFlapPan(view.roots[0])).toBe(0);
    view.reads.forEach(read => expect(read).not.toHaveBeenCalled());
    view.roots[1].remove();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.7);
    expect(view.reads[0]).toHaveBeenCalledOnce();
    expect(view.reads[1]).not.toHaveBeenCalled();
  });

  it("releases observations/listeners and ignores stale warming/font callbacks after unmount", async () => {
    const view = board();
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const removeFonts = vi.spyOn(fonts, "removeEventListener");
    view.register();
    dispose.forEach(cleanup => cleanup());
    ready();
    await flush();
    view.reads.forEach(read => expect(read).not.toHaveBeenCalled());
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(removeWindow).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(removeDocument).toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeFonts).toHaveBeenCalledWith("loadingdone", expect.any(Function));
  });

  it("survives StrictMode cleanup/re-registration before the warm microtask", async () => {
    const view = board();
    view.register();
    dispose.forEach(cleanup => cleanup());
    view.register();
    await flush();
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.7);
    view.reads.forEach(read => expect(read).toHaveBeenCalledOnce());
  });

  it("uses a fresh read for generic components outside the fixed board layout", async () => {
    const root = document.createElement("span");
    document.body.append(root);
    const bounds = vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ left: 100, width: 100 } as DOMRect);
    dispose.push(registerFlapPan(root));
    await flush();
    expect(bounds).not.toHaveBeenCalled();
    expect(readFlapPan(root)).toBeCloseTo(-.7);
    bounds.mockReturnValue({ left: 700, width: 100 } as DOMRect);
    expect(readFlapPan(root)).toBeCloseTo(.5);
    expect(bounds).toHaveBeenCalledTimes(2);
  });

  it.each(["ResizeObserver", "MutationObserver"])("uses fresh board reads without %s", async missing => {
    vi.stubGlobal(missing, undefined);
    const view = board();
    view.register();
    await flush();
    view.reads.forEach(read => expect(read).not.toHaveBeenCalled());
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.7);
    view.positions[0] = 400;
    expect(readFlapPan(view.roots[0])).toBeCloseTo(-.1);
    expect(view.reads[0]).toHaveBeenCalledTimes(2);
  });
});
