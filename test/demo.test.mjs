import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoCli, demoMeetings } from "../demo.mjs";

test("demonstração: lista agentes, máquinas e agendadas; alguns trabalham", async () => {
  const cli = createDemoCli();
  const agents = await cli(["agent", "list"]);
  assert.ok(agents.length >= 20);
  assert.ok(agents.some((a) => a.status === "working"));
  assert.ok((await cli(["runtime", "list"])).some((r) => r.status === "offline"));
  assert.ok((await cli(["autopilot", "list"])).autopilots.length > 0);
});

test("demonstração: ids passam na validação do painel (hexadecimais)", async () => {
  const cli = createDemoCli();
  const ID = /^[0-9a-f-]{8,40}$/i;
  for (const a of await cli(["agent", "list"])) assert.match(a.id, ID);
  for (const i of (await cli(["issue", "list"])).issues) assert.match(i.id, ID);
  for (const m of demoMeetings()) for (const id of [m.id, ...m.agents]) assert.match(id, ID);
});

test("demonstração: qualquer escrita é recusada", async () => {
  const cli = createDemoCli();
  for (const args of [["issue", "status", "x", "done"], ["issue", "create", "--title", "x"], ["agent", "update", "x"], ["autopilot", "trigger", "x"]]) {
    await assert.rejects(cli(args), /Modo demonstração/);
  }
});
