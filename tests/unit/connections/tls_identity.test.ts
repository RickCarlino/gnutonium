import { expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { createTlsIdentity } from "../../../src/connections/tls_identity";

test("fresh TLS identities have distinct keys and valid matching self-signed certificates", () => {
  const first = createTlsIdentity();
  const second = createTlsIdentity();
  expect(first.key).not.toBe(second.key);
  expect(first.cert).not.toBe(second.cert);
  for (const identity of [first, second]) {
    const certificate = new X509Certificate(identity.cert);
    expect(certificate.subject).toBe("CN=Gnutonium");
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(
      certificate.checkPrivateKey(createPrivateKey(identity.key)),
    ).toBe(true);
    expect(Date.parse(certificate.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
    expect(() => createSecureContext(identity)).not.toThrow();
  }
});
