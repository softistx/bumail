/**
 * A worker process for `processes.spec.ts`: opens the store in the
 * directory given, waits for the go file, claims until nothing is left,
 * and prints the ids it claimed as JSON.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteQueueStore } from './store';

const [directory, owner] = process.argv.slice(2) as [string, string];
const store = SqliteQueueStore.open({ directory, busyTimeout: 10_000 });
while (!existsSync(join(directory, 'go'))) await Bun.sleep(2);
const claimed: string[] = [];
for (;;) {
	const item = await store.claim({ owner, now: Date.now(), leaseMs: 600_000 });
	if (!item) break;
	claimed.push(item.id);
}
store.close();
console.log(JSON.stringify(claimed));
