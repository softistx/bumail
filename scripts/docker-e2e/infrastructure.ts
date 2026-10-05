/**
 * The infrastructure the deploy files run against: the image, the network,
 * Pebble (an ACME test CA that validates for real), pebble-challtestsrv (its
 * DNS) and Traefik.
 */
import { $ } from 'bun';
import { must, textOf, until } from './check';
import { inNetwork, traefikCompose } from './compose';
import { CLIENT_IMAGE, type Context, HOST, ROOT } from './context';

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
