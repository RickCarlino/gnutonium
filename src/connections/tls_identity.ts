import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

type TlsIdentity = { key: string; cert: string };

// AlgorithmIdentifier for sha256WithRSAEncryption, including NULL parameters.
const SHA256_RSA = Buffer.from("300d06092a864886f70d01010b0500", "hex");

function der(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts);
  const length: number[] = [];
  for (let n = value.length; n > 0; n = Math.floor(n / 256)) {
    length.unshift(n & 0xff);
  }
  const prefix =
    value.length < 128
      ? [value.length]
      : [0x80 | length.length, ...length];
  return Buffer.concat([Buffer.from([tag, ...prefix]), value]);
}

function certificateTime(timestamp: number): Buffer {
  const date = new Date(timestamp);
  const value = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "")
    .slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${value.slice(2)}Z`))
    : der(0x18, Buffer.from(`${value}Z`));
}

function pemCertificate(bytes: Buffer): string {
  const lines = bytes.toString("base64").match(/.{1,64}/g) ?? [];
  return [
    "-----BEGIN CERTIFICATE-----",
    ...lines,
    "-----END CERTIFICATE-----",
    "",
  ].join("\n");
}

/** Create an in-memory, self-signed peer identity using RFC 5280 certificate encoding. */
export function createTlsIdentity(): TlsIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const name = der(
    0x30,
    der(
      0x31,
      der(
        0x30,
        Buffer.from("0603550403", "hex"), // commonName
        der(0x0c, Buffer.from("Gnutonium")),
      ),
    ),
  );
  const now = Date.now();
  const serial = randomBytes(16);
  // Positive, nonzero INTEGER with no redundant leading zero octets.
  serial[0] = (serial[0]! & 0x7f) | 1;
  const body = der(
    0x30,
    der(0x02, serial),
    SHA256_RSA,
    name,
    der(
      0x30,
      certificateTime(now - 60_000),
      certificateTime(now + 365 * 24 * 60 * 60_000),
    ),
    name,
    publicKey.export({ format: "der", type: "spki" }),
  );
  const certificate = der(
    0x30,
    body,
    SHA256_RSA,
    der(0x03, Buffer.from([0]), sign("sha256", body, privateKey)),
  );
  return {
    key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    cert: pemCertificate(certificate),
  };
}
