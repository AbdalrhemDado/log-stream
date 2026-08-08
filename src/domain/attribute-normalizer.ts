import type { NormalizedSearchAttributes, OriginalAttributes } from "./attributes.js";

const INVALID_ATTRIBUTE_VALUE_MESSAGE = "Original attributes contain an unsupported runtime value.";

function unsupportedAttributeValue(): never {
  throw new TypeError(INVALID_ATTRIBUTE_VALUE_MESSAGE);
}

function normalizeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return unsupportedAttributeValue();
  }

  if (Object.is(value, -0)) {
    return "0";
  }

  return JSON.stringify(value);
}

export function normalizeAttributes(attributes: OriginalAttributes): NormalizedSearchAttributes {
  const normalized = Object.create(null) as Record<string, string>;

  for (const key of Object.keys(attributes)) {
    const value: unknown = attributes[key];
    normalized[key] = normalizeValue(value);
  }

  return normalized as NormalizedSearchAttributes;
}
