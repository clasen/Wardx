export class RecentClients {
  constructor(max) {
    this.max = max;
    this.byId = new Map();
  }

  touch(client) {
    const instanceId = client.instanceId;
    if (this.byId.has(instanceId)) this.byId.delete(instanceId);
    this.byId.set(instanceId, {
      instanceId,
      role: client.role,
      appVersion: client.appVersion,
      platform: client.platform,
      environment: client.environment,
      lastSeen: Date.now()
    });
    while (this.byId.size > this.max) {
      const oldest = this.byId.keys().next().value;
      this.byId.delete(oldest);
    }
  }

  list() {
    return [...this.byId.values()].reverse();
  }
}
