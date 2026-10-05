/** `docker compose` and `docker run` on this run's project and network. */
import { $ } from 'bun';
import { type Context, ROOT, STANDALONE_HOST } from './context';

/** A `docker compose` of one project: `(...args)`, and `.stdin(text, ...args)` with `text` piped in. */
export interface Compose {
	(...args: string[]): ReturnType<typeof $>;
	stdin(text: string, ...args: string[]): ReturnType<typeof $>;
}

/** `docker compose` on a deploy file and the test's own, in a project; failures are returned, not thrown. */
export function composeOf(
	ctx: Context,
	project: string,
	files: readonly string[],
	env: Record<string, string | undefined> = {},
): Compose {
	const args = files.flatMap((file) => ['-f', file]);
	const full = { ...ctx.env, ...env };
	const run = (...rest: string[]) =>
		$`docker compose -p ${project} ${args} ${rest}`.env(full).nothrow().quiet();
	run.stdin = (text: string, ...rest: string[]) =>
		$`echo ${text} | docker compose -p ${project} ${args} ${rest}`
			.env(full)
			.nothrow()
			.quiet();
	return run;
}

/** The Traefik variants: `compose.traefik.yaml` or `compose.traefik-tcp.yaml`, with the test's own. */
export function traefikCompose(
	ctx: Context,
	variant: string,
	extra: readonly string[] = [],
) {
	return composeOf(ctx, ctx.project, [
		`${ROOT}/deploy/${variant}.yaml`,
		`${ROOT}/deploy/test/e2e.yaml`,
		...extra,
	]);
}

/** The standalone variant: `compose.yaml`, in a project of its own. */
export function standaloneCompose(ctx: Context) {
	return composeOf(
		ctx,
		ctx.standaloneProject,
		[
			`${ROOT}/deploy/compose.yaml`,
			`${ROOT}/deploy/test/e2e-standalone.yaml`,
			`${ctx.work}/standalone-ports.yaml`,
		],
		{ BUMAIL_HOST: STANDALONE_HOST },
	);
}

/** A bun script run in a container on the test network, at an address of its own. */
export async function inNetwork(ctx: Context, args: string[], ip?: string) {
	const address = ip === undefined ? [] : ['--ip', ip];
	return $`docker run --rm --network ${ctx.network} ${address} ${args}`
		.nothrow()
		.quiet();
}

/** What `service` logged so far, without compose's prefix. */
export async function logsOf(
	compose: Compose,
	service = 'bumail',
): Promise<string> {
	const out = await compose('logs', '--no-color', '--no-log-prefix', service);
	return `${out.stdout.toString()}${out.stderr.toString()}`;
}
