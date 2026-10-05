/** Traefik phase 1: `bumail init`, `check-config` and a user (the guide, steps 3 and 4). */
import { lineWith, textOf } from '../check';
import { traefikCompose } from '../compose';
import { type Context, DOMAIN, HOST, PEBBLE_DIRECTORY } from '../context';

/** The init flags of the guide's Traefik variants, for this run's network. */
export const initArgs = (): string[] => [
	'init',
	'--hostname',
	HOST,
	'--domain',
	DOMAIN,
	'--acme-email',
	`postmaster@${DOMAIN}`,
	'--acme-directory',
	PEBBLE_DIRECTORY,
];

export const behindTraefik = (ctx: Context): string[] => [
	'--behind-traefik',
	'--trusted-proxy',
	ctx.subnet,
];

export const directCompose = (ctx: Context) =>
	traefikCompose(ctx, 'compose.traefik', [`${ctx.work}/ports.yaml`]);

export async function init(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	const direct = directCompose(ctx);
	console.log('== 1: init and a user (the guide, steps 3 and 4)');
	const args = [...initArgs(), ...behindTraefik(ctx)];
	const first = await direct('run', '--rm', '-T', 'bumail', ...args);
	report.check(
		'bumail init writes the configuration and the DKIM key',
		first.exitCode === 0 &&
			textOf(first).includes('wrote /data/bumail.toml') &&
			textOf(first).includes('generated an RSA-2048 DKIM key'),
		lineWith(textOf(first), 'wrote'),
	);
	const again = await direct('run', '--rm', '-T', 'bumail', ...args);
	report.check(
		'bumail init refuses to overwrite',
		again.exitCode === 4 &&
			textOf(again).includes('exists; --force replaces it'),
		`exit ${again.exitCode}; ${lineWith(textOf(again), 'exists')}`,
	);
	const config = await direct('run', '--rm', '-T', 'bumail', 'check-config');
	report.check(
		'bumail check-config accepts it',
		config.exitCode === 0 && textOf(config).includes('/data/bumail.toml: ok'),
		lineWith(textOf(config), 'ok'),
	);
	const added = await direct.stdin(
		password,
		'run',
		'--rm',
		'-T',
		'bumail',
		'user',
		'add',
		user,
		'--password-stdin',
	);
	report.check(
		'bumail user add',
		added.exitCode === 0 && textOf(added).includes(`added the user ${user}`),
		textOf(added).trim().split('\n')[0] ?? '',
	);
}
