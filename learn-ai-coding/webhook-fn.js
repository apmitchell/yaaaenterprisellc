// file: learn-ai-coding-starter-course-webhook.js
// DigitalOcean Functions (OpenWhisk) handler
// Minimal webhook processor: marks Notion "status" = "paid"
// Env: NOTION_SECRET, NOTION_DB_ID

const NOTION_HOST = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// --- Helpers ---
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function bad(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...cors() },
    body: JSON.stringify({ ok: false, ...body })
  };
}

function ok(body = {}) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", ...cors() },
    body: JSON.stringify({ ok: true, ...body })
  };
}

// OpenWhisk provides raw body as base64 in __ow_body
function parseEvent(args) {
  if (args.__ow_body) {
    try {
      const raw = Buffer.from(args.__ow_body, "base64").toString("utf8");
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }
  // fallback if invoked in console test
  if (args.type && args.data) return args;
  return null;
}

// Query Notion DB for a page by email
async function findPagesByEmail(email) {
  const resp = await fetch(`${NOTION_HOST}/databases/${process.env.NOTION_DB_ID}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({
      filter: { property: "email", email: { equals: email } }
    })
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Notion query failed: ${JSON.stringify(json)}`);
  return json.results || [];
}

// Update a page's status rich_text to "paid"
async function markPaid(pageId) {
  const resp = await fetch(`${NOTION_HOST}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${process.env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({
      properties: {
        "status": { "select": { "name": "paid" } }
      }
    })
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Notion update failed: ${JSON.stringify(json)}`);
  return json;
}

// --- Main entrypoint ---
exports.main = async (args) => {
  // Handle preflight
  if (args.__ow_method === "options") {
    return { statusCode: 204, headers: cors() };
  }
  if (args.__ow_method !== "post") {
    return bad(405, { error: "Method not allowed" });
  }

  const event = parseEvent(args);
  if (!event) return bad(400, { error: "Empty or invalid body" });

  // Only handle checkout completion
  if (event.type !== "checkout.session.completed") {
    return ok({ ignored: true, reason: "unhandled_event_type" });
  }

  const session = event.data && event.data.object;
  const paid = session && session.payment_status === "paid";
  const email =
    (session && session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    null;

  if (!paid) return ok({ ignored: true, reason: "not_paid" });
  if (!email) return bad(400, { error: "No email in event" });

  try {
    const pages = await findPagesByEmail(email);

    if (!pages.length) {
      return ok({ updated: 0, note: "no_matching_email", email });
    }

    let updated = 0;
    for (const p of pages) {
      await markPaid(p.id);
      updated++;
    }

    return ok({ updated, email });
  } catch (err) {
    return bad(502, { error: err.message });
  }
};