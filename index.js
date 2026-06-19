const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Pool } = require('pg');
const dns = require('dns');
const http = require('http'), https = require('https');
const { XMLParser } = require('fast-xml-parser');

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
    tiktok:    { label: 'TikTok',    emoji: '🎵', color: '#000000' },
    instagram: { label: 'Instagram', emoji: '📸', color: '#E1306C' },
    twitch:    { label: 'Twitch',    emoji: '🟣', color: '#9146FF' },
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
    tiktok:    [
        { id: 'videos', label: 'Videos', description: 'New TikTok videos' },
        { id: 'live',   label: 'Live',   description: 'Stream goes live (best-effort)' },
    ],
    instagram: [
        { id: 'posts',  label: 'Posts',  description: 'Photos and carousels' },
        { id: 'reels',  label: 'Reels',  description: 'Short video Reels' },
    ],
    twitch:    [
        { id: 'live',   label: 'Live',   description: 'Stream goes live' },
        { id: 'vods',   label: 'VODs',   description: 'New VOD/past broadcast uploaded' },
    ],
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
    } else if (platform === 'tiktok') {
        h = h.replace(/^tiktok\.com\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    } else if (platform === 'instagram') {
        h = h.replace(/^instagram\.com\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    } else if (platform === 'twitch') {
        h = h.replace(/^twitch\.tv\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0].toLowerCase();
    }
    return h;
}
function profileUrl(platform, handle) {
    switch (platform) {
        case 'youtube': return handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${handle}`;
        case 'twitter': return `https://x.com/${handle}`;
        case 'tiktok': return `https://www.tiktok.com/@${handle}`;
        case 'instagram': return `https://www.instagram.com/${handle}`;
        case 'twitch': return `https://www.twitch.tv/${handle}`;
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

async function fetchLatestTikTok(handle) {
    const html = await fetchText(`https://www.tiktok.com/@${handle}`);
    const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
    if (!m) throw new Error('TikTok page structure changed: __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag not found');
    let data;
    try { data = JSON.parse(m[1]); }
    catch (e) { throw new Error(`TikTok page JSON parse failed: ${e.message}`); }

    const userInfo = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
    let videos = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.itemList
        || data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.itemList;

    if (!videos) {
        const moduleM = html.match(/"itemList":(\[.*?\]),"webapp\.video-detail"/s);
        if (moduleM) {
            try { videos = JSON.parse(moduleM[1]); }
            catch (e) { throw new Error(`TikTok itemList JSON parse failed: ${e.message}`); }
        }
    }

    if (!videos) throw new Error('TikTok page structure changed: could not locate itemList in page data (account may be private, empty, or TikTok updated their page format)');
    if (!videos.length) throw new Error('TikTok itemList found but is empty (account may have no public videos)');

    const v = videos[0];
    if (!v?.id) throw new Error('TikTok video entry missing an id field — page format may have changed');
    return {
        id: v.id,
        url: `https://www.tiktok.com/@${handle}/video/${v.id}`,
        title: v.desc || `New TikTok from @${handle}`,
        author: userInfo?.nickname || handle,
        thumbnail: v.video?.cover || v.video?.dynamicCover,
        timestamp: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
        postType: 'videos',
    };
}

async function fetchLatestInstagram(handle) {
    const sessionId = process.env.IG_SESSION_ID;

    if (sessionId) {
        // Authenticated path: use Instagram's own internal web API, which
        // returns clean JSON and works far more reliably than scraping HTML
        // since Instagram restricts what logged-out requests can see.
        const cookie = [
            `sessionid=${sessionId}`,
            process.env.IG_CSRF_TOKEN ? `csrftoken=${process.env.IG_CSRF_TOKEN}` : null,
            process.env.IG_DS_USER_ID ? `ds_user_id=${process.env.IG_DS_USER_ID}` : null,
        ].filter(Boolean).join('; ');

        let json;
        try {
            const raw = await fetchText(
                `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
                {
                    'Cookie': cookie,
                    'X-IG-App-ID': '936619743392459',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': `https://www.instagram.com/${handle}/`,
                    'Origin': 'https://www.instagram.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-origin',
                }
            );
            json = JSON.parse(raw);
        } catch (e) {
            if (/HTTP 429/.test(e.message)) throw new Error('HTTP 429'); // let pollAll handle as rate-limit
            if (/HTTP 401|HTTP 403/.test(e.message)) throw new Error('Instagram session cookie appears to be expired or invalid — please refresh IG_SESSION_ID in Render env vars');
            throw new Error(`Instagram API request failed: ${e.message}`);
        }

        const user = json?.data?.user;
        if (!user) throw new Error('Instagram API returned no user data — account may not exist, be private, or the session cookie is invalid');
        const edges = user.edge_owner_to_timeline_media?.edges;
        if (!edges || !edges.length) throw new Error('Instagram account has no public posts, or this session cannot view its posts');
        const node = edges[0].node;
        const postType = (node.is_video && node.product_type === 'clips') ? 'reels' : 'posts';
        return {
            id: node.shortcode,
            url: `https://www.instagram.com/p/${node.shortcode}/`,
            title: node.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 200) || `New Instagram post from @${handle}`,
            author: user.full_name || handle,
            thumbnail: node.display_url || node.thumbnail_src,
            timestamp: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
            postType,
        };
    }

    // Fallback: unauthenticated HTML scraping (unreliable — Instagram
    // increasingly blocks logged-out requests from seeing post data).
    const html = await fetchText(`https://www.instagram.com/${handle}/`);

    if (/Log in to Instagram|loginForm|"require_login"\s*:\s*true/i.test(html) && !/"edge_owner_to_timeline_media"/i.test(html)) {
        throw new Error('Instagram returned a login wall for this request (no IG_SESSION_ID configured) — set IG_SESSION_ID for reliable access');
    }

    const sharedM = html.match(/window\.__additionalDataLoaded\([^,]+,(\{.*?\})\);/s) || html.match(/"PolarisProfilePage[^"]*"[^]*?"edges":(\[.*?\])\s*,\s*"page_info"/s);
    let edges = null;
    if (sharedM) {
        try {
            const parsed = JSON.parse(sharedM[1]);
            edges = parsed?.graphql?.user?.edge_owner_to_timeline_media?.edges || parsed;
        } catch (e) {
            throw new Error(`Instagram shared-data JSON parse failed: ${e.message}`);
        }
    }

    if (!edges) {
        const scMatch = html.match(/"shortcode":"([^"]+)"/);
        const capMatch = html.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/);
        const imgMatch = html.match(/"display_url":"((?:[^"\\]|\\.)*)"/);
        if (!scMatch) throw new Error('Instagram page structure changed: no post data found (shortcode/edges missing — set IG_SESSION_ID for reliable access, or Instagram updated their format)');
        return {
            id: scMatch[1],
            url: `https://www.instagram.com/p/${scMatch[1]}/`,
            title: capMatch ? JSON.parse(`"${capMatch[1]}"`).slice(0, 200) : `New Instagram post from @${handle}`,
            author: handle,
            thumbnail: imgMatch ? JSON.parse(`"${imgMatch[1]}"`) : null,
            timestamp: null,
            postType: 'posts',
        };
    }
    const first = Array.isArray(edges) ? edges[0] : edges?.[0];
    const node = first?.node;
    if (!node) throw new Error('Instagram edges array found but contained no usable post node (account may have no posts)');
    const postType = (node.is_video && node.product_type === 'clips') ? 'reels' : 'posts';
    return {
        id: node.shortcode,
        url: `https://www.instagram.com/p/${node.shortcode}/`,
        title: node.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 200) || `New Instagram post from @${handle}`,
        author: handle,
        thumbnail: node.display_url || node.thumbnail_src,
        timestamp: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
        postType,
    };
}

