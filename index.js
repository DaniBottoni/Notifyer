const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Pool } = require('pg');
const dns = require('dns');
const crypto = require('crypto');
const { URL } = require('url');
const http = require('http'), https = require('https');
const { XMLParser } = require('fast-xml-parser');

// ── OAuth config (Instagram / TikTok) ───────────────────────────────────────
// Set these env vars on Render. PUBLIC_BASE_URL should be your Render external
// URL (e.g. https://yourbot.onrender.com) with no trailing slash — it's used
// to build the OAuth redirect URIs, which must match EXACTLY what you register
// in the Meta App dashboard / TikTok Developer Portal.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const LEGAL_BASE_URL = PUBLIC_BASE_URL || 'https://your-app.onrender.com';
const OAUTH_CONFIG = {
    instagram: {
        clientId: process.env.INSTAGRAM_APP_ID,
        clientSecret: process.env.INSTAGRAM_APP_SECRET,
        redirectUri: `${PUBLIC_BASE_URL}/oauth/instagram/callback`,
        authUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
        scope: 'instagram_basic,pages_show_list,instagram_manage_insights',
    },
    tiktok: {
        clientId: process.env.TIKTOK_CLIENT_KEY,
        clientSecret: process.env.TIKTOK_CLIENT_SECRET,
        redirectUri: `${PUBLIC_BASE_URL}/oauth/tiktok/callback`,
        authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
        scope: 'user.info.basic,video.list',
    },
};
// In-memory pending OAuth states: state -> { guildId, userId, platform, expires }
// A Discord-side "link" always starts and finishes within a few minutes, so
// memory (rather than the DB) is fine here — if the process restarts mid-flow
// the user just runs /social link again.
const pendingOAuthStates = new Map();
function createOAuthState(guildId, userId, platform) {
    const state = crypto.randomBytes(16).toString('hex');
    pendingOAuthStates.set(state, { guildId, userId, platform, expires: Date.now() + 10 * 60 * 1000 });
    return state;
}
function consumeOAuthState(state) {
    const entry = pendingOAuthStates.get(state);
    if (!entry) return null;
    pendingOAuthStates.delete(state);
    if (entry.expires < Date.now()) return null;
    return entry;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingOAuthStates) if (v.expires < now) pendingOAuthStates.delete(k);
}, 5 * 60 * 1000);

function postForm(urlStr, formData, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(formData).toString();
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.write(body); req.end();
    });
}
function postJson(urlStr, bodyObj, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(bodyObj);
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.write(body); req.end();
    });
}
function fetchJson(urlStr, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.end();
    });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let pool; // created in initDB() after resolving the DB host to IPv4
pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on('error', e => console.error('⚠️ Postgres pool error:', e.message));

// Render's managed Postgres hostnames sometimes only resolve to IPv6 on the
// default resolver, which Render's network can't route (ENETUNREACH). Force
// an IPv4 lookup and rebuild the pool against the resolved IP if needed.
async function ensureIPv4Pool() {
    if (!process.env.DATABASE_URL) return;
    try {
        const url = new URL(process.env.DATABASE_URL);
        console.log(`🔍 DB host from DATABASE_URL: ${url.hostname}:${url.port || 5432}`);
        const { address } = await new Promise((resolve, reject) =>
            dns.lookup(url.hostname, { family: 4 }, (err, address, family) => err ? reject(err) : resolve({ address, family }))
        );
        if (address && address !== url.hostname) {
            const original = url.hostname;
            url.hostname = address;
            await pool.end().catch(() => {});
            pool = new Pool({
                connectionString: url.toString(),
                ssl: { rejectUnauthorized: false, servername: original }, // keep SNI/cert check against original hostname
            });
            pool.on('error', e => console.error('⚠️ Postgres pool error:', e.message));
            console.log(`🔧 Using IPv4 address ${address} for Postgres host ${original}`);
        }
    } catch (e) {
        console.error('⚠️ IPv4 DB lookup failed, using default resolver:', e.message);
    }
}
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const PLATFORMS = {
    youtube:   { label: 'YouTube',   emoji: '▶️', color: '#FF0000' },
    twitter:   { label: 'Twitter/X', emoji: '🐦', color: '#1DA1F2' },
    twitch:    { label: 'Twitch',    emoji: '🟣', color: '#9146FF' },
    instagram: { label: 'Instagram', emoji: '📸', color: '#E1306C', oauth: true },
    tiktok:    { label: 'TikTok',    emoji: '🎵', color: '#010101', oauth: true },
};

// Notification types per platform. Each watch stores a subset of these in `notify_types` (JSONB array).
// If null/empty, all types fire (default behaviour / backwards compat).
const PLATFORM_NOTIFY_TYPES = {
    youtube:   [
        { id: 'videos', label: 'Videos',  description: 'Regular uploads (long-form)' },
        { id: 'shorts', label: 'Shorts',  description: 'YouTube Shorts' },
        { id: 'live',   label: 'Live',    description: 'Stream goes live' },
    ],
    twitter:   [{ id: 'posts', label: 'Posts', description: 'New tweets/posts' }],
    twitch:    [
        { id: 'live',   label: 'Live',   description: 'Stream goes live' },
        { id: 'vods',   label: 'VODs',   description: 'New VOD/past broadcast uploaded' },
    ],
    instagram: [
        { id: 'posts',   label: 'Posts',   description: 'Feed photos/videos' },
        { id: 'reels',   label: 'Reels',   description: 'Reels' },
        { id: 'stories', label: 'Stories', description: 'Stories (24h, if available)' },
    ],
    tiktok:    [{ id: 'videos', label: 'Videos', description: 'New TikTok videos' }],
};

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ── DB ─────────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS configs   (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS watches   (
            id SERIAL PRIMARY KEY,
            guild_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            handle TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            message_template TEXT,
            last_post_id TEXT,
            last_checked BIGINT,
            added_by TEXT,
            added_at BIGINT
        );
        CREATE INDEX IF NOT EXISTS watches_guild ON watches(guild_id);
        CREATE INDEX IF NOT EXISTS watches_platform ON watches(platform);
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS role_id TEXT;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS seen_post_ids JSONB NOT NULL DEFAULT '[]';
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS notify_types JSONB;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS message_templates JSONB;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS social_link_id INTEGER;

        CREATE TABLE IF NOT EXISTS social_links (
            id SERIAL PRIMARY KEY,
            guild_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            external_user_id TEXT NOT NULL,
            external_username TEXT,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            expires_at BIGINT,
            linked_by TEXT,
            linked_at BIGINT,
            UNIQUE (guild_id, platform, external_user_id)
        );
        CREATE INDEX IF NOT EXISTS social_links_guild_platform ON social_links(guild_id, platform);
    `);
    // Backfill seen_post_ids for existing rows so nothing re-fires after migration
    await pool.query(`
        UPDATE watches
        SET seen_post_ids = jsonb_build_array(last_post_id)
        WHERE last_post_id IS NOT NULL AND seen_post_ids = '[]'::jsonb
    `);
}

const configCache = new Map();
async function getConfig(guildId) {
    if (configCache.has(guildId)) return configCache.get(guildId);
    const res = await pool.query('SELECT data FROM configs WHERE guild_id = $1', [guildId]);
    const data = res.rows[0]?.data ?? {};
    configCache.set(guildId, data); return data;
}
function saveConfig(guildId, data) {
    configCache.set(guildId, data);
    pool.query('INSERT INTO configs (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET data = $2', [guildId, data]).catch(e => console.error('saveConfig:', e.message));
}

const SUPPORT_SERVER_URL = 'https://discord.gg/CmNjecb82Y';

// Finds an admin-only channel to post in: a text channel the bot can send in,
// where @everyone does NOT have ViewChannel (i.e. it's restricted), preferring
// names containing "admin"/"staff"/"mod". Falls back to the first postable channel.
function findAnnouncementChannel(guild) {
    const me = guild.members.me;
    if (!me) return null;
    const textChannels = guild.channels.cache.filter(c =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) &&
        c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)
    );
    if (!textChannels.size) return null;

    const everyoneRole = guild.roles.everyone;
    const restricted = textChannels.filter(c => !c.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.ViewChannel));
    if (restricted.size) {
        const named = restricted.find(c => /admin|staff|mod|owner/i.test(c.name));
        return named || restricted.first();
    }
    // No restricted channel found — fall back to first available postable channel
    const named = textChannels.find(c => /admin|staff|mod|owner|general/i.test(c.name));
    return named || textChannels.first();
}

async function announceSupportServer(guild) {
    try {
        const channel = findAnnouncementChannel(guild);
        if (!channel) return;
        const embed = new EmbedBuilder().setColor('#5865F2').setTitle('👋 Thanks for using Notifyer!')
            .setDescription(`Join the support server for help, updates, and to report issues:\n${SUPPORT_SERVER_URL}`);
        await channel.send({ embeds: [embed] });
        console.log(`📨 Sent support server announcement to ${guild.name} (#${channel.name})`);
    } catch (e) {
        console.error(`announceSupportServer (${guild.id}):`, e.message);
    }
}

