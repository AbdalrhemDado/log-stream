import type { AttributeFilter, LogFilters } from "./query-parameter-parser.js";

export interface SqlPredicate {
  readonly text: string;
  readonly values: readonly unknown[];
}

function serializeAttributeFilter(attribute: AttributeFilter): string {
  const containment = Object.create(null) as Record<string, string>;
  containment[attribute.key] = attribute.value;

  return JSON.stringify(containment);
}

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export function buildLogPredicate(filters: LogFilters): SqlPredicate {
  const clauses: string[] = [];
  const values: unknown[] = [];

  const bind = (clause: (placeholder: string) => string, value: unknown): void => {
    values.push(value);
    clauses.push(clause(`$${String(values.length)}`));
  };

  if (filters.service !== undefined) {
    bind((placeholder) => `service = ${placeholder}::text`, filters.service);
  }

  if (filters.level !== undefined) {
    bind((placeholder) => `level = ${placeholder}::text`, filters.level);
  }

  if (filters.since !== undefined) {
    bind((placeholder) => `"timestamp" >= ${placeholder}::timestamptz`, filters.since);
  }

  if (filters.until !== undefined) {
    bind((placeholder) => `"timestamp" < ${placeholder}::timestamptz`, filters.until);
  }

  for (const attribute of filters.attributes) {
    bind(
      (placeholder) => `attributes_search @> ${placeholder}::jsonb`,
      serializeAttributeFilter(attribute),
    );
  }

  if (filters.q !== undefined) {
    bind(
      (placeholder) => `message ILIKE ${placeholder}::text ESCAPE E'\\\\'`,
      `%${escapeLikeLiteral(filters.q)}%`,
    );
  }

  return {
    text: clauses.length === 0 ? "TRUE" : clauses.join(" AND "),
    values,
  };
}
