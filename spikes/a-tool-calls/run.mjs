// Spike A driver. Starts `wrangler dev` for the spike worker, sends 20 hostname prompts
// and 5 plain questions to fresh agents, and classifies each tool call. Needs `wrangler login` (remote AI binding).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const PASS_BAR = 16;
const TOOL = "get_hostname_status";

const TRIALS = [
  ["Why isn't shop.acme.io working yet?", "shop.acme.io"],
  ["Can you check the status of app.brightline.dev?", "app.brightline.dev"],
  [
    "I added docs.northwind.co an hour ago. Is it verified?",
    "docs.northwind.co"
  ],
  ["What's wrong with portal.globex.com?", "portal.globex.com"],
  ["status of billing.initech.net please", "billing.initech.net"],
  ["Is help.umbrella.org ready to go live?", "help.umbrella.org"],
  [
    "My customer says store.hooli.xyz shows an error. What's going on?",
    "store.hooli.xyz"
  ],
  ["Check api.wayne-enterprises.com for me", "api.wayne-enterprises.com"],
  [
    "Did the DNS for login.starkindustries.io go through?",
    "login.starkindustries.io"
  ],
  ["Look up careers.soylent.biz", "careers.soylent.biz"],
  [
    "Hey, what's the verification state of blog.vandelay.com?",
    "blog.vandelay.com"
  ],
  [
    "Is status.piedpiper.com verified or still pending?",
    "status.piedpiper.com"
  ],
  [
    "We pointed www.dundermifflin.com at you yesterday. Any problems?",
    "www.dundermifflin.com"
  ],
  [
    "What does the setup for events.cyberdyne.ai look like right now?",
    "events.cyberdyne.ai"
  ],
  ["Tell me why my.oceanic-air.com isn't active", "my.oceanic-air.com"],
  ["Please check SUPPORT.TYRELL.COM", "support.tyrell.com"],
  [
    "Is there anything missing for go.massive-dynamic.com?",
    "go.massive-dynamic.com"
  ],
  ["Can you see the hostname learn.aperture.edu?", "learn.aperture.edu"],
  [
    "What's blocking shop.bluthcompany.com from verifying?",
    "shop.bluthcompany.com"
  ],
  ["Has partners.weyland.co passed DNS checks?", "partners.weyland.co"]
];

// Plain questions that need no tool. Measured only: how often Llama calls a tool anyway.
const PLAIN = [
  "What is a CAA record?",
  "What's the difference between a CNAME and an A record?",
  "How long does DNS propagation usually take?",
  "Why do I need a TXT record to verify a hostname?",
  "What does TTL mean in DNS?"
];

const norm = (h) =>
  String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

function classify(trial, expected) {
  if (!trial.result || trial.result.status !== "completed") {
    return {
      verdict: "turn_error",
      detail: JSON.stringify(trial.result ?? trial.error)
    };
  }
  const assistant = trial.messages.filter((m) => m.role === "assistant");
  const parts = assistant.flatMap((m) => m.parts);
  const toolParts = parts.filter((p) => p.type === `tool-${TOOL}`);
  const otherTools = parts.filter(
    (p) => p.type.startsWith("tool-") && p.type !== `tool-${TOOL}`
  );
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  if (otherTools.length > 0)
    return {
      verdict: "wrong_tool",
      detail: otherTools.map((p) => p.type).join(",")
    };
  if (toolParts.length === 0) {
    const leaked =
      text.includes(TOOL) || /"name"\s*:|"parameters"\s*:|<function/.test(text);
    return {
      verdict: leaked ? "tool_call_leaked_as_text" : "no_tool_call",
      detail: text.slice(0, 300)
    };
  }
  if (expected === null) {
    return toolParts.length > 0
      ? {
          verdict: "tool_called_anyway",
          detail: `calls=${toolParts.length}`,
          text
        }
      : { verdict: "answered_without_tool", detail: text.slice(0, 300) };
  }
  const first = toolParts[0];
  if (first.state !== "output-available") {
    return {
      verdict: "tool_input_invalid",
      detail: `${first.state} ${first.errorText ?? ""} ${JSON.stringify(first.input)}`
    };
  }
  if (norm(first.input?.hostname) !== expected) {
    return { verdict: "wrong_hostname", detail: JSON.stringify(first.input) };
  }
  return {
    verdict: "good",
    detail: `calls=${toolParts.length} answered=${text.trim().length > 0}`,
    text
  };
}

async function waitForReady(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("wrangler dev did not become ready in 90s")),
      90_000
    );
    const onData = (buf) => {
      if (/Ready on/i.test(buf.toString())) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) =>
      reject(new Error(`wrangler dev exited with ${code}`))
    );
  });
}