async function getWatches(guildId) {
    const res = await pool.query('SELECT * FROM watches WHERE guild_id = $1 ORDER BY id', [guildId]);
    return res.rows;
}
async function getAllWatches() {
    const res = await pool.query('SELECT * FROM watches ORDER BY id');
    return res.rows;
}
async function addWatch({ guildId, platform, handle, channelId, messageTemplate, addedBy }) {
    const res = await pool.query(
        'INSERT INTO watches (guild_id, platform, handle, channel_id, message_template, added_by, added_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [guildId, platform, handle, channelId, messageTemplate ?? null, addedBy, Date.now()]
    );
    return res.rows[0];
}
async function removeWatch(guildId, id) {
    const res = await pool.query('DELETE FROM watches WHERE guild_id = $1 AND id = $2', [guildId, id]);
    return res.rowCount > 0;
}
async function updateWatchTemplate(guildId, id, template) {
    await pool.query('UPDATE watches SET message_template = $1 WHERE guild_id = $2 AND id = $3', [template, guildId, id]);
}
async function updateWatchRole(guildId, id, roleId) {
    await pool.query('UPDATE watches SET role_id = $1 WHERE guild_id = $2 AND id = $3', [roleId, guildId, id]);
}
async function updateWatchActive(guildId, id, active) {
    await pool.query('UPDATE watches SET active = $1 WHERE guild_id = $2 AND id = $3', [active, guildId, id]);
}
async function updateWatchChannel(guildId, id, channelId) {
    await pool.query('UPDATE watches SET channel_id = $1 WHERE guild_id = $2 AND id = $3', [channelId, guildId, id]);
}
async function updateWatchNotifyTypes(guildId, id, types) {
    await pool.query('UPDATE watches SET notify_types = $1 WHERE guild_id = $2 AND id = $3', [JSON.stringify(types), guildId, id]);
}
async function updateWatchMessageTemplates(guildId, id, templatesObj) {
    await pool.query('UPDATE watches SET message_templates = $1 WHERE guild_id = $2 AND id = $3', [JSON.stringify(templatesObj), guildId, id]);
}
async function setWatchSocialLink(guildId, id, socialLinkId) {
    await pool.query('UPDATE watches SET social_link_id = $1 WHERE guild_id = $2 AND id = $3', [socialLinkId, guildId, id]);
}

// ── Social account links (OAuth) ────────────────────────────────────────────
async function upsertSocialLink({ guildId, platform, externalUserId, externalUsername, accessToken, refreshToken, expiresAt, linkedBy }) {
    const res = await pool.query(
        `INSERT INTO social_links (guild_id, platform, external_user_id, external_username, access_token, refresh_token, expires_at, linked_by, linked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (guild_id, platform, external_user_id) DO UPDATE SET
            external_username = EXCLUDED.external_username, access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at,
            linked_by = EXCLUDED.linked_by, linked_at = EXCLUDED.linked_at
         RETURNING *`,
        [guildId, platform, externalUserId, externalUsername, accessToken, refreshToken ?? null, expiresAt ?? null, linkedBy, Date.now()]
    );
    return res.rows[0];
}
async function getSocialLinks(guildId, platform) {
    const res = await pool.query('SELECT * FROM social_links WHERE guild_id = $1 AND platform = $2 ORDER BY external_username', [guildId, platform]);
    return res.rows;
}
async function getSocialLinkByUsername(guildId, platform, username) {
    const res = await pool.query('SELECT * FROM social_links WHERE guild_id = $1 AND platform = $2 AND lower(external_username) = lower($3)', [guildId, platform, username]);
    return res.rows[0] || null;
}
async function getSocialLinkById(id) {
    const res = await pool.query('SELECT * FROM social_links WHERE id = $1', [id]);
    return res.rows[0] || null;
}
async function updateSocialLinkTokens(id, accessToken, refreshToken, expiresAt) {
    await pool.query('UPDATE social_links SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3 WHERE id = $4', [accessToken, refreshToken, expiresAt, id]);
}
async function getWatch(guildId, id) {
    const res = await pool.query('SELECT * FROM watches WHERE guild_id = $1 AND id = $2', [guildId, id]);
    return res.rows[0] || null;
}
const SEEN_HISTORY_SIZE = 20;
async function updateLastPost(id, lastPostId, seenIds = []) {
    const updated = [...new Set([lastPostId, ...seenIds])].slice(0, SEEN_HISTORY_SIZE);
    await pool.query(
        'UPDATE watches SET last_post_id = $1, last_checked = $2, seen_post_ids = $3 WHERE id = $4',
        [lastPostId, Date.now(), JSON.stringify(updated), id]
    );
}
async function touchLastChecked(id) {
    await pool.query('UPDATE watches SET last_checked = $1 WHERE id = $2', [Date.now(), id]);
}

// ── Helpers ────────────────────────────────────────────────────────────────
const E = (c, t) => new EmbedBuilder().setColor(c).setTitle(t).setTimestamp();

function fetchText(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SocialNotifyBot/1.0)', ...headers } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location, headers).then(resolve, reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    });
}

