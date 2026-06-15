const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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
};
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
async function updateLastPost(id, lastPostId) {
    await pool.query('UPDATE watches SET last_post_id = $1, last_checked = $2 WHERE id = $3', [lastPostId, Date.now(), id]);
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
    }
    return h;
}
function profileUrl(platform, handle) {
    switch (platform) {
        case 'youtube': return handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${handle}`;
        case 'twitter': return `https://x.com/${handle}`;
        case 'tiktok': return `https://www.tiktok.com/@${handle}`;
        case 'instagram': return `https://www.instagram.com/${handle}`;
    }
}

// ── Platform fetchers: each returns { id, url, title, author, thumbnail, timestamp } or null ──
async function fetchLatestYouTube(handle) {
    let channelId = handle;
    if (handle.startsWith('@') || !/^UC[\w-]{22}$/.test(handle)) {
        // Resolve handle -> channel id via the channel page
        const url = handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/${handle.startsWith('c/') || handle.startsWith('user/') ? handle : '@' + handle}`;
        const html = await fetchText(url);
        const m = html.match(/"channelId":"(UC[\w-]{22})"/);
        if (!m) throw new Error('Could not resolve YouTube channel ID');
        channelId = m[1];
    }
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const xml = await fetchText(feedUrl);
    const data = xmlParser.parse(xml);
    const entries = data?.feed?.entry;
    if (!entries) return null;
    const entry = Array.isArray(entries) ? entries[0] : entries;
    return {
        id: entry['yt:videoId'],
        url: entry.link?.['@_href'] || `https://www.youtube.com/watch?v=${entry['yt:videoId']}`,
        title: entry.title,
        author: data?.feed?.author?.name,
        thumbnail: entry['media:group']?.['media:thumbnail']?.['@_url'],
        timestamp: entry.published,
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
    if (!m) throw new Error('Could not parse TikTok page');
    const data = JSON.parse(m[1]);
    const itemList = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
    const items = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.itemList
        || data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.itemList;
    // Fallback: search for the items module structure
    let videos = items;
    if (!videos) {
        const moduleM = html.match(/"itemList":(\[.*?\]),"webapp\.video-detail"/s);
        if (moduleM) videos = JSON.parse(moduleM[1]);
    }
    if (!videos || !videos.length) return null;
    const v = videos[0];
    return {
        id: v.id,
        url: `https://www.tiktok.com/@${handle}/video/${v.id}`,
        title: v.desc || `New TikTok from @${handle}`,
        author: itemList?.nickname || handle,
        thumbnail: v.video?.cover || v.video?.dynamicCover,
        timestamp: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
    };
}

async function fetchLatestInstagram(handle) {
    const html = await fetchText(`https://www.instagram.com/${handle}/`);
    const m = html.match(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/s);
    let post = null;
    if (m) {
        try {
            const ld = JSON.parse(m[1]);
            const main = Array.isArray(ld) ? ld[0] : ld;
            // ld+json structured data sometimes includes mainEntityofPage / image but rarely the latest post directly
        } catch {}
    }
    // Primary path: shared data with edge_owner_to_timeline_media
    const sharedM = html.match(/window\.__additionalDataLoaded\([^,]+,(\{.*?\})\);/s) || html.match(/"PolarisProfilePage[^"]*"[^]*?"edges":(\[.*?\])\s*,\s*"page_info"/s);
    let edges = null;
    if (sharedM) {
        try {
            const parsed = JSON.parse(sharedM[1]);
            edges = parsed?.graphql?.user?.edge_owner_to_timeline_media?.edges || parsed;
        } catch {}
    }
    if (!edges) {
        // Fallback regex: grab the first shortcode + caption + display_url near top of page data
        const scMatch = html.match(/"shortcode":"([^"]+)"/);
        const capMatch = html.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/);
        const imgMatch = html.match(/"display_url":"((?:[^"\\]|\\.)*)"/);
        if (!scMatch) return null;
        return {
            id: scMatch[1],
            url: `https://www.instagram.com/p/${scMatch[1]}/`,
            title: capMatch ? JSON.parse(`"${capMatch[1]}"`).slice(0, 200) : `New Instagram post from @${handle}`,
            author: handle,
            thumbnail: imgMatch ? JSON.parse(`"${imgMatch[1]}"`) : null,
            timestamp: null,
        };
    }
    const first = Array.isArray(edges) ? edges[0] : edges?.[0];
    const node = first?.node;
    if (!node) return null;
    return {
        id: node.shortcode,
        url: `https://www.instagram.com/p/${node.shortcode}/`,
        title: node.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 200) || `New Instagram post from @${handle}`,
        author: handle,
        thumbnail: node.display_url || node.thumbnail_src,
        timestamp: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
    };
}

