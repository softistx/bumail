/** Standalone phase 0a: `bumail init` and a user, then up. */
import { lineWith, textOf } from '../check';
import { standaloneCompose } from '../compose';
import {
	type Context,
	DOMAIN,
	PEBBLE_DIRECTORY,
	STANDALONE_HOST,
} from '../context';
import { addHost } from '../infrastructure';

export async function init(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	console.log(
		'== 0: the standalone variant (compose.yaml): bumail binds 80 itself',
	);
	await addHost(ctx, STANDALONE_HOST, ctx.ips.standalone);
	const alone = standaloneCompose(ctx);
	const done = await alone(
		'run',
		'--rm',
		'-T',
		'bumail',
		'init',
		'--hostname',
		STANDALONE_HOST,
		'--domain',
		DOMAIN,
		'--acme-directory',
		PEBBLE_DIRECTORY,
	);
	report.check(
		'standalone: bumail init with the flags the guide uses',
		done.exitCode === 0 && textOf(done).includes('wrote /data/bumail.toml'),
		lineWith(textOf(done), 'wrote'),
	);
	const added = await alone.stdin(
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
		'standalone: bumail user add',
		added.exitCode === 0 && textOf(added).includes(`added the user ${user}`),
		textOf(added).trim(),
	);
	const up = await alone('up', '--detach', 'bumail');
	if (up.exitCode !== 0) throw new Error(`standalone up failed: ${textOf(up)}`);
}