// ── Twitch OAuth token management ─────────────────────────────────────────
let twitchToken = null, twitchTokenExpiry = 0;
async function getTwitchToken() {
    if (twitchToken && Date.now() < twitchTokenExpiry - 60_000) return twitchToken;
    const clientId = process.env.TWITCH_CLIENT_ID, clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET env vars not set');
    const raw = await fetchText(
        `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
        { 'Content-Type': 'application/x-www-form-urlencoded' }
    );
    // fetchText uses GET, but Twitch token endpoint needs POST — use https directly
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
        case 'tiktok': return fetchLatestTikTok(handle);
        case 'instagram': return fetchLatestInstagram(handle);
        case 'twitch': return null; // Twitch uses fetchLatestTwitchAll — handled separately in pollAll
        default: return null;
    }
}

// ── Message templating ────────────────────────────────────────────────────
const DEFAULT_TEMPLATE = '🔔 **{author}** just posted on {platform}!\n{url}';
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
const PLATFORM_MIN_INTERVAL_MS = {
    instagram: 15 * 60 * 1000, // Instagram rate-limits aggressively — poll conservatively
};

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
    let content = renderTemplate(w.message_template, post, w.platform, w.handle);
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

                if (w.platform === 'twitch') {
                    // Twitch returns multiple post types at once
                    const posts = await fetchLatestTwitchAll(w.handle);
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
            // Stagger with jitter — Instagram especially benefits from non-predictable timing
            const jitter = w.platform === 'instagram' ? 2000 + Math.random() * 3000 : 1000 + Math.random() * 1000;
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
    const embed = new EmbedBuilder().setColor(p.color).setTitle(`Manage — ${p.emoji} ${w.handle}`).setTimestamp()
        .addFields(
            { name: 'Channel', value: `<#${w.channel_id}>`, inline: true },
            { name: 'Status', value: w.active ? '▶️ Active' : '⏸️ Paused', inline: true },
            { name: 'Ping role', value: w.role_id ? `<@&${w.role_id}>` : 'None', inline: true },
            { name: 'Notify types', value: (Array.isArray(w.notify_types) && w.notify_types.length) ? w.notify_types.map(t => PLATFORM_NOTIFY_TYPES[w.platform]?.find(x => x.id === t)?.label || t).join(', ') : 'All types', inline: true },
            { name: 'Message', value: w.message_template ? `\`${w.message_template}\`` : `Default: \`${DEFAULT_TEMPLATE}\`` },
        );
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_msg_${w.id}`).setLabel('Edit Message').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`socialmanage_channel_${w.id}`).setLabel('Change Channel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_role_${w.id}`).setLabel('Set/Clear Ping Role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_types_${w.id}`).setLabel('Edit Types').setStyle(ButtonStyle.Secondary),
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
        { name: 'Notes', value: 'Checks run every 2 minutes. New watches start tracking from the next post onward (no notification for existing content). TikTok/Instagram/Twitter rely on unofficial scraping and may occasionally fail or lag.' },
    );

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`✅ Social notify bot online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'social media for new posts', type: ActivityType.Watching }], status: 'online' });
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
            .addSubcommand(s => s.setName('access').setDescription('Set which role can manage social notifications')),
        new SlashCommandBuilder().setName('config').setDescription('Configure the bot')
            .addSubcommand(s => s.setName('access').setDescription('Set which role can manage social notifications')),
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

                // Verify we can fetch the account before saving
                let post = null;
                try {
                    if (platform === 'twitch') {
                        const posts = await fetchLatestTwitchAll(handle);
                        post = posts[0] || null;
                    } else {
                        post = await fetchLatestPost(platform, handle);
                    }
                } catch (e) {
                    return interaction.editReply(`❌ Couldn't fetch that account: ${e.message}\nDouble-check the handle/URL and try again.`);
                }
                if (post === null && platform !== 'twitch') {
                    return interaction.editReply(`⚠️ Account looks valid but has no posts yet. It will still be tracked.`);
                }

                const watch = await addWatch({ guildId, platform, handle, channelId: channel.id, messageTemplate: message, addedBy: interaction.user.tag });
                // Seed last_post_id so the first poll doesn't fire a notification for existing content
                await updateLastPost(watch.id, post?.id || null);

                const p = PLATFORMS[platform];
                const types = PLATFORM_NOTIFY_TYPES[platform];
                const successEmbed = E('#00ff00', 'Now Tracking').addFields(
                    { name: 'Platform', value: `${p.emoji} ${p.label}`, inline: true },
                    { name: 'Account', value: handle, inline: true },
                    { name: 'Channel', value: `${channel}`, inline: true },
                    { name: 'Message', value: message || DEFAULT_TEMPLATE },
                    post?.title ? { name: 'Latest post (baseline)', value: `[${post.title.slice(0, 100)}](${post.url})` } : { name: 'Baseline', value: 'No posts found yet — will track from first post.' },
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
                await interaction.editReply({ embeds: [successEmbed, typeEmbed], components: [typeRow, skipRow] });
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
                try { post = await fetchLatestPost(w.platform, w.handle); }
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
                        new TextInputBuilder().setCustomId('template').setLabel('Message (use {author} {handle} {platform} {title} {url})')
                            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
                            .setValue(w.message_template || '')
                            .setPlaceholder(DEFAULT_TEMPLATE)
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
    await client.login(process.env.DISCORD_TOKEN);
})();

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e));
client.on('error', e => console.error('⚠️ Discord client error:', e));

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { const ok = req.url === '/' || req.url === '/health'; res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' }); res.end(ok ? 'Social notify bot is running!' : 'Not found'); }).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

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
