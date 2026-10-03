/**
 * Step 5: what a mail client does with a mailbox — LIST with SPECIAL-USE,
 * APPEND, STORE and SEARCH by flag, COPY, EXPUNGE, MOVE.
 */
import { ALICE, type E2e, message, searched } from '../context';
import type { ImapClient } from '../imap-client';

export async function imapOps(e2e: E2e, imap: ImapClient): Promise<void> {
	const { report, run } = e2e;
	const list = await imap.command('LIST "" "*" RETURN (SPECIAL-USE)');
	const lines = list.untagged.join('\n');
	report.check(
		'LIST RETURN (SPECIAL-USE)',
		list.ok &&
			['\\Sent', '\\Drafts', '\\Archive', '\\Junk', '\\Trash'].every((use) =>
				lines.includes(use),
			),
		lines,
	);

	const subject = `e2e append ${run}`;
	const appended = await imap.command(
		'APPEND INBOX (\\Flagged)',
		message(ALICE, ALICE, subject, 'Appended by the e2e.'),
	);
	report.check('APPEND', appended.ok, appended.status);
	await imap.command('NOOP');

	const [number] = searched(
		(await imap.command(`SEARCH SUBJECT "${subject}"`)).untagged,
	);
	if (!report.check('SEARCH SUBJECT finds the APPEND', number !== undefined))
		return;
	await flags(e2e, imap, number as number);
	await copyAndExpunge(e2e, imap, number as number, subject);
	await moveToArchive(e2e, imap, subject);
	await imap.command('LOGOUT');
}

/** STORE `\Seen` on the appended message, then SEARCH SEEN and UNSEEN. */
async function flags(
	{ report }: E2e,
	imap: ImapClient,
	number: number,
): Promise<void> {
	const stored = await imap.command(`STORE ${number} +FLAGS (\\Seen)`);
	const flags = stored.untagged.join(' ');
	report.check(
		'STORE +FLAGS \\Seen',
		stored.ok && flags.includes('\\Seen') && flags.includes('\\Flagged'),
		flags,
	);
	const seen = searched((await imap.command('SEARCH SEEN')).untagged);
	report.check('SEARCH SEEN', seen.includes(number), seen.join(' '));
	const unseen = searched((await imap.command('SEARCH UNSEEN')).untagged);
	report.check(
		'SEARCH UNSEEN excludes it',
		!unseen.includes(number),
		unseen.join(' '),
	);
}

/** COPY to Archive, then `\Deleted` and EXPUNGE from INBOX. */
async function copyAndExpunge(
	{ report }: E2e,
	imap: ImapClient,
	number: number,
	subject: string,
): Promise<void> {
	const copied = await imap.command(`COPY ${number} Archive`);
	report.check('COPY to Archive', copied.ok, copied.status);

	const deleted = await imap.command(`STORE ${number} +FLAGS (\\Deleted)`);
	const expunged = await imap.command('EXPUNGE');
	report.check(
		'EXPUNGE',
		deleted.ok &&
			expunged.ok &&
			expunged.untagged.includes(`* ${number} EXPUNGE`),
		expunged.untagged.join(' '),
	);
	const gone = searched(
		(await imap.command(`SEARCH SUBJECT "${subject}"`)).untagged,
	);
	report.check(
		'EXPUNGEd message gone from INBOX',
		gone.length === 0,
		gone.join(' '),
	);
}

/** MOVE the IDLE step's message to Archive, which then holds it and the COPY. */
async function moveToArchive(
	{ report, run }: E2e,
	imap: ImapClient,
	subject: string,
): Promise<void> {
	const [idled] = searched(
		(await imap.command(`SEARCH SUBJECT "e2e idle ${run}"`)).untagged,
	);
	const moved = await imap.command(`MOVE ${idled} Archive`);
	report.check(
		'MOVE to Archive',
		moved.ok && moved.untagged.includes(`* ${idled} EXPUNGE`),
		`${moved.status} ${moved.untagged.join(' ')}`,
	);

	const archive = await imap.command('SELECT Archive');
	const exists = archive.untagged.find((line) => / EXISTS$/.test(line));
	report.check(
		'Archive holds both',
		exists === '* 2 EXISTS',
		exists ?? archive.status,
	);
	const [copy] = searched(
		(await imap.command(`SEARCH SUBJECT "${subject}" SEEN FLAGGED`)).untagged,
	);
	report.check('the COPY kept its flags', copy !== undefined);
}
