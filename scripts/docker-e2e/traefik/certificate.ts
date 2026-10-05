/** Traefik phase 2: up, and the certificate through Traefik's challenge route. */
import { lineWith, textOf, until } from '../check';
import { logsOf } from '../compose';
import type { Context } from '../context';
import { directCompose } from './init';

export async function certificate(ctx: Context): Promise<void> {
	const { report } = ctx;
	const direct = directCompose(ctx);
	console.log('== 2: up, and the certificate through the challenge route');
	const up = await direct('up', '--detach', 'bumail');
	if (up.exitCode !== 0) throw new Error(`up failed: ${textOf(up)}`);
	const started = await until('the certificate', 120, async () => {
		const log = await logsOf(direct);
		return log.includes('tls: obtained (') ? log : undefined;
	}).catch(() => logsOf(direct));
	report.check(
		'the certificate was obtained from the CA',
		started.includes('tls: obtained ('),
		lineWith(started, 'tls: obtained') || started.slice(-300),
	);
	report.check(
		'the CA fetched the challenge (through Traefik)',
		started.includes('acme: the CA fetched the challenge'),
		lineWith(started, 'the CA fetched'),
	);
	const traefikLog = await logsOf(direct, 'traefik');
	report.check(
		'Traefik routed it with the bumail-acme router',
		/acme-challenge[^\n]*bumail-acme@docker/.test(traefikLog),
		lineWith(traefikLog, 'bumail-acme@docker') || 'no access log line',
	);
	await until('bumail serving', 60, async () =>
		(await logsOf(direct)).includes('bumail: serving'),
	);
}
