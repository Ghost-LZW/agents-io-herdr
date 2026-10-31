/**
 * The exec shim as a child process speaking over real pipes, for test/exec-shim.test.ts: what sshd
 * would start, minus sshd, the dedicated user and the sandbox. The interlock is off; `ps` is a made-up
 * table (or fails, with AIH_TEST_PS_FAILS) and kill does nothing, so a sweep here never touches a
 * real process.
 *
 *   node test/shim-child.ts <op>     (AIH_TEST_HOME: the "user's" home)
 */
import { shim } from "../src/exec/shim.ts";
import type { Exec } from "../src/system.ts";
import { realExec } from "../src/system.ts";

const exec: Exec = (cmd, args, t, input) =>
  cmd !== "/bin/ps"
    ? realExec(cmd, args, t, input)
    : process.env.AIH_TEST_PS_FAILS
      ? { code: 1, stdout: "", stderr: "ps: failed" }
      : {
          code: 0,
          stdout: `    1     0     0 launchd\n${process.pid} 1 501 node\n 9001 1 501 /tmp/left-behind\n`,
          stderr: "",
        };

process.exitCode = await shim({
  command: process.argv[2],
  stdin: process.stdin,
  out: (b) => process.stdout.write(b),
  err: (s) => process.stderr.write(s),
  now: Date.now,
  uid: 501,
  home: process.env.AIH_TEST_HOME ?? "/nonexistent",
  pid: process.pid,
  exec,
  interlock: () => null,
  sandboxExec: null,
  kill: () => undefined,
  graceMs: 300,
});
process.stdin.destroy();
