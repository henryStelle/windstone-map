import { describe, expect, it } from "vitest";
import { nearestNode, type TrailNode } from "./graph";

describe("nearestNode", () => {
  const nodes: TrailNode[] = [
    { id: "near", coordinate: [10, 10] },
    { id: "far", coordinate: [100, 100] },
  ];

  it("snaps inside the pixel threshold", () => {
    expect(
      nearestNode(nodes, ([x, y]) => ({ x, y }), { x: 13, y: 12 }, 5)?.id,
    ).toBe("near");
  });

  it("does not snap outside the pixel threshold", () => {
    expect(
      nearestNode(nodes, ([x, y]) => ({ x, y }), { x: 20, y: 20 }, 5),
    ).toBeUndefined();
  });
});
