import { parentPort, workerData } from 'node:worker_threads';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

// Only fixed-size drawing of generated glyphs. No input image decoding or URLs.
const alphabet = 'ACDEHJKMNPQRTUVWXY3479';
const length = workerData.length;
if (!Number.isInteger(length) || length < 4 || length > 8) throw new Error('Invalid image length');
if (!GlobalFonts.registerFromPath(fileURLToPath(new URL('../assets/fonts/RobotoMono.ttf', import.meta.url)), 'CaptchaMono')) {
  throw new Error('Bundled CAPTCHA font unavailable');
}
const answer = Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
const width = 36 * length + 28, height = 88;
const canvas = createCanvas(width, height);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#f3f5f7'; ctx.fillRect(0, 0, width, height);
for (let i = 0; i < 90; i++) {
  ctx.fillStyle = `rgba(${randomInt(80,180)},${randomInt(80,180)},${randomInt(80,180)},0.35)`;
  ctx.beginPath(); ctx.arc(randomInt(width), randomInt(height), randomInt(1,3), 0, 2*Math.PI); ctx.fill();
}
for (let i = 0; i < length; i++) {
  ctx.save(); ctx.translate(30 + 36*i + randomInt(-3,4), 47 + randomInt(-5,6));
  ctx.rotate(randomInt(-15,16)*Math.PI/180); ctx.transform(1, 0, randomInt(-8,9)/100, 1, 0, 0);
  ctx.font = `600 ${randomInt(36,42)}px CaptchaMono`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgb(${randomInt(15,65)},${randomInt(20,65)},${randomInt(25,80)})`; ctx.fillText(answer[i],0,0); ctx.restore();
}
for(let i=0;i<3;i++) {
  ctx.strokeStyle='rgba(90,110,130,0.45)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(0,randomInt(15,74));ctx.bezierCurveTo(width/3,randomInt(height),2*width/3,randomInt(height),width,randomInt(15,74));ctx.stroke();
}
const png = await canvas.encode('png');
if (png.length > 32768) throw new Error('CAPTCHA PNG exceeds limit');
parentPort.postMessage({ answer, png });
parentPort.close();
