// PandaDoc -> Discord contract notifier — single self-contained file, plain
// JavaScript, ZERO dependencies (node runs it directly; no discord.js).
//
//   1. Webhook: POST /pandadoc/webhook -> on "document.completed" posts a
//      "✅ signed" message to Discord (deduped, amount enriched from the API).
//   2. Reminder poller: reminds about contracts that JUST crossed the unsigned
//      threshold (flood-safe: remind window + per-cycle cap + baseline seed).
//   3. Daily digest: once a day at PANDADOC_DIGEST_HOUR (ET), posts a sleek,
//      name-first list of everyone still unsigned within PANDADOC_DIGEST_MAX_DAYS.
//
// Start:  npm start   (or: node index.js)
// Test Discord wiring only:  node index.js --test

import http from "node:http";
import crypto from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? "3000");
const WEBHOOK_PATH = "/pandadoc/webhook";
const REMINDER_HOURS = Number(process.env.PANDADOC_REMINDER_HOURS ?? "8");
const POLL_INTERVAL_MINUTES = Number(process.env.PANDADOC_POLL_INTERVAL_MINUTES ?? "30");
const MAX_REMINDERS_PER_CYCLE = Number(process.env.PANDADOC_MAX_REMINDERS_PER_CYCLE ?? "10");
const DISCORD_SEND_SPACING_MS = 1200;
const PANDADOC_API_BASE = "https://api.pandadoc.com/public/v1";
const REMIND_WINDOW_MS = POLL_INTERVAL_MINUTES * 2 * 60 * 1000;

const STATUS_SENT = 1;
const STATUS_VIEWED = 5;

// Daily digest
const DIGEST_ENABLED = (process.env.PANDADOC_DIGEST_ENABLED ?? "true").toLowerCase() !== "false";
const DIGEST_HOUR = Number(process.env.PANDADOC_DIGEST_HOUR ?? "20");
const DIGEST_TZ = process.env.PANDADOC_DIGEST_TIMEZONE ?? "America/New_York";
const DIGEST_MAX_LIST = 40;
const DIGEST_MAX_DAYS = Number(process.env.PANDADOC_DIGEST_MAX_DAYS ?? "7");
const DIGEST_ROLE_ID = process.env.DISCORD_DIGEST_ROLE_ID ?? process.env.DISCORD_NOTIFY_ROLE_ID ?? null;
let lastDigestDate = null;

// --------------------------------------------------------------------------
// Trello — read each agent's "live date" from their card so a signed contract
// posts "goes live <date>" and pings the right person to turn them on.
//   Card title:  "New Agent - Anzac Keehan"  (agent name follows "New Agent -")
//   Description: "...Live Monday, September 21..."  (the live date)
// --------------------------------------------------------------------------
function boardIdFromEnv(v) {
  if (!v) return v;
  const m = String(v).match(/trello\.com\/b\/([A-Za-z0-9]+)/);
  return m ? m[1] : String(v).trim();
}
const TRELLO_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID = boardIdFromEnv(process.env.TRELLO_BOARD_ID);
const TRELLO_TZ = process.env.TRELLO_TIMEZONE ?? "America/New_York";
const ONBOARDING_ROLE_ID = process.env.DISCORD_ONBOARDING_ROLE_ID ?? null;
const ONBOARDING_USER_ID = process.env.DISCORD_ONBOARDING_USER_ID ?? null;
const trelloEnabled = Boolean(TRELLO_KEY && TRELLO_TOKEN && TRELLO_BOARD_ID);

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const remindedDocIds = new Set();
const completedNotifiedIds = new Set();

