export type AttributeValue = string | number | boolean;

declare const originalAttributesBrand: unique symbol;
declare const normalizedSearchAttributesBrand: unique symbol;

/**
 * Original attributes after runtime validation.
 *
 * The future factory for this type must preserve every key exactly, including
 * empty, Unicode, `__proto__`, and `constructor` keys. Values must be own,
 * enumerable properties of a null-prototype object or an equivalently safe
 * representation. Inherited properties must never be treated as attributes.
 */
export type OriginalAttributes = Readonly<Record<string, AttributeValue>> & {
  readonly [originalAttributesBrand]: "OriginalAttributes";
};

/**
 * String-normalized attributes used by the persistence and query layers.
 *
 * This type has the same prototype-safety and exact-key-preservation invariant
 * as OriginalAttributes, but every own enumerable value is a string.
 */
export type NormalizedSearchAttributes = Readonly<Record<string, string>> & {
  readonly [normalizedSearchAttributesBrand]: "NormalizedSearchAttributes";
};
