import { gzipSync } from 'node:zlib';

export class ConfigRepository {
  constructor(initial) {
    this.replace(initial);
  }

  replace(snapshot) {
    if (typeof snapshot.version !== 'number' || !Number.isFinite(snapshot.version)) {
      throw new Error('config version must be a finite number');
    }
    this.version = snapshot.version;
    this.values = snapshot.values;
    this.experiments = snapshot.experiments;
    this.configJson = JSON.stringify({
      values: snapshot.values,
      experiments: snapshot.experiments
    });
    this.configGzip = gzipSync(Buffer.from(this.configJson));
  }

  buildResponse(includeConfig) {
    const serverTime = Date.now();
    if (includeConfig) {
      return `{"ok":true,"serverTime":${serverTime},"configVersion":${this.version},"config":${this.configJson}}`;
    }
    return `{"ok":true,"serverTime":${serverTime},"configVersion":${this.version}}`;
  }
}
