import { ModelCapacityLeaseManager } from './model-capacity.js';

const [databasePath, provider, model] = process.argv.slice(2);
const manager = new ModelCapacityLeaseManager({ databasePath });
const lease = await manager.tryAcquire({ provider, model }, 1);
if (lease === undefined) {
  process.stdout.write('BUSY\n');
  process.exit(2);
}
process.stdout.write('ACQUIRED\n');
setInterval(() => {}, 60_000);
