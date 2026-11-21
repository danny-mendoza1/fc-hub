/**
 * Building blocks for validating what clients send (inventory uploads, Wondrous Tails, and any
 * upload type added later), so every endpoint checks ids, text and timestamps the same way.
 */

/** 64-bit game ids travel as decimal strings (they exceed JS's safe integer range). */
export const ID_PATTERN = /^[1-9][0-9]{0,19}$/;

/** Max length of any text field (names, locations). */
export const TEXT_MAX = 200;

/** Client clocks drift; a capture time is never accepted more than this far in the future. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** A capture time from a client, clamped so it can't claim to be newer than the server's now. */
export function clampCapturedAt(capturedAt: string, now: Date): string {
  return new Date(Math.min(Date.parse(capturedAt), now.getTime() + MAX_CLOCK_SKEW_MS)).toISOString();
}

/**
 * Collects every problem instead of stopping at the first, so a client sees them all at once.
 * Each check returns the value when it's valid and `undefined` (after recording an error) when not;
 * unknown fields are ignored.
 */
export class Validator {
  readonly errors: string[] = [];

  /** The value if nothing failed, else the first 20 errors. */
  result<T>(value: T): Validation<T> {
    return this.errors.length > 0 ? { ok: false, errors: this.errors.slice(0, 20) } : { ok: true, value };
  }

  object(value: unknown, path: string): Record<string, unknown> | undefined {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    this.errors.push(`${path} must be an object`);
    return undefined;
  }

  array(value: unknown, path: string, max: number): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.errors.push(`${path} must be an array`);
      return undefined;
    }
    if (value.length > max) {
      this.errors.push(`${path} has more than ${max} entries`);
      return undefined;
    }
    return value;
  }

  text(value: unknown, path: string, allowEmpty = false): string | undefined {
    if (typeof value === "string" && value.length <= TEXT_MAX && (allowEmpty || value.length > 0)) return value;
    this.errors.push(`${path} must be a ${allowEmpty ? "" : "non-empty "}string of at most ${TEXT_MAX} characters`);
    return undefined;
  }

  optionalText(value: unknown, path: string): string | null | undefined {
    if (value === null || value === undefined) return null;
    return this.text(value, path, true);
  }

  int(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max) return value;
    this.errors.push(
      max === Number.MAX_SAFE_INTEGER ? `${path} must be a non-negative integer` : `${path} must be an integer between 0 and ${max}`,
    );
    return undefined;
  }

  bool(value: unknown, path: string): boolean | undefined {
    if (typeof value === "boolean") return value;
    this.errors.push(`${path} must be a boolean`);
    return undefined;
  }

  id(value: unknown, path: string): string | undefined {
    if (typeof value === "string" && ID_PATTERN.test(value)) return value;
    this.errors.push(`${path} must be a decimal id string`);
    return undefined;
  }

  /** An ISO timestamp, normalised to UTC with milliseconds. */
  timestamp(value: unknown, path: string): string | undefined {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
    this.errors.push(`${path} must be an ISO timestamp`);
    return undefined;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
    if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
    this.errors.push(`${path} must be one of ${options.join(", ")}`);
    return undefined;
  }
}
