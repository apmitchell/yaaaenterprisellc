// DigitalOcean Functions (OpenWhisk) handler
// Accepts GET ?name=&email=&start_date=&cohort= or POST JSON body
// Writes to Notion DB using env vars: NOTION_SECRET, NOTION_DB_ID

const NOTION_API = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2022-06-28";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function parseBody(args) {
  // OpenWhisk encodes raw body in __ow_body (base64) for POST
  if (args.__ow_method === "post") {
    if (args.__ow_body) {
      try {
        const raw = Buffer.from(args.__ow_body, "base64").toString("utf8");
        return JSON.parse(raw || "{}");
      } catch (_) { return {}; }
    }
  }
  return args; // GET query params live directly on args
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || "").trim());
}

exports.main = async (args) => {
  // CORS preflight
  if (args.__ow_method === "options") {
    return { statusCode: 204, headers: corsHeaders() };
  }

  const data = parseBody(args);
  const name = (data.name || "").trim();
  const email = (data.email || "").trim();
  const start_date = (data.start_date || "").trim(); // ISO date yyyy-mm-dd
  const cohort = (data.cohort || "unknown").trim();
  const goal = (data.goal || "unknown").trim();


  // Basic validation
  const errors = [];
  if (!name) errors.push("name is required");
  if (!validEmail(email)) errors.push("valid email is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) errors.push("start_date must be ISO yyyy-mm-dd");
  
  if (errors.length) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
      body: JSON.stringify({ ok: false, errors })
    };
  }

  // Build Notion page payload — adjust property names to match your DB
const payload = {
  parent: { database_id: process.env.
   },
   properties: {
    name: { title: [{ text: { content: name } }] },   // Title
    email: { email },                                  // Email
    start_date: { date: { start: start_date } },       // Date
    cohort: { rich_text: [{ text: { content: cohort } }] }, // 🔁 rich_text
    expectation: { rich_text: [{ text: { content: goal } }] }, // Rich text
    status: { select: { name: "registered" } }         // Select (ensure option exists)
  }
};

  try {
    const resp = await fetch(NOTION_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_SECRET}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify(payload)
    });

    const json = await resp.json();
    if (!resp.ok) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
        body: JSON.stringify({ ok: false, error: json })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
      body: JSON.stringify({ ok: true, pageId: json.id })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
