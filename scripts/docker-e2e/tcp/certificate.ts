/** TCP phase 4b: up on the volume, with the stored certificate and no new order. */
import { lineWith, textOf, until } from '../check';
import { logsOf } from '../compose';
import type { Context } from '../context';
import { tcpCompose } from './init';

export async function certificate(ctx: Context): Promise<void> {
	const tcp = tcpCompose(ctx);
	const up = await tcp('up', '--detach', 'bumail');
	if (up.exitCode !== 0) throw new Error(`up failed: ${textOf(up)}`);
	const second = await until('bumail serving again', 90, async () => {
		const log = await logsOf(tcp);
		return log.includes('bumail: serving') &&
			log.includes('tls: using the stored certificate')
			? log
			: undefined;
	}).catch(() => logsOf(tcp));
	ctx.report.check(
		'restarts on the volume with the stored certificate, no new order',
		second.includes('tls: using the stored certificate') &&
			!second.includes('tls: waiting for a certificate'),
		lineWith(second, 'stored certificate').slice(0, 160),
	);
}
