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

// Update a page's status to "paid" and add Stripe session info
async function markPaidWithStripeInfo(pageId, stripeData) {
  const properties = {
    "status": { "select": { "name": "paid" } }
  };

  // Add Stripe session ID for linking back to Stripe dashboard
  if (stripeData.sessionId) {
    properties["stripe_session_id"] = {
      "rich_text": [{ "text": { "content": stripeData.sessionId } }]
    };
  }

  // Add clickable Stripe dashboard link
  if (stripeData.sessionId) {
    const stripeUrl = `https://dashboard.stripe.com/payments/${stripeData.sessionId}`;
    properties["stripe_link"] = {
      "url": stripeUrl
    };
  }

  // Add payment amount for reference
  if (stripeData.amountPaid !== undefined) {
    properties["amount_paid"] = {
      "number": stripeData.amountPaid / 100 // Convert cents to dollars
    };
  }

  // Add payment date
  if (stripeData.paymentDate) {
    properties["payment_date"] = {
      "date": { "start": stripeData.paymentDate }
    };
  }

  const resp = await fetch(`${NOTION_HOST}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${process.env.NOTION_SECRET}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({ properties })
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

  // Extract Stripe session data for storage
  const stripeData = {
    sessionId: session.id,
    amountPaid: session.amount_total || session.amount_subtotal,
    paymentDate: new Date(session.created * 1000).toISOString().split('T')[0], // Convert Unix timestamp to ISO date
    customerName: session.customer_details?.name || null,
    currency: session.currency || 'usd'
  };

  try {
    const pages = await findPagesByEmail(email);

    if (!pages.length) {
      return ok({ 
        updated: 0, 
        note: "no_matching_email", 
        email,
        stripeSessionId: stripeData.sessionId
      });
    }

    let updated = 0;
    const updatedPages = [];
    
    for (const p of pages) {
      await markPaidWithStripeInfo(p.id, stripeData);
      updated++;
      updatedPages.push({
        pageId: p.id,
        stripeLink: `https://dashboard.stripe.com/payments/${stripeData.sessionId}`
      });
    }

    return ok({ 
      updated, 
      email,
      stripeSessionId: stripeData.sessionId,
      stripeLink: `https://dashboard.stripe.com/payments/${stripeData.sessionId}`,
      amountPaid: `$${(stripeData.amountPaid / 100).toFixed(2)}`,
      pages: updatedPages
    });
  } catch (err) {
    return bad(502, { error: err.message });
  }
};