async function fetchLatestPost(platform, handle) {
    switch (platform) {
        case 'youtube': return fetchLatestYouTube(handle);
        case 'twitter': return fetchLatestTwitter(handle);
        case 'tiktok': return fetchLatestTikTok(handle);
        case 'instagram': return fetchLatestInstagram(handle);
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
let pollInProgress = false;
async function pollAll() {
    if (pollInProgress) return;
    pollInProgress = true;
    try {
        const watches = await getAllWatches();
        for (const w of watches) {
            try {
                const post = await fetchLatestPost(w.platform, w.handle);
                if (!post || !post.id) { await touchLastChecked(w.id); continue; }
                if (w.last_post_id === null) {
                    // First check — just record current latest, don't spam old content
                    await updateLastPost(w.id, post.id);
                    continue;
                }
                if (post.id === w.last_post_id) { await touchLastChecked(w.id); continue; }
                await updateLastPost(w.id, post.id);
                const guild = client.guilds.cache.get(w.guild_id);
                const channel = guild?.channels.cache.get(w.channel_id);
                if (!channel) continue;
                const content = renderTemplate(w.message_template, post, w.platform, w.handle);
                const embed = new EmbedBuilder()
                    .setColor(PLATFORMS[w.platform].color)
                    .setAuthor({ name: `${post.author || w.handle} • ${PLATFORMS[w.platform].label}` })
                    .setURL(post.url)
                    .setDescription(post.title || null)
                    .setTimestamp(post.timestamp ? new Date(post.timestamp) : new Date());
                if (post.thumbnail) embed.setImage(post.thumbnail);
                const linkRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel('View post').setStyle(ButtonStyle.Link).setURL(post.url).setEmoji(PLATFORMS[w.platform].emoji)
                );
                await channel.send({ content, embeds: [embed], components: [linkRow] }).catch(e => console.error('send notification:', e.message));
            } catch (e) {
                console.error(`poll ${w.platform}/${w.handle}:`, e.message);
                await touchLastChecked(w.id).catch(() => {});
            }
            // Stagger requests slightly to avoid hammering sites all at once
            await new Promise(r => setTimeout(r, 1500));
        }
    } finally {
        pollInProgress = false;
    }
}

// ── Embeds / UI builders ──────────────────────────────────────────────────
const refreshBtn = (id) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel('↻ Refresh').setStyle(ButtonStyle.Secondary));

