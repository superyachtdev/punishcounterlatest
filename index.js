const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { XMLParser } = require("fast-xml-parser");

const RSS_URL = "https://invadedlands.net/forums/ban-appeals.19/index.rss";

let lastSeenGuid = null;

const xmlParser = new XMLParser({
  ignoreAttributes: false
});
// ================= CONFIG =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1309957290673180823";
const PORT = 3001;
const STAFF_CHAT_EMBED_COLOR = 0xF59E0B; // orange
const STAFF_CHAT_ICON = "https://cdn.discordapp.com/attachments/1309957290673180823/1472237167446065284/ILlogo.png";
const PUBLIC_STAFF_CHAT_CHANNEL = "1472239592575860808";
const PUBLIC_PUNISH_CHANNEL = "1472239487646961684";
const APPEALS_CHANNEL = "1473002170344542364";
let reasonStats = {};
// ================= HOURLY TRACKING =================
let currentHourCount = 0;
let previousHourCount = 0;
let lastHourTimestamp = Date.now();
// ================= LEGACY TOTALS =================

const FORUM_URL = "https://invadedlands.net/forums/ban-appeals.19/";
let lastSeenAppeal = null;


// ================= REPLAY / STAFF CHAT =================
const MAX_REPLAY = 50;
const replayBuffer = [];
const STAFF_CHAT_MAX = 500;
const staffChatBuffer = [];
const staffChatSeen = new Set();

// ================= PERSISTENT STATS =================
let staffStats = {};

if (!DISCORD_TOKEN) {
  console.error("❌ Discord token missing");
  process.exit(1);
}

// ================= DISCORD CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ================= EXPRESS =================
const app = express();
app.use(bodyParser.json());

// ================= SSE =================
let appealListeners = [];

app.get("/appeals/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write("\n");

  appealListeners.push(res);
  console.log("🟢 MC client connected");

  req.on("close", () => {
    appealListeners = appealListeners.filter(r => r !== res);
    console.log("🔴 MC client disconnected");
  });
});

// ================= DISCORD READY =================
client.once("clientReady", async () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);

  // 🔥 Set bot presence
  client.user.setPresence({
    activities: [
      {
        name: "counting on Invaded",
        type: 3
      }
    ],
    status: "online"
  });

  // ✅ Rebuild stats normally
  await backfillHistory();

  
 // Start RSS polling
checkAppealsRSS(); // run immediately once
setInterval(checkAppealsRSS, 20000);
  // ✅ Check appeals every 20s

  console.log("🚀 PunishCounter fully initialized");
});

client.login(DISCORD_TOKEN);

