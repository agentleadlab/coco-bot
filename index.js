// Discord out-of-office auto-reply bot ("Coco"). Also answers FAQs, and — in
// your internal team server only — pulls live PandaDoc contract info:
//   • the list of unsigned contracts ("unsigned contracts", "last 5 days", …)
//   • a specific person's status ("is Jane Doe's contract signed?")
//
// Start:  npm start   (or: node index.js)

import { Client, Events, GatewayIntentBits } from "discord.js";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

// --------------------------------------------------------------------------
// Config (all from environment variables)
// --------------------------------------------------------------------------
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

const MESSAGE =
  process.env.OOO_MESSAGE ??
  "Thanks for reaching out! Our team is currently out of office. We'll get back to you as soon as we're back during business hours.";

const TIMEZONE = process.env.OOO_TIMEZONE ?? "America/New_York";
const START_HOUR = Number(process.env.OOO_START_HOUR ?? "9");
const END_HOUR = Number(process.env.OOO_END_HOUR ?? "18");
const COOLDOWN_MS = Number(process.env.OOO_COOLDOWN_MINUTES ?? "240") * 60 * 1000;
const TRIGGER = (process.env.OOO_TRIGGER ?? "both").toLowerCase();

// --------------------------------------------------------------------------
// FAQ
// --------------------------------------------------------------------------
const FAQ_ENABLED = (process.env.FAQ_ENABLED ?? "false").toLowerCase() === "true";
const FAQ = FAQ_ENABLED ? loadFaq() : [];
const FAQ_COOLDOWN_MS = 60 * 1000;

