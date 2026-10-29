import { randomInt } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';

const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const IMAGE_CODE_LENGTH = 6;

export interface CaptchaImage {
  code: string;
  image: string;
}

/** Server-side generator. The answer is used only to render pixels and store an HMAC. */
export function createImageChallenge(): CaptchaImage {
  const code = Array.from({ length: IMAGE_CODE_LENGTH }, () => alphabet[randomInt(alphabet.length)]).join('');
  const canvas = createCanvas(264, 88);
  const context = canvas.getContext('2d');
  context.fillStyle = '#eef2e6';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < 110; i++) {
    context.fillStyle = ['#bdcbb0', '#9bb1a2', '#d2c7a9'][randomInt(3)] ?? '#bdcbb0';
    context.beginPath();
    context.arc(randomInt(264), randomInt(88), randomInt(1, 3), 0, Math.PI * 2);
    context.fill();
  }
  for (let i = 0; i < code.length; i++) {
    context.save();
    context.translate(30 + i * 40, 46 + randomInt(-6, 7));
    context.rotate(randomInt(-14, 15) * Math.PI / 180);
    context.font = 'bold 38px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = ['#17362f', '#315a55', '#344455'][randomInt(3)] ?? '#17362f';
    context.fillText(code[i] ?? '', 0, 0);
    context.restore();
  }
  for (let i = 0; i < 3; i++) {
    context.beginPath();
    context.strokeStyle = '#8aa18b99';
    context.lineWidth = 1;
    context.moveTo(0, randomInt(15, 75));
    context.bezierCurveTo(85, randomInt(88), 175, randomInt(88), 264, randomInt(15, 75));
    context.stroke();
  }
  // A raster image has no answer text in an SVG element, alt attribute or metadata.
  return { code, image: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}` };
}