// --------------------------------------------------------------------------
// Formatting helpers (no libraries — Intl handles timezone)
// --------------------------------------------------------------------------
function formatEastern(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d) + " ET"
  );
}
function timeAgo(iso) {
  if (!iso) return "a while";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "a while";
  const hours = (Date.now() - then) / 3_600_000;
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `about ${mins} minute${mins === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const r = Math.round(hours);
    return `about ${r} hour${r === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}
function compactAge(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (isNaN(t)) return "";
  const h = (Date.now() - t) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
function clientName(name) {
  if (!name) return "(unknown)";
  const i = name.toLowerCase().lastIndexOf(" x ");
  return (i !== -1 ? name.slice(i + 3) : name).trim();
}
function formatMoney(total) {
  if (!total || !total.amount) return "";
  const num = Number(total.amount);
  if (!isFinite(num) || num === 0) return "";
  const currency = total.currency || "USD";
  if (currency === "USD") return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return `${num.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`;
}
function primaryRecipient(doc) {
  const recipients = doc.recipients ?? [];
  return recipients.find((r) => r.has_completed === false) ?? recipients[0];
}
function recipientLabel(r) {
  if (!r) return "the recipient";
  const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  if (name && r.email) return `${name} (${r.email})`;
  return name || r.email || "the recipient";
}

// --------------------------------------------------------------------------
// Trello lookups (live date per agent)
// --------------------------------------------------------------------------
async function trelloGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.trello.com/1${path}${sep}key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
let trelloCardsCache = { at: 0, cards: [] };
async function getBoardCards() {
  const FRESH_MS = 5 * 60 * 1000;
  if (trelloCardsCache.cards.length && Date.now() - trelloCardsCache.at < FRESH_MS) return trelloCardsCache.cards;
  const cards = await trelloGet(`/boards/${TRELLO_BOARD_ID}/cards?fields=name,desc`);
  trelloCardsCache = { at: Date.now(), cards };
  return cards;
}
// Normalize a name for matching: drop the "New Agent -" prefix, punctuation, case.
function normName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/new agent\s*[-–—:]\s*/i, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Keep original casing but strip the "New Agent -" prefix for display.
function displayAgentName(cardName) {
  return (cardName || "").replace(/^\s*new agent\s*[-–—:]\s*/i, "").trim() || cardName || "the agent";
}
// Candidate agent names from a signed document (recipient name + client from title).
function agentNamesFromDoc(doc) {
  const names = [];
  const c = clientName(doc.name); // client parsed from the contract title — most reliable
  if (c && c !== "(unknown)") names.push(c);
  const r = primaryRecipient(doc); // recipient name — fallback (may be an internal signer)
  if (r) {
    const full = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
    if (full) names.push(full);
  }
  return names;
}
async function findTrelloCardForDoc(doc) {
  const candidates = agentNamesFromDoc(doc).map(normName).filter((n) => n.length >= 3);
  if (!candidates.length) return null;
  let cards;
  try {
    cards = await getBoardCards();
  } catch (err) {
    console.error("trello: card fetch failed", err.message ?? err);
    return null;
  }
  for (const card of cards) {
    const title = normName(card.name);
    if (!title) continue;
    for (const cand of candidates) {
      if (title === cand || title.includes(cand) || cand.includes(title)) return card;
    }
  }
  return null;
}
// Build a Date for a given month/day in TRELLO_TZ (assume this year; roll to
// next year only if the date is well in the past).
function buildDateFromMonthDay(monthIdx, day) {
  if (monthIdx < 0 || monthIdx > 11 || !(day >= 1 && day <= 31)) return null;
  const now = new Date();
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: TRELLO_TZ, year: "numeric" }).format(now));
  let d = new Date(Date.UTC(year, monthIdx, day, 16, 0, 0)); // ~noon ET, tz-safe
  if (d.getTime() < now.getTime() - 120 * 24 * 3600 * 1000) {
    d = new Date(Date.UTC(year + 1, monthIdx, day, 16, 0, 0));
  }
  return d;
}
// Parse "Live Monday, September 21" / "Live September 21" / "Live 9/21" from a card description.
function parseLiveDate(desc) {
  if (!desc) return null;
  const idx = desc.toLowerCase().indexOf("live");
  const seg = idx >= 0 ? desc.slice(idx, idx + 80) : desc;
  let m = seg.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    return buildDateFromMonthDay(MONTHS[m[1].toLowerCase()], Number(m[2]));
  }
  const n = seg.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (n) return buildDateFromMonthDay(Number(n[1]) - 1, Number(n[2]));
  return null;
}
function ymdInTz(date, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function liveDayLabel(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TRELLO_TZ, weekday: "long", month: "short", day: "numeric" }).format(date);
}

