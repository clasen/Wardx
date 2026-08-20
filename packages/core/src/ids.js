import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()) {
  const chars = new Array(26);
  let time = now;
  for (let i = 9; i >= 0; i--) {
    chars[i] = ENCODING[time & 31];
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(10);
  chars[10] = ENCODING[(rand[0] & 224) >> 5];
  chars[11] = ENCODING[rand[0] & 31];
  chars[12] = ENCODING[(rand[1] & 248) >> 3];
  chars[13] = ENCODING[((rand[1] & 7) << 2) | ((rand[2] & 192) >> 6)];
  chars[14] = ENCODING[(rand[2] & 62) >> 1];
  chars[15] = ENCODING[((rand[2] & 1) << 4) | ((rand[3] & 240) >> 4)];
  chars[16] = ENCODING[((rand[3] & 15) << 1) | ((rand[4] & 128) >> 7)];
  chars[17] = ENCODING[(rand[4] & 124) >> 2];
  chars[18] = ENCODING[((rand[4] & 3) << 3) | ((rand[5] & 224) >> 5)];
  chars[19] = ENCODING[rand[5] & 31];
  chars[20] = ENCODING[(rand[6] & 248) >> 3];
  chars[21] = ENCODING[((rand[6] & 7) << 2) | ((rand[7] & 192) >> 6)];
  chars[22] = ENCODING[(rand[7] & 62) >> 1];
  chars[23] = ENCODING[((rand[7] & 1) << 4) | ((rand[8] & 240) >> 4)];
  chars[24] = ENCODING[((rand[8] & 15) << 1) | ((rand[9] & 128) >> 7)];
  chars[25] = ENCODING[(rand[9] & 124) >> 2];
  return chars.join('');
}