async function hasCommandPermission(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const cfg = await getConfig(guildId);
    return cfg.accessRoleId ? interaction.member.roles.cache.has(cfg.accessRoleId) : false;
}
function normalizeHandle(platform, raw) {
    let h = raw.trim();
    // Strip full URLs down to the handle/channel identifier
    h = h.replace(/^https?:\/\/(www\.)?/i, '');
    if (platform === 'youtube') {
        h = h.replace(/^(youtube\.com|m\.youtube\.com|youtu\.be)\//i, '');
        h = h.replace(/^@/, '@'); // keep @handle form if present
        h = h.replace(/\/(videos|featured|streams|shorts).*$/i, '');
        h = h.replace(/\/$/, '');
    } else if (platform === 'twitter') {
        h = h.replace(/^(twitter\.com|x\.com)\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    } else if (platform === 'twitch') {
        h = h.replace(/^twitch\.tv\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0].toLowerCase();
    } else if (platform === 'instagram') {
        h = h.replace(/^(instagram\.com)\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    } else if (platform === 'tiktok') {
        h = h.replace(/^(tiktok\.com)\/@?/i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    }
    return h;
}
function profileUrl(platform, handle) {
    switch (platform) {
        case 'youtube': return handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${handle}`;
        case 'twitter': return `https://x.com/${handle}`;
        case 'twitch': return `https://www.twitch.tv/${handle}`;
        case 'instagram': return `https://www.instagram.com/${handle}`;
        case 'tiktok': return `https://www.tiktok.com/@${handle}`;
    }
}

// ── Platform fetchers: each returns { id, url, title, author, thumbnail, timestamp } or null ──
async function fetchLatestYouTube(handle) {
    let channelId = handle;
    if (handle.startsWith('@') || !/^UC[\w-]{22}$/.test(handle)) {
        // Resolve handle -> channel id via the channel page.
        const url = handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/${handle.startsWith('c/') || handle.startsWith('user/') ? handle : '@' + handle}`;
        const html = await fetchText(url);
        // Prefer the canonical link (most reliable — points at the page's own channel)
        let m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/);
        // Fall back to the channel metadata's externalId field
        if (!m) m = html.match(/"externalId":"(UC[\w-]{22})"/);
        // Last resort: first generic channelId occurrence
        if (!m) m = html.match(/"channelId":"(UC[\w-]{22})"/);
        if (!m) throw new Error('Could not resolve YouTube channel ID');
        channelId = m[1];

        // Sanity check: confirm the resolved channel's handle matches what was requested
        if (handle.startsWith('@')) {
            const handleMatch = html.match(/"channelHandleText":\{"runs":\[\{"text":"(@[^"]+)"/) || html.match(/"vanityChannelUrl":"https:\/\/www\.youtube\.com\/(@[^"]+)"/);
            if (handleMatch && handleMatch[1].toLowerCase() !== handle.toLowerCase()) {
                throw new Error(`Resolved to a different channel handle (${handleMatch[1]}) than requested (${handle}) — check the spelling/casing`);
            }
        }
    }
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const xml = await fetchText(feedUrl);
    const data = xmlParser.parse(xml);
    const entries = data?.feed?.entry;
    if (!entries) return null;
    const entry = Array.isArray(entries) ? entries[0] : entries;
    const videoId = entry['yt:videoId'];
    const url = entry.link?.['@_href'] || `https://www.youtube.com/watch?v=${videoId}`;
    const postType = await detectYouTubePostType(videoId, url);
    return {
        id: videoId,
        url,
        title: entry.title,
        author: data?.feed?.author?.name,
        thumbnail: entry['media:group']?.['media:thumbnail']?.['@_url'],
        timestamp: entry.published,
        postType,
    };
}

async function fetchLatestTwitter(handle) {
    // Twitter/X has no free official API. Query several Nitter mirrors in
    // parallel and pick whichever returns the newest tweet (by numeric ID),
    // since individual instances are often stale/cached.
    const instances = [
        'https://nitter.net',
        'https://nitter.privacydev.net',
        'https://nitter.poast.org',
        'https://nitter.tiekoetter.com',
        'https://nitter.cz',
        'https://lightbrd.com',
    ];

    const results = await Promise.allSettled(instances.map(async base => {
        const xml = await fetchText(`${base}/${handle}/rss`);
        const data = xmlParser.parse(xml);
        const items = data?.rss?.channel?.item;
        if (!items) throw new Error('No items in feed');
        const item = Array.isArray(items) ? items[0] : items;
        const idMatch = (item.link || item.guid || '').match(/status\/(\d+)/);
        if (!idMatch) throw new Error('Could not parse tweet ID');
        return {
            id: idMatch[1],
            idNum: BigInt(idMatch[1]),
            url: (item.link || '').replace(base, 'https://x.com'),
            title: (item.title || '').slice(0, 200),
            author: data?.rss?.channel?.title,
            thumbnail: null,
            timestamp: item.pubDate,
            source: base,
        };
    }));

    const successes = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!successes.length) {
        const errs = results.map((r, i) => `${instances[i]}: ${r.reason?.message || 'unknown error'}`).join('; ');
        throw new Error(`All Nitter instances failed (${errs})`);
    }

    // Pick the result with the highest (newest) tweet ID — Twitter snowflake
    // IDs are monotonically increasing over time.
    successes.sort((a, b) => (b.idNum > a.idNum ? 1 : b.idNum < a.idNum ? -1 : 0));
    const best = successes[0];
    delete best.idNum;
    delete best.source;
    return best;
}



async function fetchTwitch(path) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!clientId) throw new Error('TWITCH_CLIENT_ID env var not set');
    const token = await getTwitchToken();
    const raw = await fetchText(`https://api.twitch.tv/helix/${path}`, {
        'Client-Id': clientId,
        'Authorization': `Bearer ${token}`,
    });
    return JSON.parse(raw);
}

// ── Twitch OAuth token management ─────────────────────────────────────────
let twitchToken = null, twitchTokenExpiry = 0;
async function getTwitchToken() {
    if (twitchToken && Date.now() < twitchTokenExpiry - 60_000) return twitchToken;
    const clientId = process.env.TWITCH_CLIENT_ID, clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET env vars not set');

    // Twitch's token endpoint requires POST, so we can't use fetchText (GET-only) here.
    const res = await new Promise((resolve, reject) => {
        const body = `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
        const req = https.request('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject); req.write(body); req.end();
    });
    if (!res.access_token) throw new Error(`Twitch token error: ${JSON.stringify(res)}`);
    twitchToken = res.access_token;
    twitchTokenExpiry = Date.now() + (res.expires_in * 1000);
    return twitchToken;
}

// Cache login→id mappings to avoid repeated lookups
const twitchUserIdCache = new Map();
async function getTwitchUserId(login) {
    if (twitchUserIdCache.has(login)) return twitchUserIdCache.get(login);
    const data = await fetchTwitch(`users?login=${encodeURIComponent(login)}`);
    const user = data.data?.[0];
    if (!user) throw new Error(`Twitch user "${login}" not found`);
    twitchUserIdCache.set(login, user.id);
    return user.id;
}

// Returns array of posts: [{id, url, title, author, thumbnail, timestamp, postType}]
async function fetchLatestTwitchAll(handle) {
    const userId = await getTwitchUserId(handle);
    const [streamData, vodData] = await Promise.all([
        fetchTwitch(`streams?user_id=${userId}`),
        fetchTwitch(`videos?user_id=${userId}&type=archive&first=1`),
    ]);
    const results = [];

    const stream = streamData.data?.[0];
    if (stream) {
        results.push({
            id: `live_${stream.id}`,
            url: `https://www.twitch.tv/${handle}`,
            title: stream.title || `${handle} is live!`,
            author: stream.user_name || handle,
            thumbnail: (stream.thumbnail_url || '').replace('{width}', '1280').replace('{height}', '720'),
            timestamp: stream.started_at,
            postType: 'live',
            isLive: true,
        });
    }

    const vod = vodData.data?.[0];
    if (vod) {
        results.push({
            id: vod.id,
            url: vod.url,
            title: vod.title,
            author: vod.user_name || handle,
            thumbnail: (vod.thumbnail_url || '').replace('%{width}', '1280').replace('%{height}', '720'),
            timestamp: vod.published_at || vod.created_at,
            postType: 'vods',
        });
    }
    return results;
}

// ── YouTube post type detection ────────────────────────────────────────────
async function detectYouTubePostType(videoId, url) {
    // Shorts have a distinctive URL pattern after redirect — check via oEmbed
    if (url?.includes('/shorts/')) return 'shorts';
    // Check if the video is a live stream via YouTube's oEmbed endpoint
    try {
        const raw = await fetchText(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        const data = JSON.parse(raw);
        // oEmbed doesn't directly expose live status, so check if the page HTML has live indicators
        const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
        if (/"isLiveBroadcast"\s*:\s*true|"style"\s*:\s*"LIVE"/.test(html)) return 'live';
        if (html.includes('"shorts"') || url?.includes('/shorts/')) return 'shorts';
    } catch {}
    return 'videos';
}

async function fetchLatestPost(platform, handle) {
    switch (platform) {
        case 'youtube': return fetchLatestYouTube(handle);
        case 'twitter': return fetchLatestTwitter(handle);
        case 'twitch': return null;    // handled separately in pollAll (fetchLatestTwitchAll)
        case 'instagram': return null; // handled separately in pollAll (fetchLatestInstagramAll)
        case 'tiktok': return null;    // handled separately in pollAll (fetchLatestTikTokAll)
        default: return null;
    }
}

// ── OAuth token refresh (Instagram / TikTok) ───────────────────────────────
// Refreshes a stored social_links row's access token if it's near expiry.
// Returns the (possibly updated) row, or throws if refresh fails — callers
// should treat a throw as "the link is dead, tell the person to /social link again".
async function ensureFreshToken(link) {
    const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // refresh if <24h left
    if (!link.expires_at || link.expires_at - Date.now() > REFRESH_MARGIN_MS) return link;

    if (link.platform === 'instagram') {
        const cfg = OAUTH_CONFIG.instagram;
        // Long-lived Facebook user/page tokens are refreshed via a fresh fb_exchange_token call.
        const { json } = await fetchJson(
            `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${cfg.clientId}&client_secret=${cfg.clientSecret}&fb_exchange_token=${encodeURIComponent(link.access_token)}`
        );
        if (!json?.access_token) throw new Error('Instagram token refresh failed — re-link with /social link.');
        const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 55 * 24 * 60 * 60 * 1000);
        await updateSocialLinkTokens(link.id, json.access_token, null, expiresAt);
        return { ...link, access_token: json.access_token, expires_at: expiresAt };
    }

    if (link.platform === 'tiktok') {
        const cfg = OAUTH_CONFIG.tiktok;
        if (!link.refresh_token) throw new Error('TikTok refresh token missing — re-link with /social link.');
        const { json } = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
            client_key: cfg.clientId, client_secret: cfg.clientSecret,
            grant_type: 'refresh_token', refresh_token: link.refresh_token,
        });
        if (!json?.access_token) throw new Error('TikTok token refresh failed — re-link with /social link.');
        const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 24 * 60 * 60 * 1000);
        await updateSocialLinkTokens(link.id, json.access_token, json.refresh_token || link.refresh_token, expiresAt);
        return { ...link, access_token: json.access_token, refresh_token: json.refresh_token || link.refresh_token, expires_at: expiresAt };
    }

    return link;
}

// ── Instagram (Meta Graph API) ─────────────────────────────────────────────
async function fetchLatestInstagramAll(link) {
    const fresh = await ensureFreshToken(link);
    const { json } = await fetchJson(
        `https://graph.facebook.com/v21.0/${fresh.external_user_id}/media?fields=id,caption,media_type,media_product_type,media_url,permalink,timestamp&limit=10&access_token=${encodeURIComponent(fresh.access_token)}`
    );
    if (json?.error) throw new Error(`Instagram API: ${json.error.message}`);
    const items = json?.data || [];
    return items.map(m => ({
        id: m.id,
        url: m.permalink,
        title: (m.caption || '').slice(0, 200),
        author: fresh.external_username,
        thumbnail: m.media_type === 'VIDEO' ? null : m.media_url,
        timestamp: m.timestamp,
        // media_product_type: FEED | REELS | STORY (STORY rarely returned — stories expire in 24h and this endpoint mostly covers feed/reels)
        postType: m.media_product_type === 'REELS' ? 'reels' : m.media_product_type === 'STORY' ? 'stories' : 'posts',
    }));
}

// ── TikTok ───────────────────────────────────────────────────────────────
async function fetchLatestTikTokAll(link) {
    const fresh = await ensureFreshToken(link);
    const { json } = await postJson(
        'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,create_time',
        { max_count: 10 },
        { Authorization: `Bearer ${fresh.access_token}` }
    );
    if (json?.error?.code && json.error.code !== 'ok') throw new Error(`TikTok API: ${json.error.message || json.error.code}`);
    const items = json?.data?.videos || [];
    return items.map(v => ({
        id: v.id,
        url: v.share_url,
        title: (v.title || v.video_description || '').slice(0, 200),
        author: fresh.external_username,
        thumbnail: v.cover_image_url,
        timestamp: v.create_time ? v.create_time * 1000 : Date.now(),
        postType: 'videos',
    }));
}

