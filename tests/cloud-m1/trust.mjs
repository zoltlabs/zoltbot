import { getCACertificates, setDefaultCACertificates } from "node:tls";

// Only the isolated harness child imports this module. TLS verification remains enabled.
const certificate = process.env.ZOLTBOT_TEST_CA_CERTIFICATE;
if (!certificate || !certificate.startsWith("-----BEGIN CERTIFICATE-----"))
  throw new Error("fixture_tls_trust_unavailable");
setDefaultCACertificates([...getCACertificates("default"), certificate]);
