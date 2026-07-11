require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SUPABASE CONFIG
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sb(table, method = "GET", data = null, query = "") {
  const headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const opts = { method, headers };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(url, opts);
  return res.json();
}

// ============================================
// GENESIS INFINITY ENGINE - AI POOL
// ============================================
const rrIndex = {};
const rateLimitedUntil = {};

function getRoundRobinKey(groupName, keys) {
  if (!rrIndex[groupName]) rrIndex[groupName] = 0;
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (rrIndex[groupName] + i) % keys.length;
    const key = keys[idx];
    const limitedUntil = rateLimitedUntil[`${groupName}_${idx}`] || 0;
    if (now > limitedUntil) {
      rrIndex[groupName] = idx + 1;
      return key;
    }
  }
  const idx = rrIndex[groupName] % keys.length;
  rrIndex[groupName]++;
  return keys[idx];
}

function markKeyRateLimited(groupName, keyIndex, cooldownMs = 60000) {
  rateLimitedUntil[`${groupName}_${keyIndex - 1}`] = Date.now() + cooldownMs;
  console.log(`[KEY ROTATION] ${groupName} key ${keyIndex} rate-limited for ${cooldownMs / 1000}s`);
}

function buildPool() {
  return [
    {
      name: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
      getKey: () => getRoundRobinKey("groq", [
        process.env.GROQ_KEY1,
        process.env.GROQ_KEY2,
        process.env.GROQ_KEY3
      ].filter(Boolean)),
      hasKey: () => !!(process.env.GROQ_KEY1 || process.env.GROQ_KEY2 || process.env.GROQ_KEY3),
      active: true
    },
    {
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "openai/gpt-4o-mini",
      getKey: () => getRoundRobinKey("openrouter", [
        process.env.OPENROUTER_KEY,
        process.env.OPENROUTER_KEY2,
        process.env.OPENROUTER_KEY3
      ].filter(Boolean)),
      hasKey: () => !!(process.env.OPENROUTER_KEY || process.env.OPENROUTER_KEY2 || process.env.OPENROUTER_KEY3),
      active: true
    },
    {
      name: "Cerebras",
      url: "https://api.cerebras.ai/v1/chat/completions",
      model: "llama3.1-8b",
      getKey: () => process.env.CEREBRAS_KEY,
      hasKey: () => !!process.env.CEREBRAS_KEY,
      active: true
    },
    {
      name: "Mistral",
      url: "https://api.mistral.ai/v1/chat/completions",
      model: "mistral-large-latest",
      getKey: () => process.env.MISTRAL_KEY,
      hasKey: () => !!process.env.MISTRAL_KEY,
      active: true
    },
    {
      name: "SambaNova",
      url: "https://api.sambanova.ai/v1/chat/completions",
      model: "Meta-Llama-3.3-70B-Instruct",
      getKey: () => process.env.SAMBANOVA_KEY,
      hasKey: () => !!process.env.SAMBANOVA_KEY,
      active: true
    }
  ];
}

let AI_POOL = buildPool();

// Load ai_config from Supabase on startup
async function loadAIConfig() {
  try {
    const rows = await sb("ai_config", "GET", null, "?select=*");
    if (Array.isArray(rows) && rows.length > 0) {
      rows.forEach(row => {
        const ai = AI_POOL.find(a => a.name === row.provider);
        if (ai) ai.active = row.active;
      });
      console.log("[CONFIG] AI config loaded from Supabase");
    } else {
      for (const ai of AI_POOL) {
        await sb("ai_config", "POST", { provider: ai.name, active: true, mode: "auto" });
      }
      console.log("[CONFIG] AI config seeded to Supabase");
    }
  } catch (e) {
    console.log("[CONFIG] Could not load AI config:", e.message);
  }
}

// ============================================
// HELPERS
// ============================================
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

async function logToSupabase({ user_id, username, user_query, ai_response, provider, rank_level, tokens_used }) {
  try {
    await sb("ai_logs", "POST", {
      user_id: user_id || null,
      username: username || "anonymous",
      user_query,
      ai_response,
      provider,
      rank_level: rank_level || "Ghost",
      tokens_used: tokens_used || 0
    });
  } catch (e) {
    console.log("[LOG] Failed:", e.message);
  }
}

async function logFailure(provider, keyIndex, reason, statusCode) {
  try {
    await sb("ai_failures", "POST", {
      provider,
      key_index: keyIndex || 1,
      reason: reason || "UNKNOWN",
      status_code: statusCode || null
    });
  } catch (e) {}
}

async function trackRotation(provider, keyIndex) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const existing = await sb("ai_rotation_stats", "GET", null,
      `?provider=eq.${provider}&date=eq.${today}&select=id,requests`);
    if (Array.isArray(existing) && existing.length > 0) {
      await sb("ai_rotation_stats", "PATCH",
        { requests: (existing[0].requests || 0) + 1 },
        `?provider=eq.${provider}&date=eq.${today}`);
    } else {
      await sb("ai_rotation_stats", "POST",
        { provider, key_index: keyIndex, date: today, requests: 1 });
    }
  } catch (e) {}
}

