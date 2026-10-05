/**
 * The e2e's context and its setup: names and addresses unique to this run
 * (so two runs never clobber each other), the image, the network, and the
 * infrastructure the deploy files run against: Pebble (an ACME test CA that
 * validates for real), pebble-challtestsrv (its DNS) and Traefik.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { freePorts, must, type Report, textOf, until } from './check';

export const ROOT = new URL('../..', import.meta.url).pathname.replace(
	/\/$/,
	'',
);
export const DOMAIN = 'bumail.test';
export const HOST = 'mail.bumail.test';
export const STANDALONE_HOST = 'standalone.bumail.test';
export const PEBBLE_DIRECTORY = 'https://pebble:14000/dir';
export const CLIENT_IMAGE =
	'oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895';
export const PASSWORD_PREFIX = 'e2e';

export interface Context {
	readonly report: Report;
	readonly suffix: string;
	/** The project of the Traefik variants and of the infrastructure. */
	readonly project: string;
	readonly standaloneProject: string;
	readonly network: string;
	/** `172.29.<n>.0/24`, picked for this run. */
	readonly subnet: string;
	readonly ips: {
		traefik: string;
		challtestsrv: string;
		standalone: string;
		client: string;
	};
	/** Host ports on 127.0.0.1, free when chosen. */
	readonly ports: {
		mx: number;
		submissions: number;
		submission: number;
		imaps: number;
		jmapDirect: number;
		jmapTraefik: number;
		tcpMx: number;
		tcpSubmissions: number;
		tcpSubmission: number;
		tcpImaps: number;
		challtestsrv: number;
	};
	readonly image: string;
	readonly work: string;
	readonly password: string;
	readonly user: string;
	/** Tags this run's messages. */
	readonly run: string;
	readonly env: Record<string, string | undefined>;
}

export function createContext(report: Report): Context {
	const suffix = crypto.randomUUID().slice(0, 6);
	const octet = 20 + Math.floor(Math.random() * 200);
	const prefix = `172.29.${octet}`;
	const [
		mx,
		submissions,
		submission,
		imaps,
		jmapDirect,
		jmapTraefik,
		tcpMx,
		tcpSubmissions,
		tcpSubmission,
		tcpImaps,
		challtestsrv,
	] = freePorts(11) as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const work = mkdtempSync(join(tmpdir(), 'bumail-e2e-'));
	const network = `bumail-e2e-proxy-${suffix}`;
	const project = `bumail-e2e-docker-${suffix}`;
	const ips = {
		traefik: `${prefix}.200`,
		challtestsrv: `${prefix}.250`,
		standalone: `${prefix}.150`,
		client: `${prefix}.99`,
	};
	const ports = {
		mx,
		submissions,
		submission,
		imaps,
		jmapDirect,
		jmapTraefik,
		tcpMx,
		tcpSubmissions,
		tcpSubmission,
		tcpImaps,
		challtestsrv,
	};
	const image = `bumail:e2e-docker-${suffix}`;
	return {
		report,
		suffix,
		project,
		standaloneProject: `${project}-standalone`,
		network,
		subnet: `${prefix}.0/24`,
		ips,
		ports,
		image,
		work,
		password: `${PASSWORD_PREFIX}-${crypto.randomUUID().slice(0, 12)}`,
		user: `alice@${DOMAIN}`,
		run: crypto.randomUUID().slice(0, 8),
		env: {
			...process.env,
			COMPOSE_FILE: '',
			TRAEFIK_NETWORK: network,
			BUMAIL_HOST: HOST,
			BUMAIL_IMAGE: image,
			E2E_DIR: work,
			E2E_NETWORK: network,
			E2E_IP_TRAEFIK: ips.traefik,
			E2E_IP_CHALLTESTSRV: ips.challtestsrv,
			E2E_IP_STANDALONE: ips.standalone,
			E2E_PORT_HTTPS: String(jmapTraefik),
			E2E_PORT_SMTP: String(tcpMx),
			E2E_PORT_SUBMISSIONS: String(tcpSubmissions),
			E2E_PORT_SUBMISSION: String(tcpSubmission),
			E2E_PORT_IMAPS: String(tcpImaps),
			E2E_PORT_CHALLTESTSRV: String(challtestsrv),
		},
	};
}

