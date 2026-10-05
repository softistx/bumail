/** Removes everything this run made, whatever happened. */
import { rmSync } from 'node:fs';
import { $ } from 'bun';
import { type Context, standaloneCompose, traefikCompose } from './setup';

let done = false;

export async function teardown(ctx: Context): Promise<void> {
	if (done) return;
	done = true;
	const down = ['down', '--volumes', '--remove-orphans', '--timeout', '30'];
	await standaloneCompose(ctx)(...down);
	for (const variant of ['compose.traefik-tcp', 'compose.traefik']) {
		await traefikCompose(ctx, variant)(...down);
	}
	await $`docker network rm ${ctx.network}`.nothrow().quiet();
	await $`docker rmi ${ctx.image}`.nothrow().quiet();
	rmSync(ctx.work, { recursive: true, force: true });
}