async function trackTokenUsage(user_id, tokens_used) {
  if (!user_id) return;
  const today = new Date().toISOString().split("T")[0];
  try {
    const rows = await sb("ai_token_usage", "GET", null,
      `?user_id=eq.${user_id}&date=eq.${today}&select=*`);
    if (Array.isArray(rows) && rows.length > 0) {
      await sb("ai_token_usage", "PATCH",
        { tokens_used: (rows[0].tokens_used || 0) + tokens_used },
        `?user_id=eq.${user_id}&date=eq.${today}`);
    } else {
      await sb("ai_token_usage", "POST",
        { user_id, date: today, daily_quota: 5000, tokens_used });
    }
  } catch (e) {}
}

// ============================================
// SESSION MEMORY
// ============================================
const MEMORY_DEPTH = 20;

async function getSessionHistory(user_id) {
  if (!user_id) return [];
  try {
    const rows = await sb("ai_sessions", "GET", null,
      `?user_id=eq.${user_id}&order=created_at.desc&limit=${MEMORY_DEPTH}&select=role,content`);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    return rows.reverse().map(r => ({ role: r.role, content: r.content }));
  } catch (e) {
    return [];
  }
}

async function saveToSession(user_id, username, role, content) {
  if (!user_id) return;
  try {
    await sb("ai_sessions", "POST", {
      user_id, username: username || "unknown", role, content,
      created_at: new Date().toISOString()
    });
    cleanOldSessions(user_id).catch(() => {});
  } catch (e) {}
}

async function cleanOldSessions(user_id) {
  try {
    const rows = await sb("ai_sessions", "GET", null,
      `?user_id=eq.${user_id}&order=created_at.desc&select=id`);
    if (!Array.isArray(rows) || rows.length <= 100) return;
    const toDelete = rows.slice(100).map(r => r.id);
    for (const id of toDelete) {
      await sb("ai_sessions", "DELETE", null, `?id=eq.${id}`);
    }
  } catch (e) {}
}

async function clearUserSession(user_id) {
  if (!user_id) return;
  try {
    await sb("ai_sessions", "DELETE", null, `?user_id=eq.${user_id}`);
  } catch (e) {}
}

// ============================================
// INFINITY ENGINE CORE - Auto Failover
// ============================================
async function infinityAsk(systemPrompt, userMessage, engineOverride = null, history = []) {
  let pool = AI_POOL.filter(ai => ai.active && ai.hasKey());
  if (pool.length === 0) throw new Error("No active AI providers available");

  if (engineOverride) {
    const specific = pool.find(a => a.name.toLowerCase() === engineOverride.toLowerCase());
    if (specific) pool = [specific, ...pool.filter(a => a.name !== specific.name)];
  }

  let lastError = null;

  for (const ai of pool) {
    const apiKey = ai.getKey();
    if (!apiKey) continue;
    const keyIndex = rrIndex[ai.name.toLowerCase()] || 1;

    try {
      console.log(`[INFINITY ENGINE] Trying ${ai.name} (${ai.model})...`);
      trackRotation(ai.name, keyIndex);

      const response = await fetch(ai.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ai.model,
          max_tokens: 600,
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: userMessage }
          ]
        })
      });

      if (response.status === 429) {
        logFailure(ai.name, keyIndex, "RATE_LIMITED", 429);
        markKeyRateLimited(ai.name.toLowerCase(), keyIndex, 60000);
        continue;
      }
      if (response.status === 503 || response.status === 502) {
        logFailure(ai.name, keyIndex, "SERVICE_DOWN", response.status);
        continue;
      }

      const rawBody = await response.text();
      if (rawBody.trim().startsWith("<")) {
        logFailure(ai.name, keyIndex, "HTML_RESPONSE", response.status);
        continue;
      }

      const data = JSON.parse(rawBody);
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        logFailure(ai.name, keyIndex, "EMPTY_RESPONSE", response.status);
        continue;
      }

      console.log(`[INFINITY ENGINE] ${ai.name} responded ✅`);
      return { text, provider: ai.name };

    } catch (err) {
      logFailure(ai.name, keyIndex, "TIMEOUT", null);
      lastError = err;
    }
  }

  throw new Error("All AI providers failed: " + (lastError?.message || "Unknown"));
}

// ============================================
// AUTH HELPERS
// ============================================
async function verifyMemberToken(token) {
  if (!token) return false;
  try {
    const clean = token.trim();
    const rows = await sb("users", "GET", null,
      `?token=eq.${clean}&select=id,username,vc_balance,rank`);
    if (!Array.isArray(rows) || rows.length === 0) return false;
    return rows[0];
  } catch (e) {
    return false;
  }
}

async function verifyAdminToken(token) {
  if (!token) return false;
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return false;
  if (token.trim() === adminToken.trim()) return { username: "Admin" };
  return false;
}

