// Reads DateTimeOriginal (+ OffsetTimeOriginal) from a JPEG's EXIF block. Returns null
// for anything else (HEIC, PNG, no EXIF); the caller falls back to the capture time.
export function exifTakenAt(buf: ArrayBuffer): { local: string; offset: string | null } | null {
  // Malformed EXIF is common enough (edited or truncated files) that it must never cost
  // the photo: any read past the end just means "no date here".
  try {
    return readJpeg(new DataView(buf));
  } catch {
    return null;
  }
}

function readJpeg(v: DataView) {
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    const marker = v.getUint16(p);
    const len = v.getUint16(p + 2);
    if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) return readTiff(v, p + 10); // "Exif"
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // bad marker or start of scan
    p += 2 + len;
  }
  return null;
}

function readTiff(v: DataView, t: number) {
  if (t + 8 > v.byteLength) return null;
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o: number) => v.getUint16(t + o, le);
  const u32 = (o: number) => v.getUint32(t + o, le);
  const str = (o: number, n: number) => {
    let s = "";
    for (let i = 0; i < n && t + o + i < v.byteLength; i++) {
      const ch = v.getUint8(t + o + i);
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s;
  };
  const tags = (ifd: number) => {
    const out = new Map<number, number>(); // tag -> offset of its 4-byte value field
    if (t + ifd + 2 > v.byteLength) return out;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (t + e + 12 > v.byteLength) break;
      out.set(u16(e), e + 8);
    }
    return out;
  };
  const exifPtr = tags(u32(4)).get(0x8769);
  if (exifPtr === undefined) return null;
  const exif = tags(u32(exifPtr));
  const ascii = (tag: number) => {
    const at = exif.get(tag);
    if (at === undefined) return null;
    const count = v.getUint32(t + at - 4, le);
    return count <= 4 ? str(at, count) : str(u32(at), count);
  };
  const dt = ascii(0x9003); // "YYYY:MM:DD HH:MM:SS"
  if (!dt || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(dt)) return null;
  const off = ascii(0x9011); // "+05:30"
  return {
    local: dt.slice(0, 10).replace(/:/g, "-") + "T" + dt.slice(11),
    offset: off && /^[+-]\d{2}:\d{2}$/.test(off) ? off : null,
  };
}
