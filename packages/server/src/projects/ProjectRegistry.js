import { Project } from './Project.js';

export class ProjectRegistry {
  constructor(config) {
    this.byName = new Map();
    for (const [name, snapshot] of Object.entries(config.projects)) {
      this.byName.set(name, new Project(name, snapshot, config));
    }
  }

  get(name) {
    return this.byName.get(name);
  }

  names() {
    return [...this.byName.keys()].sort();
  }
}
