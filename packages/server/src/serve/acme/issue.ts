import {
	AcmeClient,
	type AcmeFetch,
	exportPrivateKeyPem,
	generateKeyPair,
	importKeyPairPem,
	obtainCertificate,
} from '@bumail/acme';
import type { AcmeConfig } from '../../config/types';
import type { TlsFiles } from '../tls';
import type { Challenge } from './challenge';
import type { AcmeState } from './state';

/** What one issuance needs. */
export interface IssueOptions {
	readonly config: AcmeConfig;
	readonly state: AcmeState;
	readonly challenge: Challenge;
	/** The CA is reached through this; default the global `fetch`. */
	readonly fetch?: AcmeFetch | undefined;
	/** Milliseconds between polls of the CA. */
	readonly pollMs: number;
	/** The limit of the whole flow, in milliseconds. */
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}

/** The account key from the volume, made and kept at the first start. */
async function accountKey(state: AcmeState): Promise<CryptoKeyPair> {
	const stored = state.readAccountKey();
	if (stored !== undefined) return await importKeyPairPem(stored);
	const pair = await generateKeyPair('P-256');
	await state.writeAccountKey(await exportPrivateKeyPem(pair.privateKey));
	return pair;
}

/**
 * One whole HTTP-01 flow: the account (found or created), a new ECDSA
 * P-256 key for the certificate, an order for `config.names`, the
 * challenges answered by `challenge`, the chain downloaded. It answers
 * the pair and writes nothing of it: the caller keeps it. Throws
 * `AcmeError`.
 */
export async function issue(options: IssueOptions): Promise<TlsFiles> {
	const { config, state, challenge, signal } = options;
	const client = new AcmeClient({
		directoryUrl: config.directory,
		accountKey: await accountKey(state),
		pollIntervalMs: options.pollMs,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	await client.newAccount({
		termsOfServiceAgreed: true,
		...(config.email === undefined
			? {}
			: { contact: [`mailto:${config.email}`] }),
		signal,
	});
	const certificateKey = await generateKeyPair('P-256');
	const { certificate } = await obtainCertificate({
		client,
		names: config.names,
		certificateKey,
		http01: challenge.hooks,
		timeoutMs: options.timeoutMs,
		signal,
	});
	return {
		cert: certificate,
		key: await exportPrivateKeyPem(certificateKey.privateKey),
	};
}
