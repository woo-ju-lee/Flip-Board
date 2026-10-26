import { useLayoutEffect, useState } from "react";
import type { Train } from "../types";

type Row = { train: Train; exiting: boolean };

/** Preserve departing rows only for a short, non-interactive mechanical fade. */
export function useRowPresence(
  trains: Train[],
  context: string,
  reduced: boolean,
) {
  const [state, setState] = useState<{ context: string; rows: Row[] }>({
    context,
    rows: trains.map((train) => ({ train, exiting: false })),
  });
  const signature = trains.map((t) => t.id).join("|");
  useLayoutEffect(() => {
    const active = trains.map((train) => ({ train, exiting: false }));
    setState((previous) => {
      if (previous.context !== context || reduced)
        return { context, rows: active };
      const ids = new Set(trains.map((t) => t.id));
      const next = [...active];
      previous.rows.forEach((row, index) => {
        if (!ids.has(row.train.id))
          next.splice(Math.min(index, next.length), 0, {
            ...row,
            exiting: true,
          });
      });
      return { context, rows: next };
    });
    const timer = window.setTimeout(
      () => {
        setState((current) => ({
          ...current,
          rows: current.rows.filter((row) => !row.exiting),
        }));
      },
      reduced ? 0 : 220,
    );
    return () => clearTimeout(timer);
    // Identity changes control presence; field updates are taken from the current DTO below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, context, reduced]);
  if (state.context !== context)
    return trains.map((train) => ({ train, exiting: false }));
  const current = new Map(trains.map((train) => [train.id, train]));
  return state.rows.map((row) => ({
    ...row,
    train: current.get(row.train.id) ?? row.train,
  }));
}
