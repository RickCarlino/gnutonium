import { expect, test } from "bun:test";
import { MAX_HEADER_BYTES } from "../../../src/const";
import { boundedHeaderEnd } from "../../../src/wire/handshake";

test("header limits include terminators and exclude coalesced bodies", () => {
  const header = `${"x".repeat(MAX_HEADER_BYTES - 4)}\r\n\r\n`;
  expect(boundedHeaderEnd(header)).toBe(MAX_HEADER_BYTES);
  expect(
    boundedHeaderEnd(`${header}${"b".repeat(MAX_HEADER_BYTES * 2)}`),
  ).toBe(MAX_HEADER_BYTES);
  expect(boundedHeaderEnd("partial\r\n")).toBe(-1);
  expect(() =>
    boundedHeaderEnd(`${"x".repeat(MAX_HEADER_BYTES - 3)}\r\n\r\n`),
  ).toThrow("headers too large");
});
