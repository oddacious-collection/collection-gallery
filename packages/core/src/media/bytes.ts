/** Small byte helpers shared by the image-format modules. */

export class FormatError extends Error {
  override readonly name = 'FormatError';
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function u16be(b: Uint8Array, at: number): number {
  if (at + 2 > b.length) throw new FormatError('truncated');
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

export function u16le(b: Uint8Array, at: number): number {
  if (at + 2 > b.length) throw new FormatError('truncated');
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

export function u24le(b: Uint8Array, at: number): number {
  if (at + 3 > b.length) throw new FormatError('truncated');
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
}

export function u32le(b: Uint8Array, at: number): number {
  if (at + 4 > b.length) throw new FormatError('truncated');
  return (
    ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) + (b[at + 3] ?? 0) * 2 ** 24
  );
}

export function ascii(b: Uint8Array, at: number, length: number): string {
  let s = '';
  for (let i = at; i < at + length && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function setU16le(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
}

export function setU24le(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
}

export function setU32le(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
  b[at + 3] = (v >>> 24) & 0xff;
}
