# Reference fixtures

Supplied by the project owner (SPEC.md, section 14) on 2026-10-14, stored
exactly as received: one line of lowercase hex bytes separated by spaces.

| Fixture | Status | Contents | Checksums (base / ext) |
| --- | --- | --- | --- |
| `Tessera-EJE-test.txt` | Original; 10-bit fell back to 8-bit | 4K60 DTD at 594 MHz, 23 VICs, 12-bit flags, 4:2:0 map. Pasted in chat by the owner | 32 / 2c |
| `Tessera-SX40.txt` | Status not stated | Same base block as the original; CTA lists only VICs 97 and 96, keeps HDMI VICs, 12-bit flags and the 4:2:0 map | 32 / fe |
| `Tessera-EJE-4K50-10bit-RGB.txt` | Reported working | 4K50 reduced-blanking DTD only, RGB only, 10-bit only. Has a trailing space after the last byte | bf / d6 |

`Tessera-EJE-4K50-10bit.txt` (first rebuild, bf / 05) has not been supplied.

Acceptance test 1 runs the SPEC.md section 9 recipe on `Tessera-EJE-test.txt`
and must produce `Tessera-EJE-4K50-10bit-RGB.txt` byte for byte; an
end-to-end test does the same through the web UI.
