/** The e2e's report, and the small helpers its phases share. */

export interface Result {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

export class Report {
	readonly results: Result[] = [];

	/** Records and prints one check: `ok` must be a condition measured, never a constant. */
	check(name: string, ok: boolean, detail = ''): void {
		this.results.push({ name, ok, detail });
		console.log(
			`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
		);
	}

	get failed(): Result[] {
		return this.results.filter((result) => !result.ok);
	}

	/** Prints the totals; answers whether every check passed. */
	summary(): boolean {
		const failed = this.failed;
		console.log(
			`\n${this.results.length - failed.length} of ${this.results.length} checks passed`,
		);
		for (const f of failed) console.log(`FAILED: ${f.name}  ${f.detail}`);
		return failed.length === 0;
	}
}

/** What a finished Bun shell command printed, stdout then stderr. */
export interface Output {
	readonly exitCode: number;
	readonly stdout: { toString(): string };
	readonly stderr: { toString(): string };
}

export const textOf = (out: Output): string =>
	`${out.stdout.toString()}${out.stderr.toString()}`;

/** Throws when `out` failed: a step the run cannot go on without. */
export function must(out: Output, what: string): Output {
	if (out.exitCode !== 0) {
		throw new Error(
			`${what} failed (exit ${out.exitCode}): ${textOf(out).slice(-600)}`,
		);
	}
	return out;
}

/** Polls `probe` every second until it answers something, or throws after `seconds`. */
export async function until<T>(
	what: string,
	seconds: number,
	probe: () => Promise<T | undefined | false>,
): Promise<T> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const found = await probe().catch(() => undefined);
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(1000);
	}
}

/** `first` line of `text` containing `part`, trimmed, for a check's detail. */
export const lineWith = (text: string, part: string): string =>
	text
		.split('\n')
		.find((line) => line.includes(part))
		?.trim()
		.slice(0, 220) ?? '';

/** `n` ports free on 127.0.0.1 now. */
export function freePorts(n: number): number[] {
	const servers = Array.from({ length: n }, () =>
		Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(''),
		}),
	);
	const ports = servers.map((server) => server.port as number);
	for (const server of servers) server.stop(true);
	return ports;
}