/** `docker compose` on a deploy file and the test's own, in a project; failures are returned, not thrown. */
export function composeOf(
	ctx: Context,
	project: string,
	files: readonly string[],
	env: Record<string, string | undefined> = {},
) {
	const args = files.flatMap((file) => ['-f', file]);
	return (...rest: string[]) =>
		$`docker compose -p ${project} ${args} ${rest}`
			.env({ ...ctx.env, ...env })
			.nothrow()
			.quiet();
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

/** Whether `url` answers, asked from inside the network, where Pebble's ports are not published. */
async function answersInside(ctx: Context, url: string): Promise<boolean> {
	const script = `fetch(${JSON.stringify(url)}, {tls:{rejectUnauthorized:false}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`;
	const out = await inNetwork(ctx, [CLIENT_IMAGE, 'bun', '-e', script]);
	return out.exitCode === 0;
}

/** Builds the image, makes the network and the generated files. */
export async function prepare(ctx: Context): Promise<void> {
	const { report } = ctx;
	mustNetwork(
		await $`docker network create --subnet ${ctx.subnet} ${ctx.network}`
			.nothrow()
			.quiet(),
	);
	const built = await $`docker build -t ${ctx.image} ${ROOT}`.nothrow().quiet();
	report.check(
		'docker build',
		built.exitCode === 0,
		built.exitCode === 0 ? ctx.image : textOf(built).slice(-500),
	);
	must(built, 'docker build');
	const size =
		await $`docker image inspect ${ctx.image} --format ${'{{.Size}}'}`.text();
	report.check(
		'image size',
		Number(size) > 0,
		`${(Number(size) / 1e6).toFixed(0)} MB (docker image inspect)`,
	);
	const user = (
		await $`docker image inspect ${ctx.image} --format ${'{{.Config.User}}'}`.text()
	).trim();
	report.check('runs as a non-root user', user === '10001:10001', user);

	// Traefik's static file, for this run's project and network.
	const template = await Bun.file(`${ROOT}/deploy/test/traefik.yml`).text();
	await Bun.write(
		`${ctx.work}/traefik.yml`,
		template
			.replaceAll('@PROJECT@', ctx.project)
			.replaceAll('@NETWORK@', ctx.network),
	);
	const high = (name: keyof Context['ports']) => ctx.ports[name];
	const lines = (pairs: [number, number][]) =>
		pairs
			.map(([outside, inside]) => `      - '127.0.0.1:${outside}:${inside}'\n`)
			.join('');
	// The deploy files publish 25, 465, 587 and 993 (and 80 and 443): the test publishes high ports instead.
	await Bun.write(
		`${ctx.work}/ports.yaml`,
		`services:\n  bumail:\n    ports: !override\n${lines([
			[high('mx'), 25],
			[high('submissions'), 465],
			[high('submission'), 587],
			[high('imaps'), 993],
		])}`,
	);
	await Bun.write(
		`${ctx.work}/standalone-ports.yaml`,
		`services:\n  bumail:\n    ports: !override\n${lines([
			[high('mx'), 25],
			[high('submissions'), 465],
			[high('submission'), 587],
			[high('imaps'), 993],
			[high('jmapDirect'), 443],
		])}`,
	);
}

function mustNetwork(out: {
	exitCode: number;
	stderr: { toString(): string };
}): void {
	if (out.exitCode !== 0)
		throw new Error(`docker network create failed: ${out.stderr}`);
}

/** Starts Pebble, the test DNS and Traefik; waits until they answer, from inside the network. */
export async function startInfrastructure(ctx: Context): Promise<void> {
	const { report } = ctx;
	const direct = traefikCompose(ctx, 'compose.traefik', [
		`${ctx.work}/ports.yaml`,
	]);
	// Pebble's CA is a file of its image, which bumail and Traefik read at start:
	// make the containers, copy it out, then start.
	must(
		await direct('create', 'pebble', 'challtestsrv'),
		'creating Pebble and the test DNS',
	);
	const pebble = textOf(
		must(await direct('ps', '--all', '--quiet', 'pebble'), 'finding Pebble'),
	).trim();
	must(
		await $`docker cp ${pebble}:/test/certs/pebble.minica.pem ${ctx.work}/minica.pem`
			.nothrow()
			.quiet(),
		'copying the test CA',
	);
	must(
		await direct('up', '--detach', 'traefik', 'pebble', 'challtestsrv'),
		'starting the infrastructure',
	);
	await until('the challtestsrv API', 30, async () => {
		const answer = await fetch(
			`http://127.0.0.1:${ctx.ports.challtestsrv}/`,
		).catch(() => undefined);
		return answer !== undefined;
	});
	await addHost(ctx, HOST, ctx.ips.traefik);
	await until('Pebble, asked from inside the network', 60, () =>
		answersInside(ctx, 'https://pebble:14000/dir'),
	);
	const dns = await answersInside(ctx, 'https://pebble:15000/roots/0');
	report.check(
		'Pebble answers from inside the network',
		dns,
		'directory on 14000, roots on 15000',
	);
	const route =
		await $`docker inspect ${await traefikId(ctx)} --format ${'{{.State.Running}}'}`
			.nothrow()
			.quiet();
	report.check(
		'Traefik is running',
		route.stdout.toString().trim() === 'true',
		`${HOST} -> ${ctx.ips.traefik}`,
	);
}

async function traefikId(ctx: Context): Promise<string> {
	const out = await traefikCompose(ctx, 'compose.traefik')(
		'ps',
		'--quiet',
		'traefik',
	);
	return textOf(out).trim();
}

/** Points `name` at `address` in the test DNS. */
export async function addHost(
	ctx: Context,
	name: string,
	address: string,
): Promise<void> {
	const answer = await fetch(
		`http://127.0.0.1:${ctx.ports.challtestsrv}/add-a`,
		{
			method: 'POST',
			body: JSON.stringify({ host: `${name}.`, addresses: [address] }),
		},
	);
	if (!answer.ok)
		throw new Error(`the test DNS refused ${name}: HTTP ${answer.status}`);
}
