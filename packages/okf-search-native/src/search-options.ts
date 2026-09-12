import type {
  SearchBoost as NativeSearchBoost,
  SearchOptions as NativeSearchOptions,
  SearchWhere as NativeSearchWhere,
} from "../native.cjs";

const PUBLIC_FIELDS = [
  "resource",
  "title",
  "heading",
  "description",
  "tags",
  "type",
  "sources",
  "body",
] as const;

type PublicField = typeof PUBLIC_FIELDS[number];

const FILTER_NAMES = [
  "types",
  "tagsAny",
  "statuses",
  "trustTiers",
  "stale",
  "conformance",
] as const;

type FilterName = typeof FILTER_NAMES[number];

type SearchOptionsInput = {
  readonly limit?: unknown;
  readonly where?: unknown;
  readonly asOf?: unknown;
  readonly match?: unknown;
  readonly fields?: unknown;
  readonly boost?: unknown;
  readonly fuzzy?: unknown;
};

/**
 * Validate the friendly root options and create a detached native DTO.
 *
 * Top-level unknown properties are intentionally not enumerated. Native's
 * prepared API remains strict; only this root ingress accepts extra caller
 * properties.
 */
export function sanitizeSearchOptions(
  options: SearchOptionsInput = {},
): NativeSearchOptions {
  const asOfValue = options.asOf;
  const asOf = validateAsOf(asOfValue);

  const limitValue = options.limit;
  const limit = validateLimit(limitValue);

  const matchValue = options.match;
  const match = validateMatch(matchValue);

  const fieldsValue = options.fields;
  const fields = validateFields(fieldsValue);

  const fuzzyValue = options.fuzzy;
  const fuzzy = validateFuzzy(fuzzyValue);

  const whereValue = options.where;
  const where = validateWhere(whereValue);

  const boostValue = options.boost;
  const boost = validateBoost(boostValue);

  const native: NativeSearchOptions = {};

  if (limitValue !== undefined) {
    native.limit = limit;
  }

  if (where !== undefined) {
    native.where = where;
  }

  if (asOf !== undefined) {
    native.asOf = asOf;
  }

  if (match !== undefined) {
    native.match = match;
  }

  if (fields !== undefined) {
    native.fields = fields;
  }

  if (boost !== undefined) {
    native.boost = boost;
  }

  if (fuzzy !== undefined) {
    native.fuzzy = fuzzy;
  }

  return native;
}

function validateAsOf(value: unknown): Date | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!(value instanceof Date)) {
    throw new TypeError(
      "options.asOf must be a valid Date",
    );
  }

  const time = value.getTime();

  if (Number.isNaN(time)) {
    throw new TypeError(
      "options.asOf must be a valid Date",
    );
  }

  return new Date(time);
}

function validateLimit(value: unknown): number {
  const limit = value === undefined ? 10 : value;

  if (
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    throw new TypeError(
      "options.limit must be a finite non-negative integer",
    );
  }

  return limit;
}

function validateMatch(
  value: unknown,
): "any" | "all" | undefined {
  if (
    value !== undefined &&
    value !== "any" &&
    value !== "all"
  ) {
    throw new TypeError(
      'options.match must be "any" or "all"',
    );
  }

  return value as "any" | "all" | undefined;
}

function validateFields(
  value: unknown,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      "options.fields must be a non-empty array",
    );
  }

  const fields: string[] = [];

  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(
        "options.fields must contain only valid OkfSearchField values",
      );
    }

    const field = value[index];

    if (
      typeof field !== "string" ||
      !PUBLIC_FIELDS.includes(field as PublicField)
    ) {
      throw new TypeError(
        "options.fields must contain only valid OkfSearchField values",
      );
    }

    fields.push(field);
  }

  return fields;
}

function validateFuzzy(
  value: unknown,
): boolean | number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === true || value === false) {
    return value;
  }

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new TypeError(
      "options.fuzzy must be a boolean or a finite number between 0 and 1, inclusive",
    );
  }

  return value;
}

