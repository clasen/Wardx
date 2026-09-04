const PROJECT = {
  type: 'string',
  minLength: 1,
  description: 'Project name as mapped from a Wardx project key.'
};

const ROLE = {
  type: 'string',
  minLength: 1,
  description:
    'Open client role name declared by an SDK instance, for example backend, frontend, desktop, or unity. Not *.'
};

const ROLES = {
  type: 'array',
  minItems: 1,
  items: { type: 'string', minLength: 1 },
  description:
    'Role names that receive this key or assign this experiment. Use ["*"] for every role that syncs.'
};

const EXPECTED_VERSION = {
  type: 'integer',
  minimum: 0,
  description: 'Current project config version required for optimistic concurrency.'
};

const REASON = { type: 'string', minLength: 1, description: 'Non-empty reason retained in the mutation journal.' };
const CATEGORY = {
  type: 'string',
  minLength: 1,
  description: 'Exact catalog category, for example business, performance, reliability, or security.'
};

export const TOOL_DEFS = [
  {
    name: 'list_projects',
    description: 'List project names isolated on this ingest server.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_project_overview',
    description:
      'Project description, onboarding gaps, catalog categories, Remote Config knobs (each with the roles that receive them), telemetry and clients grouped by role, inspectEvents/persistLogs allowlists, and previously proposed experiments. Optional category filters knobs and outcomes by exact catalog category. Outcomes include counters, events, histogram peaks (max + exemplar of the window max), and allowlisted persist log rollups (count + last exemplar). Each role may include optional path (local checkout) and git (repository URL). A predefined catalog can make onboarding.complete true. If it is false, ask only about the listed gaps and persist with set_project_description / set_role_description / set_signal before proposing experiments.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum counters, events, and histograms to return per kind, highest first.'
        },
        category: CATEGORY
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'set_project_description',
    description: 'Set the MCP-only project description. Advances the project version. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        description: { type: 'string' },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'description', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'set_role_description',
    description:
      'Set the MCP-only description for one client role in the project. Advances the project version. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        role: ROLE,
        description: { type: 'string', minLength: 1 },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'role', 'description', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'set_role_source',
    description:
      'Set optional source location for this role: path for a checkout on this machine, git for a repository URL. Provide one or both. Advances the project version. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        role: ROLE,
        path: {
          type: 'string',
          minLength: 1,
          description: 'Filesystem path of this role\'s source on the machine running the agent.'
        },
        git: {
          type: 'string',
          minLength: 1,
          description: 'Git remote URL for this role\'s source, when it is not a local checkout.'
        },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'role', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'set_signal',
    description:
      'Document one Remote Config key, metric, event, or log name with an optional category. Advances the project version. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
        category: CATEGORY,
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'name', 'description', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_signal',
    description: 'Remove one catalog signal. Advances the project version.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1 },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'name', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'set_inspect_event',
    description:
      'Add an exact event name to catalog.inspectEvents so its raw attrs and instance ID enter the bounded volatile recent-event ring. Advances the project version.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1, description: 'Exact event name to inspect.' },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'name', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_inspect_event',
    description:
      'Remove an event name from catalog.inspectEvents and purge its retained volatile samples. Advances the project version.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1 },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'name', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'set_persist_log',
    description:
      'Add a log message name to the catalog persistLogs allowlist. The server keeps a lifetime count and last exemplar for that name. Advances the project version. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1, description: 'Exact log message to persist.' },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'name', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_persist_log',
    description:
      'Remove a log message name from persistLogs and drop its lifetime rollup. Advances the project version.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1 },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'name', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'get_config',
    description: 'Read the Remote Config snapshot for a project: version, values, experiments.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'set_config_value',
    description:
      'Set one Remote Config key and the roles that receive it. Bumps configVersion so those clients receive the snapshot on the next sync. roles is ["*"] or a list of role names.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        key: { type: 'string', minLength: 1 },
        value: {},
        roles: ROLES,
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'key', 'value', 'roles', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_config_value',
    description: 'Delete one Remote Config key. Bumps configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        key: { type: 'string', minLength: 1 },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'key', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'list_experiments',
    description: 'List previously proposed experiment definitions for a project, including MCP-only hypothesis when set.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'upsert_experiment',
    description:
      'Propose or replace an experiment. experiment.roles lists which client roles assign it. variant.values may only contain Remote Config keys visible to those roles. Optional hypothesis stays on the server. A closable test declares the complete fixed-horizon plan and evidence-health thresholds before enablement. Bumps configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        experiment: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            enabled: { type: 'boolean' },
            allocation: { type: 'number', minimum: 0, maximum: 1 },
            salt: { type: 'string', minLength: 1 },
            roles: ROLES,
            primaryMetric: { type: 'string', minLength: 1 },
            goalMetric: {
              type: 'string',
              minLength: 1,
              description: 'Exact experiment.goal metric name for this experiment.'
            },
            hypothesis: { type: 'string', minLength: 1 },
            assignmentUnitKind: {
              type: 'string',
              minLength: 1,
              description: 'Stable deduplication unit kind, for example account or session.'
            },
            outcomeKind: {
              type: 'string',
              enum: ['conversion', 'mean'],
              description: 'conversion compares goals/exposures. mean compares goalMean. Required to ship.'
            },
            control: { type: 'string', minLength: 1, description: 'Baseline variant key. Required to ship.' },
            targetSampleSizePerVariant: {
              type: 'integer',
              minimum: 1,
              description: 'Fixed sample horizon per variant.'
            },
            earliestAnalysisAt: { type: 'integer', minimum: 0 },
            familyWiseAlpha: {
              type: 'number',
              exclusiveMinimum: 0,
              exclusiveMaximum: 1,
              description: 'Pre-registered family-wise alpha.'
            },
            minimumEffect: { type: 'number', minimum: 0 },
            direction: { type: 'string', enum: ['increase', 'decrease', 'two-sided'] },
            terminalRetentionMs: { type: 'integer', minimum: 1 },
            healthThresholds: {
              type: 'object',
              properties: {
                maxDroppedFrames: { type: 'integer', minimum: 0 },
                maxDuplicateExposures: { type: 'integer', minimum: 0 },
                maxDuplicateGoals: { type: 'integer', minimum: 0 },
                maxConflictingGoals: { type: 'integer', minimum: 0 },
                maxVariantConflicts: { type: 'integer', minimum: 0 },
                maxUntrustedRows: { type: 'integer', minimum: 0 },
                maxLateRows: { type: 'integer', minimum: 0 },
                maxMissingExposures: { type: 'integer', minimum: 0 },
                maxImplicitExposures: { type: 'integer', minimum: 0 }
              },
              required: [
                'maxDroppedFrames',
                'maxDuplicateExposures',
                'maxDuplicateGoals',
                'maxConflictingGoals',
                'maxVariantConflicts',
                'maxUntrustedRows',
                'maxLateRows',
                'maxMissingExposures',
                'maxImplicitExposures'
              ],
              additionalProperties: false
            },
            variants: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', minLength: 1 },
                  weight: { type: 'number', minimum: 0 },
                  values: { type: 'object' }
                },
                required: ['key', 'weight', 'values'],
                additionalProperties: false
              }
            }
          },
          required: [
            'id',
            'enabled',
            'allocation',
            'salt',
            'roles',
            'goalMetric',
            'assignmentUnitKind',
            'terminalRetentionMs',
            'variants'
          ],
          additionalProperties: false
        },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'experiment', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'set_experiment_enabled',
    description:
      'Enable or disable an experiment without rewriting variants. Does not copy a winner into Remote Config. Use ship_experiment to close a test. Bumps configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        id: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'id', 'enabled', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'ship_experiment',
    description:
      'Close a test: copy the winning variant values into Remote Config and disable the experiment. Refuses unless analyze_experiment decision.status is winner (or already shipped that variant). Omit variant to ship decision.leadingVariant. Bumps configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        experimentId: { type: 'string', minLength: 1 },
        variant: { type: 'string', minLength: 1, description: 'Must be the winning variant. Omit to ship leadingVariant.' },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'experimentId', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'get_aggregates',
    description:
      'Read 1-minute telemetry windows for a project, with catalog descriptions and categories on names. Distinct rows expose mergeable HLL estimates without identifiers or registers. Windows include logNames for catalog persistLogs (count + last exemplar). Optional names and category filters intersect; from, to, and role also filter the payload.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        names: { type: 'array', items: { type: 'string' } },
        from: { type: 'number' },
        to: { type: 'number' },
        role: ROLE,
        category: CATEGORY
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'get_aggregate_history',
    description: 'Read bounded closed hourly or daily aggregate history with catalog descriptions/categories and completeness metadata. Optional names and category filters intersect. Distinct rows expose merged HLL estimates without identifiers or registers.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        tier: { type: 'string', enum: ['hour', 'day'] },
        from: { type: 'integer' },
        to: { type: 'integer' },
        role: ROLE,
        environment: { type: 'string', minLength: 1 },
        appVersion: { type: 'string', minLength: 1 },
        names: { type: 'array', items: { type: 'string', minLength: 1 } },
        category: CATEGORY
      },
      required: ['project', 'tier', 'from', 'to'],
      additionalProperties: false
    }
  },
  {
    name: 'list_config_changes',
    description: 'List the bounded durable Remote Config mutation journal.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        after: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 }
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'rollback_config_change',
    description: 'Apply the inverse of one retained change as a new version and journal entry.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        changeId: { type: 'string', minLength: 1 },
        expectedVersion: EXPECTED_VERSION,
        reason: REASON
      },
      required: ['project', 'changeId', 'expectedVersion', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'get_recent_events',
    description:
      'Recent catalog.inspectEvents rows for one isolated project, newest timestamp first. Optional name, role, scalar attrs (exact match on listed keys), and limit. Rows include raw attrs and instanceId and exist only in the bounded in-memory ring. Events outside the allowlist remain aggregate counts only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1, description: 'Exact event name.' },
        attrs: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
          description: 'Exact match on these scalar attr keys, for example { "product": "premium" }.'
        },
        role: ROLE,
        limit: { type: 'integer', minimum: 1, description: 'Maximum rows to return, newest first.' }
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'get_recent_logs',
    description:
      'Recent log rows for a project, newest first. Drill from a series into a sample row. Optional level, message, attrs (exact match on listed keys), and limit.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
        message: { type: 'string', minLength: 1, description: 'Exact log message.' },
        attrs: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
          description: 'Exact match on these attr keys, for example { "code": "timeout" }.'
        },
        role: ROLE,
        limit: { type: 'integer', minimum: 1, description: 'Maximum rows to return, newest first.' }
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'analyze_experiment',
    description:
      'Experiment definition, trusted decision samples, all telemetry samples with source/trust provenance, evidence health, primaryMetric fleet total, and the persisted fixed-horizon decision. Do not call a variant the winner unless status is winner or shipped.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        experimentId: { type: 'string', minLength: 1 }
      },
      required: ['project', 'experimentId'],
      additionalProperties: false
    }
  }
];

