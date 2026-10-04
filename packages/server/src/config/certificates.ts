import type { Checker } from './checker';
import { fromDir } from './files';
import { checkTlsFiles } from './tls';
import type { AcmeConfig, PortsConfig, TlsConfig } from './types';
import { checkHttpsUrl } from './urls';

/** Let's Encrypt's production directory (RFC 8555 §7.1.1). */
export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CertificatesContext {
	/** The configuration file's directory, which relative paths start from. */
	readonly dir: string;
	/** `undefined` when it is missing or invalid, so no certificate is checked against it. */
	readonly hostname: string | undefined;
	readonly ports: PortsConfig;
	readonly now: Date;
}

/**
 * `[tls]` and `[acme]`. With `mode = "acme"`, the default, `[acme]` needs
 * an e-mail and `acceptTerms = true`, and `ports.http` must be on for
 * HTTP-01; `cert` and `key` are refused. With `mode = "files"`, both
 * files are checked (`checkTlsFiles`), and `[acme]` is refused.
 */
export function checkCertificates(
	checker: Checker,
	rawTls: unknown,
	rawAcme: unknown,
	context: CertificatesContext,
): { tls: TlsConfig; acme: AcmeConfig | undefined } {
	const tls = checker.table(rawTls, 'tls', ['mode', 'cert', 'key']);
	const mode =
		checker.oneOf(tls, 'mode', 'tls', ['acme', 'files'] as const) ?? 'acme';
	const cert = checker.string(tls, 'cert', 'tls');
	const key = checker.string(tls, 'key', 'tls');

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
				tls: { mode, cert: cert ?? '', key: key ?? '' },
				acme: undefined,
			};
		}
		const files = {
			cert: fromDir(context.dir, cert),
			key: fromDir(context.dir, key),
		};
		checkTlsFiles(checker, files, context.hostname, context.now);
		return { tls: { mode, ...files }, acme: undefined };
	}

	if (cert !== undefined)
		checker.add('tls.cert', 'is only for tls.mode "files"');
	if (key !== undefined) checker.add('tls.key', 'is only for tls.mode "files"');
	if (context.ports.http === 0) {
		checker.add(
			'ports.http',
			'is 0, but tls.mode "acme" answers its HTTP-01 challenges there',
		);
	}
	return { tls: { mode }, acme: checkAcme(checker, rawAcme) };
}

function checkAcme(checker: Checker, raw: unknown): AcmeConfig {
	const acme = checker.table(raw, 'acme', [
		'email',
		'acceptTerms',
		'directory',
	]);
	const email = checker.string(acme, 'email', 'acme');
	if (email === undefined && acme?.['email'] === undefined) {
		checker.add('acme.email', 'is required with tls.mode "acme"');
	} else if (email !== undefined && !EMAIL.test(email)) {
		checker.add('acme.email', 'must be an e-mail address');
	}
	const accepted = checker.boolean(acme, 'acceptTerms', 'acme');
	// Not a boolean is already recorded; false and absent are refused here.
	if (accepted === false || acme?.['acceptTerms'] === undefined) {
		checker.add(
			'acme.acceptTerms',
			"must be true: the CA's terms of service, read and accepted",
		);
	}
	const directoryValue = checker.string(acme, 'directory', 'acme');
	const directory =
		directoryValue === undefined
			? LETS_ENCRYPT
			: (checkHttpsUrl(checker, directoryValue, 'acme.directory', false) ??
				LETS_ENCRYPT);
	return { email: email ?? '', acceptTerms: true, directory };
}