function validateWhere(
  value: unknown,
): NativeSearchWhere | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "options.where must be an object",
    );
  }

  const object = value as Record<string, unknown>;

  validateOwnEnumerableKeys(
    object,
    FILTER_NAMES,
    "options.where must contain only valid filter names",
  );

  const where: NativeSearchWhere = {};

  if (Object.hasOwn(object, "types")) {
    where.types = validateFilterArray(
      object.types,
      "types",
      (entry): entry is string =>
        typeof entry === "string",
      "options.where.types must contain only strings",
    );
  }

  if (Object.hasOwn(object, "tagsAny")) {
    where.tagsAny = validateFilterArray(
      object.tagsAny,
      "tagsAny",
      (entry): entry is string =>
        typeof entry === "string",
      "options.where.tagsAny must contain only strings",
    );
  }

  if (Object.hasOwn(object, "statuses")) {
    where.statuses = validateFilterArray(
      object.statuses,
      "statuses",
      isOkfStatus,
      "options.where.statuses must contain only valid OkfStatus values",
    );
  }

  if (Object.hasOwn(object, "trustTiers")) {
    where.trustTiers = validateFilterArray(
      object.trustTiers,
      "trustTiers",
      isOkfTrustTier,
      "options.where.trustTiers must contain only valid OkfTrustTier values",
    );
  }

  if (Object.hasOwn(object, "stale")) {
    const stale = object.stale;

    if (typeof stale !== "boolean") {
      throw new TypeError(
        "options.where.stale must be a boolean",
      );
    }

    where.stale = stale;
  }

  if (Object.hasOwn(object, "conformance")) {
    where.conformance = validateFilterArray(
      object.conformance,
      "conformance",
      isOkfConformance,
      "options.where.conformance must contain only valid OkfConformance values",
    );
  }

  return where;
}

function validateBoost(
  value: unknown,
): NativeSearchBoost | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "options.boost must be an object",
    );
  }

  const object = value as Record<string, unknown>;

  validateOwnEnumerableKeys(
    object,
    PUBLIC_FIELDS,
    "options.boost must contain only valid OkfSearchField keys",
  );

  const boost: NativeSearchBoost = {};

  for (const field of PUBLIC_FIELDS) {
    if (!Object.hasOwn(object, field)) {
      continue;
    }

    const fieldValue = object[field];

    if (
      typeof fieldValue !== "number" ||
      !Number.isFinite(fieldValue) ||
      fieldValue < 0.1 ||
      fieldValue > 10
    ) {
      throw new TypeError(
        `options.boost.${field} must be a finite number between 0.1 and 10, inclusive`,
      );
    }

    boost[field] = fieldValue;
  }

  return boost;
}

function validateOwnEnumerableKeys(
  value: object,
  allowed: readonly string[],
  message: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (
      Object.prototype.propertyIsEnumerable.call(value, key) &&
      (
        typeof key !== "string" ||
        !allowed.includes(key)
      )
    ) {
      throw new TypeError(message);
    }
  }
}

function validateFilterArray<T>(
  value: unknown,
  field: FilterName,
  isValidEntry: (entry: unknown) => entry is T,
  invalidEntryMessage: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `options.where.${field} must be an array`,
    );
  }

  const validated: T[] = [];

  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(invalidEntryMessage);
    }

    const entry = value[index];

    if (!isValidEntry(entry)) {
      throw new TypeError(invalidEntryMessage);
    }

    validated.push(entry);
  }

  return validated;
}

function isOkfConformance(value: unknown): value is "strict" | "degraded" {
  return value === "strict" || value === "degraded";
}
function isOkfStatus(value: unknown): value is "draft" | "stable" | "deprecated" {
  return value === "draft" || value === "stable" || value === "deprecated";
}
function isOkfTrustTier(value: unknown): value is "unverified" | "machine-confirmed" | "human-reviewed" {
  return value === "unverified" || value === "machine-confirmed" || value === "human-reviewed";
}
