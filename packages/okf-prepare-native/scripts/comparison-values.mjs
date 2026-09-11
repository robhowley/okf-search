// Only declared trees are inspected. YAML extensions and graph topology are excluded.
const enumeration = (...values) => (value) => values.includes(value);
const status = enumeration("draft", "stable", "deprecated");
const trust = enumeration("unverified", "machine-confirmed", "human-reviewed");
const diagnostic = { code: enumeration("ERR_OKF_PARSE", "ERR_OKF_FIELD"), message: "string", path: "string", "field?": "string" };
const identity = { path: "string", documentId: "string" };
const section = { id: "string", headingPath: "string", text: "string", startLine: "number", endLine: "number" };
const windowShape = { from: "string", to: "string" };
const extras = {
  sources: [{ resource: "string", "id?": "string", "title?": "string", "author?": "string", "usageCount?": "number", "lastModified?": "string", "usageWindow?": windowShape }],
  "usageWindow?": windowShape, "generated?": { by: "string", "at?": "string" },
  verified: [{ by: "string", at: "string" }], "runtime?": "string",
  "parameters?": [{ name: "string", type: "string", required: "boolean" }],
  "computation?": "string", "executor?": { resource: "string", receipt: ["string"] },
  "attester?": { resource: "string" },
};
const extraKeys = Object.keys(extras).map((key) => key.replace(/\?$/, ""));
const metadata = { title: "string", "description?": "string", "resource?": "string", tags: ["string"], sourceText: "string" };
const stale = { value: "string", epochMillis: "number" };
const jsStaleness = { classified: "boolean", "staleAfter?": "string", "staleAfterEpoch?": "number" };
const nativeFields = { type: "string", ...metadata, ...extras, "status?": status, "trustTier?": trust,
  "staleAfter?": stale, staleness: { classified: "boolean", "staleAfter?": stale } };

function shape(value, schema, path = "$", allowUnknown = false) {
  const fail = () => { throw new Error(`Malformed return at ${path}`); };
  if (typeof schema === "string") { if (typeof value !== schema) fail(); return; }
  if (typeof schema === "function") { if (!schema(value)) fail(); return; }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) fail();
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail();
      shape(value[i], schema[0], `${path}[${i}]`);
    }
    if (Object.keys(value).length !== value.length) fail();
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = new Set();
  for (const [declared, child] of Object.entries(schema)) {
    const optional = declared.endsWith("?");
    const key = optional ? declared.slice(0, -1) : declared;
    keys.add(key);
    if (!Object.hasOwn(value, key)) { if (!optional) fail(); continue; }
    if (optional && value[key] === undefined) continue;
    shape(value[key], child, `${path}.${key}`);
  }
  if (!allowUnknown && Reflect.ownKeys(value).some((key) => !keys.has(key))) fail();
}

export function validateValidation(value) {
  shape(value, { isValid: "boolean", isIndexable: "boolean", errors: [diagnostic] });
  if ((value.isValid && (!value.isIndexable || value.errors.length !== 0))
    || (!value.isValid && value.errors.length === 0)) throw new Error("Malformed validation state");
}

export function validatePreparation(engine, value) {
  if (engine === "native" && value?.kind === "fatal") {
    shape(value, { kind: enumeration("fatal"), diagnostics: [diagnostic] });
    if (!value.diagnostics.length) throw new Error("Malformed fatal state");
    return;
  }
  const common = { identity, conformance: enumeration("strict", "degraded"), diagnostics: [diagnostic], sections: [section] };
  if (engine === "native") {
    shape(value, { kind: enumeration("accepted"), ...common, fields: nativeFields, body: "string", bodyStartLine: "number" });
  } else {
    shape(value, { ...common, type: "string", metadata,
      facets: { status: { classified: "boolean", "value?": status }, trust: { classified: "boolean", "value?": trust }, staleness: jsStaleness },
      ...(value?.conformance === "strict" ? { document: (document) => {
        shape(document, { id: "string", type: "string", title: "string", "description?": "string", "resource?": "string", tags: ["string"], ...extras,
          status, "staleAfter?": "string", body: "string", extensions: (v) => v !== null && typeof v === "object" && !Array.isArray(v) });
        return true;
      } } : {}),
    });
  }
  if (!value.sections.length || (value.conformance === "strict") !== (value.diagnostics.length === 0)) throw new Error("Malformed accepted state");
  if (engine === "js") {
    for (const facet of [value.facets.status, value.facets.trust]) {
      if (facet.classified ? typeof facet.value !== "string" : facet.value !== undefined) throw new Error("Malformed classified facet");
      if (value.conformance === "strict" && !facet.classified) throw new Error("Malformed strict facet");
    }
    const stale = value.facets.staleness;
    if ((!stale.classified && (stale.staleAfter !== undefined || stale.staleAfterEpoch !== undefined))
      || ((typeof stale.staleAfter === "string") !== (typeof stale.staleAfterEpoch === "number"))
      || (value.conformance === "strict" && !stale.classified)) throw new Error("Malformed staleness facet");
  }
}

