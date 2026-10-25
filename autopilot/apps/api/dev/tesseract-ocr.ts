/** Free, local OCR (tesseract.js, Apache-2.0) for the Node local server and eval harness. Not bundled into the Worker:
 * WASM + language data exceed what a free Worker can sensibly load, so deployed Workers keep MockOcr (labelled mock). */
import { createWorker, type Worker } from "tesseract.js";
import type { ImageOcr, OcrResult } from "@xevrion/books";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export class TesseractOcr implements ImageOcr {
  readonly name = "tesseract-local";
  private worker: Promise<Worker> | null = null;
  constructor(private readonly cachePath = ".local/tesseract-cache") {}
  private get() {
    this.worker ??= createWorker("eng", 1, { cachePath: this.cachePath, logger: () => undefined });
    return this.worker;
  }
  async recognise(input: { bytes: Uint8Array; contentType: string }): Promise<OcrResult> {
    // PDFs/HEIC are not rasterised locally; they go to human review rather than being guessed.
    if (!IMAGE_TYPES.has(input.contentType)) return { text: "", confidence: 0, engine: this.name };
    const { data } = await (await this.get()).recognize(Buffer.from(input.bytes));
    return { text: data.text, confidence: Math.max(0, Math.min(1, data.confidence / 100)), engine: this.name };
  }
  async close() {
    if (this.worker) await (await this.worker).terminate();
    this.worker = null;
  }
}