// --------------------------------------------------------------------------
// Message wording
// --------------------------------------------------------------------------
function signedMessage(doc) {
  const client = clientName(doc.name);
  const who = recipientLabel(primaryRecipient(doc));
  const amount = formatMoney(doc.grand_total);
  const when = formatEastern(doc.date_completed) || formatEastern(doc.date_modified);
  const lines = [`✅ **Contract signed** — ${client}`, `${who} just signed.`];
  if (amount) lines.push(`💰 Amount: ${amount}`);
  if (when) lines.push(`🕑 Completed: ${when}`);
  lines.push(`\n🚀 **Next:** set up **${client}** on the lead hub, then turn them on for their live date. React ✅ when live.`);
  return lines.join("\n");
}
// Signed notification enriched with the agent's live date from Trello. Falls
// back to the generic signedMessage() if Trello is off or no card/date is found.
// Returns { content, mention: { roleId?, userId? } }.
async function buildSignedNotification(doc) {
  const mention = { roleId: ONBOARDING_ROLE_ID ?? undefined, userId: ONBOARDING_USER_ID ?? undefined };
  if (!trelloEnabled) return { content: signedMessage(doc), mention };

  let card = null;
  try {
    card = await findTrelloCardForDoc(doc);
  } catch (err) {
    console.error("trello: lookup failed", err.message ?? err);
  }
  if (!card) {
    console.log(`trello: no matching card for [${agentNamesFromDoc(doc).join(" / ")}] — generic signed message`);
    return { content: signedMessage(doc), mention };
  }

  const agent = displayAgentName(card.name);
  const amount = formatMoney(doc.grand_total);
  const live = parseLiveDate(card.desc);

  if (!live) {
    console.log(`trello: matched "${card.name}" but couldn't read a live date`);
    const lines = [
      `✅ **${agent} signed!**`,
      `📇 Found their Trello card, but I couldn't read a live date from it.`,
    ];
    if (amount) lines.push(`💰 Amount: ${amount}`);
    lines.push(`👉 Set up **${agent}** on the lead hub, then turn them on for their live date. React ✅ when live.`);
    return { content: lines.join("\n"), mention };
  }

  const todayYmd = ymdInTz(new Date(), TRELLO_TZ);
  const liveYmd = ymdInTz(live, TRELLO_TZ);
  const label = liveDayLabel(live);
  let lines;
  if (liveYmd === todayYmd) {
    lines = [
      `✅ **${agent} signed!** — goes live **TODAY** 🎯 (${label})`,
      `Set up **${agent}** on the lead hub and **turn them on now**.`,
    ];
  } else if (liveYmd > todayYmd) {
    lines = [
      `✅ **${agent} signed!** — goes live **${label}** 📅`,
      `Set up **${agent}** on the lead hub now, then turn them on on their live date (**${label}**).`,
    ];
  } else {
    lines = [
      `✅ **${agent} signed!** — live date **${label}** has already passed ⚠️`,
      `Set up **${agent}** on the lead hub and turn them on ASAP.`,
    ];
  }
  if (amount) lines.push(`💰 Amount: ${amount}`);
  lines.push(`React ✅ when they're live.`);
  return { content: lines.join("\n"), mention };
}
function reminderMessage(doc) {
  const who = recipientLabel(primaryRecipient(doc));
  const amount = formatMoney(doc.grand_total);
  const sentIso = doc.date_modified || doc.date_created;
  const ago = timeAgo(sentIso);
  const viewed = doc.status === "document.viewed";
  const lines = [
    `⏰ **Contract not signed yet** — ${doc.name}`,
    `${who} received this ${ago} ago and ${viewed ? "has viewed but not signed" : "hasn't opened or signed"} it. Please follow up.`,
  ];
  if (amount) lines.push(`💰 Amount: ${amount}`);
  const when = formatEastern(sentIso);
  if (when) lines.push(`🕑 Sent: ${when}`);
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Discord delivery (429-aware). opts.mentionRoleId pings a role on this message.
// --------------------------------------------------------------------------
async function discordPost(url, headers, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 429) {
      let retryAfter = 1;
      try {
        const j = await res.json();
        retryAfter = Number(j.retry_after) || 1;
      } catch {
        /* ignore */
      }
      console.warn(`Discord rate-limited — waiting ${retryAfter}s then retrying`);
      await sleep((retryAfter + 0.25) * 1000);
      continue;
    }
    if (!res.ok) console.error("Discord post failed", res.status, await res.text());
    return;
  }
  console.error("Discord post failed after retries (still rate-limited)");
}
async function notifyDiscord(content, opts = {}) {
  const roleId = opts.mentionRoleId ?? process.env.DISCORD_NOTIFY_ROLE_ID;
  const userId = opts.mentionUserId ?? null;
  const allowed = { parse: [] };
  let prefix = "";
  if (userId) {
    prefix += `<@${userId}> `;
    allowed.users = [userId];
  }
  if (roleId) {
    prefix += `<@&${roleId}> `;
    allowed.roles = [roleId];
  }
  const body = { content: (prefix + content).slice(0, 2000), allowed_mentions: allowed };
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    await discordPost(webhookUrl, { "Content-Type": "application/json" }, body);
    return;
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_NOTIFY_CHANNEL_ID;
  if (!token || !channelId) {
    throw new Error("No Discord destination — set DISCORD_WEBHOOK_URL, or DISCORD_BOT_TOKEN + DISCORD_NOTIFY_CHANNEL_ID");
  }
  await discordPost(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { "Content-Type": "application/json", Authorization: `Bot ${token}` },
    body
  );
}

