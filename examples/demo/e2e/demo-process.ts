/**
 * Runs `main.ts` as its own process, as the owner would, and waits for its
 * `DEMO READY` line.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoInfo } from '../src/demo';

export interface DemoProcess {
	readonly info: DemoInfo;
	/** What the demo printed, for a failure's context. */
	readonly output: string[];
	stop(): Promise<void>;
}

export async function spawnDemo(password: string): Promise<DemoProcess> {
	const directory = mkdtempSync(join(tmpdir(), 'bumail-e2e-'));
	const child = Bun.spawn(['bun', join(import.meta.dir, '../main.ts')], {
		env: { ...Bun.env, DEMO_PASSWORD: password, DEMO_DIR: directory },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const output: string[] = [];
	let ready: (info: DemoInfo) => void = () => {};
	const started = new Promise<DemoInfo>((resolve) => {
		ready = resolve;
	});

	async function drain(stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder();
		let pending = '';
		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				output.push(line);
				if (line.startsWith('DEMO READY ')) {
					ready(JSON.parse(line.slice('DEMO READY '.length)) as DemoInfo);
				}
			}
		}
	}
	void drain(child.stdout);
	void drain(child.stderr);

	const info = await Promise.race([
		started,
		child.exited.then((code) => {
			throw new Error(
				`the demo exited with ${code} before it was ready:\n${output.join('\n')}`,
			);
		}),
		Bun.sleep(15_000).then(() => {
			throw new Error(`the demo was not ready in 15 s:\n${output.join('\n')}`);
		}),
	]);

	return {
		info,
		output,
		async stop() {
			child.kill('SIGTERM');
			const exited = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(5000).then(() => false),
			]);
			if (!exited) child.kill('SIGKILL');
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
