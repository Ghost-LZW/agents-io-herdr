/** Synthetic herdr rows for tests (made-up panes, paths and titles). */
import type { HerdrAgent } from "../src/herdr.ts";

export function agent(status: string, o: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    pane_id: "w1:p1",
    terminal_id: "term_1",
    agent: "codex",
    agent_status: status,
    terminal_title_stripped: "fix the parser",
    cwd: "/home/dev/projects/ledger",
    foreground_cwd: "/home/dev/projects/ledger",
    focused: false,
    ...o,
  };
}