// ── Message templating ────────────────────────────────────────────────────
const DEFAULT_TEMPLATE = '🔔 **{author}** just posted on {platform}!\n{url}';
// Resolves the message template for a watch + post, preferring a per-post-type
// override (w.message_templates[post.postType]) over the watch's single
// message_template, over the global default.
function resolveTemplate(w, post) {
    if (post.postType && w.message_templates && w.message_templates[post.postType]) return w.message_templates[post.postType];
    return w.message_template || null;
}
function renderTemplate(template, post, platform, handle) {
    const tmpl = template || DEFAULT_TEMPLATE;
    return tmpl
        .replace(/\{author\}/g, post.author || handle)
        .replace(/\{handle\}/g, handle)
        .replace(/\{platform\}/g, PLATFORMS[platform].label)
        .replace(/\{title\}/g, post.title || '')
        .replace(/\{url\}/g, post.url || '');
}

// ── Polling loop ───────────────────────────────────────────────────────────
const PLATFORM_MIN_INTERVAL_MS = {};

function shouldNotify(w, post) {
    const types = Array.isArray(w.notify_types) && w.notify_types.length ? w.notify_types : null;
    if (!types) return true; // no filter = all types
    return post.postType ? types.includes(post.postType) : true;
}

async function sendNotification(w, post) {
    const guild = client.guilds.cache.get(w.guild_id);
    const channel = guild?.channels.cache.get(w.channel_id);
    if (!channel) return;
    const p = PLATFORMS[w.platform];
    const typeLabel = post.postType ? ` (${PLATFORM_NOTIFY_TYPES[w.platform]?.find(t => t.id === post.postType)?.label || post.postType})` : '';
    let content = renderTemplate(resolveTemplate(w, post), post, w.platform, w.handle);
    if (w.role_id) content = `<@&${w.role_id}> ${content}`;
    const embed = new EmbedBuilder()
        .setColor(post.isLive ? '#FF0000' : p.color)
        .setAuthor({ name: `${post.author || w.handle} • ${p.label}${typeLabel}` })
        .setURL(post.url)
        .setDescription(post.title || null)
        .setTimestamp(post.timestamp ? new Date(post.timestamp) : new Date());
    if (post.isLive) embed.addFields({ name: '🔴 LIVE', value: 'Stream is live now!', inline: true });
    if (post.thumbnail) embed.setImage(post.thumbnail);
    const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(post.isLive ? 'Watch live' : 'View post').setStyle(ButtonStyle.Link).setURL(post.url).setEmoji(p.emoji)
    );
    await channel.send({ content, embeds: [embed], components: [linkRow] }).catch(e => console.error('send notification:', e.message));
}

let pollInProgress = false;
async function pollAll() {
    if (pollInProgress) return;
    pollInProgress = true;
    try {
        const watches = await getAllWatches();
        for (const w of watches) {
            if (!w.active) continue;
            const minInterval = PLATFORM_MIN_INTERVAL_MS[w.platform];
            if (minInterval && w.last_checked && (Date.now() - w.last_checked) < minInterval) continue;
            try {
                const seenIds = Array.isArray(w.seen_post_ids) ? w.seen_post_ids : [];

                if (w.platform === 'twitch' || w.platform === 'instagram' || w.platform === 'tiktok') {
                    // These platforms return multiple posts/post-types at once per check
                    let posts;
                    if (w.platform === 'twitch') {
                        posts = await fetchLatestTwitchAll(w.handle);
                    } else {
                        if (!w.social_link_id) { await touchLastChecked(w.id); continue; } // not linked yet — nothing to poll
                        const link = await getSocialLinkById(w.social_link_id);
                        if (!link) { await touchLastChecked(w.id); continue; } // link was removed
                        posts = w.platform === 'instagram' ? await fetchLatestInstagramAll(link) : await fetchLatestTikTokAll(link);
                    }
                    let newSeenIds = [...seenIds];
                    let updated = false;
                    for (const post of posts) {
                        if (w.last_post_id === null) continue; // first check — skip all
                        if (newSeenIds.includes(post.id)) continue;
                        if (!shouldNotify(w, post)) { newSeenIds = [...new Set([post.id, ...newSeenIds])].slice(0, 20); updated = true; continue; }
                        newSeenIds = [...new Set([post.id, ...newSeenIds])].slice(0, 20);
                        updated = true;
                        await sendNotification(w, post);
                    }
                    if (w.last_post_id === null && posts.length) {
                        // Seed baseline from first check
                        await updateLastPost(w.id, posts[0].id, posts.map(p => p.id));
                    } else if (updated) {
                        await updateLastPost(w.id, newSeenIds[0], newSeenIds);
                    } else {
                        await touchLastChecked(w.id);
                    }
                } else {
                    const post = await fetchLatestPost(w.platform, w.handle);
                    if (!post || !post.id) { await touchLastChecked(w.id); continue; }
                    if (w.last_post_id === null) {
                        await updateLastPost(w.id, post.id, seenIds);
                        continue;
                    }
                    if (seenIds.includes(post.id)) { await touchLastChecked(w.id); continue; }
                    await updateLastPost(w.id, post.id, seenIds);
                    if (!shouldNotify(w, post)) continue;
                    await sendNotification(w, post);
                }
            } catch (e) {
                if (/HTTP 429/.test(e.message)) {
                    console.warn(`poll ${w.platform}/${w.handle}: rate-limited (429), retrying next cycle`);
                } else {
                    console.error(`poll ${w.platform}/${w.handle}:`, e.message);
                }
                await touchLastChecked(w.id).catch(() => {});
            }
            // Stagger with jitter to avoid hammering platforms all at once
            const jitter = 1000 + Math.random() * 1000;
            await new Promise(r => setTimeout(r, jitter));
        }
    } finally {
        pollInProgress = false;
    }
}

// ── Embeds / UI builders ──────────────────────────────────────────────────
const refreshBtn = (id) => new ButtonBuilder().setCustomId(id).setLabel('↻ Refresh').setStyle(ButtonStyle.Secondary);

async function buildWatchListEmbed(guildId) {
    const watches = await getWatches(guildId);
    if (!watches.length) {
        return { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Social Media Watches').setDescription('No accounts are being tracked yet. Use `/social add` to add one.')], components: [] };
    }
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Social Media Watches').setTimestamp()
        .setDescription(`Tracking **${watches.length}** account${watches.length > 1 ? 's' : ''}.`);
    for (const w of watches.slice(0, 25)) {
        const p = PLATFORMS[w.platform];
        const lines = [
            `Posts to <#${w.channel_id}>`,
            `ID: \`${w.id}\``,
            w.message_template ? `Custom message: \`${w.message_template.slice(0, 80)}${w.message_template.length > 80 ? '…' : ''}\`` : 'Using default message',
        ];
        if (w.role_id) lines.push(`Ping: <@&${w.role_id}>`);
        if (!w.active) lines.push('⏸️ Paused');
        embed.addFields({
            name: `${p.emoji} ${p.label} — ${w.handle}${w.active ? '' : ' (paused)'}`,
            value: lines.join('\n'),
            inline: false,
        });
    }
    if (watches.length > 25) embed.setFooter({ text: `Showing first 25 of ${watches.length}` });
    const components = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sociallist_manage_${guildId}`).setPlaceholder('Manage a watch…')
                .addOptions(watches.slice(0, 25).map(w => ({ label: `${PLATFORMS[w.platform].label} — ${w.handle}`.slice(0, 100), value: `${w.id}` })))
        ),
        new ActionRowBuilder().addComponents(refreshBtn(`sociallist_refresh_${guildId}`)),
    ];
    return { embeds: [embed], components };
}

function buildManageView(w) {
    const p = PLATFORMS[w.platform];
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const templates = w.message_templates || {};
    const perTypeLines = types.filter(t => templates[t.id]).map(t => `**${t.label}:** \`${templates[t.id].slice(0, 80)}\``);
    const embed = new EmbedBuilder().setColor(p.color).setTitle(`Manage — ${p.emoji} ${w.handle}`).setTimestamp()
        .addFields(
            { name: 'Channel', value: `<#${w.channel_id}>`, inline: true },
            { name: 'Status', value: w.active ? '▶️ Active' : '⏸️ Paused', inline: true },
            { name: 'Ping role', value: w.role_id ? `<@&${w.role_id}>` : 'None', inline: true },
            { name: 'Notify types', value: (Array.isArray(w.notify_types) && w.notify_types.length) ? w.notify_types.map(t => PLATFORM_NOTIFY_TYPES[w.platform]?.find(x => x.id === t)?.label || t).join(', ') : 'All types', inline: true },
            { name: 'Default message', value: w.message_template ? `\`${w.message_template}\`` : `Default: \`${DEFAULT_TEMPLATE}\`` },
        );
    if (perTypeLines.length) embed.addFields({ name: 'Per-type message overrides', value: perTypeLines.join('\n') });
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_msg_${w.id}`).setLabel('Edit Message').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`socialmanage_channel_${w.id}`).setLabel('Change Channel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_role_${w.id}`).setLabel('Set/Clear Ping Role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_types_${w.id}`).setLabel('Edit Types').setStyle(ButtonStyle.Secondary),
        ...(types.length > 1 ? [new ButtonBuilder().setCustomId(`socialpertype_open_${w.id}`).setLabel('Per-Type Messages').setStyle(ButtonStyle.Secondary)] : []),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_toggle_${w.id}`).setLabel(w.active ? 'Pause' : 'Resume').setStyle(w.active ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`socialmanage_remove_${w.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`socialmanage_back_${w.guild_id}`).setLabel('← Back to List').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row1, row2] };
}

