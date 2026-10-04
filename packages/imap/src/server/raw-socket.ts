import type { Socket } from 'bun';

/**
 * The socket a transport drives: Bun's, or `ProxiedTls` — implicit TLS
 * behind a PROXY header — which has its shape.
 */
export type RawSocket = Pick<
	Socket<unknown>,
	'remoteAddress' | 'shutdown' | 'terminate' | 'pause' | 'resume' | 'timeout'
> & { write(bytes: Uint8Array): number };
