/** Removes everything this run made, whatever happened. */
import { rmSync } from 'node:fs';
import { $ } from 'bun';
import { standaloneCompose, traefikCompose } from './compose';
import type { Context } from './context';

let pending: Promise<void> | undefined;

/**
 * The teardown, once: a second call (a signal during the `finally`, or the
 * `finally` after a signal) awaits the same one instead of returning early.
 */
export function teardown(ctx: Context): Promise<void> {
	pending ??= removeAll(ctx);
	return pending;
}

async function removeAll(ctx: Context): Promise<void> {
	const down = ['down', '--volumes', '--remove-orphans', '--timeout', '30'];
	await standaloneCompose(ctx)(...down);
	for (const variant of ['compose.traefik-tcp', 'compose.traefik']) {
		await traefikCompose(ctx, variant)(...down);
	}
	await $`docker network rm ${ctx.network}`.nothrow().quiet();
	await $`docker rmi ${ctx.image}`.nothrow().quiet();
	rmSync(ctx.work, { recursive: true, force: true });
}
