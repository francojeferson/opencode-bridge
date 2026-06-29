import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })
const MODEL = { providerID: "openrouter", modelID: "google/gemma-4-31b-it:free" }

const txt = (msgs) =>
  (msgs ?? [])
    .map((m) => {
      const role = m.info?.role
      const t = (m.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim()
      return t ? `[${role}] ${t}` : null
    })
    .filter(Boolean)

// 1. create
const created = await client.session.create({
  body: { agent: "build", model: { providerID: MODEL.providerID, id: MODEL.modelID } },
})
const id = created.data?.id ?? created.id
console.log("session:", id)

// 2. prompt (drives turn). prompt_async returns ack; then poll messages.
const ack = await client.session.prompt({
  path: { id },
  body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Reply with exactly: SDK_ROUNDTRIP_OK" }] },
})
console.log("ack:", JSON.stringify(ack.data ?? ack).slice(0, 160))

// 3. poll until assistant text or timeout
let out = []
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500))
  const res = await client.session.messages({ path: { id } })
  out = txt(res.data ?? res)
  if (out.some((l) => l.startsWith("[assistant]"))) break
}
console.log("messages:")
out.forEach((l) => console.log("  " + l.slice(0, 200)))
if (!out.length) console.log("  <none>")