function loadFaq() {
  try {
    if (!existsSync("faq.json")) {
      console.warn("FAQ_ENABLED=true but faq.json not found — FAQ answers disabled until you add it.");
      return [];
    }
    const data = JSON.parse(readFileSync("faq.json", "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter((e) => e && Array.isArray(e.keywords) && typeof e.answer === "string");
  } catch (err) {
    console.error("Couldn't read faq.json (check for a JSON typo like a missing comma):", err?.message ?? err);
    return [];
  }
}
function matchFaq(text) {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  for (let i = 0; i < FAQ.length; i++) {
    for (const kw of FAQ[i].keywords) {
      const k = String(kw).toLowerCase().trim();
      if (k && t.includes(k)) return { entry: FAQ[i], index: i };
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Contracts (PandaDoc) — INTERNAL team server(s) only
// --------------------------------------------------------------------------
const PANDADOC_API_KEY = process.env.PANDADOC_API_KEY ?? "";
const PANDADOC_API_BASE = "https://api.pandadoc.com/public/v1";
const PANDADOC_STATUS_SENT = 1;
const PANDADOC_STATUS_VIEWED = 5;
const CONTRACT_LIST_GUILD_IDS = (process.env.PANDADOC_LIST_GUILD_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CONTRACTS_ENABLED = !!PANDADOC_API_KEY && CONTRACT_LIST_GUILD_IDS.length > 0;
const CONTRACT_LIST_MAX = 40;
const DEFAULT_LIST_DAYS = Number(process.env.PANDADOC_LIST_DEFAULT_DAYS ?? "10");
const CONTRACT_COOLDOWN_MS = 3_000; // per-person, just to swallow double-taps
const contractCooldown = new Map(); // userId -> last-request timestamp

async function pandaGet(path) {
  const res = await fetch(`${PANDADOC_API_BASE}${path}`, { headers: { Authorization: `API-Key ${PANDADOC_API_KEY}` } });
  if (!res.ok) throw new Error(`PandaDoc GET ${path} -> ${res.status}`);
  return res.json();
}
async function listPandaByStatus(code) {
  const data = await pandaGet(`/documents?status=${code}&count=100&order_by=date_created`);
  return data.results ?? [];
}
async function getPandaDetails(id) {
  return pandaGet(`/documents/${id}/details`);
}
// Search documents by name (their titles end with "… x <Client Name>").
async function searchPandaByName(name) {
  const data = await pandaGet(`/documents?q=${encodeURIComponent(name)}&count=25`);
  return data.results ?? [];
}
function docAgeMs(doc) {
  const iso = doc.date_modified || doc.date_created;
  const t = iso ? Date.parse(iso) : NaN;
  return isFinite(t) ? Date.now() - t : 0;
}
function contractClientName(name) {
  if (!name) return "(unknown)";
  const i = name.toLowerCase().lastIndexOf(" x ");
  return (i !== -1 ? name.slice(i + 3) : name).trim();
}
function contractCompactAge(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (isNaN(t)) return "";
  const h = (Date.now() - t) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
function fmtContractDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return "";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d) + " ET"
  );
}
function contractStatusLabel(status) {
  switch (status) {
    case "document.completed": return "✅ signed";
    case "document.sent": return "⏳ sent — not signed yet";
    case "document.viewed": return "👀 viewed — not signed yet";
    case "document.declined": return "❌ declined";
    case "document.voided": return "🚫 voided";
    case "document.paid": return "💰 paid";
    case "document.draft": return "📝 draft (not sent)";
    default: return (status || "unknown").replace("document.", "");
  }
}

// --- "unsigned contracts" list request -----------------------------------
function isUnsignedListRequest(text) {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  const aboutContracts = /(contract|signed|signature|sign)/.test(t);
  const wantsList = /(unsigned|not signed|haven't signed|havent signed|hasn't signed|hasnt signed|didn't sign|didnt sign|pending|outstanding|list|who has not|who hasn|not yet sign|still need|need to sign|awaiting)/.test(t);
  return aboutContracts && wantsList;
}
function parseRequestedWindow(text) {
  const m = (text || "").toLowerCase().match(/(\d+)\s*(hour|hr|day)s?/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!isFinite(n) || n <= 0) return null;
  const isHours = m[2].startsWith("h");
  return {
    ms: n * (isHours ? 3_600_000 : 86_400_000),
    label: `${n} ${isHours ? (n === 1 ? "hour" : "hours") : n === 1 ? "day" : "days"}`,
  };
}
async function buildUnsignedContractMessages(windowMs, windowLabel) {
  const [sent, viewed] = await Promise.all([
    listPandaByStatus(PANDADOC_STATUS_SENT),
    listPandaByStatus(PANDADOC_STATUS_VIEWED),
  ]);
  const cutoff = windowMs && isFinite(windowMs) ? windowMs : Infinity;
  const outstanding = [...sent, ...viewed]
    .filter((d) => docAgeMs(d) <= cutoff)
    .sort((a, b) => docAgeMs(a) - docAgeMs(b)); // newest first
  const scope = windowLabel ? ` — last ${windowLabel}` : "";
  if (outstanding.length === 0) return [`📋 **Unsigned contracts${scope}** — ✅ None. All caught up! 🎉`];

  const capped = outstanding.slice(0, CONTRACT_LIST_MAX);
  const extra = outstanding.length - capped.length;
  const lines = capped.map((d, i) => `${i + 1}. **${contractClientName(d.name)}** · ${contractCompactAge(d.date_modified || d.date_created)}`);
  const header = `📋 **Unsigned contracts${scope}** · ${outstanding.length} pending`;
  const footer = extra > 0 ? `_+${extra} more (${CONTRACT_LIST_MAX} shown)_` : "";

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
  return messages;
}

// --- specific person's contract status -----------------------------------
// Pulls a person's name out of a status question. Returns the name or null.
function parseContractStatusName(raw) {
  const text = (raw || "").replace(/<@!?\d+>/g, " ").trim(); // strip the @Coco mention
  const lower = text.toLowerCase();
  if (!/(contract|\bsign)/.test(lower)) return null; // must be about signing/contracts
  if (isUnsignedListRequest(text)) return null; // that's the LIST command, not a person

  let name = null;
  let m;
  if ((m = text.match(/\b(?:is|has|was)\s+(.+?)'s\s+contract/i))) name = m[1];
  else if ((m = text.match(/\bcontract\s+(?:for|of)\s+([A-Za-z][A-Za-z .'-]+)/i))) name = m[1];
  else if ((m = text.match(/\bwhen\s+(?:did|will)\s+(.+?)\s+sign/i))) name = m[1];
  else if ((m = text.match(/\b(?:did|has|when did)\s+(.+?)\s+(?:already\s+)?sign/i))) name = m[1];
  else if ((m = text.match(/\bis\s+(.+?)\s+(?:contract\s+)?(?:already\s+)?signed/i))) name = m[1];
  else if ((m = text.match(/\b(.+?)'s\s+contract/i))) name = m[1];
  else if ((m = text.match(/\bstatus\s+(?:for|of)\s+([A-Za-z][A-Za-z .'-]+)/i))) name = m[1];

  if (!name) return null;
  name = name.replace(/["'?.!,]/g, "").replace(/\b(the|a|an|contract|for|of|her|his|their|already)\b/gi, " ").replace(/\s+/g, " ").trim();
  const bad = new Set(["who", "anyone", "everyone", "someone", "my", "our", "this", "that", "he", "she", "they", "client", "agent"]);
  if (!name || bad.has(name.toLowerCase()) || name.length < 2) return null;
  if (name.split(/\s+/).length > 4) return null; // too long to be a name
  return name;
}
async function buildContractStatusReply(name) {
  const docs = await searchPandaByName(name);
  if (!docs.length) {
    return `🔎 I couldn't find a contract matching **${name}**. Try their full name as it appears on the contract.`;
  }
  const lines = [];
  for (const d of docs.slice(0, 10)) {
    let when = "";
    if (d.status === "document.completed") {
      let dt = d.date_modified;
      try {
        const det = await getPandaDetails(d.id);
        dt = det.date_completed || det.date_modified || dt;
      } catch {
        /* fall back to list date */
      }
      when = dt ? ` (completed ${fmtContractDate(dt)})` : "";
    } else {
      const iso = d.date_modified || d.date_created;
      when = iso ? ` (as of ${fmtContractDate(iso)})` : "";
    }
    lines.push(`• ${contractStatusLabel(d.status)} — **${contractClientName(d.name)}**${when}`);
  }
  const header = docs.length === 1 ? `📄 Contract for **${name}**:` : `📄 Contracts matching **${name}** (${docs.length}):`;
  return header + "\n" + lines.join("\n");
}

// --------------------------------------------------------------------------
// Channels + schedule
// --------------------------------------------------------------------------
const CHANNEL_NAMES = (process.env.OOO_SUPPORT_CHANNELS ?? "support")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CHANNEL_IDS = (process.env.OOO_SUPPORT_CHANNEL_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const BUSINESS_DAYS = parseDays(process.env.OOO_BUSINESS_DAYS ?? "1-5");
function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let d = a; d <= b; d++) days.add(d);
    } else days.add(Number(part));
  }
  return days;
}
function nowPartsInTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: WEEKDAY_INDEX[get("weekday")], hour: Number(get("hour")), minute: Number(get("minute")) };
}
export function isOutOfOffice(date = new Date()) {
  const { weekday, hour, minute } = nowPartsInTz(date, TIMEZONE);
  const onBusinessDay = BUSINESS_DAYS.has(weekday);
  const minutesNow = hour * 60 + minute;
  const withinHours = minutesNow >= START_HOUR * 60 && minutesNow < END_HOUR * 60;
  return !(onBusinessDay && withinHours);
}
function isSupportChannel(channel) {
  if (!channel) return false;
  if (CHANNEL_IDS.includes(channel.id)) return true;
  const name = (channel.name ?? "").toLowerCase();
  return CHANNEL_NAMES.some((n) => name === n || name.includes(n));
}

// --------------------------------------------------------------------------
// Discord client + anti-spam state
// --------------------------------------------------------------------------
const repliedThisPeriod = new Set(); // key: `${guildId}:${userId}`
const lastReplyAt = new Map();
const faqLastReplyAt = new Map();

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (FAQ_ENABLED || CONTRACTS_ENABLED) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });

client.on(Events.Error, (err) => console.error("client error:", err?.message ?? err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err?.message ?? err));

let wasOutOfOffice = isOutOfOffice();
setInterval(() => {
  const out = isOutOfOffice();
  if (wasOutOfOffice && !out) {
    repliedThisPeriod.clear();
    console.log("business hours resumed — auto-reply dedupe reset");
  }
  wasOutOfOffice = out;
}, 60 * 1000);

function shouldAutoReply(message) {
  const mentioned =
    !!client.user &&
    message.mentions?.users?.has(client.user.id) &&
    !message.mentions?.everyone;
  const inSupport = isSupportChannel(message.channel);
  if (TRIGGER === "mention") return mentioned;
  if (TRIGGER === "channels") return inSupport;
  if (TRIGGER === "all") return true;
  return mentioned || inSupport; // "both"
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.guild) return; // ignore DMs
    if (!shouldAutoReply(message)) return;

    // 0) Contract commands — INTERNAL team server(s) only.
    if (CONTRACTS_ENABLED && CONTRACT_LIST_GUILD_IDS.includes(message.guildId)) {
      const who = parseContractStatusName(message.content);
      const wantsList = isUnsignedListRequest(message.content);

      if (who || wantsList) {
        const ccKey = message.author.id;
        if (Date.now() - (contractCooldown.get(ccKey) ?? 0) < CONTRACT_COOLDOWN_MS) return;
        contractCooldown.set(ccKey, Date.now());
        try {
          if (who) {
            // 0a) specific person's status
            const reply = await buildContractStatusReply(who);
            await message.reply({ content: reply.slice(0, 1990), allowedMentions: { repliedUser: true } });
            console.log(`contracts: status "${who}" -> ${message.author.tag}`);
          } else {
            // 0b) unsigned list (default window, or the one they asked for)
            const win = parseRequestedWindow(message.content);
            const windowMs = win ? win.ms : DEFAULT_LIST_DAYS * 86_400_000;
            const windowLabel = win ? win.label : `${DEFAULT_LIST_DAYS} days`;
            const msgs = await buildUnsignedContractMessages(windowMs, windowLabel);
            await message.reply({ content: msgs[0], allowedMentions: { repliedUser: true } });
            for (let i = 1; i < msgs.length; i++) {
              await message.channel.send({ content: msgs[i], allowedMentions: { parse: [] } });
            }
            console.log(`contracts: unsigned list -> ${message.author.tag}`);
          }
        } catch (err) {
          console.error("contracts: fetch failed", err?.message ?? err);
          await message.reply("Sorry, I couldn't reach PandaDoc just now — try again in a moment.");
        }
        return;
      }
    }

    // 1) FAQ — any time of day.
    if (FAQ.length) {
      const hit = matchFaq(message.content);
      if (hit) {
        const fkey = `${message.author.id}:${hit.index}`;
        if (Date.now() - (faqLastReplyAt.get(fkey) ?? 0) >= FAQ_COOLDOWN_MS) {
          faqLastReplyAt.set(fkey, Date.now());
          await message.reply({ content: hit.entry.answer, allowedMentions: { repliedUser: true } });
          console.log(`FAQ reply (topic #${hit.index}) -> ${message.author.tag}`);
        }
        return;
      }
    }

    // 2) Out-of-office fallback — only outside business hours.
    if (!isOutOfOffice()) return;
    const key = `${message.guildId}:${message.author.id}`;
    if (repliedThisPeriod.has(key)) return;
    if (Date.now() - (lastReplyAt.get(key) ?? 0) < COOLDOWN_MS) return;
    repliedThisPeriod.add(key);
    lastReplyAt.set(key, Date.now());
    await message.reply({ content: MESSAGE, allowedMentions: { repliedUser: true } });
    console.log(`OOO reply -> #${message.channel?.name} in "${message.guild.name}" (to ${message.author.tag})`);
  } catch (err) {
    console.error("handler error:", err?.message ?? err);
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`OOO bot online as ${c.user.tag}`);
  console.log(`  trigger mode:  ${TRIGGER} (mention | channels | all | both)`);
  console.log(`  FAQ:           ${FAQ_ENABLED ? `on, ${FAQ.length} topic(s) loaded` : "off (set FAQ_ENABLED=true)"}`);
  console.log(`  contracts cmd: ${CONTRACTS_ENABLED ? `on (list + per-person status; team server[s]: ${CONTRACT_LIST_GUILD_IDS.join(", ")})` : "off (set PANDADOC_API_KEY + PANDADOC_LIST_GUILD_IDS)"}`);
  console.log(`  timezone:      ${TIMEZONE}`);
  console.log(`  business hours: ${START_HOUR}:00–${END_HOUR}:00, days ${[...BUSINESS_DAYS].join(",")} (1=Mon…7=Sun)`);
  console.log(`  in ${c.guilds.cache.size} server(s); currently ${isOutOfOffice() ? "OUT of office → will auto-reply" : "within business hours → silent"}`);
});

client.login(TOKEN);

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("discord out-of-office bot ok");
  })
  .listen(Number(process.env.PORT ?? "3000"));
