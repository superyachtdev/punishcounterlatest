const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const bodyParser = require("body-parser");

// ================= CONFIG =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1309957290673180823";
const PORT = 3001;
const STAFF_CHAT_EMBED_COLOR = 0xF59E0B; // orange
const STAFF_CHAT_ICON = "https://cdn.discordapp.com/attachments/1309957290673180823/1472237167446065284/ILlogo.png";

// ================= LEGACY TOTALS =================
const LEGACY_TOTALS = {
  "7gtz": { mutes: 129, bans: 117, kicks: 8, blacklists: 0 },
  "fallenphoenix111": { mutes: 65, bans: 106, kicks: 0, blacklists: 0 },
  "superyacht": { mutes: 58, bans: 78, kicks: 1, blacklists: 0 },
  "skeppycat": { mutes: 47, bans: 59, kicks: 2, blacklists: 0 },
  "mddey": { mutes: 2, bans: 8, kicks: 0, blacklists: 0 },
  "internals": { mutes: 18, bans: 10, kicks: 0, blacklists: 0 }
};

// ================= REPLAY / STAFF CHAT =================
const MAX_REPLAY = 50;
const replayBuffer = [];
const STAFF_CHAT_MAX = 500;
const staffChatBuffer = [];
const staffChatSeen = new Set();

// ================= PERSISTENT STATS =================
const staffStats = {};

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
client.once("ready", async () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);

  // 🔹 Apply legacy totals ONCE
  for (const [staff, data] of Object.entries(LEGACY_TOTALS)) {
    staffStats[staff] = {
      staff,
      mutes: data.mutes,
      bans: data.bans,
      kicks: data.kicks,
      blacklists: data.blacklists,
      total: data.mutes + data.bans + data.kicks + data.blacklists
    };
  }

  // 🔹 Backfill newer punishments from Discord
  await backfillHistory();

  console.log("🚀 PunishCounter fully initialized");
});

client.login(DISCORD_TOKEN);

// ================= DISCORD → MC =================
client.on("messageCreate", async msg => {
  if (msg.channel.id !== CHANNEL_ID) return;
  if (!msg.content) return;

  // ================= PUNISHMENTS =================
  if (msg.content.startsWith("PUNISH|")) {
    const ev = parseEvent(msg.content);
    if (!ev.staff) return;

    const staff = ev.staff.toLowerCase();

    if (!staffStats[staff]) {
      staffStats[staff] = {
        staff,
        total: 0,
        bans: 0,
        mutes: 0,
        kicks: 0,
        blacklists: 0
      };
    }

    staffStats[staff].total++;

    const t = (ev.type || "").toLowerCase();
    if (t.includes("ban")) staffStats[staff].bans++;
    else if (t.includes("mute")) staffStats[staff].mutes++;
    else if (t.includes("kick")) staffStats[staff].kicks++;
    else if (t.includes("blacklist")) staffStats[staff].blacklists++;

    replayBuffer.push(ev);
    if (replayBuffer.length > MAX_REPLAY) replayBuffer.shift();
  }

  // ================= STAFF CHAT =================
  if (msg.content.startsWith("STAFF_CHAT|")) {
  const ev = parseEvent(msg.content);
  if (!ev.staff || !ev.msg) return;

  // ❌ Ignore filtered staff messages
  if (ev.msg.includes("[Filtered]")) return;

  // Prevent duplicate echoes
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
  .setAuthor({
    name: ev.staff,
    iconURL: STAFF_CHAT_ICON
  })
  .setDescription(ev.msg)
  .setFooter({
    text: "Staff Chat"
  })
  .setTimestamp(
    ev.time ? new Date(Number(ev.time) * 1000) : new Date()
  );

await msg.channel.send({ embeds: [embed] });

  // Remove raw STAFF_CHAT line
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

////raaaatttatata
// ================= BACKFILL =================
async function backfillHistory() {
  console.log("🔄 Backfilling punishments from Discord...");
  const channel = await client.channels.fetch(CHANNEL_ID);
  let lastId;

  while (true) {
    const fetched = await channel.messages.fetch({
      limit: 100,
      before: lastId
    });

    if (!fetched.size) break;

    for (const msg of fetched.values()) {
      if (!msg.content || !msg.content.startsWith("PUNISH|")) continue;

      const ev = parseEvent(msg.content);
      if (!ev.staff) continue;

      const staff = ev.staff.toLowerCase();

      // 🚫 DO NOT backfill legacy staff (pre-seeded totals)
      if (LEGACY_TOTALS[staff]) {
        // Optional debug log (safe to remove later)
        console.log(`⏭️ Skipping legacy staff backfill: ${staff}`);
        continue;
      }

      // Initialize staff if new
      if (!staffStats[staff]) {
        staffStats[staff] = {
          staff,
          total: 0,
          bans: 0,
          mutes: 0,
          kicks: 0,
          blacklists: 0
        };
      }

      // Increment totals
      staffStats[staff].total++;

      const t = (ev.type || "").toLowerCase();
      if (t.includes("ban")) staffStats[staff].bans++;
      else if (t.includes("mute")) staffStats[staff].mutes++;
      else if (t.includes("kick")) staffStats[staff].kicks++;
      else if (t.includes("blacklist")) staffStats[staff].blacklists++;
    }

    lastId = fetched.last().id;
  }

  console.log("✅ Backfill complete (legacy staff excluded)");
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

// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on ${PORT}`);
});