export function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}
function nativeStaleness(fields, nested) {
  const source = nested ? fields.staleness : fields;
  const result = { classified: fields.staleness.classified };
  if (Object.hasOwn(source, "staleAfter")) {
    if (source.staleAfter === undefined) {
      result.staleAfter = undefined;
      result.staleAfterEpoch = undefined;
    } else {
      if (Object.hasOwn(source.staleAfter, "value")) result.staleAfter = source.staleAfter.value;
      if (Object.hasOwn(source.staleAfter, "epochMillis")) result.staleAfterEpoch = source.staleAfter.epochMillis;
    }
  }
  return result;
}
function facet(fields, key) {
  return Object.hasOwn(fields, key) ? { classified: true, value: fields[key] } : { classified: false };
}

export function project(engine, value) {
  validatePreparation(engine, value);
  if (value.kind === "fatal") return { kind: "fatal", diagnostics: value.diagnostics };
  const native = engine === "native";
  const fields = native ? value.fields : value;
  const result = {
    kind: "accepted", identity: value.identity, conformance: value.conformance, type: fields.type,
    metadata: native ? pick(fields, Object.keys(metadata).map((k) => k.replace(/\?$/, ""))) : value.metadata,
    facets: native ? { status: facet(fields, "status"), trust: facet(fields, "trustTier"), staleness: nativeStaleness(fields, true) } : value.facets,
    staleAfter: native ? nativeStaleness(fields, false) : value.facets.staleness,
    diagnostics: value.diagnostics, sections: value.sections,
  };
  if (value.conformance === "strict") {
    result.strict = { body: native ? value.body : value.document.body, ...pick(native ? fields : value.document, extraKeys) };
    if (native) {
      if (Object.hasOwn(fields, "staleAfter")) result.strict.staleAfter = fields.staleAfter?.value;
      result.strict.id = value.identity.documentId;
    } else Object.assign(result.strict, pick(value.document, ["staleAfter", "id"]));
  }
  return result;
}

// Tagged values preserve undefined, signed zero, nonfinite numbers, holes and UTF-16 strings.
export function encode(value) {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : value === Infinity ? "+Infinity" : value === -Infinity ? "-Infinity" : value];
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
  if (Array.isArray(value)) return ["array", value.length, Object.keys(value).map((key) => [key, encode(value[key])])];
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return ["record", Object.keys(value).sort().map((key) => [key, encode(value[key])])];
  }
  throw new Error("Unsupported capture value");
}
export function decode(value) {
  const [tag, data] = value;
  if (tag === "undefined") return undefined;
  if (tag === "null") return null;
  if (tag === "number") return data === "-0" ? -0 : data === "NaN" ? NaN : data === "+Infinity" ? Infinity : data === "-Infinity" ? -Infinity : data;
  if (tag === "string" || tag === "boolean") return data;
  const result = tag === "array" ? new Array(data) : {};
  for (const [key, child] of tag === "array" ? value[2] : data) Object.defineProperty(result, key, { value: decode(child), enumerable: true, writable: true, configurable: true });
  return result;
}

export function differences(left, right, path = "$", output = []) {
  if (Object.is(left, right)) return output;
  const record = (value) => value !== null && typeof value === "object";
  if (!record(left) || !record(right) || Array.isArray(left) !== Array.isArray(right)) {
    output.push({ path, left: encode(left), right: encode(right) }); return output;
  }
  if (Array.isArray(left) && left.length !== right.length) output.push({ path: `${path}.length`, left: encode(left.length), right: encode(right.length) });
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const child = `${path}[${JSON.stringify(key)}]`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      output.push({ path: child, left: Object.hasOwn(left, key) ? encode(left[key]) : ["missing"], right: Object.hasOwn(right, key) ? encode(right[key]) : ["missing"] });
    } else differences(left[key], right[key], child, output);
  }
  return output;
}

export function capture(engine, api, input) {
  const rawValidation = engine === "js" ? api.validateOkfDocument(input) : api.validate(input);
  validateValidation(rawValidation);
  const validation = decode(encode(rawValidation));
  let preparation;
  let prepareError;
  if (engine === "js") {
    try { preparation = project(engine, api.prepareOkfDocument(input)); }
    catch (error) {
      if (!(error instanceof api.PrepareError)) throw error;
      prepareError = { name: error.name, message: error.message, ...pick(error, ["code", "path", "field"]) };
      shape(prepareError, { name: "string", ...diagnostic });
      preparation = { kind: "fatal", diagnostics: validation.errors };
      if (!validation.errors.length) throw new Error("Fatal preparation without validation errors");
    }
  } else preparation = project(engine, api.prepare(input));
  // Detach each call before a later call can mutate reused result objects.
  return decode(encode({ validation, preparation, ...(prepareError ? { prepareError } : {}) }));
}

export function compareCaptures(js, native) {
  const output = differences(js.validation, native.validation, "validation");
  const left = js.preparation;
  const right = native.preparation;
  if (left.kind !== right.kind) differences(left.kind, right.kind, "preparation.kind", output);
  else if (left.kind === "fatal") differences(js.validation.errors, right.diagnostics, "preparation.diagnostics", output);
  else {
    // Strict extras are not a degraded projection contract.
    const keys = Object.keys(left).filter((key) => key !== "strict");
    differences(pick(left, keys), pick(right, keys), "preparation", output);
    differences(right.staleAfter, right.facets.staleness, "native.staleAfterAgreement", output);
    if (left.conformance === "strict" && right.conformance === "strict") {
      differences(left.strict, right.strict, "preparation.strict", output);
      differences(left.strict.id, left.identity.documentId, "js.documentIdentityAgreement", output);
    }
  }
  return output;
}
