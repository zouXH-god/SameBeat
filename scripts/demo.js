import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../data/demo/', import.meta.url));
mkdirSync(directory, { recursive: true });
function wav(name, sample) {
  const rate = 22050, seconds = 30, length = rate * seconds;
  const bytes = Buffer.alloc(44 + length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) { const t = i / rate; const envelope = Math.min(1, t / 1.5, (seconds - t) / 2); bytes.writeInt16LE(Math.round(sample(t) * envelope * 6000), 44 + i * 2); }
  writeFileSync(directory + name, bytes);
}
const chordRoots = [261.63, 220, 174.61, 196];
wav('01-示例伴奏.wav', t => { const root = chordRoots[Math.floor(t / 4) % 4]; const beat = t % 2; return [1, 1.25, 1.5].reduce((v, r) => v + Math.sin(t * Math.PI * 2 * root * r) / 3, 0) * Math.exp(-beat * 1.5); });
const notes = [523.25, 659.25, 783.99, 659.25, 440, 523.25, 659.25, 523.25];
wav('02-示例旋律.wav', t => Math.sin(t * Math.PI * 2 * notes[Math.floor(t) % notes.length]) * Math.sin(Math.PI * (t % 1)) * 0.5);
writeFileSync(directory + '示例歌词.lrc', '[ti:同频测试旋律]\n[00:00.00]一个房间，一条时间轴\n[00:04.00]伴奏和旋律，在此刻相遇\n[00:08.00]无论相隔多远\n[00:12.00]让每个声音，一起发生\n[00:16.00]试试暂停，再继续\n[00:20.00]拖动进度，歌词也会跟随\n[00:24.00]不同的设备，相同的瞬间\n[00:28.00]谢谢一起聆听\n');
console.log('示例文件已生成：' + directory + '（示例旋律为合成音，不是真实人声）');
