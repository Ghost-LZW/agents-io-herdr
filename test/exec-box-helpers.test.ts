/** Python helpers run with the image's isolated, standard-library-only interpreter flags. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it("passes the helpers' real-file, git-archive, unsafe-tar and fake-uv tests", () => {
  const r = spawnSync("/usr/bin/python3", ["-I", "-S", join(import.meta.dirname, "box-helpers.py")], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status, `${r.error ?? ""}\n${r.stdout}\n${r.stderr}`).toBe(0);
});