// ================= DISCORD → MC =================
client.on("messageCreate", async msg => {

  // Ignore empty messages
  if (!msg.content && !msg.embeds?.length) return;

  // =====================================================
// 1️⃣ DISCORD → MC STAFF CHAT BRIDGE (PUBLIC CHANNEL)
// =====================================================
if (msg.channel.id === PUBLIC_STAFF_CHAT_CHANNEL) {

  // Ignore bots (including itself)
  if (msg.author.bot) return;

  const nickname = msg.member?.nickname || msg.author.username;
  const content = msg.content?.trim();

  if (!content) return;

  // Send to Minecraft clients
  broadcast({
    type: "discord_chat",
    nick: nickname,
    message: content
  });

  // ✅ Delivery confirmation
  if (appealListeners.length > 0) {
    await msg.reply({
      content: "*message successfully sent to invadedlands.*",
      allowedMentions: { repliedUser: false }
    });
  } else {
    await msg.reply({
      content: "*no invadedlands staff currently online.*",
      allowedMentions: { repliedUser: false }
    });
  }

  return;
}

  // =====================================================
  // 2️⃣ EVERYTHING BELOW ONLY RUNS IN RAW WEBHOOK CHANNEL
  // =====================================================
  if (msg.channel.id !== CHANNEL_ID) return;

  // ================= PUNISHMENTS =================
  if (msg.content.startsWith("PUNISH|")) {

    const ev = parseEvent(msg.content);
    const reason = (ev.reason || "Unknown")
      .replace(/#\d+/g, "")
      .trim()
      .toLowerCase();

    if (!ev.staff) return;

    const staff = ev.staff.toLowerCase();

    if (!staffStats[staff]) {
      staffStats[staff] = {
        staff,
        total: 0,
        bans: 0,
        mutes: 0,
        kicks: 0,
        blacklists: 0,
        reasons: {}
      };
    }

    staffStats[staff].total++;
    currentHourCount++;

    const typeRaw = (ev.type || "").toLowerCase();

    if (typeRaw.includes("ban")) staffStats[staff].bans++;
    else if (typeRaw.includes("mute")) staffStats[staff].mutes++;
    else if (typeRaw.includes("kick")) staffStats[staff].kicks++;
    else if (typeRaw.includes("blacklist")) staffStats[staff].blacklists++;

    if (!reasonStats[reason]) {
      reasonStats[reason] = {
        total: 0,
        bans: 0,
        mutes: 0,
        kicks: 0,
        blacklists: 0
      };
    }

    reasonStats[reason].total++;

    if (typeRaw.includes("ban")) reasonStats[reason].bans++;
    else if (typeRaw.includes("mute")) reasonStats[reason].mutes++;
    else if (typeRaw.includes("kick")) reasonStats[reason].kicks++;
    else if (typeRaw.includes("blacklist")) reasonStats[reason].blacklists++;

    if (!staffStats[staff].reasons[reason]) {
      staffStats[staff].reasons[reason] = 0;
    }

    staffStats[staff].reasons[reason]++;

    let pastTense = "punished";
    let typeLabel = "Punishments";
    let typeTotal = 0;

    if (typeRaw.includes("ban")) {
      pastTense = "banned";
      typeLabel = "Bans";
      typeTotal = staffStats[staff].bans;
    } else if (typeRaw.includes("mute")) {
      pastTense = "muted";
      typeLabel = "Mutes";
      typeTotal = staffStats[staff].mutes;
    } else if (typeRaw.includes("kick")) {
      pastTense = "kicked";
      typeLabel = "Kicks";
      typeTotal = staffStats[staff].kicks;
    } else if (typeRaw.includes("blacklist")) {
      pastTense = "blacklisted";
      typeLabel = "Blacklists";
      typeTotal = staffStats[staff].blacklists;
    }

    const player = ev.player || "Unknown Player";

    let embedColor = 0xF59E0B;

    if (typeRaw.includes("ban")) embedColor = 0xDC2626;
    else if (typeRaw.includes("mute")) embedColor = 0xF59E0B;
    else if (typeRaw.includes("kick")) embedColor = 0x16A34A;
    else if (typeRaw.includes("blacklist")) embedColor = 0x000000;

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(ev.staff)
      .setThumbnail(`https://minotar.net/helm/${ev.staff}/64.png`)
      .setDescription(
        `> ${ev.staff} just ${pastTense} **${player}** for **${formatReason(reason)}**.\n` +
        `> They now have **${typeTotal} ${typeLabel}**.`
      )
      .setFooter({
        text: "Punishment Logged",
        iconURL: STAFF_CHAT_ICON
      })
      .setTimestamp();

    const publicChannel = await client.channels.fetch(PUBLIC_PUNISH_CHANNEL);
    if (publicChannel) {
      await publicChannel.send({ embeds: [embed] });
    }

    replayBuffer.push(ev);
    if (replayBuffer.length > MAX_REPLAY) replayBuffer.shift();

    await msg.delete().catch(() => {});
    return;
  }

  // ================= STAFF CHAT (FROM MC) =================
  if (msg.content.startsWith("STAFF_CHAT|")) {

    const ev = parseEvent(msg.content);
    if (!ev.staff || !ev.msg) return;

    if (ev.msg.includes("[Filtered]")) return;

    const key = ev.staff + "|" + ev.msg;
    if (staffChatSeen.has(key)) return;
    staffChatSeen.add(key);

    staffChatBuffer.push({
      staff: ev.staff,
      msg: ev.msg,
      time: Number(ev.time) || Date.now() / 1000
    });

    if (staffChatBuffer.length > STAFF_CHAT_MAX) {
      staffChatBuffer.shift();
    }

    const embed = new EmbedBuilder()
      .setColor(STAFF_CHAT_EMBED_COLOR)
      .setTitle(ev.staff)
      .setThumbnail(`https://minotar.net/helm/${ev.staff}/64.png`)
      .setDescription(`> ${ev.msg}`)
      .setFooter({
        text: "Staff Chat",
        iconURL: STAFF_CHAT_ICON
      })
      .setTimestamp(new Date((Number(ev.time) || Date.now() / 1000) * 1000));

    const publicChannel = await client.channels.fetch(PUBLIC_STAFF_CHAT_CHANNEL);
    if (publicChannel) {
      await publicChannel.send({ embeds: [embed] });
    }

    await msg.delete().catch(() => {});
    return;
  }

  // ================= SCHISTORY =================
  if (msg.content.startsWith("SCHISTORY_REQUEST|")) {

    const req = parseEvent(msg.content);

    const windowMap = { "5m": 300, "10m": 600, "30m": 1800, "1h": 3600 };
    const seconds = windowMap[req.window] || 300;
    const cutoff = Date.now() / 1000 - seconds;

    const data = staffChatBuffer
      .filter(e => e.time >= cutoff)
      .slice(-50)
      .map(e => `[${e.staff}] ${e.msg}|${e.time}`)
      .join(";");

    broadcast({
      type: "schistory",
      staff: req.staff,
      data: data || "No staff chat in window"
    });

    return;
  }

  // ================= REPLAY =================
  if (msg.content.startsWith("REPLAY_REQUEST|")) {

    const req = parseEvent(msg.content);
    const count = Math.min(parseInt(req.count || 5), replayBuffer.length);

    const data = replayBuffer
      .slice(-count)
      .reverse()
      .map(p => `${p.staff} | ${p.type.toUpperCase()} | ${p.player}`)
      .join(";");

    broadcast({ type: "replay", staff: req.staff, data: data || "No data" });
    return;
  }

  if (
    !msg.content.startsWith("APPEAL_") &&
    !msg.content.startsWith("REPORT_") &&
    !msg.content.startsWith("PUNISH|") &&
    !msg.content.startsWith("FLEX|")
  ) return;

  broadcast(parseEvent(msg.content));
});

async function checkAppealsRSS() {
  try {
    console.log("🔄 Checking RSS...");

    const response = await fetch(RSS_URL);
    const xml = await response.text();

    const parsed = xmlParser.parse(xml);

    // More defensive parsing
    const channel = parsed?.rss?.channel;

    if (!channel) {
      console.log("❌ RSS channel missing");
      return;
    }

    let items = channel.item;

    if (!items) {
      console.log("❌ No items in channel");
      return;
    }

    if (!Array.isArray(items)) {
      items = [items];
    }

    console.log("✅ Found", items.length, "RSS items");

    // 🔥 Instead of only checking newest,
    // loop through ALL items and send ones we haven't seen

    for (const item of items.reverse()) {

      const guid = item.guid?.["#text"] || item.guid;

      if (!guid) continue;

      if (lastSeenGuid && guid <= lastSeenGuid) continue;

      const title = item.title;
      const link = item.link;
      const creator = item["dc:creator"];

      const ign = creator || title.split("'s")[0].trim();

      console.log("🚨 Sending appeal:", ign);

      await handleNewAppeal({
        title,
        link,
        ign
      });

      lastSeenGuid = guid;
    }

  } catch (err) {
    console.log("⚠️ RSS check error:", err.message);
  }
}

function formatReason(reason) {
  return reason
    .toLowerCase()
    .split(" ")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
// ================= API =================
app.get("/leaderboard", (req, res) => {
  res.json(
    Object.values(staffStats)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  );
});

app.get("/staff/:name", (req, res) => {
  const staff = req.params.name.toLowerCase();
  res.json(
    staffStats[staff] || {
      staff,
      total: 0,
      bans: 0,
      mutes: 0,
      kicks: 0,
      blacklists: 0
    }
  );
});
app.get("/analytics/topreasons", (req, res) => {
  const data = Object.entries(reasonStats)
    .filter(([label]) => label !== "unknown") // ❌ remove Unknown
    .map(([label, stats]) => ({
      label: formatReason(label),
      value: stats.total
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  res.json(data);
});

app.get("/analytics/reasontrend", (req, res) => {
  const query = (req.query.reason || "").trim().toLowerCase();

  // Find matching key manually (true case-insensitive match)
  const matchedKey = Object.keys(reasonStats)
    .find(r => r.toLowerCase() === query);

  if (!matchedKey || matchedKey === "unknown") {
    return res.json([]);
  }

  const stats = reasonStats[matchedKey];

  res.json([
    { label: formatReason(matchedKey), value: stats.total },
    { label: "Bans", value: stats.bans },
    { label: "Mutes", value: stats.mutes },
    { label: "Kicks", value: stats.kicks },
    { label: "Blacklists", value: stats.blacklists }
  ]);
});

app.get("/analytics/reasons", (req, res) => {
  const data = Object.entries(reasonStats)
    .map(([label, stats]) => ({
      label,
      value: stats.total
    }));

  res.json(data);
});

app.get("/analytics/staffreason/:name", (req, res) => {
  const staff = req.params.name.toLowerCase();
  const data = staffStats[staff];

  if (!data || !data.total) {
    return res.json([]);
  }

  const breakdown = Object.entries(data.reasons)
    .map(([reason, count]) => ({
      label: formatReason(reason),
      value: count,
      percent: ((count / data.total) * 100).toFixed(1)
    }))
    .sort((a, b) => b.value - a.value);

  res.json(breakdown);
});

app.get("/analytics/modhealth", (req, res) => {
  const allStaff = Object.values(staffStats);

  if (!allStaff.length) return res.json({});

  const totalPunishments = allStaff.reduce((a, s) => a + s.total, 0);
  const totalBans = allStaff.reduce((a, s) => a + s.bans, 0);
  const totalMutes = allStaff.reduce((a, s) => a + s.mutes, 0);

  const banPercent = totalPunishments
    ? ((totalBans / totalPunishments) * 100).toFixed(1)
    : 0;

  const mutePercent = totalPunishments
    ? ((totalMutes / totalPunishments) * 100).toFixed(1)
    : 0;

  // 🔥 Exclude "unknown" from top reason
  const filteredReasons = Object.entries(reasonStats)
    .filter(([reason]) => reason !== "unknown");

  let topReason = null;

  if (filteredReasons.length) {
    topReason = filteredReasons
      .sort((a, b) => b[1].total - a[1].total)[0];
  }

  res.json({
    totalPunishments,
    banPercent,
    mutePercent,
    topReason: topReason
      ? formatReason(topReason[0])
      : "No Data Yet"
  });
});

////raaaatttatata
// ================= BACKFILL =================
async function backfillHistory() {
  console.log("🔄 Rebuilding all punishments from BOTH sources...");

  // 🔥 Reset memory
  staffStats = {};
  reasonStats = {};

  // Prevent double counting
  const processedKeys = new Set();

  // =============================
  // 1️⃣ RAW WEBHOOK CHANNEL (OLD DATA)
  // =============================
  const rawChannel = await client.channels.fetch(CHANNEL_ID);
  let lastIdRaw;

  while (true) {
    const fetched = await rawChannel.messages.fetch({
      limit: 100,
      before: lastIdRaw
    });

    if (!fetched.size) break;

    for (const msg of fetched.values()) {
      if (!msg.content || !msg.content.startsWith("PUNISH|")) continue;

      const ev = parseEvent(msg.content);
      if (!ev.staff) continue;

      const staff = ev.staff.toLowerCase();
      const typeRaw = (ev.type || "").toLowerCase();
      const reason = (ev.reason || "Unknown")
        .replace(/#\d+/g, "")
        .trim()
        .toLowerCase();

      // Unique key to prevent duplicates
      const uniqueKey = `${staff}|${ev.player}|${ev.time}`;
      if (processedKeys.has(uniqueKey)) continue;
      processedKeys.add(uniqueKey);

      applyPunishment(staff, typeRaw, reason);
    }

    lastIdRaw = fetched.last().id;
  }

  // =============================
  // 2️⃣ PUBLIC EMBED CHANNEL (NEW DATA)
  // =============================
  const embedChannel = await client.channels.fetch(PUBLIC_PUNISH_CHANNEL);
  let lastIdEmbed;

  while (true) {
    const fetched = await embedChannel.messages.fetch({
      limit: 100,
      before: lastIdEmbed
    });

    if (!fetched.size) break;

    for (const msg of fetched.values()) {
      if (!msg.embeds || !msg.embeds.length) continue;

      const embed = msg.embeds[0];

      if (!embed.footer || embed.footer.text !== "Punishment Logged") continue;

      const staff = embed.title ? embed.title.toLowerCase() : null;
      if (!staff) continue;

      const description = embed.description || "";

      const reasonMatch = description.match(/for \*\*(.*?)\*\*/);
      const reason = reasonMatch
        ? reasonMatch[1].replace(/#\d+/g, "").trim().toLowerCase()
        : "unknown";

      let typeRaw = "unknown";
      if (description.includes("banned")) typeRaw = "ban";
      else if (description.includes("muted")) typeRaw = "mute";
      else if (description.includes("kicked")) typeRaw = "kick";
      else if (description.includes("blacklisted")) typeRaw = "blacklist";

      // Unique key (embed message ID is safe)
      const uniqueKey = `embed|${msg.id}`;
      if (processedKeys.has(uniqueKey)) continue;
      processedKeys.add(uniqueKey);

      applyPunishment(staff, typeRaw, reason);
    }

    lastIdEmbed = fetched.last().id;
  }

  console.log("✅ Backfill complete (raw + embed merged)");
}



async function handleNewAppeal(appeal) {
  try {

    const ign = appeal.ign || appeal.title.split("'s")[0].trim();

    const embed = new EmbedBuilder()
      .setColor(0x3B82F6)
      .setTitle("📩 New Ban Appeal")
      .setDescription(
        `**${ign}** just appealed on the forums.\n\n` +
        `[Click here to handle the appeal](${appeal.link})`
      )
      .setFooter({
        text: "Invaded Forums",
        iconURL: STAFF_CHAT_ICON
      })
      .setTimestamp(new Date());

    const channel = await client.channels.fetch(APPEALS_CHANNEL);

    if (channel) {
      await channel.send({ embeds: [embed] });
    }

    broadcast({
      type: "appeal_opened",
      appealer: ign,
      link: appeal.link,
      timestamp: Date.now()
    });

  } catch (err) {
    console.log("❌ Error handling appeal:", err.message);
  }
}

function applyPunishment(staff, typeRaw, reason) {

  if (!staffStats[staff]) {
    staffStats[staff] = {
      staff,
      total: 0,
      bans: 0,
      mutes: 0,
      kicks: 0,
      blacklists: 0,
      reasons: {}
    };
  }

  staffStats[staff].total++;

  if (typeRaw.includes("ban")) staffStats[staff].bans++;
  else if (typeRaw.includes("mute")) staffStats[staff].mutes++;
  else if (typeRaw.includes("kick")) staffStats[staff].kicks++;
  else if (typeRaw.includes("blacklist")) staffStats[staff].blacklists++;

  if (!reasonStats[reason]) {
    reasonStats[reason] = {
      total: 0,
      bans: 0,
      mutes: 0,
      kicks: 0,
      blacklists: 0
    };
  }

  reasonStats[reason].total++;

  if (typeRaw.includes("ban")) reasonStats[reason].bans++;
  else if (typeRaw.includes("mute")) reasonStats[reason].mutes++;
  else if (typeRaw.includes("kick")) reasonStats[reason].kicks++;
  else if (typeRaw.includes("blacklist")) reasonStats[reason].blacklists++;

  if (!staffStats[staff].reasons[reason]) {
    staffStats[staff].reasons[reason] = 0;
  }

  staffStats[staff].reasons[reason]++;
}
// ================= HELPERS =================
function broadcast(payload) {
  for (const c of appealListeners) {
    c.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function parseEvent(content) {
  const parts = content.split("|");
  const data = { type: parts[0].toLowerCase() };
  for (const p of parts.slice(1)) {
    const i = p.indexOf("=");
    if (i !== -1) data[p.slice(0, i)] = p.slice(i + 1);
  }
  return data;
}

// ================= TOP OF HOUR TREND SYSTEM =================
function scheduleTopOfHourBroadcast() {

  function getMsUntilNextHour() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setMinutes(60);
    nextHour.setSeconds(0);
    nextHour.setMilliseconds(0);
    return nextHour - now;
  }

  function runHourlyBroadcast() {

    let percentChange = 0;

    if (previousHourCount > 0) {
      percentChange =
        ((currentHourCount - previousHourCount) / previousHourCount) * 100;
    }

    percentChange = percentChange.toFixed(1);

    let trend = "stable";
    if (percentChange > 0) trend = "up";
    if (percentChange < 0) trend = "down";

    broadcast({
      type: "hourlytrend",
      current: currentHourCount,
      previous: previousHourCount,
      percent: percentChange,
      trend: trend
    });

    console.log("📊 Hourly trend broadcasted:", {
      current: currentHourCount,
      previous: previousHourCount,
      percent: percentChange,
      trend
    });

    // Shift window
    previousHourCount = currentHourCount;
    currentHourCount = 0;

    // Schedule next exact hour
    setTimeout(runHourlyBroadcast, 60 * 60 * 1000);
  }

  const delay = getMsUntilNextHour();
  console.log(`⏳ First hourly trend scheduled in ${Math.round(delay / 1000)}s`);

  setTimeout(runHourlyBroadcast, delay);
}

// Start scheduler
scheduleTopOfHourBroadcast();
// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on ${PORT}`);
});
