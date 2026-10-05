/** Standalone phase 0b: the certificate, with the CA reaching bumail's own port 80. */
import { lineWith, until } from '../check';
import { logsOf, standaloneCompose } from '../compose';
import type { Context } from '../context';

export async function certificate(ctx: Context): Promise<void> {
	const alone = standaloneCompose(ctx);
	const logs = () => logsOf(alone);
	const log = await until('the standalone certificate', 120, async () => {
		const text = await logs();
		return text.includes('tls: obtained (') ? text : undefined;
	}).catch(logs);
	ctx.report.check(
		"standalone: the certificate was obtained, the CA reaching bumail's own port 80",
		log.includes('tls: obtained (') &&
			log.includes('acme: the CA fetched the challenge'),
		lineWith(log, 'tls: obtained') || log.slice(-300),
	);
	await until('standalone serving', 60, async () =>
		(await logs()).includes('bumail: serving'),
	);
}
