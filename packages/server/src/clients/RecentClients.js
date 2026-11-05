// Most recently seen SDK instances, bounded per role so a large role cannot
// evict every instance of a smaller one.
export class RecentClients {
  constructor(max) {
    this.max = max;
    this.byRole = new Map();
    this.roleById = new Map();
  }

  touch(client, sdk) {
    const instanceId = client.instanceId;
    const previousRole = this.roleById.get(instanceId);
    if (previousRole !== undefined) this.byRole.get(previousRole).delete(instanceId);
    let clients = this.byRole.get(client.role);
    if (!clients) {
      clients = new Map();
      this.byRole.set(client.role, clients);
    }
    clients.set(instanceId, {
      instanceId,
      role: client.role,
      appVersion: client.appVersion,
      platform: client.platform,
      os: client.os,
      sdkName: sdk.name,
      sdkVersion: sdk.version,
      environment: client.environment,
      lastSeen: Date.now()
    });
    this.roleById.set(instanceId, client.role);
    while (clients.size > this.max) {
      const oldest = clients.keys().next().value;
      clients.delete(oldest);
      this.roleById.delete(oldest);
    }
  }

  list() {
    const rows = [];
    for (const clients of this.byRole.values()) rows.push(...clients.values());
    return rows.sort((left, right) => right.lastSeen - left.lastSeen);
  }
}
