# Test corpus

Third-party EDIDs used for round-trip and decoder tests. Project fixtures
from the case study live in `../fixtures`.

| Path | Source | Licence |
| --- | --- | --- |
| `edid-decode/` | `utils/edid-decode/data` in [v4l-utils](https://git.linuxtv.org/v4l-utils.git), commit `c6600a7e342ef6e336fba02212c90b60a36ca02d`. 126 binary EDIDs read from real hardware. | MIT, see `edid-decode/LICENSE` |
| `cta-eeodb.test`, `blockmap-128.test` | `utils/edid-decode/test` in the same commit. Hex text; synthetic. Cover the HDMI Forum EEODB and block maps. | MIT |
| `layouts/` | `edid-decode/dell-p2415q-hdmi2.0` dumped with `xxd`, `hexdump -C`, `xxd -i` and `edid-decode`, to test hex import against real tool output. | MIT (derived) |

Two samples are deliberately broken (`*-corrupted`); the round-trip test
checks that everything but their checksums survives.
