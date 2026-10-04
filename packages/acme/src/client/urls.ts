import { shown } from '../encoding';
import { AcmeError } from '../errors';
import { isRequestUrl } from '../url';

/** A URL the CA gave, checked, or `BAD_RESPONSE` naming the member it came from. */
export function serverUrl(
	value: unknown,
	member: string,
	where: string,
	allowInsecure: boolean,
): string {
	if (!isRequestUrl(value, allowInsecure)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's ${member} must be an https: URL without credentials or a fragment, not ${shown(value)}`,
		);
	}
	return value as string;
}

/** A URL the caller gave, checked, or `INVALID_OPTION`. */
export function callerUrl(
	value: unknown,
	name: string,
	where: string,
	allowInsecure: boolean,
): string {
	if (!isRequestUrl(value, allowInsecure)) {
		throw new AcmeError(
			'INVALID_OPTION',
			`${where}: ${name} must be an https: URL without credentials or a fragment (http: only with allowInsecure), not ${shown(value)}`,
		);
	}
	return value as string;
}
