// DigitalOcean Functions (OpenWhisk) handler
// Accepts GET ?check-avail=<cohort> for availability checking
// Accepts GET ?name=&email=&start_date=&cohort= or POST JSON body for registration
// Writes to Notion DB using env vars: NOTION_SECRET, NOTION_DB_ID

const NOTION_API = "https://api.notion.com/v1/pages";
const NOTION_QUERY_API = "https://api.notion.com/v1/databases";
const NOTION_VERSION = "2022-06-28";


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

async function checkCohortAvailability(cohort, startDate = null) {
  try {
    const filterConditions = [
      {
        property: "cohort",
        rich_text: {
          equals: cohort
        }
      },
      {
        property: "status",
        select: {
          equals: "paid"
        }
      }
    ];

    // If startDate provided, filter by exact start date
    if (startDate) {
      filterConditions.push({
        property: "start_date",
        date: {
          equals: startDate
        }
      });
    }

    const resp = await fetch(`${NOTION_QUERY_API}/${process.env.NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_SECRET}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify({
        filter: {
          and: filterConditions
        }
      })
    });

    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(`Notion API error: ${JSON.stringify(json)}`);
    }

    const paidCount = json.results.length;
    const isAvailable = paidCount < 10;
    const spotsLeft = Math.max(0, 10 - paidCount);

    return { isAvailable, spotsLeft, paidCount };
  } catch (err) {
    throw new Error(`Failed to check availability: ${err.message}`);
  }
}

async function findExistingRecord(email, cohort, startDate) {
  try {
    const resp = await fetch(`${NOTION_QUERY_API}/${process.env.NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_SECRET}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: "email",
              email: {
                equals: email
              }
            },
            {
              property: "cohort",
              rich_text: {
                equals: cohort
              }
            },
            {
              property: "start_date",
              date: {
                equals: startDate
              }
            }
          ]
        }
      })
    });

    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(`Notion API error: ${JSON.stringify(json)}`);
    }

    return json.results.length > 0 ? json.results[0] : null;
  } catch (err) {
    throw new Error(`Failed to find existing record: ${err.message}`);
  }
}

async function updateExistingRecord(pageId, goal) {
  try {
    const resp = await fetch(`${NOTION_API}/${pageId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_SECRET}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify({
        properties: {
          expectation: { rich_text: [{ text: { content: goal } }] }
        }
      })
    });

    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(`Notion API error: ${JSON.stringify(json)}`);
    }

    return json;
  } catch (err) {
    throw new Error(`Failed to update existing record: ${err.message}`);
  }
}

exports.main = async (args) => {
  // CORS preflight
  if (args.__ow_method === "options") {
    return { statusCode: 204 };
  }

  const data = parseBody(args);
  
  // Check if this is an availability check request
  const checkAvail = data["check-avail"] || data.checkAvail;
  const checkDate = data["check-date"] || data.checkDate;
  if (checkAvail) {
    try {
      const availability = await checkCohortAvailability(checkAvail, checkDate);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
          ok: true, 
          cohort: checkAvail,
          startDate: checkDate,
          ...availability 
        })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ok: false, error: err.message })
      };
    }
  }

  // Regular registration flow
  const name = (data.name || "").trim();
  const email = (data.email || "").trim();
  const start_date = (data.start_date || "").trim(); // ISO date yyyy-mm-dd
  const cohort = (data.cohort || "unknown").trim();
  const goal = (data.goal || "unknown").trim();

  // Check availability before allowing registration
  try {
    const availability = await checkCohortAvailability(cohort, start_date);
    if (!availability.isAvailable) {
      return {
        statusCode: 409, // Conflict
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
          ok: false, 
          error: "Cohort is full",
          cohort,
          startDate: start_date,
          spotsLeft: 0
        })
      };
    }
  } catch (err) {
    // Log error but continue with registration (fail open)
    console.error("Availability check failed:", err.message);
  }


  // Basic validation
  const errors = [];
  if (!name) errors.push("name is required");
  if (!validEmail(email)) errors.push("valid email is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) errors.push("start_date must be ISO yyyy-mm-dd");
  
  if (errors.length) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ok: false, errors })
    };
  }

  // Check if record already exists for this email + cohort + date
  try {
    const existingRecord = await findExistingRecord(email, cohort, start_date);
    
    if (existingRecord) {
      // Update existing record with new goal
      const updated = await updateExistingRecord(existingRecord.id, goal);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
          ok: true, 
          pageId: existingRecord.id, 
          updated: true,
          message: "Updated existing registration"
        })
      };
    }
  } catch (err) {
    // Log error but continue with creation (fail open)
    console.error("Failed to check/update existing record:", err.message);
  }

  // Build Notion page payload — adjust property names to match your DB
  const payload = {
    parent: { database_id: process.env.NOTION_DB_ID },
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
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ok: false, error: json })
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        ok: true, 
        pageId: json.id,
        created: true,
        message: "Created new registration"
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
