import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SplitFlap } from "../components/SplitFlap";
import { flapAudio } from "../audio";

describe("split-flap mechanics", () => {
  it("animates only the changed character, and stays quiet for identical data", () => {
    vi.useFakeTimers();
    const clicks = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const { container, rerender } = render(
      <SplitFlap text="KTX 31" length={6} reduced={false} />,
    );
    act(() => vi.advanceTimersByTime(2300));
    expect(container.querySelectorAll('[data-flipping="true"]')).toHaveLength(
      0,
    );
    clicks.mockClear();
    rerender(<SplitFlap text="KTX 31" length={6} reduced={false} />);
    act(() => vi.advanceTimersByTime(2300));
    expect(clicks).not.toHaveBeenCalled();
    rerender(<SplitFlap text="KTX 32" length={6} reduced={false} />);
    act(() => vi.advanceTimersByTime(250));
    expect(container.querySelectorAll('[data-flipping="true"]')).toHaveLength(
      1,
    );
    expect(container.querySelectorAll(".flap-out")).toHaveLength(1);
    expect(container.querySelectorAll(".flap-in")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2300));
    expect(container.querySelectorAll('[data-flipping="true"]')).toHaveLength(
      0,
    );
  });

  it("respects reduced motion without audio", () => {
    const clicks = vi.spyOn(flapAudio, "schedule");
    const { container, rerender } = render(
      <SplitFlap text="정상" length={3} reduced />,
    );
    rerender(<SplitFlap text="+3분" length={3} reduced />);
    expect(container.querySelectorAll('[data-flipping="true"]')).toHaveLength(
      0,
    );
    expect(container.firstChild).toHaveAttribute("aria-label", "+3분");
    expect(clicks).not.toHaveBeenCalled();
  });

  it("cancels a mid-flip update even when reverting to the settled character", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <SplitFlap text="A" length={1} reduced={false} />,
    );
    act(() => vi.advanceTimersByTime(2300));
    rerender(<SplitFlap text="B" length={1} reduced={false} />);
    act(() => vi.advanceTimersByTime(50));
    rerender(<SplitFlap text="A" length={1} reduced={false} />);
    act(() => vi.advanceTimersByTime(2300));
    expect(container.querySelector('[data-flipping="true"]')).toBeNull();
    expect(container.querySelector(".flap-top > span")).toHaveTextContent("A");
  });

  it("keeps the complete accessible label when a field is shortened", () => {
    const { container } = render(
      <SplitFlap text="아주 긴 현재 위치 문구" length={6} reduced />,
    );
    expect(container.querySelector(".flap-word")).toHaveAttribute(
      "aria-label",
      "아주 긴 현재 위치 문구",
    );
    expect(container.querySelectorAll(".flap")).toHaveLength(6);
    expect(container.querySelector(".flap:last-child")).toHaveAttribute(
      "data-value",
      "…",
    );
  });

  it("settles on the newest value and cancels every obsolete audio owner", () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const cancel = vi.spyOn(flapAudio, "cancel");
    const { container, rerender, unmount } = render(<SplitFlap text="서울" length={2} reduced={false} />);
    act(() => vi.advanceTimersByTime(350));
    rerender(<SplitFlap text="부산" length={2} reduced={false} />);
    act(() => vi.advanceTimersByTime(250));
    rerender(<SplitFlap text="광명" length={2} reduced={false} />);
    act(() => vi.advanceTimersByTime(2300));
    expect(Array.from(container.querySelectorAll(".flap-top > span"), n => n.textContent).join("")).toBe("광명");
    expect(container.querySelector('[data-flipping="true"]')).toBeNull();
    for (const [owner] of schedule.mock.calls) expect(cancel).toHaveBeenCalledWith(owner);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("immediately settles and cancels sound when the page is hidden or motion is reduced", () => {
    vi.useFakeTimers();
    const cancel = vi.spyOn(flapAudio, "cancel");
    const { container, rerender } = render(<SplitFlap text="A" length={1} reduced={false} />);
    act(() => vi.advanceTimersByTime(250));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(cancel).toHaveBeenCalled();
    expect(container.querySelector('[data-flipping="true"]')).toBeNull();
    expect(container.querySelector(".flap-top > span")).toHaveTextContent("A");
    expect(vi.getTimerCount()).toBe(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    rerender(<SplitFlap text="B" length={1} reduced={false} />);
    act(() => vi.advanceTimersByTime(250));
    rerender(<SplitFlap text="B" length={1} reduced />);
    expect(container.querySelector(".flap-top > span")).toHaveTextContent("B");
    expect(vi.getTimerCount()).toBe(0);
  });
});
