// src/utils/record.ts
// A value read as a plain object, or null where it is not one. Parsed JSON bodies arrive as
// `unknown`; this is how a caller reads a field off one without `any`.

export const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