const helpEmbed = () => new EmbedBuilder().setColor('#5865F2').setTitle('Social Notify Bot')
    .setDescription('Get notified in a channel whenever a tracked account posts new content.')
    .addFields(
        { name: '/social add', value: 'Track a new account. Choose a platform, enter the handle/URL, and pick a channel. Optionally set a custom message.' },
        { name: '/social list', value: 'View all tracked accounts. Pick one from the dropdown to manage it: edit message, change channel, set a ping role, pause/resume, or remove.' },
        { name: '/social check', value: 'Force an immediate check of all tracked accounts.' },
        { name: 'Placeholders', value: 'Custom messages support `{author}`, `{handle}`, `{platform}`, `{title}`, and `{url}`.' },
        { name: 'Notes', value: 'Checks run every 2 minutes. New watches start tracking from the next post onward (no notification for existing content). Twitter relies on unofficial scraping and may occasionally fail or lag.' },
        { name: 'Legal', value: `[Terms of Service](${LEGAL_BASE_URL}/terms) • [Privacy Policy](${LEGAL_BASE_URL}/privacy)` },
    );

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`✅ Social notify bot online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Refreshing social media for new posts', type: ActivityType.Watching }], status: 'online' });
    const commands = [
        new SlashCommandBuilder().setName('invite').setDescription('Get a link to invite this bot to another server'),
        new SlashCommandBuilder().setName('help').setDescription('View commands and features'),
        new SlashCommandBuilder().setName('social').setDescription('Manage social media notifications')
            .addSubcommand(s => s.setName('add').setDescription('Track a new account')
                .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
                    .addChoices(...Object.entries(PLATFORMS).map(([k, v]) => ({ name: v.label, value: k }))))
                .addStringOption(o => o.setName('handle').setDescription('Username, handle, or profile URL').setRequired(true))
                .addChannelOption(o => o.setName('channel').setDescription('Channel to post notifications in').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addStringOption(o => o.setName('message').setDescription('Custom message (supports {author} {handle} {platform} {title} {url})')))
            .addSubcommand(s => s.setName('list').setDescription('View tracked accounts'))
            .addSubcommand(s => s.setName('check').setDescription('Force an immediate check of all tracked accounts'))
            .addSubcommand(s => s.setName('debug').setDescription('Show live fetch result vs stored baseline for a watch')
                .addIntegerOption(o => o.setName('id').setDescription('Watch ID (see /social list)').setRequired(true)))
            .addSubcommand(s => s.setName('link').setDescription('Connect an Instagram or TikTok account via OAuth so it can be tracked')
                .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
                    .addChoices({ name: 'Instagram', value: 'instagram' }, { name: 'TikTok', value: 'tiktok' })))
            .addSubcommand(s => s.setName('links').setDescription('View accounts linked via OAuth in this server'))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can manage social notifications')),
        new SlashCommandBuilder().setName('config').setDescription('Configure the bot')
            .addSubcommand(s => s.setName('access').setDescription('Set which role can manage social notifications')),
        new SlashCommandBuilder().setName('killbot').setDescription('Owner only: suspend the Render service to stop usage'),
    ];
    await client.application.commands.set(commands).catch(e => console.error('command registration:', e));

    // Start polling
    pollAll().catch(e => console.error('initial poll:', e.message));
    setInterval(() => pollAll().catch(e => console.error('poll loop:', e.message)), POLL_INTERVAL_MS);

    // Announce the support server to existing guilds, once each.
    for (const guild of client.guilds.cache.values()) {
        try {
            const cfg = await getConfig(guild.id);
            if (cfg.supportAnnounced) continue;
            await announceSupportServer(guild);
            cfg.supportAnnounced = true;
            saveConfig(guild.id, cfg);
        } catch (e) {
            console.error(`support announce (${guild.id}):`, e.message);
        }
        await new Promise(r => setTimeout(r, 1000)); // light stagger to avoid rate limits
    }
});

client.on('guildCreate', async (guild) => {
    try {
        const cfg = await getConfig(guild.id);
        if (cfg.supportAnnounced) return;
        await announceSupportServer(guild);
        cfg.supportAnnounced = true;
        saveConfig(guild.id, cfg);
    } catch (e) {
        console.error(`guildCreate announce (${guild.id}):`, e.message);
    }
});

// ── Interaction handling ────────────────────────────────────────────────────
const pendingMessageEdits = new Map(); // userId_watchId -> { guildId }

client.on('interactionCreate', async interaction => {
  try {
    const guildId = interaction.guild?.id;
    if (!guildId) return;
    const reply = (payload) => {
        const opts = typeof payload === 'string' ? { content: payload, flags: [MessageFlags.Ephemeral] } : payload;
        return interaction.replied || interaction.deferred ? interaction.editReply(opts) : interaction.reply(opts);
    };

    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'invite') {
            const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=2147485696&scope=bot%20applications.commands`;
            return reply({ embeds: [E('#5865F2', 'Invite Social Notify Bot').setDescription(`[Click here to invite this bot to another server](${inviteUrl})`)], flags: [MessageFlags.Ephemeral] });
        }

        if (commandName === 'help') {
            return reply({ embeds: [helpEmbed()], flags: [MessageFlags.Ephemeral] });
        }

        if (commandName === 'config' || commandName === 'social') {
            const sub = interaction.options.getSubcommand();

            if (sub === 'access' && (commandName === 'config' || commandName === 'social')) {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return reply('❌ Only administrators can change access settings.');
                await interaction.reply({
                    embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🔒 Access Configuration').setDescription('Select which role should have access to `/social` commands.\n\n**Note:** Server administrators always have access.').setFooter({ text: 'Select a role from the dropdown below' })],
                    components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`social_access_role_${guildId}`).setPlaceholder('Select a role for access').setMinValues(1).setMaxValues(1))],
                    flags: [MessageFlags.Ephemeral],
                });
                return;
            }

            if (!await hasCommandPermission(interaction, guildId)) return reply('❌ No permission. An administrator must configure access with `/social access`.');

            if (sub === 'add') {
                const platform = interaction.options.getString('platform');
                const rawHandle = interaction.options.getString('handle');
                const channel = interaction.options.getChannel('channel');
                const message = interaction.options.getString('message');
                const handle = normalizeHandle(platform, rawHandle);
                if (!handle) return reply('❌ Could not parse that handle/URL.');

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const watches = await getWatches(guildId);
                if (watches.some(w => w.platform === platform && w.handle.toLowerCase() === handle.toLowerCase() && w.channel_id === channel.id)) {
                    return interaction.editReply('❌ That account is already being tracked in this channel.');
                }
                if (watches.length >= 50) return interaction.editReply('❌ This server has reached the maximum of 50 tracked accounts.');

                let post = null;
                let socialLinkId = null;
                if (PLATFORMS[platform].oauth) {
                    // Instagram/TikTok can only be watched for accounts that have gone through
                    // /social link — there's no way to poll an arbitrary public account via
                    // their official APIs without that account's consent.
                    const link = await getSocialLinkByUsername(guildId, platform, handle);
                    if (!link) {
                        return interaction.editReply(`❌ **${handle}** hasn't been linked yet. That account needs to run \`/social link\` and authorize with ${PLATFORMS[platform].label} first — this bot can't watch ${PLATFORMS[platform].label} accounts that haven't consented.\nUse \`/social links\` to see what's already linked in this server.`);
                    }
                    socialLinkId = link.id;
                    try {
                        const posts = platform === 'instagram' ? await fetchLatestInstagramAll(link) : await fetchLatestTikTokAll(link);
                        post = posts[0] || null;
                    } catch (e) {
                        return interaction.editReply(`❌ Couldn't fetch that account: ${e.message}`);
                    }
                } else {
                    try {
                        if (platform === 'twitch') {
                            const posts = await fetchLatestTwitchAll(handle);
                            post = posts[0] || null;
                        } else {
                            post = await fetchLatestPost(platform, handle);
                        }
                    } catch (e) {
                        if (/HTTP 429/.test(e.message)) {
                            // Rate-limited on verify — account likely exists, proceed anyway
                            post = null;
                        } else {
                            return interaction.editReply(`❌ Couldn't fetch that account: ${e.message}\nDouble-check the handle/URL and try again.`);
                        }
                    }
                }

                const watch = await addWatch({ guildId, platform, handle, channelId: channel.id, messageTemplate: message, addedBy: interaction.user.tag });
                if (socialLinkId) await setWatchSocialLink(guildId, watch.id, socialLinkId);
                // Seed last_post_id so the first poll doesn't fire a notification for existing content
                await updateLastPost(watch.id, post?.id || null);

                const p = PLATFORMS[platform];
                const types = PLATFORM_NOTIFY_TYPES[platform];
                const successEmbed = E('#00ff00', 'Now Tracking').addFields(
                    { name: 'Platform', value: `${p.emoji} ${p.label}`, inline: true },
                    { name: 'Account', value: handle, inline: true },
                    { name: 'Channel', value: `${channel}`, inline: true },
                    { name: 'Message', value: message || DEFAULT_TEMPLATE },
                    post?.title
                        ? { name: 'Latest post (baseline)', value: `[${post.title.slice(0, 100)}](${post.url})` }
                        : { name: 'Baseline', value: 'No posts found yet — will track from first post.' },
                );

                // If platform only has one type, skip the selector
                if (types.length <= 1) {
                    await interaction.editReply({ embeds: [successEmbed] });
                    return;
                }

                // Show notification type selector
                const typeEmbed = new EmbedBuilder().setColor('#5865F2')
                    .setTitle(`${p.emoji} Choose Notification Types`)
                    .setDescription(`Which types of **${p.label}** content do you want notifications for?\nSelect one or more below. You can change this later via \`/social list\`.`);
                const typeRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`socialtype_select_${watch.id}`)
                        .setPlaceholder('Select notification types…')
                        .setMinValues(1).setMaxValues(types.length)
                        .addOptions(types.map(t => ({ label: t.label, value: t.id, description: t.description })))
                );
                const skipRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`socialtype_skip_${watch.id}`).setLabel('All types (skip)').setStyle(ButtonStyle.Secondary)
                );
                const msgRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`socialpertype_open_${watch.id}`).setLabel('Set custom message per type').setStyle(ButtonStyle.Primary)
                );
                await interaction.editReply({ embeds: [successEmbed, typeEmbed], components: [typeRow, skipRow, msgRow] });
                return;
            }

            if (sub === 'list') {
                const { embeds, components } = await buildWatchListEmbed(guildId);
                return reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
            }

            if (sub === 'check') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                await pollAll();
                return interaction.editReply('✅ Checked all tracked accounts for new posts.');
            }

            if (sub === 'debug') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const id = interaction.options.getInteger('id');
                const watches = await getWatches(guildId);
                const w = watches.find(x => x.id === id);
                if (!w) return interaction.editReply(`❌ No watch with ID \`${id}\` in this server. Use \`/social list\` to see IDs.`);

                let post = null, fetchError = null;
                try {
                    if (w.platform === 'twitch') post = (await fetchLatestTwitchAll(w.handle))[0] || null;
                    else if (w.platform === 'instagram' || w.platform === 'tiktok') {
                        if (!w.social_link_id) throw new Error('Not linked — run /social link first.');
                        const link = await getSocialLinkById(w.social_link_id);
                        if (!link) throw new Error('Linked account no longer found — re-link with /social link.');
                        post = (w.platform === 'instagram' ? (await fetchLatestInstagramAll(link)) : (await fetchLatestTikTokAll(link)))[0] || null;
                    } else {
                        post = await fetchLatestPost(w.platform, w.handle);
                    }
                }
                catch (e) { fetchError = e.message; }

                const embed = E('#5865F2', `Debug — ${PLATFORMS[w.platform].label} ${w.handle}`)
                    .addFields(
                        { name: 'Most recent post ID', value: w.last_post_id ? `\`${w.last_post_id}\`` : '*(none yet)*' },
                        { name: 'Recently seen IDs', value: Array.isArray(w.seen_post_ids) && w.seen_post_ids.length ? w.seen_post_ids.slice(0, 10).map(id => `\`${id}\``).join(', ') : '*(none yet)*' },
                        { name: 'Last checked', value: w.last_checked ? `<t:${Math.floor(w.last_checked / 1000)}:R>` : '*(never)*' },
                    );
                if (fetchError) {
                    embed.addFields({ name: 'Live fetch', value: `❌ Error: ${fetchError}` }).setColor('#ff0000');
                } else if (!post) {
                    embed.addFields({ name: 'Live fetch', value: '⚠️ Returned no post (account empty or unparsable).' });
                } else {
                    const alreadySeen = Array.isArray(w.seen_post_ids) && w.seen_post_ids.includes(post.id);
                    embed.addFields(
                        { name: 'Live fetch — latest post ID', value: `\`${post.id}\`` },
                        { name: 'Already notified for this?', value: alreadySeen ? '✅ Yes — no notification will fire' : '🆕 New — notification should fire on next poll/check' },
                        { name: 'Live post', value: post.title ? `[${post.title.slice(0, 150)}](${post.url})` : (post.url || 'N/A') },
                    );
                }
                return interaction.editReply({ embeds: [embed] });
            }

            if (sub === 'link') {
                const platform = interaction.options.getString('platform');
                const cfg = OAUTH_CONFIG[platform];
                if (!cfg.clientId || !cfg.clientSecret) {
                    return reply(`❌ ${PLATFORMS[platform].label} OAuth isn't configured on this bot yet (missing app credentials env vars). Ask the bot owner to set them up.`);
                }
                if (!PUBLIC_BASE_URL) {
                    return reply('❌ PUBLIC_BASE_URL (or RENDER_EXTERNAL_URL) isn\'t set, so OAuth redirects have nowhere to go. Ask the bot owner to configure it.');
                }
                const state = createOAuthState(guildId, interaction.user.id, platform);
                const authUrl = `${cfg.authUrl}?client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&scope=${encodeURIComponent(cfg.scope)}&response_type=code&state=${state}`;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel(`Authorize with ${PLATFORMS[platform].label}`).setStyle(ButtonStyle.Link).setURL(authUrl)
                );
                return reply({
                    embeds: [E('#5865F2', `Link ${PLATFORMS[platform].label}`).setDescription(`Click below and log in with the **${PLATFORMS[platform].label} account you want this bot to track**. That account has to authorize this app — the bot can't watch accounts that haven't consented.\n\nThis link expires in 10 minutes.`)],
                    components: [row],
                    flags: [MessageFlags.Ephemeral],
                });
            }

            if (sub === 'links') {
                const igLinks = await getSocialLinks(guildId, 'instagram');
                const ttLinks = await getSocialLinks(guildId, 'tiktok');
                const embed = E('#5865F2', 'Linked Accounts').setDescription('Accounts authorized via `/social link` in this server. Only these can be added with `/social add`.');
                embed.addFields(
                    { name: '📸 Instagram', value: igLinks.length ? igLinks.map(l => `• ${l.external_username} (linked by ${l.linked_by})`).join('\n') : '*(none linked)*' },
                    { name: '🎵 TikTok', value: ttLinks.length ? ttLinks.map(l => `• ${l.external_username} (linked by ${l.linked_by})`).join('\n') : '*(none linked)*' },
                );
                return reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
            }
        }
        if (commandName === 'invite' || commandName === 'help' || commandName === 'config' || commandName === 'social') return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'killbot') {
        const ownerId = process.env.BOT_OWNER_ID;
        if (!ownerId || interaction.user.id !== ownerId) {
            return interaction.reply({ content: '❌ This command is owner-only.', flags: [MessageFlags.Ephemeral] });
        }
        await interaction.reply({ content: '🛑 Suspending the Render service…', flags: [MessageFlags.Ephemeral] });
        const renderKey = process.env.RENDER_API_KEY, serviceId = process.env.RENDER_SERVICE_ID;
        if (renderKey && serviceId) {
            try {
                const { status } = await postJson(`https://api.render.com/v1/services/${serviceId}/suspend`, {}, { Authorization: `Bearer ${renderKey}` });
                if (status >= 200 && status < 300) {
                    await interaction.followUp({ content: '✅ Render service suspended — it will stay off (and stop using hours) until manually resumed from the Render dashboard.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
                } else {
                    await interaction.followUp({ content: `⚠️ Render API returned status ${status}. Falling back to crashing the process.`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
                    process.exit(1);
                }
            } catch (e) {
                await interaction.followUp({ content: `⚠️ Render suspend call failed (${e.message}). Falling back to crashing the process.`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
                process.exit(1);
            }
        } else {
            await interaction.followUp({ content: '⚠️ RENDER_API_KEY/RENDER_SERVICE_ID not set, so I can\'t properly suspend the service — just crashing the process instead. Note: on most Render plans this alone gets restarted automatically and will keep using hours. Set those two env vars for a real stop.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            process.exit(1);
        }
        return;
    }

    // ── Role select: access role ──────────────────────────────────────────
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('social_access_role_')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Only administrators can do this.', flags: [MessageFlags.Ephemeral] });
        const role = interaction.values[0];
        const cfg = await getConfig(guildId);
        cfg.accessRoleId = role; saveConfig(guildId, cfg);
        return interaction.update({ embeds: [E('#00ff00', '✅ Access Updated').setDescription(`<@&${role}> can now manage social notifications.`)], components: [] });
    }

    // ── Buttons: refresh list ───────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('sociallist_refresh_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = await buildWatchListEmbed(guildId);
        return interaction.update({ embeds, components });
    }

    // ── Select: open manage view for a watch ────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sociallist_manage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.values[0], 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found (it may have been removed).', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Buttons: manage view actions ─────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialmanage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const [, action, idStr] = interaction.customId.split('_');

        if (action === 'back') {
            const { embeds, components } = await buildWatchListEmbed(guildId);
            return interaction.update({ embeds, components });
        }

        const id = parseInt(idStr, 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found (it may have been removed).', embeds: [], components: [] });

        if (action === 'msg') {
            const modal = new ModalBuilder().setCustomId(`socialmsg_modal_${id}`).setTitle('Edit Notification Message')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('template').setLabel('Custom message (leave blank for default)')
                            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
                            .setValue(w.message_template || '')
                            .setPlaceholder('{author} just posted on {platform}!\n{url}')
                    )
                );
            return interaction.showModal(modal);
        }

        if (action === 'channel') {
            return interaction.update({
                embeds: [E('#5865F2', `Change Channel — ${w.handle}`).setDescription('Select the new channel for this watch\'s notifications.')],
                components: [new ActionRowBuilder().addComponents(
                    new ChannelSelectMenuBuilder().setCustomId(`socialchannel_select_${id}`).setPlaceholder('Select a channel…')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )],
            });
        }

        if (action === 'role') {
            return interaction.update({
                embeds: [E('#5865F2', `Ping Role — ${w.handle}`).setDescription('Select a role to ping on every notification, or click "Clear Role" to remove it.')],
                components: [
                    new ActionRowBuilder().addComponents(
                        new RoleSelectMenuBuilder().setCustomId(`socialrole_select_${id}`).setPlaceholder('Select a role…')
                    ),
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`socialrole_clear_${id}`).setLabel('Clear Role').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`socialmanage_backto_${id}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
                    ),
                ],
            });
        }

        if (action === 'types') {
            const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
            if (types.length <= 1) return interaction.update({ content: 'This platform only has one notification type.', embeds: [], components: [] });
            const current = Array.isArray(w.notify_types) && w.notify_types.length ? w.notify_types : types.map(t => t.id);
            return interaction.update({
                embeds: [E('#5865F2', `Notification Types — ${w.handle}`).setDescription(`Choose which **${PLATFORMS[w.platform].label}** content types to get notified for.`)],
                components: [
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId(`socialtype_select_${id}`)
                            .setPlaceholder('Select types…').setMinValues(1).setMaxValues(types.length)
                            .addOptions(types.map(t => ({ label: t.label, value: t.id, description: t.description, default: current.includes(t.id) })))
                    ),
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`socialmanage_backto_${id}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
                    ),
                ],
            });
        }

        if (action === 'toggle') {
            await updateWatchActive(guildId, id, !w.active);
            const updated = await getWatch(guildId, id);
            const { embeds, components } = buildManageView(updated);
            return interaction.update({ embeds, components });
        }

        if (action === 'remove') {
            await removeWatch(guildId, id);
            const { embeds, components } = await buildWatchListEmbed(guildId);
            return interaction.update({ content: `✅ Removed ${PLATFORMS[w.platform].label} — ${w.handle}.`, embeds, components });
        }

        if (action === 'backto') {
            const { embeds, components } = buildManageView(w);
            return interaction.update({ content: null, embeds, components });
        }
    }

    // ── Select: notification types (post-add and manage flows) ──────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('socialtype_select_')) {
        const id = parseInt(interaction.customId.slice(18), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, interaction.values);
        const typeNames = interaction.values.map(v => PLATFORM_NOTIFY_TYPES[w.platform]?.find(t => t.id === v)?.label || v).join(', ');
        const updated = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(updated);
        return interaction.update({ content: `✅ Notification types set to: **${typeNames}**`, embeds, components });
    }

    // ── Button: skip type selector (all types) ───────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialtype_skip_')) {
        const id = parseInt(interaction.customId.slice(16), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, null);
        const updated = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(updated);
        return interaction.update({ content: '✅ Will notify for all content types.', embeds, components });
    }

    // ── Select: change channel ───────────────────────────────────────────────
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('socialchannel_select_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(21), 10);
        const channelId = interaction.values[0];
        await updateWatchChannel(guildId, id, channelId);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Select: set ping role ────────────────────────────────────────────────
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('socialrole_select_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(18), 10);
        const roleId = interaction.values[0];
        await updateWatchRole(guildId, id, roleId);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Button: clear ping role ──────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialrole_clear_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(17), 10);
        await updateWatchRole(guildId, id, null);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Modal: save custom message ──────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('socialmsg_modal_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(16), 10);
        const template = interaction.fields.getTextInputValue('template').trim() || null;
        await updateWatchTemplate(guildId, id, template);
        await interaction.deferUpdate();
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.editReply({ embeds, components });
    }

    // ── Button: open per-post-type custom message popup form ────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialpertype_open_')) {
        const id = parseInt(interaction.customId.slice(19), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found.', flags: [MessageFlags.Ephemeral] });
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
        const templates = w.message_templates || {};
        const modal = new ModalBuilder().setCustomId(`socialpertype_modal_${id}`).setTitle(`Per-Type Messages — ${w.handle}`.slice(0, 45));
        // Discord modals support at most 5 text inputs — every platform we support has ≤3 notify types, so this always fits.
        modal.addComponents(
            ...types.slice(0, 5).map(t => new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId(`tmpl_${t.id}`).setLabel(`Message for ${t.label} (blank = default)`)
                    .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
                    .setValue(templates[t.id] || '')
                    .setPlaceholder('{author} just posted on {platform}!\n{url}')
            ))
        );
        return interaction.showModal(modal);
    }

    // ── Modal: save per-post-type custom messages ────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('socialpertype_modal_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(20), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found.', flags: [MessageFlags.Ephemeral] });
        const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
        const updatedTemplates = {};
        for (const t of types.slice(0, 5)) {
            const val = interaction.fields.getTextInputValue(`tmpl_${t.id}`).trim();
            if (val) updatedTemplates[t.id] = val;
        }
        await updateWatchMessageTemplates(guildId, id, updatedTemplates);
        await interaction.deferUpdate();
        const updated = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(updated);
        return interaction.editReply({ embeds, components });
    }

  } catch (error) {
      if (error?.code === 40060) return;
      console.error('❌ Interaction error:', error);
      try {
          if (interaction.deferred) await interaction.editReply({ content: '❌ Something went wrong. Please try again.' }).catch(() => {});
          else if (!interaction.replied) await interaction.reply({ content: '❌ Something went wrong. Please try again.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      } catch {}
  }
});

(async () => {
    await ensureIPv4Pool();
    try {
        await initDB();
    } catch (e) {
        console.error('⚠️ initDB failed, starting bot anyway:', e.message);
    }
    if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_TOKEN.trim()) {
        console.error('❌ DISCORD_TOKEN is missing or empty. Set it in this service\'s environment variables and redeploy.');
        process.exit(1);
    }
    try {
        await client.login(process.env.DISCORD_TOKEN.trim());
    } catch (e) {
        console.error('❌ Discord login failed:', e.message, '\nDouble-check DISCORD_TOKEN on this service — copy it fresh from the Developer Portal with no extra whitespace/quotes.');
        process.exit(1);
    }
})();

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e));
client.on('error', e => console.error('⚠️ Discord client error:', e));

