import { memo, useEffect, useRef, useState } from "react";
import { flapAudio } from "../audio";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = () => setReduced(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return reduced;
}

const ROTOR = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const FlapCharacter = memo(function FlapCharacter({
  value,
  index,
  reduced,
}: {
  value: string;
  index: number;
  reduced: boolean;
}) {
  const settled = useRef(" ");
  const [frame, setFrame] = useState({
    from: " ",
    to: " ",
    active: false,
    serial: 0,
  });
  useEffect(() => {
    if (reduced) {
      settled.current = value;
      setFrame((f) => ({
        from: value,
        to: value,
        active: false,
        serial: f.serial,
      }));
      return;
    }
    if (settled.current === value) {
      setFrame((f) =>
        f.active || f.to !== value
          ? { from: value, to: value, active: false, serial: f.serial }
          : f,
      );
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const intermediate = value.trim()
      ? [ROTOR[(value.codePointAt(0)! + index) % ROTOR.length], value]
      : [value];
    let from = settled.current;
    intermediate.forEach((to, step) => {
      const before = from;
      timers.push(
        setTimeout(
          () => {
            setFrame((f) => ({
              from: before,
              to,
              active: true,
              serial: f.serial + 1,
            }));
            flapAudio.click();
          },
          (index % 6) * 14 + step * 160,
        ),
      );
      timers.push(
        setTimeout(
          () => {
            settled.current = to;
            setFrame((f) => ({
              from: to,
              to,
              active: false,
              serial: f.serial,
            }));
          },
          (index % 6) * 14 + step * 160 + 150,
        ),
      );
      from = to;
    });
    return () => timers.forEach(clearTimeout);
  }, [value, reduced, index]);
  return (
    <span
      className="flap"
      aria-hidden="true"
      data-flipping={frame.active ? "true" : "false"}
      data-value={value}
    >
      <span className="flap-half flap-top">
        <span>{frame.to}</span>
      </span>
      <span className="flap-half flap-bottom">
        <span>{frame.active ? frame.from : frame.to}</span>
      </span>
      {frame.active && (
        <span key={frame.serial} className="flap-motion">
          <span className="flap-half flap-top flap-out">
            <span>{frame.from}</span>
          </span>
          <span className="flap-half flap-bottom flap-in">
            <span>{frame.to}</span>
          </span>
        </span>
      )}
      <span className="flap-seam" />
    </span>
  );
});

export const SplitFlap = memo(function SplitFlap({
  text,
  length,
  className = "",
  reduced,
}: {
  text: string;
  length: number;
  className?: string;
  reduced: boolean;
}) {
  const chars = Array.from(text);
  const fitted =
    chars.length > length
      ? [...chars.slice(0, length - 1), "…"]
      : [...chars, ...Array(Math.max(0, length - chars.length)).fill(" ")];
  return (
    <span
      className={`flap-word ${className}`}
      aria-label={text || "빈칸"}
      title={text}
    >
      {fitted.map((char, index) => (
        <FlapCharacter
          key={index}
          value={char}
          index={index}
          reduced={reduced}
        />
      ))}
    </span>
  );
});
