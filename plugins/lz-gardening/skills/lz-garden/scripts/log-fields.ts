// The shapes the garden's values take: commit ids, class ids, sources, bed names, layers, stamped times and printable
// text. The event schemas hold an event's fields to them, and the other scripts hold what they read or are given to
// them. Neither needs the events or the replay for that, and these change less often than the log does.
import type { z } from 'zod';

export const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const classPattern = /^[a-z0-9][a-z0-9-]*$/;

export const sourcePattern = /^[a-z][a-z-]*:\S/;

export const bedPattern = /^bed\/([a-z0-9][a-z0-9-]*)@([0-9a-f]{4,64})$/;

const controlsAndLineBreaks = String.raw`\p{Cc}\p{Zl}\p{Zp}`;
const bidiControls = String.raw`\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}`;
export const unprintablePattern = new RegExp(`[${controlsAndLineBreaks}${bidiControls}]`, 'u');

export function hasText(text: string): boolean {
  return text.trim() !== '';
}

const strongestLayer = 1;
const layerCount = 6;

export function isLayer(layer: number): boolean {
  return Number.isInteger(layer) && layer >= strongestLayer && layer <= layerCount;
}

export function isStampedTime(text: string): boolean {
  const time = Date.parse(text);

  return /^\d{4}-/.test(text) && !Number.isNaN(time) && new Date(time).toISOString() === text;
}

export function firstReason(error: z.ZodError): string {
  // Stryker disable next-line OptionalChaining,LogicalOperator: a failed parse has at least one issue
  return error.issues[0]?.message ?? error.message;
}
