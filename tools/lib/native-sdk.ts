import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export async function resolvePackageDirectory(name: string, from: string): Promise<string> {
  let directory = resolve(from);
  while (true) {
    const path = join(directory, "node_modules", name);
    try {
      await lstat(join(path, "package.json"));
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw Error(
        `Missing runtime dependency ${name}; install locked dependencies including optional native packages`,
      );
    directory = parent;
  }
}
