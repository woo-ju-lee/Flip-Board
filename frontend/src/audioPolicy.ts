import type { FlapSoundEvent } from "./flapMotion";

export const MIN_IMPACT_GAP_MS = 25;
export const MAX_AUDIO_VOICES = 8;
const CLOCK_EPSILON_MS = 1e-7;

/** All times use the caller's one clock, in milliseconds. */
export type AudioInterval = { at: number; start: number; end: number };
export type AudioCandidate = FlapSoundEvent & AudioInterval & { owner: string; order: number };

export function compareAudioEvents(a: AudioCandidate, b: AudioCandidate): number {
  return a.at - b.at || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.order - b.order;
}

/** Peak overlap during this candidate, including already reserved future sound. */
export function audioDensity(candidate: AudioInterval, reservations: readonly AudioInterval[]): number {
  const edges: [number, number][] = [];
  for (const other of reservations) {
    const start = Math.max(candidate.start, other.start);
    const end = Math.min(candidate.end, other.end);
    if (start < end) edges.push([start, 1], [end, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 1, peak = 1;
  for (const [, delta] of edges) peak = Math.max(peak, active += delta);
  return peak;
}

/**
 * Shared by live scheduling and offline preview. The sorted input contains the
 * scheduling window plus a 25ms peek, so a stop just beyond the horizon can win its window.
 * Such a window stays pending until its winner is inside the scheduling horizon.
 * Selection never moves a timestamp or changes an already committed impact.
 * A winner only excludes its neighbours after tryCommit succeeds. A source that
 * misses its deadline during creation must not erase still-viable alternatives.
 */
export function selectAudioEvents<T extends AudioCandidate>(
  events: readonly T[], horizon: number, reservations: readonly AudioInterval[],
  valid: (event: T) => boolean = () => true,
  tryCommit: (event: T, density: number) => boolean = () => true,
): { selected: { event: T; density: number }[]; remaining: T[] } {
  const committed = [...reservations];
  const selected: { event: T; density: number }[] = [];
  const rejected = new Set<number>();
  const eligible = (index: number) => {
    const event = events[index];
    return !rejected.has(index)
      && !committed.some(other => Math.abs(other.at - event.at) < MIN_IMPACT_GAP_MS - CLOCK_EPSILON_MS)
      && valid(event)
      && audioDensity(event, committed) <= MAX_AUDIO_VOICES;
  };
  let index = 0;
  while (index < events.length) {
    const first = events[index];
    if (first.at > horizon) break;
    if (!eligible(index)) { index++; continue; }
    let winnerIndex = index;
    for (let next = index; next < events.length && events[next].at < first.at + MIN_IMPACT_GAP_MS - CLOCK_EPSILON_MS; next++) {
      if (events[next].kind === "stop" && eligible(next)) { winnerIndex = next; break; }
    }
    const winner = events[winnerIndex];
    if (winner.at > horizon) break;
    const density = audioDensity(winner, committed);
    if (!tryCommit(winner, density)) {
      rejected.add(winnerIndex);
      continue;
    }
    selected.push({ event: winner, density });
    committed.push(winner);
    // Includes conflicts after the winner, even across a fixed bucket boundary.
    while (index < events.length && events[index].at < winner.at + MIN_IMPACT_GAP_MS - CLOCK_EPSILON_MS) index++;
  }
  const remaining = events.slice(index);
  return { selected, remaining: rejected.size ? remaining.filter((_, offset) => !rejected.has(index + offset)) : remaining };
}
