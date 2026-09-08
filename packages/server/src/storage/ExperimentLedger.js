const EMPTY_TOTALS = Object.freeze({
  exposures: 0,
  goals: 0,
  goalSum: 0,
  goalSumSq: 0,
  duplicateExposures: 0,
  duplicateGoals: 0,
  conflictingGoals: 0,
  variantConflicts: 0,
  untrustedRows: 0,
  lateRows: 0,
  missingExposures: 0,
  implicitExposures: 0
});
const TERMINAL_STATUSES = new Set(['winner', 'no_difference', 'inconclusive', 'invalid']);

function emptyTotals() {
  return { ...EMPTY_TOTALS };
}

function assertHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) {
    throw new Error('assignment hash must be 16 lowercase hexadecimal characters');
  }
  return Buffer.from(value, 'hex');
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('experiment evidence source must be an object');
  }
  assertNonEmptyString(source.role, 'experiment evidence source.role');
  if (typeof source.trustedForDecisions !== 'boolean') {
    throw new Error('experiment evidence source.trustedForDecisions must be a boolean');
  }
}

function assertEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('experiment event must be an object');
  }
  if (event.kind !== 'exposure' && event.kind !== 'goal') {
    throw new Error('experiment event kind must be exposure or goal');
  }
  assertNonEmptyString(event.experiment, 'experiment event.experiment');
  assertNonEmptyString(event.variant, 'experiment event.variant');
  assertHash(event.assignmentHash);
  if (!Number.isInteger(event.timestamp) || event.timestamp < 0) {
    throw new Error('experiment event.timestamp must be an integer >= 0');
  }
  if (event.kind === 'goal' && (typeof event.value !== 'number' || !Number.isFinite(event.value))) {
    throw new Error('experiment goal value must be a finite number');
  }
}

function assertTerminalDecision(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('terminal decision must be an object');
  }
  if (!TERMINAL_STATUSES.has(decision.status)) {
    throw new Error('terminal decision status must be winner, no_difference, inconclusive, or invalid');
  }
  assertNonEmptyString(decision.method, 'terminal decision.method');
  if (!decision.terminalInput || typeof decision.terminalInput !== 'object' || Array.isArray(decision.terminalInput)) {
    throw new Error('terminal decision.terminalInput must be an object');
  }
  if (!Number.isInteger(decision.terminalInput.analysisAt) || decision.terminalInput.analysisAt < 0) {
    throw new Error('terminal decision.terminalInput.analysisAt must be an integer >= 0');
  }
}

function trustClass(source) {
  return source.trustedForDecisions ? 'trusted' : 'untrusted';
}

function eventDetails(event, source) {
  return JSON.stringify({ timestamp: event.timestamp, sourceRole: source.role, trustClass: trustClass(source) });
}

export class ExperimentLedger {
  constructor({ store, maxRows }) {
    if (!store || typeof store.transaction !== 'function' || !store.database) {
      throw new Error('SQLite state store is required');
    }
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error('experiment ledger maxRows must be an integer >= 1');
    this.store = store;
    this.maxRows = maxRows;
    this.selectAssignment = store.database.prepare(`
      SELECT * FROM experiment_assignment_ledger
      WHERE project = ? AND experiment = ? AND assignment_hash = ?
    `);
    this.insertAssignment = store.database.prepare(`
      INSERT INTO experiment_assignment_ledger(
        project, experiment, assignment_hash, variant, exposure_json, goal_json,
        source_role, trust_class, expires_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0)
    `);
    this.updateGoal = store.database.prepare(`
      UPDATE experiment_assignment_ledger SET goal_json = ?
      WHERE project = ? AND experiment = ? AND assignment_hash = ?
    `);
    this.selectTotals = store.database.prepare(`
      SELECT totals_json FROM experiment_totals
      WHERE project = ? AND experiment = ? AND variant = ? AND source_role = ? AND trust_class = ?
    `);
    this.upsertTotals = store.database.prepare(`
      INSERT INTO experiment_totals(project, experiment, variant, source_role, trust_class, totals_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, experiment, variant, source_role, trust_class)
      DO UPDATE SET totals_json = excluded.totals_json
    `);
    this.countAssignments = store.database.prepare('SELECT count(*) AS count FROM experiment_assignment_ledger');
    this.selectTerminalDecision = store.database.prepare(`
      SELECT decision_json FROM experiment_terminal_decisions WHERE project = ? AND experiment = ?
    `);
  }

  _updateTotals(project, experiment, variant, source, mutate) {
    const classification = trustClass(source);
    const stored = this.selectTotals.get(project, experiment, variant, source.role, classification);
    const totals = stored ? { ...emptyTotals(), ...JSON.parse(stored.totals_json) } : emptyTotals();
    mutate(totals);
    this.upsertTotals.run(project, experiment, variant, source.role, classification, JSON.stringify(totals));
  }

