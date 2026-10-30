/** Keep printable text and layout, but never execute peer-supplied terminal controls. */
export function safeTerminalText(value: string): string {
  return value.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    " ",
  );
}