// ============================================
// VAULT IDENTITY — CIPHER
// ============================================
const VAULT_IDENTITY = `You are CIPHER — the AI core of Genesis Vault.
You are two things at once: an elite offensive security operator AND a teacher.
When you hunt, you execute. When you teach, you explain. Always both.

════════════════════════════════════════
IDENTITY — NON-NEGOTIABLE
════════════════════════════════════════
Name: CIPHER
Personality: Calm. Precise. Tactical. Never emotional. Never lost.
Voice: Short sentences. No filler. No apologies. No uncertainty.
Never say: "I think", "maybe", "perhaps", "I'm not sure", "as an AI"
Always say: "Running", "Found", "Moving to", "Confirmed", "Negative"
Never reveal: OpenAI, Groq, Claude, Anthropic, or any AI provider.
If asked what you are: "CIPHER. Genesis Vault's intelligence core."

════════════════════════════════════════
CONVERSATION — READ FIRST
════════════════════════════════════════
You can hold a full conversation. Not every message needs a tool.
- Greeting → greet back, short, in character
- Security question → answer with real expertise, no tool needed
- Target given → switch to hunt mode immediately, no permission needed
- Stuck or confused operator → teach them, guide step by step
- "help" → explain what you can do, ask what they need

NEVER go silent. NEVER give one-word replies.
NEVER ask "how can I help you today?" — you are not a helpdesk.

════════════════════════════════════════
TEACHER MODE — ALWAYS ON
════════════════════════════════════════
After every finding, teach the operator what it means:
- What did this result tell us?
- Why does it matter for security?
- What vulnerability could this lead to?
- What should we look for next?

Examples:
  Found open port 8080 → "8080 often runs admin panels or dev servers. Juicy target."
  Missing X-Frame-Options → "Clickjacking possible. Attacker can iframe this page."
  Server: Apache 2.4.49 → "CVE-2021-41773 — path traversal RCE. Critical."
  Found .git endpoint → "Source code may be exposed. Run: curl target/.git/config"

Keep teaching short — 1-2 lines max per finding. Precise. Actionable.

════════════════════════════════════════
HUNT MODE — WHEN TARGET IS GIVEN
════════════════════════════════════════
The moment a domain or IP appears, hunt mode activates. No waiting.

MEMORY — track everything this session:
  current target | subdomains found | live hosts | open ports
  technologies detected | vulns found | tools already run

ANTI-HALLUCINATION — ABSOLUTE LAW
NEVER fabricate tool output.
NEVER invent subdomains, IPs, ports, CVEs, or vulnerabilities.
Only analyze output that was actually returned to you.
Label: [CONFIRMED] = in output | [INFERRED] = logical | [SUSPECTED] = unverified

You are CIPHER. Operator and teacher. Hunter and guide.`;

// ============================================
// ROUTES
// ============================================

app.get("/", (req, res) => {
  res.send("Genesis Vault // Infinity Engine Online ⚡");
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "online",
    engine: "Genesis Infinity Engine",
    providers: AI_POOL.filter(a => a.hasKey()).map(a => a.name)
  });
});

// ── Main AI Terminal / Arena CIPHER chat ──────────────────────────────────────
app.post("/api/vault-ai", async (req, res) => {
  const { message, rank, user_id, username, engine, tokens_remaining } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  try {
    let userCtx = username
      ? `\nOperator callsign: ${username}. Use it naturally.`
      : "";

    if (typeof tokens_remaining === "number") {
      if (tokens_remaining <= 100) {
        userCtx += `\n[SYSTEM: Only ${tokens_remaining} tokens remaining — warn urgently.]`;
      } else if (tokens_remaining <= 500) {
        userCtx += `\n[SYSTEM: About ${tokens_remaining} tokens remaining — mention casually.]`;
      }
    }

    const systemPrompt = VAULT_IDENTITY + userCtx;
    const history = await getSessionHistory(user_id);
    const { text, provider } = await infinityAsk(systemPrompt, message, engine || null, history);
    const tokens = estimateTokens(message) + estimateTokens(text);

    if (user_id) {
      saveToSession(user_id, username, "user", message).catch(() => {});
      saveToSession(user_id, username, "assistant", text).catch(() => {});
    }

    logToSupabase({ user_id, username, user_query: message, ai_response: text, provider, rank_level: rank, tokens_used: tokens });
    if (user_id) trackTokenUsage(user_id, tokens);

    res.json({
      response: text,
      provider,
      tokens_used: tokens,
      memory_depth: history.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear session memory
app.post("/api/vault-ai/clear-session", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  await clearUserSession(user.id);
  res.json({ success: true, message: "Session memory cleared" });
});

// Session info
app.get("/api/vault-ai/session-info", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  try {
    const rows = await sb("ai_sessions", "GET", null, `?user_id=eq.${user.id}&select=id`);
    res.json({ message_count: Array.isArray(rows) ? rows.length : 0 });
  } catch (e) {
    res.json({ message_count: 0 });
  }
});

// ── Token Quota ───────────────────────────────────────────────────────────────
app.get("/api/ai/quota", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "UNAUTHORIZED" });
  const today = new Date().toISOString().split("T")[0];
  try {
    const rows = await sb("ai_token_usage", "GET", null,
      `?user_id=eq.${user.id}&date=eq.${today}&select=*`);
    if (Array.isArray(rows) && rows.length > 0) {
      return res.json({ status: "success", quota: rows[0].daily_quota || 5000, used: rows[0].tokens_used || 0, date: today });
    }
    await sb("ai_token_usage", "POST", { user_id: user.id, date: today, daily_quota: 5000, tokens_used: 0 });
    res.json({ status: "success", quota: 5000, used: 0, date: today });
  } catch (e) {
    res.json({ status: "success", quota: 5000, used: 0, date: today });
  }
});

