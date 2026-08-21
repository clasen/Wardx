import { createWardx } from 'wardx';

const wardx = createWardx({
  endpoint: 'http://127.0.0.1:8787',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'client',
  appVersion: '0.1.0',
  environment: 'development'
});

wardx.log.info('match_started', { mode: 'ranked', players: 4 });
wardx.event('match.started', { mode: 'ranked', country: 'AR' });
wardx.counter('match.completed', { mode: 'ranked' }).inc();
wardx.gauge('players.online').set(12);
wardx.histogram('request.duration', { buckets: [10, 25, 50, 100, 250] }).observe(42);
const end = wardx.timer('matchmaking.duration');
end({ result: 'success' });

await wardx.flush();

const delay = wardx.config.get('message.delayMs', 1000, { subjectId: 'demo-user' });
wardx.experiment.goal('message.sent', { subjectId: 'demo-user' });

await wardx.flush();
await wardx.shutdown();
process.stdout.write(`flushed; message.delayMs=${delay}\n`);