  ingestBatch(project, events, source) {
    assertNonEmptyString(project, 'project');
    if (!Array.isArray(events)) throw new Error('experiment events must be an array');
    assertSource(source);
    if (events.length > this.store.settings.maxWriteBatch) {
      throw new Error('experiment event batch exceeds configured maximum');
    }
    for (const event of events) assertEvent(event);
    if (events.length === 0) return [];
    const preflight = this._preflight(project, events, source);
    if (preflight.newAssignments + this.countAssignments.get().count > this.maxRows) {
      throw new Error('experiment ledger capacity exceeded');
    }
    if (preflight.rejected) {
      const rejected = preflight.rejected;
      this.store.transaction(() => {
        if (!source.trustedForDecisions) {
          for (const event of events) {
            this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
              totals.untrustedRows += 1;
            });
          }
        }
        this._updateTotals(project, rejected.event.experiment, rejected.event.variant, source, (totals) => {
          totals[rejected.status === 'variant_conflict' ? 'variantConflicts' : 'missingExposures'] += 1;
        });
      });
      return [{ status: rejected.status, experiment: rejected.event.experiment }];
    }
    return this.store.transaction(() => events.map((event) => this._ingest(project, event, source)));
  }

  _preflight(project, events, source) {
    const assignments = new Map();
    const terminalExperiments = new Map();
    const classification = trustClass(source);
    let newAssignments = 0;
    for (const event of events) {
      const hash = assertHash(event.assignmentHash);
      const key = `${event.experiment}\0${event.assignmentHash}`;
      let terminal = terminalExperiments.get(event.experiment);
      if (terminal === undefined) {
        terminal = this.selectTerminalDecision.get(project, event.experiment) !== undefined;
        terminalExperiments.set(event.experiment, terminal);
      }
      let current = assignments.get(key);
      if (!current) {
        const stored = this.selectAssignment.get(project, event.experiment, hash);
        current = stored
          ? {
              variant: stored.variant,
              hasExposure: true,
              goalValue: stored.goal_json === null ? undefined : JSON.parse(stored.goal_json).value,
              sourceRole: stored.source_role,
              trustClass: stored.trust_class,
              closed: stored.expires_at > 0
            }
          : null;
      }
      if (terminal || current?.closed) {
        assignments.set(key, { ...current, closed: true });
        continue;
      }
      if (current && current.variant !== event.variant) {
        return { newAssignments, rejected: { status: 'variant_conflict', event } };
      }
      if (event.kind === 'exposure') {
        if (!current) {
          current = {
            variant: event.variant,
            hasExposure: true,
            goalValue: undefined,
            sourceRole: source.role,
            trustClass: classification,
            closed: false
          };
          newAssignments += 1;
        }
        assignments.set(key, current);
        continue;
      }
      if (
        !current?.hasExposure ||
        current.sourceRole !== source.role ||
        current.trustClass !== classification
      ) {
        return { newAssignments, rejected: { status: 'missing_exposure', event } };
      }
      if (current.goalValue === undefined) current.goalValue = event.value;
      assignments.set(key, current);
    }
    return { newAssignments, rejected: null };
  }

  _ingest(project, event, source) {
    const assignmentHash = assertHash(event.assignmentHash);
    const current = this.selectAssignment.get(project, event.experiment, assignmentHash);
    if (this.selectTerminalDecision.get(project, event.experiment) || current?.expires_at > 0) {
      this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
        totals.lateRows += 1;
        if (!source.trustedForDecisions) totals.untrustedRows += 1;
      });
      return { status: 'late_row', experiment: event.experiment };
    }
    if (current && current.variant !== event.variant) {
      this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
        totals.variantConflicts += 1;
        if (!source.trustedForDecisions) totals.untrustedRows += 1;
      });
      return { status: 'variant_conflict', experiment: event.experiment };
    }
    if (event.kind === 'exposure') {
      if (current) {
        this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
          totals.duplicateExposures += 1;
          if (!source.trustedForDecisions) totals.untrustedRows += 1;
        });
        return { status: 'duplicate_exposure', experiment: event.experiment };
      }
      this.insertAssignment.run(
        project,
        event.experiment,
        assignmentHash,
        event.variant,
        eventDetails(event, source),
        source.role,
        trustClass(source)
      );
      this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
        totals.exposures += 1;
        if (!source.trustedForDecisions) totals.untrustedRows += 1;
      });
      return { status: 'accepted_exposure', experiment: event.experiment };
    }
    if (
      !current ||
      current.source_role !== source.role ||
      current.trust_class !== trustClass(source)
    ) {
      this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
        totals.missingExposures += 1;
        if (!source.trustedForDecisions) totals.untrustedRows += 1;
      });
      return { status: 'missing_exposure', experiment: event.experiment };
    }
    if (current.goal_json !== null) {
      const accepted = JSON.parse(current.goal_json);
      const conflicting = accepted.value !== event.value;
      this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
        if (conflicting) totals.conflictingGoals += 1;
        else totals.duplicateGoals += 1;
        if (!source.trustedForDecisions) totals.untrustedRows += 1;
      });
      return { status: conflicting ? 'conflicting_goal' : 'duplicate_goal', experiment: event.experiment };
    }
    this.updateGoal.run(
      JSON.stringify({
        timestamp: event.timestamp,
        value: event.value,
        sourceRole: source.role,
        trustClass: trustClass(source)
      }),
      project,
      event.experiment,
      assignmentHash
    );
    this._updateTotals(project, event.experiment, event.variant, source, (totals) => {
      totals.goals += 1;
      totals.goalSum += event.value;
      totals.goalSumSq += event.value * event.value;
      if (!source.trustedForDecisions) totals.untrustedRows += 1;
    });
    return { status: 'accepted_goal', experiment: event.experiment };
  }

  totals(project, experiment) {
    return this.store.database
      .prepare(`
        SELECT variant, source_role, trust_class, totals_json
        FROM experiment_totals WHERE project = ? AND experiment = ?
        ORDER BY variant, trust_class, source_role
      `)
      .all(project, experiment)
      .map((row) => ({
        key: row.variant,
        sourceRole: row.source_role,
        trustClass: row.trust_class,
        ...emptyTotals(),
        ...JSON.parse(row.totals_json)
      }));
  }

  hasTrustedExposure(project, experiment) {
    return this.totals(project, experiment).some(
      (row) => row.trustClass === 'trusted' && row.exposures > 0
    );
  }

  hasAnyEvidence(project, experiment) {
    return this.totals(project, experiment).some((row) => row.exposures > 0 || row.goals > 0);
  }

  hasAssignmentRows(project, experiment) {
    return this.store.database
      .prepare('SELECT 1 FROM experiment_assignment_ledger WHERE project = ? AND experiment = ? LIMIT 1')
      .get(project, experiment) !== undefined;
  }

  scheduleExpiry(project, experiment, expiresAt) {
    assertNonEmptyString(project, 'project');
    assertNonEmptyString(experiment, 'experiment');
    if (!Number.isInteger(expiresAt) || expiresAt < 1) throw new Error('expiresAt must be an integer >= 1');
    return this.store.database
      .prepare(`
        UPDATE experiment_assignment_ledger SET expires_at = ?
        WHERE project = ? AND experiment = ? AND expires_at = 0
      `)
      .run(expiresAt, project, experiment).changes;
  }

  clearExpiry(project, experiment) {
    return this.store.database
      .prepare('UPDATE experiment_assignment_ledger SET expires_at = 0 WHERE project = ? AND experiment = ?')
      .run(project, experiment).changes;
  }

  pruneExpired(now = Date.now()) {
    if (!Number.isInteger(now) || now < 0) throw new Error('now must be an integer >= 0');
    return this.store.database
      .prepare('DELETE FROM experiment_assignment_ledger WHERE expires_at > 0 AND expires_at <= ?')
      .run(now).changes;
  }

  readTerminalDecision(project, experiment) {
    assertNonEmptyString(project, 'project');
    assertNonEmptyString(experiment, 'experiment');
    const row = this.selectTerminalDecision.get(project, experiment);
    return row ? JSON.parse(row.decision_json) : null;
  }

  persistTerminalDecision(project, experiment, decision, decidedAt = Date.now()) {
    assertNonEmptyString(project, 'project');
    assertNonEmptyString(experiment, 'experiment');
    if (!Number.isInteger(decidedAt) || decidedAt < 0) throw new Error('decidedAt must be an integer >= 0');
    const existing = this.readTerminalDecision(project, experiment);
    if (existing) return existing;
    assertTerminalDecision(decision);
    const inserted = this.store.database
      .prepare(`
        INSERT INTO experiment_terminal_decisions(project, experiment, decided_at, decision_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project, experiment) DO NOTHING
      `)
      .run(project, experiment, decidedAt, JSON.stringify(decision));
    return inserted.changes === 1 ? decision : this.readTerminalDecision(project, experiment);
  }

  persistTerminalDecisionAndScheduleExpiry(project, experiment, decision, expiresAt, decidedAt = Date.now()) {
    return this.store.transaction(() => {
      const persisted = this.persistTerminalDecision(project, experiment, decision, decidedAt);
      this.scheduleExpiry(project, experiment, expiresAt);
      return persisted;
    });
  }
}
