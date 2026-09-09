import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as nodeApi from "../src/node.ts";
import * as rootApi from "../src/index.ts";
import { captureOracle } from "../scripts/oracle-fixtures.mjs";
import {
  byteDifference,
  encodeStructural,
} from "../scripts/typed-structural-encoder.mjs";

describe("Phase 0 JavaScript oracle", () => {
  it("matches the checked-in typed fixture in ten shuffled runs", async () => {
    const expected = await readFile(
      new URL("./fixtures/oracle-v1.typed", import.meta.url),
    );

    for (let run = 0; run < 10; run += 1) {
      const actual = encodeStructural(await captureOracle(rootApi, nodeApi, run));
      expect(byteDifference(expected, actual), `structural run ${run + 1}`)
        .toBeUndefined();
    }
  });

  it("preserves graph, property, numeric, string, and branded-value distinctions", () => {
    const shared = {};
    const cycle = { shared };
    cycle.self = cycle;

    const values = [
      [{}, { value: undefined }],
      [[undefined], Array(1)],
      [0, -0],
      [Infinity, -Infinity],
      [Number.NaN, null],
      ["\uD800", "\uFFFD"],
      [{ first: 1, second: 2 }, { second: 2, first: 1 }],
      [{ first: shared, second: shared }, { first: {}, second: {} }],
      [cycle, { shared: {}, self: {} }],
      [new Map([["key", "value"]]), { key: "value" }],
      [new Set(["value"]), ["value"]],
      [new Date(0), 0],
      [Buffer.from([1, 2]), new Uint8Array([1, 2])],
    ];

    for (const [left, right] of values) {
      expect(encodeStructural(left).equals(encodeStructural(right))).toBe(false);
    }
  });

  it("fails closed on values it cannot represent", () => {
    expect(() => encodeStructural(Symbol("unsupported")))
      .toThrow("Unsupported symbol at $");
    expect(() => encodeStructural(/unsupported/))
      .toThrow("Unsupported RegExp at $");
  });
});
