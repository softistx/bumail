/** Why `jmap()` refused an option, or why a hook failed. */
export type JmapErrorCode = 'INVALID_OPTION' | 'HOOK_TIMEOUT';

/**
 * Thrown by `jmap()` for a wrong option; and what `onError` is given when
 * `authenticate` does not settle within `hookTimeout`.
 */
export class JmapError extends Error {
	override readonly name = 'JmapError';
	readonly code: JmapErrorCode;

	constructor(code: JmapErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
