import { checkDomain } from '../../directory/address';
import { DKIM_KEY_BITS, zoneLine } from '../../directory/dkim';
import { ServerError } from '../../errors';
import { type Handler, table } from './shared';

/** `bumail dkim generate|show|list|remove`: the key, and the TXT record to publish. */
export const dkim: Handler = async (args, directory, _, { out }) => {
	const [domain = ''] = args.operands;
	if (args.verb === 'list') {
		out(
			table(
				directory.dkim
					.list()
					.map((key) => [key.domain, `selector ${key.selector}`]),
			),
		);
		return;
	}
	if (args.verb === 'remove') {
		out(
			`removed the DKIM key of ${directory.dkim.remove(domain)}; its mail goes unsigned\n`,
		);
		return;
	}
	const key =
		args.verb === 'generate'
			? await directory.dkim.generate(domain, {
					...(args.selector === undefined ? {} : { selector: args.selector }),
					replace: args.replace,
				})
			: directory.dkim.get(domain);
	if (key === undefined) {
		throw new ServerError(
			'NOT_FOUND',
			`the domain ${checkDomain(domain)} has no DKIM key; bumail dkim generate makes one`,
		);
	}
	if (args.verb === 'generate') {
		out(
			`generated an RSA-${DKIM_KEY_BITS} DKIM key for ${key.domain}, selector ${key.selector}; mail from ${key.domain} is signed with it from now on\n`,
		);
	}
	out(
		[
			'publish this TXT record:',
			`  name   ${key.name}`,
			`  value  ${key.record}`,
			'as a zone file line:',
			`  ${zoneLine(key)}`,
			'',
		].join('\n'),
	);
};
