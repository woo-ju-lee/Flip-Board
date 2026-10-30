import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlapRendererProvider } from "../components/FlapRendererProvider";
import { SplitFlap } from "../components/SplitFlap";

let animateDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  if (animateDescriptor) Object.defineProperty(Element.prototype, "animate", animateDescriptor);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

const digits = <SplitFlap text="82" length={2} reduced indexedDigits />;

describe("shared renderer selection", () => {
  it("uses reusable character faces by default without changing displayed values", () => {
    const { container } = render(<FlapRendererProvider>{digits}</FlapRendererProvider>);
    expect(container.querySelectorAll(".flap-optimized")).toHaveLength(2);
    expect([...container.querySelectorAll(".flap > .flap-top > span")].map(node => node.textContent)).toEqual(["8", "2"]);
    expect(container.querySelectorAll(".flap-motion")).toHaveLength(2);
    expect(container.querySelectorAll('[data-flipping="true"]')).toHaveLength(0);
  });

  it("keeps the explicit legacy comparison even inside the optimized app provider", () => {
    const { container } = render(
      <FlapRendererProvider>
        <FlapRendererProvider renderer="legacy">{digits}</FlapRendererProvider>
      </FlapRendererProvider>,
    );
    expect(container.querySelectorAll(".flap")).toHaveLength(2);
    expect(container.querySelectorAll(".flap-optimized, .flap-motion")).toHaveLength(0);
    expect([...container.querySelectorAll(".flap > .flap-top > span")].map(node => node.textContent)).toEqual(["8", "2"]);
  });

  it("falls back to the legacy renderer when Web Animations is unavailable", () => {
    Reflect.deleteProperty(Element.prototype, "animate");
    const { container } = render(<FlapRendererProvider>{digits}</FlapRendererProvider>);
    expect(container.querySelectorAll(".flap")).toHaveLength(2);
    expect(container.querySelectorAll(".flap-optimized")).toHaveLength(0);
    expect(container.querySelector('[aria-label="82"]')).toBeInTheDocument();
  });
});
