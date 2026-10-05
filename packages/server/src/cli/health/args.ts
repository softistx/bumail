import { once, type Tokens } from '../tokens';
import { usage } from '../verbs';

/** `bumail health`: asks the running server's health check. */
export interface HealthArgs {
	readonly kind: 'health';
	readonly config: string | undefined;
	/** A server still waiting for its first certificate counts as healthy. */
	readonly tlsPending: boolean;
}

/** `health` takes `--config` and `--tls-pending`, and nothing else. */
export function resolveHealth(tokens: Tokens): HealthArgs {
	const extra = [...tokens.values.keys(), ...tokens.flags].filter(
		(name) => name !== '--config' && name !== '--tls-pending',
	);
	if (extra[0] !== undefined) throw usage(`health takes no ${extra[0]}`);
	return {
		kind: 'health',
		config: once(tokens, '--config'),
		tlsPending: tokens.flags.has('--tls-pending'),
	};
}
