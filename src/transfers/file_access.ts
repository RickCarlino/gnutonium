import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function assertDownloadFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      "download destination must be a regular file with one link",
    );
  }
}

function sameFile(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

/** Open before truncating, so links and special files cannot redirect writes. */
export function openDownloadFile(filePath: string, start: number): number {
  const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (entry) assertDownloadFile(entry);
  const flags =
    fs.constants.O_RDWR |
    fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK |
    (entry ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    assertDownloadFile(opened);
    if (entry && !sameFile(entry, opened)) {
      throw new Error("download destination changed while opening");
    }
    if (start === 0) fs.ftruncateSync(fd, 0);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

async function containedSharePath(
  filePath: string,
  root: string,
): Promise<string> {
  const [realRoot, realFile] = await Promise.all([
    fsp.realpath(root),
    fsp.realpath(filePath),
  ]);
  const relative = path.relative(realRoot, realFile);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("share is outside the shared directory");
  }
  return realFile;
}

/** Resolve a catalog path inside its share root and retain the opened file. */
export async function openSharedFile(
  filePath: string,
  root?: string,
): Promise<fsp.FileHandle> {
  const entry = await fsp.lstat(filePath);
  if (!entry.isFile()) throw new Error("share must be a regular file");
  if (root) filePath = await containedSharePath(filePath, root);
  const file = await fsp.open(
    filePath,
    fs.constants.O_RDONLY |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (!opened.isFile() || !sameFile(entry, opened)) {
      throw new Error("share changed while opening");
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
