import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CredentialAuthorizationError,
  CredentialRegistry
} from '../src/auth/CredentialRegistry.js';

const RAW_FRONTEND_KEY = 'raw-frontend-secret';
const RAW_BACKEND_KEY = 'raw-backend-secret';

function records() {
  return {
    [RAW_FRONTEND_KEY]: {
      project: 'demo',
      label: 'public-web',
      allowedRoles: ['frontend'],
      trustedForDecisions: false,
      enabled: true
    },
    [RAW_BACKEND_KEY]: {
      project: 'demo',
      label: 'orders-service',
      allowedRoles: ['backend', 'worker'],
      trustedForDecisions: true,
      enabled: true
    },
    'disabled-secret': {
      project: 'demo',
      label: 'retired-client',
      allowedRoles: ['frontend'],
      trustedForDecisions: false,
      enabled: false
    }
  };
}

test('CredentialRegistry resolves server-side role and trust metadata without exposing the key', () => {
  const registry = new CredentialRegistry(records());
  const frontend = registry.resolve(RAW_FRONTEND_KEY, 'frontend');
  const backend = registry.resolve(RAW_BACKEND_KEY, 'backend');

  assert.deepEqual(frontend, {
    project: 'demo',
    label: 'public-web',
    role: 'frontend',
    trustedForDecisions: false
  });
  assert.equal(backend.trustedForDecisions, true);
  assert.equal(backend.role, 'backend');
  assert.doesNotMatch(JSON.stringify([frontend, backend]), /raw-frontend-secret|raw-backend-secret/);
});

test('CredentialRegistry rejects role escalation, disabled credentials, and rotated keys without leaking them', () => {
  const registry = new CredentialRegistry(records());
  assert.throws(
    () => registry.resolve(RAW_FRONTEND_KEY, 'backend'),
    (error) => error instanceof CredentialAuthorizationError && error.code === 'role_not_allowed'
  );
  assert.throws(
    () => registry.resolve('disabled-secret', 'frontend'),
    (error) => error instanceof CredentialAuthorizationError && error.code === 'disabled_credential'
  );

  const rotated = new CredentialRegistry({
    'replacement-secret': {
      project: 'demo',
      label: 'public-web-v2',
      allowedRoles: ['frontend'],
      trustedForDecisions: false,
      enabled: true
    }
  });
  let rejected;
  try {
    rotated.resolve(RAW_FRONTEND_KEY, 'frontend');
  } catch (error) {
    rejected = error;
  }
  assert.equal(rejected.code, 'unknown_credential');
  assert.doesNotMatch(rejected.message, new RegExp(RAW_FRONTEND_KEY));
  assert.equal(rotated.resolve('replacement-secret', 'frontend').label, 'public-web-v2');
});

test('CredentialRegistry requires the complete strict credential schema', () => {
  const missingTrust = records();
  delete missingTrust[RAW_FRONTEND_KEY].trustedForDecisions;
  assert.throws(() => new CredentialRegistry(missingTrust), /trustedForDecisions is required/);

  const wildcard = records();
  wildcard[RAW_FRONTEND_KEY].allowedRoles = ['*'];
  assert.throws(() => new CredentialRegistry(wildcard), /cannot contain \*/);

  const extra = records();
  extra[RAW_FRONTEND_KEY].rawKey = 'must-not-be-record-metadata';
  assert.throws(() => new CredentialRegistry(extra), /unknown key: rawKey/);
});
