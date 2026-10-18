import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exifTakenAt } from "../../src/app/lib/exif";

const bytes = (name: string) => {
  const b = readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe("exifTakenAt", () => {
  it("reads DateTimeOriginal with its UTC offset", () => {
    expect(exifTakenAt(bytes("meal-with-offset.jpg"))).toEqual({ local: "2026-10-16T19:32:05", offset: "-05:00" });
  });
  it("reads DateTimeOriginal without an offset", () => {
    expect(exifTakenAt(bytes("meal-no-offset.jpg"))).toEqual({ local: "2026-10-16T08:05:00", offset: null });
  });
  it("returns null for non-JPEG input", () => {
    expect(exifTakenAt(bytes("side.png"))).toBeNull();
  });
  it("returns null for truncated or garbage input instead of throwing", () => {
    const b = new Uint8Array(bytes("meal-with-offset.jpg")).slice(0, 40);
    expect(exifTakenAt(b.buffer)).toBeNull();
    expect(exifTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 2]).buffer)).toBeNull();
  });
});
