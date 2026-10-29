import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrainLogo } from "../components/TrainLogo";
import { flapAudio } from "../audio";
import { makePanelPlan } from "../panelMotion";
import { FLAP_MS, soundEvents } from "../flapMotion";

describe("train logo flap", () => {
  it("synchronizes the logo's landing and sound, and skips an unchanged kind", () => {
    const labels = ["KTX", "KTX-청룡", "무궁화"];
    const plan = makePanelPlan("KTX", "KTX-청룡", labels, "logo", 1000, 7);
    expect(plan.steps.at(-1)?.to).toBe("KTX-청룡");
    expect(plan.steps[0].from).toBe("KTX");
    plan.steps.forEach((step, i) => {
      expect(step.landAt - step.at).toBe(FLAP_MS);
      if (i) expect(step.from).toBe(plan.steps[i - 1].to);
    });
    expect(soundEvents(plan, 0).map(e => e.at)).toEqual(plan.steps.map(s => s.landAt));
    expect(makePanelPlan("KTX", "KTX", labels, "logo", 0, 0).steps).toHaveLength(0);
  });

  it("cancels an interrupted rotation and puts the latest logo on both halves", () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const cancel = vi.spyOn(flapAudio, "cancel");
    const { container, rerender, unmount } = render(<TrainLogo kind="KTX" index={0} reduced={false} />);
    act(() => vi.advanceTimersByTime(1600));
    const leaf = container.querySelector(".logo-leaf");
    schedule.mockClear();
    rerender(<TrainLogo kind="KTX" index={0} reduced={false} />);
    expect(schedule).not.toHaveBeenCalled();
    rerender(<TrainLogo kind="무궁화" index={0} reduced={false} />);
    act(() => vi.advanceTimersByTime(120));
    rerender(<TrainLogo kind="KTX-청룡" index={0} reduced={false} />);
    act(() => vi.advanceTimersByTime(1600));
    expect(container.querySelector(".logo-leaf")).toBe(leaf);
    expect(leaf).toHaveAttribute("data-value", "KTX-청룡");
    const images = Array.from(container.querySelectorAll(".flap-half img"));
    expect(images).toHaveLength(2);
    images.forEach(img => expect(img.getAttribute("src")).toContain("ktx-cheongryong.png"));
    expect(container.querySelector('[data-flipping="true"]')).toBeNull();
    expect(cancel).toHaveBeenCalled();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles immediately for reduced motion and retains family or text fallbacks", () => {
    vi.useFakeTimers();
    vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const { container, rerender } = render(<TrainLogo kind="KTX-청룡" index={0} reduced={false} />);
    act(() => vi.advanceTimersByTime(80));
    rerender(<TrainLogo kind="KTX-이음" index={0} reduced />);
    expect(container.querySelector('[data-flipping="true"]')).toBeNull();
    expect(container.querySelector(".flap-top img")?.getAttribute("src")).toContain("ktx.svg");
    expect(container.querySelector(".flap-top .train-logo-subtitle")).toHaveTextContent("이음");
    expect(vi.getTimerCount()).toBe(0);
    rerender(<TrainLogo kind="ITX-마음" index={0} reduced />);
    expect(container.querySelector(".flap-top .train-logo-label")).toHaveTextContent("ITX-마음");
    rerender(<TrainLogo kind="" index={0} reduced />);
    expect(container.querySelector(".flap-top > .panel-face")).toBeEmptyDOMElement();
    expect(container.querySelector(".flap-bottom > .panel-face")).toBeEmptyDOMElement();
  });
});
