---
"@bumail/auth": minor
---

`spfRecord`, `dmarcRecord` and `dkimRecord` write the TXT values an operator publishes, each the inverse of the matching parser: `spfRecord({ mx, a, include, ip4, ip6, all })` (`v=spf1 mx -all`, at most 10 DNS lookups), `dmarcRecord({ p, sp, rua, ruf, pct, adkim, aspf })` (an address becomes `mailto:`, a tag at its default is left out) and `dkimRecord({ publicKey, keyType, testing })` (`v=DKIM1; k=rsa; p=…`, an empty key is a revoked one). Each validates its input and throws `AuthError` `INVALID_OPTION` (`spfRecord(): …`); what it writes is read back by `checkSpf`, `checkDmarc` and `verifyDkim`. `sameSpfRecord`, `sameDmarcRecord` and `sameDkimRecord` compare two record texts as the receiver reads them (white space, case and default tags do not matter), for checking what the DNS holds against what you wrote.
