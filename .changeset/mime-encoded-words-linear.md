---
'@bumail/mime': patch
---

Decode a run of adjacent RFC 2047 encoded-words in linear time. A run in one charset was joined one word at a time, so a hostile header of tens of thousands of words took the square of its length (100,000 adjacent `B` words: about 660 ms); its bytes are now collected and joined once (about 30 ms).
