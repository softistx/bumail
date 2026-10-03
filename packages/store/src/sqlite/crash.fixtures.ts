import { Database } from 'bun:sqlite';
import { SqliteMailStore } from './store';

// Run as a process of its own by crash.spec.ts: adds a message and dies
// the moment its transaction would begin — after the content is written,
// before the row that names it commits — as a crash or a power cut would.

export const CRASHED = 7;
export const CONTENT = 'Subject: lost\r\n\r\nNever committed\r\n';

if (import.meta.main) {
	const [directory, accountId, mailboxId] = process.argv.slice(2) as [
		string,
		string,
		string,
	];
	const store = SqliteMailStore.open({ directory });
	Database.prototype.transaction = (() => () => process.exit(CRASHED)) as never;
	await store.addMessage(accountId, mailboxId, {
		content: new TextEncoder().encode(CONTENT),
	});
	process.exit(0);
}
