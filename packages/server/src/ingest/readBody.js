export class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.name = 'PayloadTooLargeError';
    this.status = 413;
  }
}

export class BodyTimeoutError extends Error {
  constructor() {
    super('request body timed out');
    this.name = 'BodyTimeoutError';
  }
}

// The socket closes before the request: Bun's node:http detaches it on
// req.destroy() and would otherwise keep the stalled connection open.
export function abortStalledBody(req) {
  req.socket.destroy();
  req.destroy(new BodyTimeoutError());
}

export async function readBody(req, maxRequestBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
