# Noise interoperability vector

`noise-ik.json` is the unchanged `Noise_IK_25519_ChaChaPoly_BLAKE2b` case from [Cacophony's independent test vectors](https://github.com/centromere/cacophony/blob/master/vectors/cacophony.txt), fetched November 4, 2026. Cacophony is [released into the public domain under the Unlicense](https://github.com/centromere/cacophony/blob/master/LICENSE).

The keys are public, deterministic test material. They must never be used for real sessions. Tests compare both handshake messages, the transcript hash, and transport messages byte for byte on the native and portable backends.