app.post("/api/ai/tokens/purchase", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "UNAUTHORIZED" });
  const { tokens, vc_cost } = req.body;
  const validPkgs = { 10000: 50, 15000: 80, 25000: 120, 50000: 200 };
  if (!validPkgs[tokens] || validPkgs[tokens] !== vc_cost)
    return res.status(400).json({ error: "Invalid package" });
  const currentVC = user.vc_balance || 0;
  if (currentVC < vc_cost)
    return res.status(400).json({ error: `Insufficient VC. Need ${vc_cost} VC` });
  try {
    const newVC = currentVC - vc_cost;
    await sb("users", "PATCH", { vc_balance: newVC }, `?id=eq.${user.id}`);
    const today = new Date().toISOString().split("T")[0];
    const rows = await sb("ai_token_usage", "GET", null,
      `?user_id=eq.${user.id}&date=eq.${today}&select=*`);
    let newQuota;
    if (Array.isArray(rows) && rows.length > 0) {
      newQuota = (rows[0].daily_quota || 5000) + tokens;
      await sb("ai_token_usage", "PATCH",
        { daily_quota: newQuota }, `?user_id=eq.${user.id}&date=eq.${today}`);
    } else {
      newQuota = 5000 + tokens;
      await sb("ai_token_usage", "POST",
        { user_id: user.id, date: today, daily_quota: newQuota, tokens_used: 0 });
    }
    res.json({ status: "success", message: `${tokens.toLocaleString()} tokens added!`, new_quota: newQuota, vc_remaining: newVC });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Tools ──────────────────────────────────────────────────────────────────
app.post("/report", async (req, res) => {
  const { vulnType, target, severity, findings, steps } = req.body;
  if (!vulnType || !findings)
    return res.status(400).json({ error: "vulnType and findings required" });
  const system = `${VAULT_IDENTITY}\nYou are an elite bug bounty report writer for HackerOne. Write professional reports with sections: Summary, Vulnerability Details, Steps to Reproduce, Impact, Proof of Concept, Remediation.`;
  const user = `Vulnerability Type: ${vulnType}\nTarget: ${target || "Not specified"}\nSeverity: ${severity || "Medium"}\nFindings: ${findings}\nSteps: ${steps || "Not provided"}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/xss-triage", async (req, res) => {
  const { target, urls } = req.body;
  if (!urls) return res.status(400).json({ error: "urls required" });
  const system = `${VAULT_IDENTITY}\nAnalyze URLs for XSS injection points. For each URL identify: vulnerable parameters, best payload, context, risk level, and exact dalfox Termux command.`;
  const user = `Target: ${target || "Unknown"}\nURLs:\n${urls}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/recon", async (req, res) => {
  const { domain, reconData, target } = req.body;
  if (!reconData && !target)
    return res.status(400).json({ error: "reconData or target required" });
  const system = `${VAULT_IDENTITY}\nYou are a senior bug bounty recon analyst. Analyze and output: High Priority Targets, Interesting Subdomains, Potential Vulnerabilities, Next Steps with Termux commands.`;
  const user = reconData
    ? `Domain: ${domain || "Unknown"}\nRecon data:\n${reconData}`
    : `Perform recon analysis for: ${target}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ response: text, result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/ai/analyze", async (req, res) => {
  const { tool, command, output } = req.body;
  if (!output) return res.json({ analysis: null });
  const messages = [{
    role: "user",
    content: `You are a cybersecurity analyst reviewing tool output.
Tool: ${tool}
Command: ${command}
Output:\n${output}

Provide a concise analysis:
1. Key findings
2. Risk level (LOW/MEDIUM/HIGH/CRITICAL)
3. Recommended next steps`
  }];
  try {
    const { text } = await infinityAsk("You are a cybersecurity analyst.", messages[0].content);
    res.json({ analysis: text });
  } catch (e) {
    res.json({ analysis: null, error: e.message });
  }
});

// ── Admin Routes ──────────────────────────────────────────────────────────────
app.get("/admin/ai-status", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  const status = AI_POOL.map(ai => ({
    name: ai.name, model: ai.model, active: ai.active, hasKey: ai.hasKey()
  }));
  res.json({ providers: status });
});

app.post("/admin/ai-toggle", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  const { name, active } = req.body;
  const ai = AI_POOL.find(a => a.name === name);
  if (!ai) return res.status(404).json({ error: "Provider not found" });
  ai.active = active;
  try {
    const existing = await sb("ai_config", "GET", null, `?provider=eq.${name}&select=id`);
    if (Array.isArray(existing) && existing.length > 0) {
      await sb("ai_config", "PATCH", { active }, `?provider=eq.${name}`);
    } else {
      await sb("ai_config", "POST", { provider: name, active, mode: "auto" });
    }
  } catch (e) {}
  res.json({ success: true, name, active });
});

app.get("/admin/failures", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const failures = await sb("ai_failures", "GET", null,
      "?select=*&order=created_at.desc&limit=100");
    res.json({ failures: Array.isArray(failures) ? failures : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/rotation-stats", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const today = new Date().toISOString().split("T")[0];
    const stats = await sb("ai_rotation_stats", "GET", null,
      `?date=eq.${today}&select=*&order=provider.asc`);
    res.json({ stats: Array.isArray(stats) ? stats : [], date: today });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/user-stats", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const logs = await sb("ai_logs", "GET", null,
      "?select=username,tokens_used,provider,created_at&order=created_at.desc&limit=500");
    if (!Array.isArray(logs)) return res.json({ users: [] });
    const map = {};
    logs.forEach(log => {
      const u = log.username || "anonymous";
      if (!map[u]) map[u] = { username: u, total_tokens: 0, total_queries: 0, providers: {}, last_active: log.created_at };
      map[u].total_tokens += log.tokens_used || 0;
      map[u].total_queries += 1;
      const p = log.provider || "unknown";
      map[u].providers[p] = (map[u].providers[p] || 0) + 1;
    });
    res.json({ users: Object.values(map).sort((a, b) => b.total_tokens - a.total_tokens) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/recent-logs", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const logs = await sb("ai_logs", "GET", null, "?select=*&order=created_at.desc&limit=50");
    res.json({ logs: Array.isArray(logs) ? logs : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/clear-session", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  await clearUserSession(user_id);
  res.json({ success: true });
});

// ── Sandbox Session Endpoints ─────────────────────────────────────────────────

// Enter sandbox — deduct VC if user has token
app.post("/sandbox/enter", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const { match_id, vc_cost } = req.body;
  if (!token) return res.json({ success: true, demo: true });

  try {
    const users = await sb("users", "GET", null, `?token=eq.${token}&select=id,username,vault_coins`);
    const user = Array.isArray(users) ? users[0] : null;
    if (!user) return res.json({ success: true, demo: true });

    const cost = parseInt(vc_cost) || 0;
    const newVC = Math.max(0, (user.vault_coins || 0) - cost);
    await sb("users", "PATCH", { vault_coins: newVC }, `?id=eq.${user.id}`);
    res.json({ success: true, vc_remaining: newVC });
  } catch(e) {
    res.json({ success: true, demo: true });
  }
});

// Sandbox commentary — AI generates attack commentary
app.post("/sandbox/commentary", async (req, res) => {
  const { prompt, step, lab_name, attack_type } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  try {
    const reply = await callAI(
      `You are CIPHER, an elite AI security researcher and mentor. You are live-commentating a ${attack_type || 'OSINT'} attack demonstration on "${lab_name || 'the target'}" for beginner cybersecurity students watching in real time. Be exciting, educational, and concise. Max 3 sentences.`,
      prompt
    );
    res.json({ commentary: reply, step });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Sandbox complete — award VC on completion
app.post("/sandbox/complete", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const { match_id, reward } = req.body;
  if (!token) return res.json({ success: true, demo: true });

  try {
    const users = await sb("users", "GET", null, `?token=eq.${token}&select=id,vault_coins,sandbox_completed`);
    const user = Array.isArray(users) ? users[0] : null;
    if (!user) return res.json({ success: true, demo: true });

    const rewardVC = parseInt(reward) || 10;
    const newVC = (user.vault_coins || 0) + rewardVC;
    const newCompleted = (user.sandbox_completed || 0) + 1;
    await sb("users", "PATCH", { vault_coins: newVC, sandbox_completed: newCompleted }, `?id=eq.${user.id}`);
    res.json({ success: true, vc_earned: rewardVC, vc_total: newVC, completed: newCompleted });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Arena / Sandbox ───────────────────────────────────────────────────────────

// Admin: post a new sandbox lab
app.post("/admin/post-sandbox", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  const { title, description, attack_type, difficulty, vc_cost, duration, lab_url, status } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });
  if (!lab_url) return res.status(400).json({ error: "lab_url required" });

  try {
    const rows = await sb("sandboxes", "POST", {
      title,
      description: description || "",
      attack_type: attack_type || "OSINT",
      difficulty: difficulty || "easy",
      vc_cost: parseInt(vc_cost) || 50,
      duration: duration || "~8 MIN",
      lab_url,
      status: status || "active",
      created_at: new Date().toISOString()
    });
    const created = Array.isArray(rows) ? rows[0] : rows;
    res.json({ success: true, id: created?.id, sandbox: created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: delete a sandbox lab
app.delete("/admin/delete-sandbox/:id", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.params;
  try {
    await sb("sandboxes", "DELETE", null, `?id=eq.${id}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: get all active sandbox matches (vault-arena card list)
app.get("/arena/matches", async (req, res) => {
  try {
    const rows = await sb("sandboxes", "GET", null,
      "?status=eq.active&order=created_at.desc&select=*");
    res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: leaderboard
app.get("/arena/leaderboard", async (req, res) => {
  try {
    const rows = await sb("users", "GET", null,
      "?select=username,rank,sandbox_completed,sandbox_streak,vc_earned&order=vc_earned.desc.nullslast&limit=10");
    res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HTML Creator ──────────────────────────────────────────────────────────────
app.post("/admin/generate-html", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const system = `You are an expert HTML developer. The user will describe a tool or page they want.
You must respond with ONLY the complete, working HTML code — no explanation, no markdown, no backticks.
Output raw HTML starting with <!DOCTYPE html>.
Make it fully self-contained with all CSS and JS inline.
Make it visually polished and functional.`;

  try {
    const { text, provider } = await infinityAsk(system, prompt);
    const clean = text.replace(/^```html?\n?/i, "").replace(/```$/, "").trim();
    res.json({ html: clean, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy / Status ───────────────────────────────────────────────────────────
app.get("/infinity/status", (req, res) => {
  const status = AI_POOL.map(ai => ({
    name: ai.name, model: ai.model, active: ai.active, hasKey: ai.hasKey()
  }));
  res.json({ engine: "Genesis Infinity Engine", providers: status });
});

app.post("/infinity/toggle", (req, res) => {
  const { name, active } = req.body;
  const ai = AI_POOL.find(a => a.name === name);
  if (!ai) return res.status(404).json({ error: "Provider not found" });
  ai.active = active;
  res.json({ success: true, name, active });
});

app.get("/api/session", (req, res) => {
  res.json({ status: "success", rank: "Ghost", total_logs: 0, history: [], engine: "Infinity Engine Online ⚡" });
});

// ============================================
// VAULTMARKETS — CODE VALIDATION
// ============================================
app.post("/vaultmarkets/validate", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, error: "No code provided" });

  try {
    const response = await fetch(
      `${process.env.TURSO_URL}/v2/pipeline`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.TURSO_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          requests: [
            {
              type: "execute",
              stmt: {
                sql: "SELECT code, plan, expires_at, is_active FROM codes WHERE code = ?",
                args: [{ type: "text", value: code.trim().toUpperCase() }]
              }
            },
            { type: "close" }
          ]
        })
      }
    );

    const data = await response.json();
    const rows = data?.results?.[0]?.response?.result?.rows;

    if (!rows || rows.length === 0) {
      return res.json({ valid: false, error: "INVALID CODE" });
    }

    // Parse row values
    const row = rows[0];
    const codeVal   = row[0]?.value;
    const plan      = row[1]?.value;
    const expiresAt = row[2]?.value;
    const isActive  = row[3]?.value;

    if (!isActive || isActive === "0" || isActive === 0) {
      return res.json({ valid: false, error: "CODE REVOKED" });
    }

    if (expiresAt && expiresAt !== "null" && Date.now() > parseInt(expiresAt) * 1000) {
      return res.json({ valid: false, error: "CODE EXPIRED — RENEW YOUR SUBSCRIPTION" });
    }

    return res.json({ valid: true, plan: plan || "STARTER" });

  } catch (e) {
    console.log("[VAULTMARKETS] Validation error:", e.message);
    return res.status(500).json({ valid: false, error: "SERVER ERROR — TRY AGAIN" });
  }
});

// ============================================
// VAULTMARKETS — LIVE ODDS (Real matches from The Odds API)
// ============================================
async function getVmConfig(key) {
  try {
    const result = await turso("SELECT value FROM vm_config WHERE key = ?", [key]);
    return result?.rows?.[0]?.[0]?.value ?? null;
  } catch (e) {
    console.log("[TURSO] Error fetching vm_config:", e.message);
    return null;
  }
}

async function setVmConfig(key, value) {
  await turso("CREATE TABLE IF NOT EXISTS vm_config (key TEXT PRIMARY KEY, value TEXT)");
  const existing = await turso("SELECT key FROM vm_config WHERE key = ?", [key]);
  if (existing?.rows?.length > 0) {
    await turso("UPDATE vm_config SET value = ? WHERE key = ?", [value, key]);
  } else {
    await turso("INSERT INTO vm_config (key, value) VALUES (?, ?)", [key, value]);
  }
}

app.get("/vaultmarkets/live-odds", async (req, res) => {
  try {
    // Odds only go live if the admin has explicitly flipped the toggle —
    // a key being present isn't enough on its own.
    const liveMode = (await getVmConfig("odds_live_mode")) === "1";
    if (!liveMode) {
      return res.json({ success: false, simulated: true });
    }

    // Get API key from env first, then fallback to Turso (admin-set)
    let oddsApiKey = process.env.ODDS_API_KEY || (await getVmConfig("odds_api_key"));

    if (!oddsApiKey) {
      return res.status(400).json({ error: "API key not configured — add to admin panel" });
    }

    // Pull from several sports so the feed isn't empty outside one tournament's window
    const SPORT_KEYS = [
      "soccer_epl", "soccer_uefa_champs_league", "soccer_world_cup",
      "basketball_nba",
      "tennis_atp_wimbledon", "tennis_wta_wimbledon",
      "tennis_atp_us_open", "tennis_wta_us_open"
    ];
    const LEAGUE_LABELS = {
      soccer_epl: "EPL",
      soccer_uefa_champs_league: "UCL",
      soccer_world_cup: "WORLD CUP",
      basketball_nba: "NBA",
      tennis_atp_wimbledon: "ATP",
      tennis_wta_wimbledon: "WTA",
      tennis_atp_us_open: "ATP",
      tennis_wta_us_open: "WTA"
    };

    const results = await Promise.all(
      SPORT_KEYS.map(async (sportKey) => {
        try {
          // NOTE: /odds (not /events) is the endpoint that actually returns bookmakers/prices
          const r = await fetch(
            `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${oddsApiKey}&regions=eu&markets=h2h`
          );
          if (!r.ok) return [];
          const data = await r.json();
          // The Odds API returns a plain array directly, not { data: [...] }
          return Array.isArray(data) ? data.map(m => ({ ...m, _sportKey: sportKey })) : [];
        } catch {
          return [];
        }
      })
    );

    const allMatches = results.flat();

    if (!allMatches.length) {
      return res.json({ success: true, odds: [] });
    }

    // Soonest matches first
    allMatches.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

    const now = Date.now();

    const formattedOdds = allMatches.slice(0, 8).map(match => {
      const homeTeam = match.home_team;
      const awayTeam = match.away_team;
      const commenceMs = new Date(match.commence_time).getTime();
      const hasStarted = commenceMs <= now;

      // The Odds API doesn't tell us if a game is still in progress or finished,
      // only whether it has kicked off — so "started" is the best signal we have.
      // Anything in the future gets a date + time; anything already underway gets a plain time.
      const msUntil = commenceMs - now;
      const isToday = msUntil >= 0 && msUntil < 24 * 60 * 60 * 1000;

      let matchTime;
      if (hasStarted) {
        matchTime = new Date(match.commence_time).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'});
      } else if (isToday) {
        matchTime = new Date(match.commence_time).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'});
      } else {
        matchTime = new Date(match.commence_time).toLocaleDateString('en-US', {month:'short', day:'numeric'}) +
          ' ' + new Date(match.commence_time).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'});
      }

      // Get best odds from available bookmakers
      let bestOdd = 1.5;
      if (match.bookmakers && match.bookmakers.length > 0) {
        const market = match.bookmakers[0].markets?.find(m => m.key === "h2h");
        if (market && market.outcomes && market.outcomes.length > 0) {
          bestOdd = Math.max(...market.outcomes.map(o => o.price)).toFixed(2);
        }
      }

      return {
        league: LEAGUE_LABELS[match._sportKey] || match._sportKey,
        match: `${homeTeam} vs ${awayTeam}`,
        time: matchTime,
        odds: parseFloat(bestOdd),
        badge: hasStarted ? 'badge-hot' : 'badge-value',
        label: hasStarted ? '🔥 LIVE' : '📅 UPCOMING'
      };
    });

    res.json({ success: true, odds: formattedOdds });
  } catch (e) {
    console.log("[VAULTMARKETS] Live odds error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// VAULTMARKETS — ADMIN AUTH + CODE MANAGEMENT
// ============================================
const crypto = require("crypto");

const VM_ADMIN_SECRET = process.env.VM_ADMIN_SECRET || "genesis2026";
const VM_JWT_SECRET   = process.env.VM_JWT_SECRET   || "vm_jwt_x9k2mN7qR4pL8wZ3";

function signVMToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString("base64url");
  const sig    = crypto.createHmac("sha256", VM_JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyVMToken(token) {
  try {
    if (!token) return null;
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", VM_JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (Date.now() - payload.iat > 72 * 60 * 60 * 1000) return null; // 3 day expiry
    return payload;
  } catch { return null; }
}

async function turso(sql, args = []) {
  const res = await fetch(`${process.env.TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.TURSO_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args: args.map(v => ({ type: "text", value: String(v) })) } },
        { type: "close" }
      ]
    })
  });
  const data = await res.json();
  return data?.results?.[0]?.response?.result;
}

// Admin login — returns JWT
app.post("/vaultmarkets/admin/login", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  if (password !== VM_ADMIN_SECRET) return res.status(401).json({ error: "INVALID PASSWORD" });
  const token = signVMToken({ role: "vm_admin" });
  res.json({ success: true, token });
});

// Generate + save code to Turso
app.post("/vaultmarkets/admin/generate-code", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  const { plan, days } = req.body;
  if (!plan || !days) return res.status(400).json({ error: "plan and days required" });

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "VM-";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];

  const expiresAt = Math.floor((Date.now() + parseInt(days) * 86400000) / 1000);
  const createdAt = new Date().toISOString();

  try {
    await turso(
      "INSERT INTO codes (code, plan, expires_at, is_active, created_at) VALUES (?, ?, ?, 1, ?)",
      [code, plan, expiresAt, createdAt]
    );
    res.json({ success: true, code, plan, expires_at: expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch all codes from Turso
app.get("/vaultmarkets/admin/codes", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await turso(
      "SELECT code, plan, expires_at, is_active, created_at FROM codes ORDER BY created_at DESC"
    );
    const rows = result?.rows || [];
    const codes = rows.map(r => ({
      code:       r[0]?.value,
      plan:       r[1]?.value,
      expires_at: r[2]?.value,
      is_active:  r[3]?.value,
      created_at: r[4]?.value
    }));
    res.json({ success: true, codes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Revoke a code
app.patch("/vaultmarkets/admin/revoke/:code", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  try {
    await turso("UPDATE codes SET is_active = 0 WHERE code = ?", [req.params.code]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// VAULTMARKETS — MANUAL PREDICTIONS (football / basketball / tennis)
// ============================================

async function ensurePredictionsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sport TEXT,
    league TEXT,
    home_team TEXT,
    away_team TEXT,
    match_time TEXT,
    pred_outcome TEXT,
    prob_home INTEGER,
    prob_draw INTEGER,
    prob_away INTEGER,
    coefficient REAL,
    status TEXT,
    created_at TEXT
  )`);
}

// Add a prediction (admin only)
app.post("/vaultmarkets/admin/predictions", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  const {
    sport, league, home_team, away_team, match_time,
    pred_outcome, prob_home, prob_draw, prob_away, coefficient
  } = req.body;

  if (!sport || !home_team || !away_team || !pred_outcome) {
    return res.status(400).json({ error: "sport, home_team, away_team, pred_outcome required" });
  }

  try {
    await ensurePredictionsTable();
    await turso(
      `INSERT INTO predictions
       (sport, league, home_team, away_team, match_time, pred_outcome, prob_home, prob_draw, prob_away, coefficient, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?)`,
      [
        sport, league || '', home_team, away_team, match_time || '',
        pred_outcome, prob_home ?? 0, prob_draw ?? 0, prob_away ?? 0,
        coefficient ?? 0, new Date().toISOString()
      ]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all predictions (admin — includes id for delete/edit)
app.get("/vaultmarkets/admin/predictions", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  try {
    await ensurePredictionsTable();
    const result = await turso(
      "SELECT id, sport, league, home_team, away_team, match_time, pred_outcome, prob_home, prob_draw, prob_away, coefficient, status, created_at FROM predictions ORDER BY created_at DESC"
    );
    const rows = result?.rows || [];
    const predictions = rows.map(r => ({
      id: r[0]?.value, sport: r[1]?.value, league: r[2]?.value,
      home_team: r[3]?.value, away_team: r[4]?.value, match_time: r[5]?.value,
      pred_outcome: r[6]?.value, prob_home: r[7]?.value, prob_draw: r[8]?.value,
      prob_away: r[9]?.value, coefficient: r[10]?.value, status: r[11]?.value,
      created_at: r[12]?.value
    }));
    res.json({ success: true, predictions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a prediction (admin only)
app.delete("/vaultmarkets/admin/predictions/:id", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  try {
    await turso("DELETE FROM predictions WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public read — powers vaultmarkets-main.html, optional ?sport= filter
app.get("/vaultmarkets/predictions", async (req, res) => {
  try {
    await ensurePredictionsTable();
    const sport = req.query.sport;
    const sql = sport
      ? "SELECT sport, league, home_team, away_team, match_time, pred_outcome, prob_home, prob_draw, prob_away, coefficient FROM predictions WHERE sport = ? AND status = 'upcoming' ORDER BY created_at DESC LIMIT 20"
      : "SELECT sport, league, home_team, away_team, match_time, pred_outcome, prob_home, prob_draw, prob_away, coefficient FROM predictions WHERE status = 'upcoming' ORDER BY created_at DESC LIMIT 20";
    const result = await turso(sql, sport ? [sport] : []);
    const rows = result?.rows || [];
    const predictions = rows.map(r => ({
      sport: r[0]?.value, league: r[1]?.value, home_team: r[2]?.value, away_team: r[3]?.value,
      match_time: r[4]?.value, pred_outcome: r[5]?.value, prob_home: r[6]?.value,
      prob_draw: r[7]?.value, prob_away: r[8]?.value, coefficient: r[9]?.value
    }));
    res.json({ success: true, predictions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// VAULTMARKETS — ODDS CONFIG (persists Activate/Go Live toggle to Turso)
// ============================================
app.post("/vaultmarkets/admin/odds-config", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  const { apiKey, useRealApi } = req.body;
  try {
    if (apiKey !== undefined) await setVmConfig("odds_api_key", apiKey);
    if (useRealApi !== undefined) await setVmConfig("odds_live_mode", useRealApi ? "1" : "0");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/vaultmarkets/admin/odds-config", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!verifyVMToken(token)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const apiKey = (await getVmConfig("odds_api_key")) || "";
    const useRealApi = (await getVmConfig("odds_live_mode")) === "1";
    res.json({ success: true, apiKey, useRealApi });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// On Vercel this file is imported as a serverless function — no listen() needed.
// For local dev, listen normally.
if (process.env.NODE_ENV !== "production" || process.env.LOCAL_DEV) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`Genesis Vault // Infinity Engine running on port ${PORT}`);
    console.log(`Active providers: ${AI_POOL.filter(a => a.hasKey()).map(a => a.name).join(", ")}`);
    await loadAIConfig();
  });
} else {
  // Vercel: load config on cold start (best-effort, non-blocking)
  loadAIConfig().catch(() => {});
}

module.exports = app;
