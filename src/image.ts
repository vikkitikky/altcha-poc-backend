import { Worker } from 'node:worker_threads';
import { ApiError } from './errors.js';

export const imageAlphabet = 'ACDEHJKMNPQRTUVWXY3479';
export interface CaptchaImage { answer: string; png: Uint8Array }
export interface ImageGenerator { generate(length: number): Promise<CaptchaImage> }
/** Bounded isolated workers: at most two per service instance, no unbounded waiting queue. */
export class CanvasImageGenerator implements ImageGenerator {
  private active = 0;
  constructor(private readonly timeoutMs = 2000) {}
  async generate(length: number): Promise<CaptchaImage> {
    if (!Number.isSafeInteger(length) || length < 4 || length > 8) throw new ApiError(503, 'IMAGE_GENERATION_FAILED');
    if (this.active >= 2) throw new ApiError(503, 'IMAGE_GENERATOR_BUSY');
    this.active++;
    let worker: Worker | undefined, timer: NodeJS.Timeout | undefined;
    try {
      worker = new Worker(new URL('./image-worker.mjs', import.meta.url), { workerData: { length },
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
      return await new Promise<CaptchaImage>((resolve, reject) => {
        timer = setTimeout(() => reject(new ApiError(503, 'IMAGE_GENERATION_TIMEOUT')), this.timeoutMs);
        worker!.once('error', () => reject(new ApiError(503, 'IMAGE_GENERATION_FAILED')));
        worker!.once('exit', (code) => { if(code !== 0) reject(new ApiError(503, 'IMAGE_GENERATION_FAILED')); });
        worker!.once('message', (value: CaptchaImage) => {
          if (typeof value.answer !== 'string' || value.answer.length !== length
            || [...value.answer].some(c => !imageAlphabet.includes(c)) || !(value.png instanceof Uint8Array)
            || value.png.length > 32768 || Buffer.from(value.png.subarray(0,8)).toString('hex') !== '89504e470d0a1a0a') {
            reject(new ApiError(503, 'IMAGE_GENERATION_FAILED'));
          } else resolve(value);
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
      await worker?.terminate(); this.active--;
    }
  }
}
