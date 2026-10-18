import { exifTakenAt } from "./exif";
import { encodeJpeg } from "./jpeg";
import { localIso, withLocalOffset } from "./time";

// Turns a captured file into what the outbox stores: the original bytes untouched, a
// display copy (long edge 1600 px, JPEG, EXIF stripped by the canvas), both hashes, and
// the time the photo was taken.
export type PreparedPhoto = {
  original: Blob;
  mime: string;
  sha256: string;
  display: Blob;
  displaySha256: string;
  width: number;
  height: number;
  takenAt: string;
};

const LONG_EDGE = 1600;

export async function preparePhoto(file: File, capturedAt: Date): Promise<PreparedPhoto> {
  const buf = await file.arrayBuffer();
  const mime = file.type || sniffMime(buf);
  const exif = exifTakenAt(buf);
  const takenAt = exif ? (exif.offset ? exif.local + exif.offset : withLocalOffset(exif.local)) : localIso(capturedAt);

  const { source, width, height, release } = await decode(file);
  try {
    const scale = Math.min(1, LONG_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
    const display = await encodeJpeg(canvas, 0.8);
    canvas.width = canvas.height = 0; // free the backing store now; iOS caps total canvas memory
    return {
      original: new Blob([buf], { type: mime }),
      mime,
      sha256: await sha256Hex(buf),
      display,
      displaySha256: await sha256Hex(await display.arrayBuffer()),
      width,
      height,
      takenAt,
    };
  } finally {
    release();
  }
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// createImageBitmap applies EXIF orientation; an <img> is the fallback for formats or
// browsers where it fails (Safari decodes HEIC in <img> on recent iOS).
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("unsupported_image");
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  }
}

function sniffMime(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  const brand = String.fromCharCode(...b.slice(4, 12));
  if (brand.startsWith("ftyphei") || brand.startsWith("ftypheic") || brand.startsWith("ftypmif1")) return "image/heic";
  return "application/octet-stream";
}