// ── OAuth code exchange (called from the HTTP callback routes) ────────────
async function exchangeInstagramCode(code) {
    const cfg = OAUTH_CONFIG.instagram;
    // 1. Exchange the auth code for a short-lived user access token.
    const { json: tokenRes } = await postForm('https://graph.facebook.com/v21.0/oauth/access_token', {
        client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, code,
    });
    if (!tokenRes?.access_token) throw new Error(tokenRes?.error?.message || 'Instagram token exchange failed');

    // 2. Exchange for a long-lived token (~60 days).
    const { json: longRes } = await fetchJson(
        `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${cfg.clientId}&client_secret=${cfg.clientSecret}&fb_exchange_token=${encodeURIComponent(tokenRes.access_token)}`
    );
    const accessToken = longRes?.access_token || tokenRes.access_token;
    const expiresIn = longRes?.expires_in || tokenRes.expires_in || 55 * 24 * 60 * 60;

    // 3. Find the user's Facebook Page(s) and the Instagram professional account linked to one.
    // (Instagram's Graph API requires the IG account to be Business/Creator and linked to a Page.)
    const { json: pages } = await fetchJson(`https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(accessToken)}`);
    const page = (pages?.data || []).find(p => p.instagram_business_account);
    if (!page) throw new Error('No Instagram professional account found — the account must be Business/Creator and linked to a Facebook Page.');
    const igUserId = page.instagram_business_account.id;
    const { json: igProfile } = await fetchJson(`https://graph.facebook.com/v21.0/${igUserId}?fields=username&access_token=${encodeURIComponent(accessToken)}`);

    return { externalUserId: igUserId, externalUsername: igProfile?.username || igUserId, accessToken, refreshToken: null, expiresAt: Date.now() + expiresIn * 1000 };
}

