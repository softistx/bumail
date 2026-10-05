import { checkAcme } from './acme';
import type { Checker } from './checker';
import { fromDir } from './files';
import { checkTlsFiles } from './tls';
import type { AcmeConfig, PortsConfig, TlsConfig } from './types';

/** Seconds between two looks at the certificate files, by default. */
export const DEFAULT_POLL_SECONDS = 30;

/** The longest wait between two looks: a day. */
const MAX_POLL_SECONDS = 86_400;

export interface CertificatesContext {
	/** The configuration file's directory, which relative paths start from. */
	readonly dir: string;
	/** `undefined` when it is missing or invalid, so no certificate is checked against it. */
	readonly hostname: string | undefined;
	readonly ports: PortsConfig;
	/** `data`, which the ACME state's default directory is under. */
	readonly data: string;
	/** The top-level `bind`, which the challenge listener's default is. */
	readonly bind: string;
	readonly now: Date;
}

/**
 * `[tls]` and `[acme]`. With `mode = "acme"`, the default, `[acme]` needs
 * `acceptTerms = true` (`checkAcme`), and `ports.http` must be on for
 * HTTP-01; `cert`, `key` and `pollSeconds` are refused. With `mode =
 * "files"`, both files are checked (`checkTlsFiles`), `pollSeconds` is how
 * often `serve` looks for a renewed pair (0: never), and `[acme]` is
 * refused.
 */
export function checkCertificates(
	checker: Checker,
	rawTls: unknown,
	rawAcme: unknown,
	context: CertificatesContext,
): { tls: TlsConfig; acme: AcmeConfig | undefined } {
	const tls = checker.table(rawTls, 'tls', [
		'mode',
		'cert',
		'key',
		'pollSeconds',
	]);
	const mode =
		checker.oneOf(tls, 'mode', 'tls', ['acme', 'files'] as const) ?? 'acme';
	const cert = checker.string(tls, 'cert', 'tls');
	const key = checker.string(tls, 'key', 'tls');
	const poll = checker.integer(tls, 'pollSeconds', 'tls', 0, MAX_POLL_SECONDS);

	if (mode === 'files') {
		if (rawAcme !== undefined)
			checker.add('acme', 'is only for tls.mode "acme"');
		if (cert === undefined && tls?.['cert'] === undefined) {
			checker.add('tls.cert', 'is required with tls.mode "files"');
		}
		if (key === undefined && tls?.['key'] === undefined) {
			checker.add('tls.key', 'is required with tls.mode "files"');
		}
		if (cert === undefined || key === undefined) {
			return {
				tls: {
					mode,
					cert: cert ?? '',
					key: key ?? '',
					pollSeconds: poll ?? DEFAULT_POLL_SECONDS,
				},
				acme: undefined,
			};
		}
		const files = {
			cert: fromDir(context.dir, cert),
			key: fromDir(context.dir, key),
		};
		checkTlsFiles(checker, files, context.hostname, context.now);
		return {
			tls: { mode, ...files, pollSeconds: poll ?? DEFAULT_POLL_SECONDS },
			acme: undefined,
		};
	}

	if (cert !== undefined)
		checker.add('tls.cert', 'is only for tls.mode "files"');
	if (key !== undefined) checker.add('tls.key', 'is only for tls.mode "files"');
	if (tls?.['pollSeconds'] !== undefined) {
		checker.add('tls.pollSeconds', 'is only for tls.mode "files"');
	}
	if (context.ports.http === 0) {
		checker.add(
			'ports.http',
			'is 0, but tls.mode "acme" answers its HTTP-01 challenges there',
		);
	}
	return { tls: { mode }, acme: checkAcme(checker, rawAcme, context) };
}
