// Nodes are tinted by their object type so instances of the same type read as a
// group, the way the mockup colours them. The palette is theme tokens, not raw
// hex, so it follows light/dark like everything else.
const PALETTE = [
  'rgb(var(--i3x-primary))',
  'rgb(var(--i3x-success))',
  'rgb(var(--i3x-warning))',
  'rgb(var(--i3x-secondary))',
]

/** Stable hash → palette slot. Same typeId always yields the same colour. */
export function colorForType(typeId: string | null | undefined): string {
  if (!typeId) return PALETTE[PALETTE.length - 1]
  let hash = 0
  for (let i = 0; i < typeId.length; i++) {
    hash = (hash * 31 + typeId.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}