// --------------------------------------------------------------------------
// PandaDoc API + webhook verification
// --------------------------------------------------------------------------
function verifyPandaDocSignature(rawBody, signature) {
  const sharedKey = process.env.PANDADOC_WEBHOOK_SHARED_KEY;
  if (!sharedKey) {
    console.warn("PANDADOC_WEBHOOK_SHARED_KEY not set — accepting webhook without verification.");
    return true;
  }
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", sharedKey).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
async function pandaGet(path) {
  const key = process.env.PANDADOC_API_KEY;
  if (!key) throw new Error("Missing PANDADOC_API_KEY");
  const res = await fetch(`${PANDADOC_API_BASE}${path}`, { headers: { Authorization: `API-Key ${key}` } });
  if (!res.ok) throw new Error(`PandaDoc GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function listDocumentsByStatus(statusCode) {
  const data = await pandaGet(`/documents?status=${statusCode}&count=100&order_by=date_created`);
  return data.results ?? [];
}
async function getDocumentDetails(id) {
  return pandaGet(`/documents/${id}/details`);
}

// --------------------------------------------------------------------------
// Webhook handling (signed alerts)
// --------------------------------------------------------------------------
async function handleWebhookEvents(events) {
  for (const evt of events) {
    const doc = evt?.data;
    if (!doc?.id) continue;
    if (doc.status === "document.completed") {
      if (completedNotifiedIds.has(doc.id)) {
        console.log(`webhook: ${doc.id} completed (duplicate) — skipping`);
        continue;
      }
      completedNotifiedIds.add(doc.id);
      remindedDocIds.delete(doc.id);
      console.log(`webhook: ${doc.id} completed — notifying Discord`);
      const enriched = await enrichForSigned(doc);
      const { content, mention } = await buildSignedNotification(enriched);
      await notifyDiscord(content, { mentionRoleId: mention.roleId, mentionUserId: mention.userId });
    } else {
      console.log(`webhook: ${doc.id} -> ${doc.status} (${evt.event}) — no notification`);
    }
  }
}
async function enrichForSigned(doc) {
  if (!process.env.PANDADOC_API_KEY) return doc;
  try {
    const details = await getDocumentDetails(doc.id);
    return { ...doc, ...details };
  } catch (err) {
    console.error(`webhook: couldn't fetch details for ${doc.id}, using webhook data`, err.message ?? err);
    return doc;
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// --------------------------------------------------------------------------
// Reminder poller
// --------------------------------------------------------------------------
function outstandingMs(doc) {
  const iso = doc.date_modified || doc.date_created;
  const since = iso ? Date.parse(iso) : NaN;
  return isFinite(since) ? Date.now() - since : 0;
}
function isNewlyOverdue(doc) {
  const thresholdMs = REMINDER_HOURS * 60 * 60 * 1000;
  const age = outstandingMs(doc);
  return age >= thresholdMs && age <= thresholdMs + REMIND_WINDOW_MS;
}
async function sendReminder(doc) {
  let enriched = doc;
  try {
    enriched = await getDocumentDetails(doc.id);
  } catch (err) {
    console.error(`poller: couldn't fetch details for ${doc.id}, using list row`, err.message ?? err);
  }
  await notifyDiscord(reminderMessage(enriched));
}
async function checkOutstandingContracts() {
  try {
    const [sent, viewed] = await Promise.all([listDocumentsByStatus(STATUS_SENT), listDocumentsByStatus(STATUS_VIEWED)]);
    const outstanding = [...sent, ...viewed];
    const stillOutstanding = new Set(outstanding.map((d) => d.id));
    for (const id of remindedDocIds) if (!stillOutstanding.has(id)) remindedDocIds.delete(id);

    const eligible = outstanding.filter((d) => !remindedDocIds.has(d.id) && isNewlyOverdue(d));
    let count = 0;
    for (const doc of eligible) {
      if (count >= MAX_REMINDERS_PER_CYCLE) {
        console.warn(`poller: per-cycle cap (${MAX_REMINDERS_PER_CYCLE}) reached — ${eligible.length - count} remaining next cycle`);
        break;
      }
      await sendReminder(doc);
      remindedDocIds.add(doc.id);
      count++;
      if (count < eligible.length) await sleep(DISCORD_SEND_SPACING_MS);
    }
    console.log(`poller: ${outstanding.length} outstanding, ${eligible.length} newly-overdue, ${count} reminder(s) sent (threshold ${REMINDER_HOURS}h)`);
  } catch (err) {
    console.error("poller: cycle failed", err.message ?? err);
  }
}
async function seedBaseline() {
  const thresholdMs = REMINDER_HOURS * 60 * 60 * 1000;
  try {
    const [sent, viewed] = await Promise.all([listDocumentsByStatus(STATUS_SENT), listDocumentsByStatus(STATUS_VIEWED)]);
    let seeded = 0;
    for (const doc of [...sent, ...viewed]) {
      if (outstandingMs(doc) >= thresholdMs) {
        remindedDocIds.add(doc.id);
        seeded++;
      }
    }
    console.log(`poller: baseline set — ${seeded} existing overdue contract(s) will NOT be notified. Only contracts that pass ${REMINDER_HOURS}h from now on will trigger a reminder.`);
  } catch (err) {
    console.warn("poller: baseline snapshot unavailable (likely rate-limited) — remind-window still prevents any backlog flood.", err.message ?? err);
  }
}

// --------------------------------------------------------------------------
// End-of-day digest
// --------------------------------------------------------------------------
function easternHourAndDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
}
async function sendUnsignedDigest() {
  try {
    const [sent, viewed] = await Promise.all([listDocumentsByStatus(STATUS_SENT), listDocumentsByStatus(STATUS_VIEWED)]);
    const allOutstanding = [...sent, ...viewed].sort((a, b) => outstandingMs(a) - outstandingMs(b)); // newest first

    const maxAgeMs = DIGEST_MAX_DAYS > 0 ? DIGEST_MAX_DAYS * 24 * 60 * 60 * 1000 : Infinity;
    const outstanding = allOutstanding.filter((d) => outstandingMs(d) <= maxAgeMs);
    const hiddenOld = allOutstanding.length - outstanding.length;
    const oldNote = hiddenOld > 0 ? `_+${hiddenOld} older than ${DIGEST_MAX_DAYS}d_` : "";

    if (outstanding.length === 0) {
      const msg =
        allOutstanding.length === 0
          ? "📋 **8 PM check** — ✅ All signed. Nothing pending."
          : `📋 **8 PM check** — ✅ Nothing unsigned in the last ${DIGEST_MAX_DAYS}d.${oldNote ? " " + oldNote : ""}`;
      await notifyDiscord(msg, { mentionRoleId: DIGEST_ROLE_ID });
      return;
    }

    const capped = outstanding.slice(0, DIGEST_MAX_LIST);
    const extra = outstanding.length - capped.length;
    const lines = capped.map((d, i) => `${i + 1}. **${clientName(d.name)}** · ${compactAge(d.date_modified || d.date_created)}`);
    const header = `📋 **Unsigned contracts — 8 PM** · ${outstanding.length} pending`;
    let footer = "";
    if (extra > 0) footer = `_+${extra} more (${DIGEST_MAX_LIST} shown)_`;
    if (hiddenOld > 0) footer += (footer ? " · " : "") + oldNote;

    const messages = [];
    let cur = header;
    for (const line of lines) {
      if ((cur + "\n" + line).length > 1900) { messages.push(cur); cur = line; }
      else cur += "\n" + line;
    }
    if (footer) {
      if ((cur + "\n\n" + footer).length <= 1990) cur += "\n\n" + footer;
      else { messages.push(cur); cur = footer; }
    }
    messages.push(cur);

    for (let i = 0; i < messages.length; i++) {
      await notifyDiscord(messages[i], i === 0 ? { mentionRoleId: DIGEST_ROLE_ID } : {});
      if (i < messages.length - 1) await sleep(1200);
    }
    console.log(`digest: posted ${outstanding.length} unsigned across ${messages.length} message(s)`);
  } catch (err) {
    console.error("digest: failed to build/send", err.message ?? err);
  }
}
async function maybeSendDigest() {
  if (!DIGEST_ENABLED) return;
  const { hour, date } = easternHourAndDate();
  if (hour === DIGEST_HOUR && lastDigestDate !== date) {
    lastDigestDate = date;
    console.log(`digest: it's ${DIGEST_HOUR}:00 ${DIGEST_TZ} — sending end-of-day contract list`);
    await sendUnsignedDigest();
  }
}

// --------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------
function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pandadoc->discord worker ok");
      return;
    }
    if (req.method === "POST" && url.pathname === WEBHOOK_PATH) {
      const rawBody = await readBody(req);
      const signature = url.searchParams.get("signature");
      if (!verifyPandaDocSignature(rawBody, signature)) {
        console.error("webhook: signature verification failed — rejecting");
        res.writeHead(401);
        res.end("invalid signature");
        return;
      }
      res.writeHead(200);
      res.end("ok");
      try {
        const parsed = JSON.parse(rawBody);
        const events = Array.isArray(parsed) ? parsed : [parsed];
        await handleWebhookEvents(events);
      } catch (err) {
        console.error("webhook: failed to process", err);
      }
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.listen(PORT, () => {
    console.log(`pandadoc->discord worker listening on :${PORT}  (flood-safe build)`);
    console.log(`  webhook path:   POST ${WEBHOOK_PATH}`);
    console.log(`  reminder after: ${REMINDER_HOURS}h unsigned (remind window ${Math.round(REMIND_WINDOW_MS / 60000)}m, cap ${MAX_REMINDERS_PER_CYCLE}/cycle)`);
    console.log(`  poll every:     ${POLL_INTERVAL_MINUTES}m`);
    console.log(`  daily digest:   ${DIGEST_ENABLED ? `${DIGEST_HOUR}:00 ${DIGEST_TZ}, show <=${DIGEST_MAX_DAYS}d, ping ${DIGEST_ROLE_ID ? "role " + DIGEST_ROLE_ID : "none"}` : "off"}`);
    console.log(`  trello live date: ${trelloEnabled ? `on (board ${TRELLO_BOARD_ID}, ping ${ONBOARDING_USER_ID ? "user " + ONBOARDING_USER_ID : ONBOARDING_ROLE_ID ? "role " + ONBOARDING_ROLE_ID : "default"})` : "off (set TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID)"}`);
    if (!process.env.PANDADOC_API_KEY) {
      console.warn("  PANDADOC_API_KEY not set — reminder polling & digest disabled (webhook notifications still work).");
      return;
    }
    (async () => {
      await seedBaseline();
      setInterval(checkOutstandingContracts, POLL_INTERVAL_MINUTES * 60 * 1000);
      setInterval(maybeSendDigest, 60 * 1000);
    })();
  });
}

// --------------------------------------------------------------------------
// Test mode: node index.js --test
// --------------------------------------------------------------------------
async function runTest() {
  const now = new Date().toISOString();
  const eightHoursAgo = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
  const signedSample = {
    id: "sample-signed",
    name: "Agent Lead Lab Agreement — Jane Sample",
    status: "document.completed",
    date_completed: now,
    grand_total: { amount: "1500.00", currency: "USD" },
    recipients: [{ first_name: "Jane", last_name: "Sample", email: "jane@example.com", has_completed: true }],
  };
  const unsignedSample = {
    id: "sample-unsigned",
    name: "Agent Lead Lab Agreement — John Pending",
    status: "document.viewed",
    date_modified: eightHoursAgo,
    grand_total: { amount: "2500.00", currency: "USD" },
    recipients: [{ first_name: "John", last_name: "Pending", email: "john@example.com", has_completed: false }],
  };
  console.log("Sending sample 'signed' notification…");
  await notifyDiscord(signedMessage(signedSample));
  console.log("Sending sample 'not signed yet' reminder…");
  await notifyDiscord(reminderMessage(unsignedSample));
  console.log("Done — check your Discord channel for two test messages.");
}

// Preview what Coco would post when <name>'s contract is signed, using the
// real Trello card. Run:  node index.js --test-trello "Anzac Keehan"
async function runTrelloTest(name) {
  if (!trelloEnabled) {
    console.error("Trello not configured — set TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID first.");
    return;
  }
  const parts = name.trim().split(/\s+/);
  const fakeDoc = {
    id: "trello-test",
    name: `Agreement x ${name}`,
    grand_total: null,
    recipients: [{ first_name: parts[0], last_name: parts.slice(1).join(" ") }],
  };
  const card = await findTrelloCardForDoc(fakeDoc);
  if (!card) {
    console.log(`No card matched "${name}". First few card titles on the board:`);
    try {
      (await getBoardCards()).slice(0, 8).forEach((c) => console.log("  -", c.name));
    } catch (err) {
      console.error("  (couldn't list cards)", err.message ?? err);
    }
    return;
  }
  console.log("Matched card:  ", card.name);
  console.log("Description:   ", JSON.stringify((card.desc || "").slice(0, 120)));
  const live = parseLiveDate(card.desc);
  console.log("Parsed live:   ", live ? `${liveDayLabel(live)} (${ymdInTz(live, TRELLO_TZ)})` : "(none)");
  const { content } = await buildSignedNotification(fakeDoc);
  console.log("\n--- Discord message Coco would post ---\n" + content + "\n---------------------------------------");
}

if (process.argv.includes("--test-trello")) {
  const i = process.argv.indexOf("--test-trello");
  const name = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "Anzac Keehan";
  runTrelloTest(name).then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
} else if (process.argv.includes("--test")) {
  runTest().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
} else {
  startServer();
}
