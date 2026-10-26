# Pragotron audio bank

Selected recording: **pragotron_split-flap-display.wav**, by **matucha**.

- Source: <https://freesound.org/people/matucha/sounds/174056/>
- License: [Creative Commons Attribution–NonCommercial 4.0](https://creativecommons.org/licenses/by-nc/4.0/)
- Intended use: this personal, noncommercial board. No endorsement by the author is implied.

**The recording is not included yet.** Freesound's binary download is blocked by the development environment's network policy. No other recording or synthesized placeholder is used. The app starts muted and reports a loading error if sound is requested without the bank.

Once the original WAV is supplied, `scripts/prepare_pragotron.py` creates `pragotron.wav` and `pragotron.json` here from reviewed source intervals. The JSON records the original SHA-256, each selected interval, silence trimming, fades, level normalization, and PCM conversion. Commit both generated files together with this attribution after listening and synchronization checks. See [audio workflow](../../../docs/AUDIO.md).
