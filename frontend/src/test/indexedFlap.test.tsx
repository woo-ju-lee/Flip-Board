import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { flapAudio } from "../audio";
import { DIGIT_ROTOR, FLAP_MS, makeIndexedFlapPlan, soundEvents } from "../flapMotion";
import { SplitFlap } from "../components/SplitFlap";
import stations from "../stationRotor.json";
import { STATION_CHARACTER_ROTOR } from "../stationCharacters";

describe("indexed physical drums", () => {
  it("takes the forward distance for every digit pair, including 9 → 0", () => {
    for (let from = 0; from < 10; from++) for (let to = 0; to < 10; to++) {
      const plan = makeIndexedFlapPlan(String(from), String(to), DIGIT_ROTOR, "number", 1000);
      const distance = (to - from + 10) % 10;
      expect(plan.steps).toHaveLength(distance);
      plan.steps.forEach((step, i) => {
        expect(step.from).toBe(String((from + i) % 10));
        expect(step.to).toBe(String((from + i + 1) % 10));
        expect(step.landAt - step.at).toBe(FLAP_MS);
      });
      expect(soundEvents(plan, 0).map(event => event.at)).toEqual(plan.steps.map(step => step.landAt));
    }
    expect(makeIndexedFlapPlan("8", "2", DIGIT_ROTOR, "number", 0).steps.map(step => step.to)).toEqual(["9", "0", "1", "2"]);
  });

  it("shares one deduplicated syllable drum, including a blank leaf, across all stations", () => {
    const rotor = STATION_CHARACTER_ROTOR;
    expect(new Set(rotor).size).toBe(rotor.length);
    expect(rotor.filter(value => value === " ")).toHaveLength(1);
    expect(rotor.every(value => Array.from(value).length === 1)).toBe(true);
    for (const station of stations) for (const character of Array.from(station)) expect(rotor).toContain(character);
    for (const shared of ["서", "산", "천"]) expect(rotor.filter(value => value === shared)).toHaveLength(1);
    const plan = makeIndexedFlapPlan(rotor[0], rotor.at(-1)!, rotor, "station", 0);
    expect(plan.steps.map(step => step.to)).toEqual(rotor.slice(1));
    expect(makeIndexedFlapPlan(rotor.at(-1)!, rotor[1], rotor, "station", 0).steps.map(step => step.to))
      .toEqual([" ", rotor[1]]);
    expect(soundEvents(plan, 0)).toHaveLength(rotor.length - 1);
  });

  it("does not change the fixed drum for missing labels or unchanged values", () => {
    const rotor = Object.freeze(["서울", "부산"]);
    for (const [from, to] of [["서울", "서울"], ["서울", "새로운역"], ["새로운역", "부산"]]) {
      expect(makeIndexedFlapPlan(from, to, rotor, "station", 0).steps).toEqual([]);
    }
    expect(rotor).toEqual(["서울", "부산"]);
  });

  it("moves 8 → 2 through four leaves with four sounds, then stays quiet on an identical update", () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const { container, rerender } = render(<SplitFlap text="8" length={1} reduced={false} rotor={DIGIT_ROTOR} />);
    expect(schedule).not.toHaveBeenCalled();
    rerender(<SplitFlap text="2" length={1} reduced={false} rotor={DIGIT_ROTOR} />);
    expect(schedule.mock.calls[0][1]).toHaveLength(4);
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector(".flap-top > span")).toHaveTextContent("2");
    schedule.mockClear();
    rerender(<SplitFlap text="2" length={1} reduced={false} rotor={DIGIT_ROTOR} />);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("keeps the five original character cells and only turns a changed syllable", () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const { container, rerender } = render(<SplitFlap text="서울" length={5} rotor={STATION_CHARACTER_ROTOR} reduced={false} />);
    const leaves = Array.from(container.querySelectorAll(".flap"));
    expect(leaves).toHaveLength(5);
    rerender(<SplitFlap text="서산" length={5} rotor={STATION_CHARACTER_ROTOR} reduced={false} />);
    expect(schedule).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(200));
    expect(leaves[0]).toHaveAttribute("data-flipping", "false");
    expect(container.querySelectorAll('[data-flipping="true"]')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(STATION_CHARACTER_ROTOR.length * FLAP_MS + 200));
    expect(Array.from(container.querySelectorAll(".flap"))).toEqual(leaves);
    expect(Array.from(container.querySelectorAll(".flap-top > span"), leaf => leaf.textContent).join("")).toBe("서산   ");
    schedule.mockClear();
    rerender(<SplitFlap text="서산" length={5} rotor={STATION_CHARACTER_ROTOR} reduced={false} />);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("redirects a changing station character from its last landed syllable", () => {
    vi.useFakeTimers();
    const rotor = [" ", "서", "울", "산", "천", "대"];
    const schedule = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const cancel = vi.spyOn(flapAudio, "cancel");
    const { container, rerender, unmount } = render(<SplitFlap text="서울" length={5} rotor={rotor} reduced={false} />);
    rerender(<SplitFlap text="서대" length={5} rotor={rotor} reduced={false} />);
    const firstEvents = schedule.mock.calls[0][1];
    expect(firstEvents).toHaveLength(3);
    act(() => vi.advanceTimersByTime(firstEvents[0].at - performance.now() + 10));
    rerender(<SplitFlap text="서천" length={5} rotor={rotor} reduced={false} />);
    // 울 → 산 has landed in the second cell, so only 천 remains.
    expect(schedule.mock.calls.at(-1)![1]).toHaveLength(1);
    expect(cancel).toHaveBeenCalledWith(schedule.mock.calls[0][0]);
    act(() => vi.advanceTimersByTime(1500));
    expect(Array.from(container.querySelectorAll(".flap-top > span"), leaf => leaf.textContent).join("")).toBe("서천   ");
    expect(container.querySelector('[data-flipping="true"]')).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns surplus characters to the shared blank leaf when a station name becomes shorter", () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const { container, rerender } = render(<SplitFlap text="여수엑스포" length={5} rotor={STATION_CHARACTER_ROTOR} reduced={false} />);
    rerender(<SplitFlap text="서울" length={5} rotor={STATION_CHARACTER_ROTOR} reduced={false} />);
    expect(schedule).toHaveBeenCalledTimes(5);
    act(() => vi.advanceTimersByTime(STATION_CHARACTER_ROTOR.length * FLAP_MS + 200));
    expect(container.querySelectorAll(".flap")).toHaveLength(5);
    expect(Array.from(container.querySelectorAll(".flap-top > span"), leaf => leaf.textContent).join("")).toBe("서울   ");
    expect(container.querySelector('[data-flipping="true"]')).toBeNull();
  });

  it("settles a long station transition and cancels audio when hidden or motion is reduced", () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
    const cancel = vi.spyOn(flapAudio, "cancel");
    const rotor = STATION_CHARACTER_ROTOR;
    const { container, rerender } = render(<SplitFlap text={rotor[1]} length={5} rotor={rotor} reduced={false} />);
    rerender(<SplitFlap text={rotor.at(-1)!} length={5} rotor={rotor} reduced={false} />);
    act(() => vi.advanceTimersByTime(500));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector(".flap-top > span")).toHaveTextContent(rotor.at(-1)!);
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    schedule.mockClear();
    rerender(<SplitFlap text={rotor[1]} length={5} rotor={rotor} reduced />);
    expect(container.querySelector(".flap-top > span")).toHaveTextContent(rotor[1]);
    expect(schedule).not.toHaveBeenCalled();
  });
});
