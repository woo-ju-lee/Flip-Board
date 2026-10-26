import { describe, expect, it } from "vitest";
import { FLAP_MS, makeFlapPlan, previewEvents, soundEvents } from "../flapMotion";

describe("shared mechanical timeline", () => {
  it("turns 6–12 leaves, lands on the target, and puts each impact on its landing", () => {
    const starts = new Set<number>();
    const ends = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const plan = makeFlapPlan("1", "7", `cell-${i}`, 1000);
      expect(plan.steps.length).toBeGreaterThanOrEqual(6);
      expect(plan.steps.length).toBeLessThanOrEqual(12);
      expect(plan.steps[0].from).toBe("1");
      expect(plan.steps.at(-1)?.to).toBe("7");
      expect(plan.endAt).toBe(plan.steps.at(-1)?.landAt);
      starts.add(plan.steps[0].at); ends.add(plan.endAt);
      plan.steps.forEach((step, n) => {
        expect(step.landAt - step.at).toBe(FLAP_MS);
        if (n) expect(step.at).toBe(plan.steps[n - 1].landAt);
      });
      const audio = soundEvents(plan, 2);
      expect(audio[0]).toMatchObject({ kind: "roll", at: plan.steps[0].at });
      expect(audio.slice(1).map(e => e.at)).toEqual(plan.steps.map(s => s.landAt));
      expect(audio.at(-1)?.kind).toBe("stop");
      expect(audio.every(e => e.pan === .85)).toBe(true);
    }
    expect(starts.size).toBeGreaterThan(20);
    expect(ends.size).toBeGreaterThan(20);
  });

  it.each([["8", /^[ 0-9]$/u], ["R", /^[ A-Z]$/u], ["울", /^[가-힣]$/u]])(
    "uses the appropriate rotor for %s", (target, alphabet) => {
      const plan = makeFlapPlan(" ", target as string, "cell", 0);
      for (const step of plan.steps) expect(step.to).toMatch(alphabet as RegExp);
    },
  );

  it("does not schedule movement or sound for unchanged values", () => {
    const plan = makeFlapPlan("서", "서", "cell", 1000);
    expect(plan.steps).toEqual([]);
    expect(soundEvents(plan, 0)).toEqual([]);
    expect(previewEvents(0).every(event => event.at < 2400)).toBe(true);
  });
});
