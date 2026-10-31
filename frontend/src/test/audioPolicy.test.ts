import { describe, expect, it, vi } from "vitest";
import { audioDensity, compareAudioEvents, selectAudioEvents, type AudioCandidate, type AudioInterval } from "../audioPolicy";

const event = (at: number, kind: "flip" | "stop" = "flip", owner = "a", order = 0): AudioCandidate =>
  ({ at, start: at - 29, end: at + 36, kind, owner, order, variant: 3, pan: 0 });
const selectedTimes = (events: AudioCandidate[], reservations: AudioInterval[] = []) =>
  selectAudioEvents(events.sort(compareAudioEvents), Infinity, reservations).selected.map(({ event }) => event.at);

describe("board-wide audio policy", () => {
  it("accepts 25ms exactly, but rejects 24.999ms and fixed-bucket boundary collisions", () => {
    expect(selectedTimes([event(100), event(124.999), event(125), event(149.999), event(150)])).toEqual([100, 125, 150]);
    expect(selectedTimes([event(49.999), event(50)])).toEqual([49.999]);
  });

  it("keeps the earliest stop in a moving window and drops conflicts after that winner", () => {
    expect(selectedTimes([event(100), event(110, "stop"), event(120, "stop"), event(130), event(135)])).toEqual([110, 135]);
  });

  it("orders equal-priority ties by owner and then registration order", () => {
    const events = [event(100, "stop", "b", 0), event(100, "stop", "a", 4), event(100, "stop", "a", 2)];
    expect(selectAudioEvents(events.sort(compareAudioEvents), Infinity, []).selected[0].event).toMatchObject({ owner: "a", order: 2 });
  });

  it("does not discard a window while its winning stop is beyond the horizon", () => {
    const events = [event(85), event(100, "stop"), event(124), event(125)];
    const first = selectAudioEvents(events, 90, []);
    expect(first.selected).toEqual([]);
    expect(first.remaining).toEqual(events);
    const second = selectAudioEvents(first.remaining, 110, []);
    expect(second.selected.map(({ event }) => event.at)).toEqual([100]);
    expect(second.remaining.map(event => event.at)).toEqual([125]);
  });

  it("cannot replace committed impacts, including impacts in a later batch's future", () => {
    expect(selectedTimes([event(75, "stop"), event(100, "stop"), event(125)], [event(100)])).toEqual([75, 125]);
    expect(selectedTimes([event(76, "stop"), event(124)], [event(100)])).toEqual([]);
  });

  it("filters missed starts before deciding stop priority", () => {
    const events = [event(100, "stop"), event(110), event(120, "stop"), event(145)];
    const result = selectAudioEvents(events, Infinity, [], event => event.start >= 85);
    expect(result.selected.map(({ event }) => event.at)).toEqual([120, 145]);
  });

  it("allows the eighth voice but excludes a ninth overlapping interval", () => {
    // The impact happened earlier, but its playback/fade tail overlaps this sample.
    const tail = { at: 0, start: 0, end: 120 };
    expect(selectedTimes([event(100)], Array(7).fill(tail))).toEqual([100]);
    expect(selectedTimes([event(100)], Array(8).fill(tail))).toEqual([]);
  });

  it("counts future reservations and an 8ms cancellation tail by interval", () => {
    const candidate = { ...event(100), start: 100, end: 150 };
    const active = Array.from({ length: 7 }, (_, index) => ({ at: -index * 25, start: 90, end: 160 }));
    const fading = { at: -300, start: 50, end: 108 };
    expect(audioDensity(candidate, [...active, fading])).toBe(9);
    expect(selectAudioEvents([candidate], Infinity, [...active, fading]).selected).toEqual([]);
    expect(audioDensity({ ...candidate, start: 108 }, [...active, fading])).toBe(8);
  });

  it("uses peak simultaneous overlap, not the number of all intersecting samples", () => {
    const candidate = { at: 100, start: 0, end: 200 };
    const sequential = Array.from({ length: 20 }, (_, i) => ({ at: i * 10, start: i * 10, end: i * 10 + 10 }));
    expect(audioDensity(candidate, sequential)).toBe(2);
  });

  it("retains untouched future events even if they are not currently eligible", () => {
    const events = [event(300)];
    expect(selectAudioEvents(events, 90, [], () => false)).toEqual({ selected: [], remaining: events });
  });

  it("only discards neighbours after a winner has actually been committed", () => {
    const attempted: number[] = [];
    const result = selectAudioEvents([event(100), event(110), event(135)], Infinity, [], undefined,
      candidate => { attempted.push(candidate.at); return candidate.at !== 100; });
    expect(attempted).toEqual([100, 110, 135]);
    expect(result.selected.map(({ event }) => event.at)).toEqual([110, 135]);
    expect(result.remaining).toEqual([]);
  });

  it("reconsiders an earlier viable flip when its preferred stop cannot be committed", () => {
    const attempted: number[] = [];
    const result = selectAudioEvents([event(100), event(110, "stop"), event(120), event(145)], Infinity, [], undefined,
      candidate => { attempted.push(candidate.at); return candidate.at !== 110; });
    expect(attempted).toEqual([110, 100, 145]);
    expect(result.selected.map(({ event }) => event.at)).toEqual([100, 145]);
  });

  it("refreshes validity after a failed commit and preserves later viable neighbours", () => {
    let now = 70;
    const attempted: number[] = [];
    const result = selectAudioEvents([event(100), event(110, "stop"), event(120), event(145)], Infinity, [],
      candidate => candidate.start >= now,
      candidate => {
        attempted.push(candidate.at);
        if (candidate.at === 110) { now = 85; return false; }
        return true;
      });
    expect(attempted).toEqual([110, 120, 145]);
    expect(result.selected.map(({ event }) => event.at)).toEqual([120, 145]);
  });

  it("terminates when every commit fails and retains untouched future events", () => {
    const events = [event(100), event(110, "stop"), event(120), event(700)];
    const commit = vi.fn(() => false);
    const result = selectAudioEvents(events, 500, [], undefined, commit);
    expect(commit.mock.calls).toHaveLength(3);
    expect(result.selected).toEqual([]);
    expect(result.remaining).toEqual([events[3]]);
  });

  it("never tries to commit a priority winner beyond the 500ms horizon", () => {
    const events = [event(495), event(510, "stop"), event(535)];
    const commit = vi.fn(() => true);
    const result = selectAudioEvents(events, 500, [], undefined, commit);
    expect(commit).not.toHaveBeenCalled();
    expect(result.remaining).toEqual(events);
    const next = selectAudioEvents(result.remaining, 520, [], undefined, commit);
    expect(next.selected.map(({ event }) => event.at)).toEqual([510]);
    expect(next.remaining).toEqual([events[2]]);
  });
});
