/** A short message from `from` to itself, for the phases that send one. */
export function mail(from: string, subject: string): string {
	return `From: <${from}>\r\nTo: <${from}>\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@e2e.bumail.test>\r\n\r\nHello from the end-to-end test.\r\n`;
}
