// Records a short voice note with the microphone (D21). iPhone Safari records AAC in an MP4
// container; Chromium records Opus in WebM. Whisper reads both.
export type Recording = { blob: Blob; mime: string; durationMs: number };

const CANDIDATE_TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];

export async function startRecording(maxMs: number, onAutoStop: (r: Recording) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = CANDIDATE_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = Date.now();
  let finished: Promise<Recording> | null = null;

  const stop = () => {
    if (!finished) {
      finished = new Promise<Recording>((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop()); // release the mic (and its indicator)
          const mime = (rec.mimeType || type || "audio/mp4").split(";")[0];
          resolve({ blob: new Blob(chunks, { type: mime }), mime, durationMs: Math.min(Date.now() - started, maxMs) });
        };
        rec.stop();
      });
    }
    return finished;
  };
  const timer = setTimeout(() => stop().then(onAutoStop), maxMs);
  rec.start(1000); // a chunk per second, so a stop always has data to keep
  return {
    started,
    stop: async () => {
      clearTimeout(timer);
      return stop();
    },
  };
}

export const formatDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
