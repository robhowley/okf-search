import { isAlias, isScalar, parseDocument, visit } from "yaml";

export function parseOkfYaml(source: string): unknown {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw document.errors[0];
  }

  visit(document, {
    Pair(_key, pair) {
      const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
      if (!isScalar(key) || typeof key.value !== "string") {
        throw new TypeError("OKF YAML mapping keys must resolve to strings");
      }
    },
  });

  return document.toJS();
}
