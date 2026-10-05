#!/usr/bin/env bun
/**
 * The Docker image and the deploy files, end to end, on this machine's
 * Docker: builds the image, starts its own Traefik v3, Pebble (an ACME test
 * CA that validates for real) and pebble-challtestsrv (its DNS) under a
 * compose project named for this run, on a network of its own and on high
 * ports of 127.0.0.1, then runs the deploy guide's steps against each
 * deploy file. The phases are in `docker-e2e/`:
 *
 *   context     names, addresses and ports unique to this run
 *   compose     docker compose and docker run, on this run's project and network
 *   infrastructure  the image, the network, Pebble, the test DNS and Traefik
 *   standalone  `compose.yaml`: bumail binds 80 itself; `bumail dns`, and `dns --check` in part
 *   traefik     `compose.traefik.yaml`: init, the certificate through the challenge route, the mail ports, JMAP, health
 *   tcp         `compose.traefik-tcp.yaml`: TCP routers, PROXY protocol v2, the real client address
 *   teardown    everything made, removed, also on SIGINT and SIGTERM
 *
 * It never touches another container. Needs Docker with Compose v2.24 or
 * later; the images in `deploy/test/e2e.yaml` are pulled if missing. Set
 * `E2E_KEEP=1` to leave everything running for a look.
 *
 *   bun run docker:e2e       (from the repository root)
 */
import { Report } from './docker-e2e/check';
import { createContext } from './docker-e2e/context';
import { prepare, startInfrastructure } from './docker-e2e/infrastructure';
import { standalone } from './docker-e2e/standalone';
import { tcpVariant } from './docker-e2e/tcp';
import { teardown } from './docker-e2e/teardown';
import { traefikVariant } from './docker-e2e/traefik';

const report = new Report();
const ctx = createContext(report);
console.log(
	`== run ${ctx.suffix}: project ${ctx.project}, network ${ctx.network} ${ctx.subnet}, work dir ${ctx.work}`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		console.log(`\n${signal}: tearing down`);
		void teardown(ctx).finally(() =>
			process.exit(signal === 'SIGINT' ? 130 : 143),
		);
	});
}

try {
	await prepare(ctx);
	await startInfrastructure(ctx);
	await standalone(ctx);
	await traefikVariant(ctx);
	await tcpVariant(ctx);
} catch (error) {
	report.check(
		'the end-to-end run itself',
		false,
		error instanceof Error ? error.message : String(error),
	);
} finally {
	if (process.env['E2E_KEEP'] === '1') {
		console.log(
			`== E2E_KEEP=1: left running; remove with: docker compose -p ${ctx.project} down -v; docker network rm ${ctx.network}`,
		);
	} else {
		console.log('== teardown');
		await teardown(ctx);
	}
}
process.exit(report.summary() ? 0 : 1);
