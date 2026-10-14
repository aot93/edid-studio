# Reference fixtures

Supplied by the project owner (SPEC.md, section 14). Not yet committed.

| Fixture | Status | Checksums (base / ext) |
| --- | --- | --- |
| `Tessera-EJE-test.txt` | Original; 10-bit fell back to 8-bit | 32 / 2c |
| `Tessera-EJE-4K50-10bit.txt` | First rebuild; not confirmed | bf / 05 |
| `Tessera-EJE-4K50-10bit-RGB.txt` | Reported working | bf / d6 |

Files are stored exactly as received. EDIDs carry serial numbers; scrub them
before committing if the device's serial should stay private, and record that
here, since scrubbing changes the base-block checksum.
