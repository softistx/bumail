/** TCP phase 4a: replace the direct bumail, and `init --force --proxy-protocol` on the same volume. */
import { lineWith, textOf } from '../check';
import { traefikCompose } from '../compose';
import type { Context } from '../context';
import { behindTraefik, directCompose, initArgs } from '../traefik/init';

export const tcpCompose = (ctx: Context) =>
	traefikCompose(ctx, 'compose.traefik-tcp');

export async function init(ctx: Context): Promise<void> {
	const { report } = ctx;
	console.log(
		'== 4: the TCP variant, PROXY protocol v2, the real client address',
	);
	const stop = await directCompose(ctx)('rm', '--stop', '--force', 'bumail');
	if (stop.exitCode !== 0) {
		throw new Error(`removing the direct bumail failed: ${textOf(stop)}`);
	}
	const tcp = tcpCompose(ctx);
	const done = await tcp(
		'run',
		'--rm',
		'-T',
		'bumail',
		...initArgs(),
		'--force',
		...behindTraefik(ctx),
		'--proxy-protocol',
	);
	const text = textOf(done);
	report.check(
		'bumail init --force with --proxy-protocol keeps the domain and the key',
		done.exitCode === 0 &&
			text.includes('kept') &&
			text.includes('wrote /data/bumail.toml'),
		text
			.split('\n')
			.filter((l) => l.includes('kept'))
			.join(' | ')
			.slice(0, 200),
	);
	const config = await tcp('run', '--rm', '-T', 'bumail', 'check-config');
	report.check(
		'check-config shows the PROXY protocol',
		config.exitCode === 0 &&
			/mail proxies\s+1 trusted prox/.test(textOf(config)),
		lineWith(textOf(config), 'mail proxies'),
	);
}