async function exchangeTikTokCode(code) {
    const cfg = OAUTH_CONFIG.tiktok;
    const { json } = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
        client_key: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri,
    });
    if (!json?.access_token) throw new Error(json?.error_description || 'TikTok token exchange failed');
    const { json: userInfo } = await postJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', {}, { Authorization: `Bearer ${json.access_token}` });
    const username = userInfo?.data?.user?.display_name || json.open_id;
    return {
        externalUserId: json.open_id, externalUsername: username,
        accessToken: json.access_token, refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in || 86400) * 1000,
    };
}

function htmlResponse(res, status, title, message) {
    res.writeHead(status, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>${title}</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2>${title}</h2><p>${message}</p></body></html>`);
}

async function handleOAuthCallback(platform, req, res) {
    const u = new URL(req.url, `https://${req.headers.host}`);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const oauthError = u.searchParams.get('error');
    if (oauthError) return htmlResponse(res, 400, 'Authorization denied', 'You can close this tab.');

    const stateEntry = state ? consumeOAuthState(state) : null;
    if (!stateEntry || stateEntry.platform !== platform) return htmlResponse(res, 400, 'Invalid or expired link', 'Run /social link again in Discord and try once more within 10 minutes.');
    if (!code) return htmlResponse(res, 400, 'Missing code', 'Something went wrong — no authorization code was returned.');

    try {
        const identity = platform === 'instagram' ? await exchangeInstagramCode(code) : await exchangeTikTokCode(code);
        await upsertSocialLink({
            guildId: stateEntry.guildId, platform,
            externalUserId: identity.externalUserId, externalUsername: identity.externalUsername,
            accessToken: identity.accessToken, refreshToken: identity.refreshToken, expiresAt: identity.expiresAt,
            linkedBy: stateEntry.userId,
        });
        return htmlResponse(res, 200, 'Linked!', `<b>${identity.externalUsername}</b> is now linked. You can close this tab and go back to Discord — use <code>/social add</code> to start tracking it.`);
    } catch (e) {
        console.error(`OAuth callback (${platform}):`, e.message);
        return htmlResponse(res, 500, 'Link failed', `${e.message} — you can close this tab and try /social link again.`);
    }
}

function legalPage(title, bodyHtml) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Notifyer</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1a1a;} h1{margin-bottom:4px;} .updated{color:#666;font-size:0.9em;margin-top:0;} h2{margin-top:28px;} a{color:#5865F2;}</style>
</head><body>${bodyHtml}</body></html>`;
}

const LEGAL_LAST_UPDATED = 'August 29, 2026';
const LEGAL_CONTACT = process.env.LEGAL_CONTACT_EMAIL || process.env.BOT_OWNER_DISCORD_TAG || 'the bot owner via the support server';

const TERMS_HTML = legalPage('Terms of Service', `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>These Terms govern your use of the Notifyer Discord bot ("the Bot"). By adding the Bot to a server or using its commands, you agree to these Terms.</p>

<h2>What the Bot does</h2>
<p>The Bot watches accounts you configure on YouTube, Twitter/X, Twitch, Instagram, and TikTok, and posts a notification in a Discord channel you choose when those accounts publish new content. For Instagram and TikTok, this only works for accounts that have explicitly authorized the Bot via OAuth (<code>/social link</code>) — the Bot cannot and does not access those platforms' accounts without their consent.</p>

<h2>Acceptable use</h2>
<ul>
<li>You must comply with Discord's <a href="https://discord.com/terms">Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a> while using the Bot.</li>
<li>You must have the right to link any Instagram or TikTok account you connect via <code>/social link</code> — only link accounts you own or are authorized to manage.</li>
<li>Don't use the Bot to spam, harass, or send notifications to channels/servers without appropriate permission.</li>
<li>Don't attempt to abuse, overload, or reverse-engineer the Bot's infrastructure.</li>
</ul>

<h2>No warranty</h2>
<p>The Bot is provided "as is," without warranty of any kind. Notifications may be delayed, missed, or occasionally inaccurate, particularly where the Bot relies on unofficial or rate-limited data sources (e.g. Twitter). We don't guarantee uninterrupted availability.</p>

<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, the Bot's operator is not liable for any indirect, incidental, or consequential damages arising from your use of, or inability to use, the Bot.</p>

<h2>Termination</h2>
<p>We may suspend or terminate the Bot's access to your server, or discontinue the Bot entirely, at any time. You can remove the Bot from your server at any time via Discord's server settings.</p>

<h2>Changes</h2>
<p>We may update these Terms from time to time. Continued use of the Bot after changes are posted constitutes acceptance of the revised Terms.</p>

<h2>Contact</h2>
<p>Questions about these Terms can be directed to ${LEGAL_CONTACT}.</p>
`);

const PRIVACY_HTML = legalPage('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>This Privacy Policy explains what data the Notifyer Discord bot ("the Bot") collects and how it's used.</p>

<h2>Data we collect</h2>
<ul>
<li><b>Server configuration:</b> the Discord server (guild) ID, channel IDs, role IDs, and the account handles/URLs you choose to track, along with any custom notification message templates you set.</li>
<li><b>Discord identifiers:</b> the Discord user ID and username of whoever adds a watch or links an account, stored only to show who configured something.</li>
<li><b>OAuth tokens:</b> if you use <code>/social link</code> to connect an Instagram or TikTok account, we store the access token, refresh token, and the linked account's platform user ID/username, so the Bot can check that account for new posts on your behalf.</li>
<li><b>Post metadata:</b> IDs and timestamps of posts already seen, so the Bot doesn't re-notify for the same content.</li>
</ul>
<p>We do not collect message content from your Discord server beyond what's needed to operate slash commands, and we do not read or store the content of DMs.</p>

<h2>How we use data</h2>
<p>Data is used solely to operate the Bot's core function: checking tracked accounts on a schedule and posting notifications to the channel you specify. We do not sell data, use it for advertising, or share it with third parties except the platform APIs (Instagram/TikTok) strictly as needed to fetch posts from accounts you've linked.</p>

<h2>Data retention & deletion</h2>
<p>Watch configurations and linked accounts are retained until you remove them (<code>/social list</code> → Remove, or by revoking a link) or remove the Bot from your server. You can request deletion of any data tied to your server or Discord account by contacting ${LEGAL_CONTACT}.</p>

<h2>Third-party services</h2>
<p>The Bot communicates with Discord's API, and — where you've configured it — YouTube, Twitter/X, Twitch, Meta's Instagram Graph API, and TikTok's API. Each of those platforms has its own privacy policy governing data you share with them directly.</p>

<h2>Security</h2>
<p>OAuth tokens are stored in a private database and are not exposed through any Bot command or public endpoint. No storage method is 100% secure, but we take reasonable steps to protect stored data.</p>

<h2>Children's privacy</h2>
<p>The Bot is not directed at children under 13, consistent with Discord's own age requirements.</p>

<h2>Changes</h2>
<p>We may update this Privacy Policy from time to time. Material changes will be reflected by updating the "Last updated" date above.</p>

<h2>Contact</h2>
<p>Questions about this policy, or requests to access/delete your data, can be directed to ${LEGAL_CONTACT}.</p>
`);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/' || path === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Social notify bot is running!');
    }
    if (path === '/terms') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(TERMS_HTML); }
    if (path === '/privacy') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PRIVACY_HTML); }
    // TikTok (and similar) URL-prefix/domain ownership verification: they give you a .txt
    // file to download and host at a specific path. This is hardcoded from the actual
    // downloaded file's content to avoid any copy/paste corruption through env vars — if
    // TikTok ever issues a NEW verification file later, update these two constants.
    const TIKTOK_VERIFY_FILENAME = process.env.TIKTOK_VERIFY_FILENAME || 'tiktok54ye0zN8LYl3cx2fMAolswrgKzdRfnvK.txt';
    const TIKTOK_VERIFY_CONTENT = process.env.TIKTOK_VERIFY_CONTENT || 'tiktok-developers-site-verification=54ye0zN8LYl3cx2fMAolswrgKzdRfnvK';
    if (path === `/${TIKTOK_VERIFY_FILENAME}`) {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(TIKTOK_VERIFY_CONTENT);
    }
    if (path === '/oauth/instagram/callback') return handleOAuthCallback('instagram', req, res);
    if (path === '/oauth/tiktok/callback') return handleOAuthCallback('tiktok', req, res);
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

// Keep-alive: ping our own URL periodically so Render's free tier doesn't spin down.
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
if (KEEP_ALIVE_URL) {
    setInterval(() => {
        https.get(`${KEEP_ALIVE_URL.replace(/\/$/, '')}/health`, res => res.resume())
            .on('error', e => console.error('⚠️ Keep-alive ping failed:', e.message));
    }, 10 * 60 * 1000); // every 10 minutes
} else {
    console.log('ℹ️ KEEP_ALIVE_URL/RENDER_EXTERNAL_URL not set — self-ping disabled.');
}