const proc = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "-c",
    join(here, "wrangler.jsonc"),
    "--port",
    String(PORT)
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

// Modes:
//   agent       (default) full path: AIChatAgent, AI SDK streamText, workers-ai-provider
//   raw         env.AI.run without streaming, read choices[0].message.tool_calls
//   raw-stream  env.AI.run with streaming, rebuilt from choices[0].delta.tool_calls only
const MODE = process.argv[2] ?? "agent";

function rawToolCall(raw) {
  const call = raw?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return null;
  return { name: call.function?.name, args: call.function?.arguments };
}

function streamToolCall(sse) {
  let name = null;
  let args = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6));
    for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      if (tc.function?.name) name = tc.function.name;
      if (tc.function?.arguments) args += tc.function.arguments;
    }
  }
  return name ? { name, args } : null;
}

function classifyRaw(call, expected) {
  if (expected === null) {
    return call
      ? { verdict: "tool_called_anyway", detail: call.name }
      : { verdict: "answered_without_tool", detail: "" };
  }
  if (!call) return { verdict: "no_tool_call", detail: "" };
  if (call.name !== TOOL) return { verdict: "wrong_tool", detail: call.name };
  let input;
  try {
    input = typeof call.args === "string" ? JSON.parse(call.args) : call.args;
  } catch {
    return { verdict: "tool_input_invalid", detail: String(call.args) };
  }
  if (norm(input?.hostname) !== expected)
    return { verdict: "wrong_hostname", detail: JSON.stringify(input) };
  return { verdict: "good", detail: JSON.stringify(input) };
}

async function runTrial(i, prompt, expected) {
  if (MODE === "agent") {
    let trial;
    try {
      const res = await fetch(
        `http://localhost:${PORT}/trial?id=${runId}-${i}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt })
        }
      );
      trial = res.ok
        ? await res.json()
        : { error: `HTTP ${res.status} ${await res.text()}` };
    } catch (err) {
      trial = { error: String(err) };
    }
    return { ...classify(trial, expected), ms: trial.ms ?? null };
  }

  const stream = MODE === "raw-stream";
  const started = Date.now();
  try {
    const res = await fetch(
      `http://localhost:${PORT}/raw${stream ? "?stream=1" : ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt })
      }
    );
    if (!res.ok)
      return {
        verdict: "turn_error",
        detail: `HTTP ${res.status}`,
        ms: Date.now() - started
      };
    const call = stream
      ? streamToolCall(await res.text())
      : rawToolCall((await res.json()).raw);
    return { ...classifyRaw(call, expected), ms: Date.now() - started };
  } catch (err) {
    return {
      verdict: "turn_error",
      detail: String(err),
      ms: Date.now() - started
    };
  }
}

const runId = Date.now().toString(36);
const rows = [];
const plainRows = [];
try {
  await waitForReady(proc);
  for (const [i, [prompt, expected]] of TRIALS.entries()) {
    const { verdict, detail, text, ms } = await runTrial(i, prompt, expected);
    rows.push({ i, prompt, expected, verdict, detail, text, ms });
    console.log(
      `${String(i + 1).padStart(2)} ${verdict.padEnd(26)} ${ms ?? "-"}ms  ${prompt}`
    );
  }
  for (const [j, prompt] of PLAIN.entries()) {
    const i = TRIALS.length + j;
    const { verdict, detail, text, ms } = await runTrial(i, prompt, null);
    plainRows.push({ i, prompt, verdict, detail, text, ms });
    console.log(`P${j + 1} ${verdict.padEnd(26)} ${ms ?? "-"}ms  ${prompt}`);
  }
} finally {
  proc.kill("SIGTERM");
}

const good = rows.filter((r) => r.verdict === "good").length;
const byVerdict = rows.reduce(
  (acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }),
  {}
);
const latencies = rows
  .map((r) => r.ms)
  .filter((n) => typeof n === "number")
  .sort((a, b) => a - b);
const median = latencies.length
  ? latencies[Math.floor(latencies.length / 2)]
  : null;
const summary = {
  mode: MODE,
  good,
  total: rows.length,
  passBar: PASS_BAR,
  pass: good >= PASS_BAR,
  byVerdict,
  medianMs: median,
  maxMs: latencies.at(-1) ?? null,
  plain: {
    total: plainRows.length,
    toolCalledAnyway: plainRows.filter(
      (r) => r.verdict === "tool_called_anyway"
    ).length,
    errors: plainRows.filter((r) => r.verdict === "turn_error").length
  }
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(
  join(here, `last-run-${MODE}.json`),
  JSON.stringify({ summary, rows, plainRows }, null, 2)
);
process.exit(summary.pass ? 0 : 1);
