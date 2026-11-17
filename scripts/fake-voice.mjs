import fs from 'node:fs';

// Speech-like fake microphone: syllables of varying length and gliding pitch separated by short pauses,
// so the sender's noise suppression does not learn it as stationary noise.
export function writeBurstWav(file, seed = 7) {
  const rate = 48000;
  const secs = 12;
  const n = rate * secs;
  const data = Buffer.alloc(n * 2);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let i = 0;
  let phase = 0;
  while (i < n) {
    const len = Math.floor(rate * (0.14 + rnd() * 0.26));
    const gap = Math.floor(rate * (0.06 + rnd() * 0.2));
    const f0a = 110 + rnd() * 140;
    const f0b = f0a * (0.8 + rnd() * 0.45);
    const amp = 0.25 + rnd() * 0.3;
    for (let k = 0; k < len && i < n; k++, i++) {
      const x = k / len;
      const f0 = f0a + (f0b - f0a) * x;
      phase += (2 * Math.PI * f0) / rate;
      const env = Math.sin(Math.PI * x) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 5 * x));
      const v = amp * env * (Math.sin(phase) + 0.6 * Math.sin(2 * phase) + 0.35 * Math.sin(3 * phase) + 0.2 * Math.sin(5 * phase)) / 2.15;
      data.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    i += gap;
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
