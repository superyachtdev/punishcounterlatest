const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");
const bodyParser = require("body-parser");

// ================= CONFIG =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1309957290673180823";
const PORT = 3001;

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

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error("❌ Discord channel not found");
    return;
  }
});

// ================= LOGIN =================
client.login(DISCORD_TOKEN);

// ================= DISCORD → MC =================
client.on("messageCreate", msg => {
  if (msg.channel.id !== CHANNEL_ID) return;

  if (
    !msg.content.startsWith("APPEAL_") &&
    !msg.content.startsWith("REPORT_") &&
    !msg.content.startsWith("PUNISH|")
  ) return;

  const payload = parseEvent(msg.content);
  console.log("➡️ Forwarding to MC:", payload);

  for (const c of appealListeners) {
    c.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
});

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

    const counts = {};
    for (const msg of messages) {
      if (!msg.content.startsWith("PUNISH|")) continue;

      const staff = msg.content
        .split("|")
        .find(p => p.startsWith("staff="))
        ?.replace("staff=", "");

      if (!staff) continue;
      counts[staff] = (counts[staff] || 0) + 1;
    }

    res.json(
      Object.entries(counts)
        .map(([staff, total]) => ({ staff, total }))
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

