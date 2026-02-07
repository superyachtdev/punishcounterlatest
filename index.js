const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");
const bodyParser = require("body-parser");

// ================= CONFIG =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1309957290673180823";
const PORT = 3001;

// ================= REPLAY STORAGE =================
const MAX_REPLAY = 50;
const replayBuffer = [];
const STAFF_CHAT_MAX = 500;
const staffChatBuffer = [];
const staffChatSeen = new Set();

if (!DISCORD_TOKEN) {
  console.error("❌ Discord token is missing");
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

// ================= SSE =====================
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
client.once("ready", async () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

// ================= LOGIN =================
client.login(DISCORD_TOKEN);

// ================= DISCORD → MC =================
client.on("messageCreate", async msg => {
  if (msg.channel.id !== CHANNEL_ID) return;
  if (!msg.content) return;

  // ================= STORE PUNISHMENTS =================
  if (msg.content.startsWith("PUNISH|")) {
    const event = parseEvent(msg.content);

    const record = {
      staff: event.staff || "Unknown",
      type: event.type || "UNKNOWN",
      player: event.player || "Unknown",
      time: Number(event.time) || Date.now() / 1000
    };

    replayBuffer.push(record);
    if (replayBuffer.length > MAX_REPLAY) replayBuffer.shift();

    console.log("📦 Stored punishment:", record);
  }

  // ================= STAFF CHAT STORAGE =================
  if (msg.content.startsWith("STAFF_CHAT|")) {
    const ev = parseEvent(msg.content);
    const key = ev.staff + "|" + ev.msg;
    if (staffChatSeen.has(key)) return;
    staffChatSeen.add(key);

    const record = {
      staff: ev.staff,
      msg: ev.msg,
      time: Number(ev.time) || Date.now() / 1000
    };

    staffChatBuffer.push(record);
    if (staffChatBuffer.length > STAFF_CHAT_MAX) staffChatBuffer.shift();

    console.log("💬 Staff chat stored:", record);
  }

  // ================= STAFF CHAT HISTORY =================
  if (msg.content.startsWith("SCHISTORY_REQUEST|")) {
    const req = parseEvent(msg.content);

    const windowMap = {
      "5m": 300,
      "10m": 600,
      "30m": 1800,
      "1h": 3600
    };

    const seconds = windowMap[req.window] || 300;
    const cutoff = Date.now() / 1000 - seconds;

    const slice = staffChatBuffer
      .filter(e => e.time >= cutoff)
      .slice(-50);

    const data = slice
      .map(e => `[${e.staff}] ${e.msg}|${e.time}`)
      .join(";");

    broadcast({
      type: "schistory",
      staff: req.staff,
      data: data || "No staff chat in window"
    });

    return;
  }

  // ================= REPLAY REQUEST =================
  if (msg.content.startsWith("REPLAY_REQUEST|")) {
    const req = parseEvent(msg.content);
    const count = Math.min(parseInt(req.count || 5), replayBuffer.length);

    if (count === 0) {
      broadcast({
        type: "replay",
        staff: req.staff,
        data: "No punishments recorded yet"
      });
      return;
    }

    const data = replayBuffer
      .slice(-count)
      .reverse()
      .map(p => `${p.staff} | ${p.type.toUpperCase()} | ${p.player}`)
      .join(";");

    broadcast({ type: "replay", staff: req.staff, data });
    return;
  }

  // ================= NORMAL FORWARD =================
  if (
    !msg.content.startsWith("APPEAL_") &&
    !msg.content.startsWith("REPORT_") &&
    !msg.content.startsWith("PUNISH|") &&
    !msg.content.startsWith("FLEX|")
  ) return;

  broadcast(parseEvent(msg.content));
});

// ================= BROADCAST =================
function broadcast(payload) {
  for (const c of appealListeners) {
    c.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

// ================= LEADERBOARD =================
app.get("/leaderboard", async (req, res) => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return res.status(500).send("Channel not found");

    let messages = [];
    let lastId;

    while (messages.length < 1000) {
      const fetched = await channel.messages.fetch({
        limit: 100,
        before: lastId
      });
      if (!fetched.size) break;
      messages.push(...fetched.values());
      lastId = fetched.last().id;
    }

    const stats = {};

    for (const msg of messages) {
      if (!msg.content.startsWith("PUNISH|")) continue;
      const ev = parseEvent(msg.content);
      if (!ev.staff) continue;

      if (!stats[ev.staff]) {
        stats[ev.staff] = {
          staff: ev.staff,
          total: 0,
          bans: 0,
          mutes: 0,
          kicks: 0,
          blacklists: 0
        };
      }

      stats[ev.staff].total++;
      const t = (ev.type || "").toLowerCase();
      if (t.includes("ban")) stats[ev.staff].bans++;
      else if (t.includes("mute")) stats[ev.staff].mutes++;
      else if (t.includes("kick")) stats[ev.staff].kicks++;
      else if (t.includes("blacklist")) stats[ev.staff].blacklists++;
    }

    res.json(Object.values(stats).sort((a, b) => b.total - a.total).slice(0, 10));
  } catch (err) {
    console.error(err);
    res.status(500).send("Leaderboard error");
  }
});

app.get("/staff/:name", async (req, res) => {
  const staffName = req.params.name.toLowerCase();

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return res.status(500).send("Channel not found");

    let messages = [];
    let lastId;

    while (messages.length < 2000) {
      const fetched = await channel.messages.fetch({
        limit: 100,
        before: lastId
      });
      if (!fetched.size) break;
      messages.push(...fetched.values());
      lastId = fetched.last().id;
    }

    let total = 0, bans = 0, mutes = 0, kicks = 0, blacklists = 0;

    for (const msg of messages) {
      if (!msg.content.startsWith("PUNISH|")) continue;
      const ev = parseEvent(msg.content);
      if (!ev.staff || ev.staff.toLowerCase() !== staffName) continue;

      total++;
      const t = (ev.type || "").toLowerCase();
      if (t.includes("ban")) bans++;
      else if (t.includes("mute")) mutes++;
      else if (t.includes("kick")) kicks++;
      else if (t.includes("blacklist")) blacklists++;
    }

    res.json({ staff: staffName, total, bans, mutes, kicks, blacklists });

  } catch (err) {
    console.error(err);
    res.status(500).send("Staff fetch error");
  }
});


// ================= HELPERS =================
function parseEvent(content) {
  const parts = content.split("|");
  const type = parts[0].toLowerCase();
  const data = { type };

  for (const p of parts.slice(1)) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    data[p.slice(0, idx)] = p.slice(idx + 1);
  }
  return data;
}

// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on ${PORT}`);
});