async function buildWatchListEmbed(guildId) {
    const watches = await getWatches(guildId);
    if (!watches.length) {
        return { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Social Media Watches').setDescription('No accounts are being tracked yet. Use `/social add` to add one.')], components: [] };
    }
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Social Media Watches').setTimestamp()
        .setDescription(`Tracking **${watches.length}** account${watches.length > 1 ? 's' : ''}.`);
    for (const w of watches.slice(0, 25)) {
        const p = PLATFORMS[w.platform];
        embed.addFields({
            name: `${p.emoji} ${p.label} — ${w.handle}`,
            value: `Posts to <#${w.channel_id}>\nID: \`${w.id}\`${w.message_template ? `\nCustom message: \`${w.message_template.slice(0, 80)}${w.message_template.length > 80 ? '…' : ''}\`` : '\nUsing default message'}`,
            inline: false,
        });
    }
    if (watches.length > 25) embed.setFooter({ text: `Showing first 25 of ${watches.length}` });
    const components = [refreshBtn(`sociallist_refresh_${guildId}`)];
    if (watches.length) {
        components.unshift(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sociallist_remove_${guildId}`).setPlaceholder('Remove a watch…')
                .addOptions(watches.slice(0, 25).map(w => ({ label: `${PLATFORMS[w.platform].label} — ${w.handle}`.slice(0, 100), value: `${w.id}` })))
        ));
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sociallist_editmsg_${guildId}`).setPlaceholder('Edit custom message for…')
                .addOptions(watches.slice(0, 25).map(w => ({ label: `${PLATFORMS[w.platform].label} — ${w.handle}`.slice(0, 100), value: `${w.id}` })))
        ));
    }
    return { embeds: [embed], components };
}

const helpEmbed = () => new EmbedBuilder().setColor('#5865F2').setTitle('Social Notify Bot')
    .setDescription('Get notified in a channel whenever a tracked account posts new content.')
    .addFields(
        { name: '/social add', value: 'Track a new account. Choose a platform, enter the handle/URL, and pick a channel. Optionally set a custom message.' },
        { name: '/social list', value: 'View all tracked accounts. Use the dropdowns to remove a watch or edit its custom message.' },
        { name: '/social check', value: 'Force an immediate check of all tracked accounts.' },
        { name: 'Placeholders', value: 'Custom messages support `{author}`, `{handle}`, `{platform}`, `{title}`, and `{url}`.' },
        { name: 'Notes', value: 'Checks run every 5 minutes. New watches start tracking from the next post onward (no notification for existing content). TikTok/Instagram/Twitter rely on unofficial scraping and may occasionally fail or lag.' },
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
                    components: [new ActionRowBuilder().addComponents(new (require('discord.js').RoleSelectMenuBuilder)().setCustomId(`social_access_role_${guildId}`).setPlaceholder('Select a role for access').setMinValues(1).setMaxValues(1))],
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
                    post = await fetchLatestPost(platform, handle);
                } catch (e) {
                    return interaction.editReply(`❌ Couldn't fetch that account: ${e.message}\nDouble-check the handle/URL and try again.`);
                }
                if (post === null) {
                    return interaction.editReply(`⚠️ Account looks valid but has no posts yet. It will still be tracked.`);
                }

                const watch = await addWatch({ guildId, platform, handle, channelId: channel.id, messageTemplate: message, addedBy: interaction.user.tag });
                // Seed last_post_id so the first poll doesn't fire a notification for existing content
                await updateLastPost(watch.id, post.id);

                const p = PLATFORMS[platform];
                await interaction.editReply({
                    embeds: [E('#00ff00', 'Now Tracking').addFields(
                        { name: 'Platform', value: `${p.emoji} ${p.label}`, inline: true },
                        { name: 'Account', value: handle, inline: true },
                        { name: 'Channel', value: `${channel}`, inline: true },
                        { name: 'Message', value: message || DEFAULT_TEMPLATE },
                        { name: 'Latest post (baseline)', value: post.title ? `[${post.title.slice(0, 100)}](${post.url})` : post.url || 'N/A' },
                    )],
                });
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
                        { name: 'Stored baseline (last_post_id)', value: w.last_post_id ? `\`${w.last_post_id}\`` : '*(none yet)*' },
                        { name: 'Last checked', value: w.last_checked ? `<t:${Math.floor(w.last_checked / 1000)}:R>` : '*(never)*' },
                    );
                if (fetchError) {
                    embed.addFields({ name: 'Live fetch', value: `❌ Error: ${fetchError}` }).setColor('#ff0000');
                } else if (!post) {
                    embed.addFields({ name: 'Live fetch', value: '⚠️ Returned no post (account empty or unparsable).' });
                } else {
                    embed.addFields(
                        { name: 'Live fetch — latest post ID', value: `\`${post.id}\`` },
                        { name: 'Matches baseline?', value: post.id === w.last_post_id ? '✅ Yes — no notification will fire' : '🆕 Different — notification should fire on next poll/check' },
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

    // ── Select: remove watch ────────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sociallist_remove_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.values[0], 10);
        await removeWatch(guildId, id);
        const { embeds, components } = await buildWatchListEmbed(guildId);
        return interaction.update({ embeds, components });
    }

    // ── Select: edit custom message -> open modal ──────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sociallist_editmsg_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = interaction.values[0];
        const modal = new ModalBuilder().setCustomId(`socialmsg_modal_${id}`).setTitle('Edit Notification Message')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('template').setLabel('Message (use {author} {handle} {platform} {title} {url})')
                        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
                        .setPlaceholder(DEFAULT_TEMPLATE)
                )
            );
        return interaction.showModal(modal);
    }

    // ── Modal: save custom message ──────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('socialmsg_modal_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(15), 10);
        const template = interaction.fields.getTextInputValue('template').trim() || null;
        await updateWatchTemplate(guildId, id, template);
        await interaction.deferUpdate();
        const { embeds, components } = await buildWatchListEmbed(guildId);
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
