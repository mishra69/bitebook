// Safari ignores the quality argument of canvas JPEG encoding (toBlob and toDataURL alike;
// found on the first real meals, D11), always writing ~0.95. So display copies are
// encoded in JS, which gives the same quality on every browser.
export async function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const { default: encode } = await import("jpeg-js/lib/encoder.js");
  // Bundled as CommonJS, the encoder returns Buffer.from(bytes): its only Node dependency.
  const g = globalThis as { Buffer?: unknown };
  g.Buffer ??= { from: (bytes: number[]) => Uint8Array.from(bytes) };
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, width, height);
  const { data } = encode({ data: pixels.data, width, height }, Math.round(quality * 100));
  return new Blob([data as BlobPart], { type: "image/jpeg" });
}
