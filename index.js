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
client.on("messageCreate", msg => {
  if (msg.channel.id !== CHANNEL_ID) return;
  if (!msg.content) return;

  // ================= STORE PUNISHMENTS =================
  if (msg.content.startsWith("PUNISH|")) {
    const event = parseEvent(msg.content);

    const record = {
      staff: event.staff || "Unknown",
      type: event.type || "UNKNOWN",
      player: event.player || "Unknown",
      time: event.time || Date.now()
    };

    replayBuffer.push(record);

    if (replayBuffer.length > MAX_REPLAY) {
      replayBuffer.shift();
    }

    console.log("📦 Stored punishment:", record);
  }

  // ================= REPLAY REQUEST =================
  if (msg.content.startsWith("REPLAY_REQUEST|")) {
    const req = parseEvent(msg.content);

    const count = Math.min(
      parseInt(req.count || 5),
      replayBuffer.length
    );

    console.log("🔁 Replay requested:", req.staff, "count=", count);

    if (count === 0) {
      const payload = {
        type: "replay",
        staff: req.staff,
        data: "No punishments recorded yet"
      };

      broadcast(payload);
      return;
    }

    const slice = replayBuffer.slice(-count).reverse();

    const data = slice
      .map(p => `${p.staff} | ${p.type.toUpperCase()} | ${p.player}`)
      .join(";");

    const payload = {
      type: "replay",
      staff: req.staff,
      data
    };

    broadcast(payload);
    return;
  }

  // ================= NORMAL FORWARD =================
  if (
    !msg.content.startsWith("APPEAL_") &&
    !msg.content.startsWith("REPORT_") &&
    !msg.content.startsWith("PUNISH|") &&
    !msg.content.startsWith("FLEX|")
  ) return;

  const payload = parseEvent(msg.content);
  broadcast(payload);
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

      const event = parseEvent(msg.content);
      const staff = event.staff;
      const type = (event.type || "").toLowerCase();

      if (!staff) continue;

      if (!stats[staff]) {
        stats[staff] = {
          staff,
          total: 0,
          bans: 0,
          mutes: 0,
          kicks: 0,
          blacklists: 0
        };
      }

      stats[staff].total++;

      if (type.includes("ban")) stats[staff].bans++;
      else if (type.includes("mute")) stats[staff].mutes++;
      else if (type.includes("kick")) stats[staff].kicks++;
      else if (type.includes("blacklist")) stats[staff].blacklists++;
    }

    res.json(
      Object.values(stats)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
    );

  } catch (err) {
    console.error(err);
    res.status(500).send("Leaderboard error");
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

    const key = p.slice(0, idx);
    const val = p.slice(idx + 1);
    data[key] = val;
  }

  return data;
}

// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on ${PORT}`);
});
