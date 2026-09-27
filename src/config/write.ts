import fs from "node:fs/promises";

const pending = new Map<string, Promise<void>>();

/** Serialize atomic config writes so cache reservations cannot race periodic saves. */
export async function writeConfigJson(
  file: string,
  contents: string,
): Promise<void> {
  const previous = pending.get(file) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${file}.tmp`;
      await fs.writeFile(temporary, contents, "utf8");
      await fs.rename(temporary, file);
    });
  pending.set(file, task);
  try {
    await task;
  } finally {
    if (pending.get(file) === task) pending.delete(file);
  }
}
