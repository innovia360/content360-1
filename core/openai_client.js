async function callOpenAI({ prompt, schema }) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const payload = {
    model,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "content360",
        schema,
        strict: true,
      },
    },
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = json?.error?.message
      ? String(json.error.message)
      : `openai_http_${resp.status}`;
    throw new Error(msg);
  }

  // Robust parse for Responses API
  let parsed = null;

  if (json?.output_text) {
    try { parsed = JSON.parse(json.output_text); } catch {}
  }

  if (!parsed) {
    const content = json?.output?.[0]?.content?.[0];
    if (content?.json) parsed = content.json;
    else if (content?.text) {
      try { parsed = JSON.parse(content.text); } catch {}
    }
  }

  if (!parsed) throw new Error("OPENAI_NO_JSON_OUTPUT");
  return parsed;
}

module.exports = { callOpenAI };
