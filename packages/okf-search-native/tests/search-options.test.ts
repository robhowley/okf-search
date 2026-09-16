import {
  describe,
  expect,
  it,
} from "vitest";

import { sanitizeSearchOptions } from "../src/search-options.js";

type SearchOptionsInput =
  Parameters<typeof sanitizeSearchOptions>[0];

function options(value: unknown): SearchOptionsInput {
  return value as SearchOptionsInput;
}

function expectTypeError(
  value: unknown,
  message: string,
): void {
  expect(() => sanitizeSearchOptions(options(value)))
    .toThrowError(new TypeError(message));
}

describe("friendly search option sanitization", () => {
  it("returns a fresh known-key DTO and clones nested values", () => {
    const asOf = new Date("2026-08-24T12:00:00Z");
    const fields = ["title", "body", "body"];
    const where = {
      types: ["note"],
      tagsAny: ["memory"],
      statuses: ["stable"],
      trustTiers: ["human-reviewed"],
      stale: false,
      conformance: ["strict"],
    };
    const boost = {
      title: 2,
      body: 0.5,
    };
    const input = Object.freeze({
      limit: 3,
      snippetLength: 128,
      asOf,
      match: "all",
      fields: Object.freeze(fields),
      fuzzy: true,
      where: Object.freeze({
        ...where,
        types: Object.freeze(where.types),
        tagsAny: Object.freeze(where.tagsAny),
        statuses: Object.freeze(where.statuses),
        trustTiers: Object.freeze(where.trustTiers),
        conformance: Object.freeze(where.conformance),
      }),
      boost: Object.freeze(boost),
      ignored: "not sent to native",
    });

    const dto = sanitizeSearchOptions(input);

    expect(Object.keys(dto)).toEqual([
      "limit",
      "snippetLength",
      "where",
      "asOf",
      "match",
      "fields",
      "boost",
      "fuzzy",
    ]);
    expect(dto).toEqual({
      limit: 3,
      snippetLength: 128,
      where,
      asOf,
      match: "all",
      fields,
      boost,
      fuzzy: true,
    });

    expect(dto).not.toBe(input);
    expect(dto.asOf).not.toBe(asOf);
    expect(dto.fields).not.toBe(fields);
    expect(dto.where).not.toBe(input.where);
    expect(dto.where?.types).not.toBe(where.types);
    expect(dto.where?.tagsAny).not.toBe(where.tagsAny);
    expect(dto.where?.statuses).not.toBe(where.statuses);
    expect(dto.where?.trustTiers).not.toBe(where.trustTiers);
    expect(dto.where?.conformance).not.toBe(where.conformance);
    expect(dto.boost).not.toBe(boost);

    dto.fields?.push("resource");
    dto.where?.types?.push("recipe");
    dto.boost!.title = 10;
    dto.asOf!.setTime(0);

    expect(input).toEqual({
      limit: 3,
      snippetLength: 128,
      asOf,
      match: "all",
      fields,
      fuzzy: true,
      where: {
        ...where,
        types: ["note"],
        tagsAny: ["memory"],
        statuses: ["stable"],
        trustTiers: ["human-reviewed"],
        conformance: ["strict"],
      },
      boost,
      ignored: "not sent to native",
    });
  });

  it("omits absent values while preserving explicit false and zero", () => {
    expect(sanitizeSearchOptions()).toEqual({});
    expect(sanitizeSearchOptions(options({
      limit: 0,
      fuzzy: false,
    }))).toEqual({
      limit: 0,
      fuzzy: false,
    });

    expect(sanitizeSearchOptions(options({
      limit: undefined,
      snippetLength: undefined,
      asOf: null,
      match: undefined,
      fields: undefined,
      fuzzy: undefined,
      where: undefined,
      boost: undefined,
    }))).toEqual({});
  });

  it("ignores unknown top-level keys without reading them", () => {
    const unknownSymbol = Symbol("unknown");
    const optionsWithUnknowns: Record<PropertyKey, unknown> = {
      limit: 1,
    };

    Object.defineProperty(optionsWithUnknowns, "ignored", {
      enumerable: true,
      get() {
        throw new Error("unknown top-level getter was read");
      },
    });
    Object.defineProperty(optionsWithUnknowns, unknownSymbol, {
      enumerable: true,
      get() {
        throw new Error("unknown top-level symbol getter was read");
      },
    });
    Object.defineProperty(optionsWithUnknowns, "hidden", {
      value: "ignored",
      enumerable: false,
    });

    expect(sanitizeSearchOptions(options(optionsWithUnknowns)))
      .toEqual({ limit: 1 });

    const invalidWithUnknown = Object.defineProperty({
      match: "invalid",
    }, "ignored", {
      enumerable: true,
      get() {
        throw new Error("unknown top-level getter was read");
      },
    });

    expectTypeError(invalidWithUnknown,
      'options.match must be "any" or "all"');
  });

  it("reads inherited known top-level values", () => {
    const inherited = Object.assign(Object.create({
      match: "all",
      ignored: "not read",
    }), {
      limit: 2,
    });

    expect(sanitizeSearchOptions(options(inherited))).toEqual({
      limit: 2,
      match: "all",
    });
  });

  describe("limit", () => {
    it("accepts zero, positive integers, and the omitted default", () => {
      expect(sanitizeSearchOptions(options({ limit: 0 })))
        .toEqual({ limit: 0 });
      expect(sanitizeSearchOptions(options({ limit: 12 })))
        .toEqual({ limit: 12 });
      expect(sanitizeSearchOptions()).toEqual({});
    });

    it("rejects non-finite, fractional, negative, and non-number values", () => {
      const invalid: unknown[] = [
        null,
        "1",
        true,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -1,
        1.5,
        1n,
        {},
        [],
      ];

      for (const limit of invalid) {
        expectTypeError({ limit },
          "options.limit must be a finite non-negative integer");
      }
    });
  });

  describe("snippetLength", () => {
    it("accepts positive safe integers and omits the default", () => {
      expect(sanitizeSearchOptions(options({ snippetLength: 1 })))
        .toEqual({ snippetLength: 1 });
      expect(sanitizeSearchOptions(options({
        snippetLength: Number.MAX_SAFE_INTEGER,
      }))).toEqual({ snippetLength: Number.MAX_SAFE_INTEGER });
      expect(sanitizeSearchOptions()).toEqual({});
    });

    it("rejects non-positive, non-integer, non-finite, and non-number values", () => {
      for (const snippetLength of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        null,
        "1",
        true,
        1n,
        {},
        [],
      ]) {
        expectTypeError({ snippetLength },
          "options.snippetLength must be a finite positive integer");
      }
    });
  });

  describe("asOf", () => {
    it("accepts valid dates by value and treats null as omitted", () => {
      const asOf = new Date("2026-08-24T12:00:00Z");
      const dto = sanitizeSearchOptions(options({ asOf }));

      expect(dto.asOf).toEqual(asOf);
      expect(dto.asOf).not.toBe(asOf);
      expect(sanitizeSearchOptions(options({ asOf: null })))
        .toEqual({});
    });

    it("rejects non-Date and invalid Date values", () => {
      for (const asOf of [
        "2026-08-24T12:00:00Z",
        0,
        {},
        new Date(Number.NaN),
      ]) {
        expectTypeError({ asOf },
          "options.asOf must be a valid Date");
      }
    });
  });

  describe("match, fields, and fuzzy", () => {
    it("accepts match modes, public fields, and fuzzy endpoints", () => {
      const fields = [
        "resource",
        "title",
        "heading",
        "description",
        "tags",
        "type",
        "sources",
        "body",
      ];

      expect(sanitizeSearchOptions(options({
        match: "any",
        fields,
        fuzzy: 0,
      }))).toEqual({
        match: "any",
        fields,
        fuzzy: 0,
      });
      expect(sanitizeSearchOptions(options({
        match: "all",
        fields: ["body"],
        fuzzy: 1,
      }))).toEqual({
        match: "all",
        fields: ["body"],
        fuzzy: 1,
      });
    });

    it("rejects invalid match values", () => {
      for (const match of [null, "sometimes", true, 1]) {
        expectTypeError({ match },
          'options.match must be "any" or "all"');
      }
    });

    it("rejects empty, malformed, sparse, and unknown fields", () => {
      for (const fields of [[], null, "body", {}]) {
        expectTypeError({ fields },
          "options.fields must be a non-empty array");
      }

      const sparse = new Array(1);
      for (const fields of [
        sparse,
        ["body", "headingPath"],
        ["unknown"],
        ["body", undefined],
      ]) {
        expectTypeError({ fields },
          "options.fields must contain only valid OkfSearchField values");
      }
    });

    it("rejects invalid fuzzy values", () => {
      for (const fuzzy of [
        -1,
        1.01,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        "true",
        null,
        {},
        [],
      ]) {
        expectTypeError({ fuzzy },
          "options.fuzzy must be a boolean or a finite number between 0 and 1, inclusive");
      }
    });
  });

  describe("where", () => {
    it("accepts every filter, empty arrays, both stale values, and clones them", () => {
      const where = {
        types: [],
        tagsAny: ["memory"],
        statuses: ["draft", "stable", "deprecated"],
        trustTiers: [
          "unverified",
          "machine-confirmed",
          "human-reviewed",
        ],
        stale: true,
        conformance: ["strict", "degraded"],
      };
      const dto = sanitizeSearchOptions(options({ where }));

      expect(dto).toEqual({ where });
      expect(dto.where).not.toBe(where);
      expect(dto.where?.types).not.toBe(where.types);
      expect(dto.where?.tagsAny).not.toBe(where.tagsAny);
      expect(dto.where?.statuses).not.toBe(where.statuses);
      expect(dto.where?.trustTiers).not.toBe(where.trustTiers);
      expect(dto.where?.conformance).not.toBe(where.conformance);

      for (const stale of [false, true]) {
        expect(sanitizeSearchOptions(options({
          where: { stale },
        }))).toEqual({ where: { stale } });
      }
    });

    it("accepts an empty filter object", () => {
      expect(sanitizeSearchOptions(options({ where: {} })))
        .toEqual({ where: {} });
    });

    it("rejects malformed containers and unknown nested keys", () => {
      const unknownSymbol = Symbol("unknown");
      const symbolWhere = { [unknownSymbol]: [] };
      const cases: Array<[unknown, string]> = [
        [null, "options.where must be an object"],
        [[], "options.where must be an object"],
        ["types", "options.where must be an object"],
        [42, "options.where must be an object"],
        [true, "options.where must be an object"],
        [{ unknown: [] },
          "options.where must contain only valid filter names"],
        [{ unknown: true, types: "not-an-array" },
          "options.where must contain only valid filter names"],
        [symbolWhere,
          "options.where must contain only valid filter names"],
        [{ types: undefined },
          "options.where.types must be an array"],
        [{ tagsAny: "tag" },
          "options.where.tagsAny must be an array"],
        [{ statuses: null },
          "options.where.statuses must be an array"],
        [{ trustTiers: {} },
          "options.where.trustTiers must be an array"],
        [{ conformance: "strict" },
          "options.where.conformance must be an array"],
      ];

      for (const [where, message] of cases) {
        expectTypeError({ where }, message);
      }
    });

    it("rejects invalid filter entries and stale values", () => {
      const cases: Array<[unknown, string]> = [
        [{ types: ["note", 1] },
          "options.where.types must contain only strings"],
        [{ tagsAny: ["tag", false] },
          "options.where.tagsAny must contain only strings"],
        [{ statuses: ["pending"] },
          "options.where.statuses must contain only valid OkfStatus values"],
        [{ trustTiers: ["manual"] },
          "options.where.trustTiers must contain only valid OkfTrustTier values"],
        [{ conformance: ["unknown"] },
          "options.where.conformance must contain only valid OkfConformance values"],
        [{ stale: undefined },
          "options.where.stale must be a boolean"],
        [{ stale: null },
          "options.where.stale must be a boolean"],
        [{ stale: "false" },
          "options.where.stale must be a boolean"],
        [{ stale: 0 },
          "options.where.stale must be a boolean"],
      ];

      for (const [where, message] of cases) {
        expectTypeError({ where }, message);
      }

      const sparseCases: Array<[unknown, string]> = [
        [{ types: new Array(1) },
          "options.where.types must contain only strings"],
        [{ tagsAny: new Array(1) },
          "options.where.tagsAny must contain only strings"],
        [{ statuses: new Array(1) },
          "options.where.statuses must contain only valid OkfStatus values"],
        [{ trustTiers: new Array(1) },
          "options.where.trustTiers must contain only valid OkfTrustTier values"],
        [{ conformance: new Array(1) },
          "options.where.conformance must contain only valid OkfConformance values"],
      ];

      for (const [where, message] of sparseCases) {
        expectTypeError({ where }, message);
      }
    });
  });

  describe("boost", () => {
    it("accepts every public field, endpoints, and an empty object", () => {
      const boost = {
        resource: 0.1,
        title: 10,
        heading: 1,
        description: 2,
        tags: 3,
        type: 4,
        sources: 5,
        body: 6,
      };

      expect(sanitizeSearchOptions(options({ boost }))).toEqual({ boost });
      expect(sanitizeSearchOptions(options({ boost: {} })))
        .toEqual({ boost: {} });
    });

    it("rejects malformed containers and unknown nested keys", () => {
      const unknownSymbol = Symbol("unknown");
      const malformed: unknown[] = [
        null,
        [],
        () => undefined,
        "object",
        1,
        1n,
        true,
        unknownSymbol,
      ];

      for (const boost of malformed) {
        expectTypeError({ boost },
          "options.boost must be an object");
      }

      for (const boost of [
        { unknown: 1 },
        { unknown: 2, title: 0 },
        { headingPath: 1 },
        { [unknownSymbol]: 1 },
      ]) {
        expectTypeError({ boost },
          "options.boost must contain only valid OkfSearchField keys");
      }
    });

    it("rejects invalid values and accepts non-enumerable known fields", () => {
      const invalid: unknown[] = [
        0,
        -1,
        0.09,
        10.01,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        "1",
        new Number(1),
        null,
        true,
        1n,
        [],
        {},
        () => 1,
        undefined,
      ];

      for (const title of invalid) {
        expectTypeError({ boost: { title } },
          "options.boost.title must be a finite number between 0.1 and 10, inclusive");
      }

      const boost = {};
      Object.defineProperty(boost, "title", {
        value: 0.1,
        enumerable: false,
      });
      Object.defineProperty(boost, "ignored", {
        value: true,
        enumerable: false,
      });

      expect(sanitizeSearchOptions(options({ boost }))).toEqual({
        boost: { title: 0.1 },
      });
    });
  });

  it("keeps validation precedence before any caller early return", () => {
    expectTypeError({
      asOf: new Date(Number.NaN),
      limit: -1,
      match: "invalid",
    }, "options.asOf must be a valid Date");
    expectTypeError({
      limit: -1,
      match: "invalid",
      fields: [],
    }, "options.limit must be a finite non-negative integer");
    expectTypeError({
      match: "invalid",
      fields: [],
      fuzzy: "true",
    }, 'options.match must be "any" or "all"');
    expectTypeError({
      fields: [],
      fuzzy: "true",
    }, "options.fields must be a non-empty array");
    expectTypeError({
      fuzzy: "true",
      where: null,
      boost: null,
    }, "options.fuzzy must be a boolean or a finite number between 0 and 1, inclusive");
    expectTypeError({
      where: { types: "note" },
      boost: null,
    }, "options.where.types must be an array");
    expectTypeError({
      boost: { title: 0 },
    }, "options.boost.title must be a finite number between 0.1 and 10, inclusive");
  });
});