export function executeTool(control, name, args = {}) {
  const mutation = {
    expectedVersion: args.expectedVersion,
    reason: args.reason,
    clientIdentity: args.clientIdentity
  };
  switch (name) {
    case 'list_projects':
      return { projects: control.listProjects() };
    case 'get_project_overview':
      return control.getOverview(args.project, args.limit, args.category);
    case 'set_project_description':
      return control.setProjectDescription(args.project, args.description, mutation);
    case 'set_role_description':
      return control.setRoleDescription(args.project, args.role, args.description, mutation);
    case 'set_role_source':
      return control.setRoleSource(args.project, args.role, { path: args.path, git: args.git }, mutation);
    case 'set_signal':
      return control.setSignal(args.project, args.name, {
        description: args.description,
        ...(args.category === undefined ? {} : { category: args.category })
      }, mutation);
    case 'delete_signal':
      return control.deleteSignal(args.project, args.name, mutation);
    case 'set_inspect_event':
      return control.setInspectEvent(args.project, args.name, mutation);
    case 'delete_inspect_event':
      return control.deleteInspectEvent(args.project, args.name, mutation);
    case 'set_persist_log':
      return control.setPersistLog(args.project, args.name, mutation);
    case 'delete_persist_log':
      return control.deletePersistLog(args.project, args.name, mutation);
    case 'get_config':
      return control.getConfig(args.project);
    case 'set_config_value':
      return control.setValue(args.project, args.key, args.value, args.roles, mutation);
    case 'delete_config_value':
      return control.deleteValue(args.project, args.key, mutation);
    case 'list_experiments':
      return { experiments: control.listExperiments(args.project) };
    case 'upsert_experiment':
      return control.upsertExperiment(args.project, args.experiment, mutation);
    case 'set_experiment_enabled':
      return control.setExperimentEnabled(args.project, args.id, args.enabled, mutation);
    case 'get_aggregates':
      return {
        windows: control.aggregates(args.project, {
          names: args.names,
          from: args.from,
          to: args.to,
          role: args.role,
          category: args.category
        })
      };
    case 'get_recent_events':
      return {
        events: control.recentEvents(args.project, {
          name: args.name,
          attrs: args.attrs,
          role: args.role,
          limit: args.limit
        })
      };
    case 'get_recent_logs':
      return {
        logs: control.recentLogs(args.project, {
          level: args.level,
          message: args.message,
          attrs: args.attrs,
          role: args.role,
          limit: args.limit
        })
      };
    case 'get_aggregate_history':
      return control.aggregateHistory(args.project, {
        tier: args.tier,
        from: args.from,
        to: args.to,
        role: args.role,
        environment: args.environment,
        appVersion: args.appVersion,
        names: args.names,
        category: args.category
      });
    case 'list_config_changes':
      return control.listConfigChanges(args.project, { after: args.after, limit: args.limit });
    case 'rollback_config_change':
      return control.rollbackConfigChange(args.project, args.changeId, mutation);
    case 'analyze_experiment':
      return control.analyzeExperiment(args.project, args.experimentId);
    case 'ship_experiment':
      return control.shipExperiment(args.project, args.experimentId, args.variant, mutation);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

export function toolError(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
  };
}
