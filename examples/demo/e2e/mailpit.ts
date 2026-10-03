/**
 * Mailpit, the demo's default smarthost: started in Docker when nothing
 * answers on its API, stopped afterwards only if this run started it.
 */
import { $ } from 'bun';

export const MAILPIT_API = 'http://localhost:8025/api/v1';
const CONTAINER = 'bumail-mailpit';

async function answering(): Promise<boolean> {
	try {
		const response = await fetch(`${MAILPIT_API}/info`, {
			signal: AbortSignal.timeout(1000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Starts Mailpit unless it already runs; `true` when this call started it. */
export async function ensureMailpit(): Promise<boolean> {
	if (await answering()) return false;
	await $`docker run -d --rm --name ${CONTAINER} -p 8025:8025 -p 1025:1025 axllent/mailpit`.quiet();
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await answering()) return true;
		await Bun.sleep(250);
	}
	throw new Error('Mailpit did not answer on :8025 within 30 s');
}

export async function stopMailpit(): Promise<void> {
	await $`docker stop ${CONTAINER}`.quiet().nothrow();
}

interface Summary {
	readonly ID: string;
	readonly Subject: string;
}

/** The raw message whose Subject is `subject`, once Mailpit has it. */
export async function findMessage(
	subject: string,
	ms = 5000,
): Promise<string | undefined> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const list = (await (
			await fetch(`${MAILPIT_API}/messages?limit=100`)
		).json()) as { messages: Summary[] };
		const found = list.messages.find((message) => message.Subject === subject);
		if (found !== undefined) {
			return await (
				await fetch(`${MAILPIT_API}/message/${found.ID}/raw`)
			).text();
		}
		await Bun.sleep(200);
	}
	return undefined;
}
