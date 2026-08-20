import { createWriteStream } from 'node:fs';

export class NdjsonSink {
  constructor({ ndjsonPath }) {
    this.stream = createWriteStream(ndjsonPath, { flags: 'a' });
  }

  ingest(envelope) {
    this.stream.write(`${JSON.stringify(envelope)}\n`);
  }

  close() {
    return new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
  }
}
