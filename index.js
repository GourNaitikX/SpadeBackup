const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const cron = require('node-cron');
const express = require('express');

// ==========================================
// DUMMY WEB SERVER (Prevents Railway SIGTERM Crash)
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Spade Master Backup Bot is running actively.'));
app.listen(PORT, () => console.log(`✅ Dummy server listening on port ${PORT}`));

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URL = process.env.MONGO_URL;
const GITHUB_API = process.env.GITHUB_API;
const RAILWAY_API = process.env.RAILWAY_API;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN || !MONGO_URL || !GITHUB_API || !RAILWAY_API || !ADMIN_CHAT_ID) {
    console.error("❌ ERROR: Missing Environment Variables!");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: { 
        params: { 
            drop_pending_updates: true,
            timeout: 10 
        } 
    } 
});

// ==========================================
// ANTI-CRASH ERROR HANDLERS
// ==========================================
bot.on('polling_error', (error) => console.log(`[Polling Error]: ${error.message}`));
bot.on('error', (error) => console.log(`[Bot Error]: ${error.message}`));
process.on('uncaughtException', (err) => console.log(`[Uncaught Exception]: ${err.message}`));
process.on('unhandledRejection', (reason) => console.log(`[Unhandled Rejection]: ${reason}`));

// ==========================================
// MONGODB SETUP
// ==========================================
const client = new MongoClient(MONGO_URL);
let db, configCol;

async function initDB() {
    try {
        await client.connect();
        db = client.db('SpadeBackupDB');
        configCol = db.collection('auto_backup_settings');
        console.log("✅ MongoDB Connected!");
    } catch (err) {
        console.error("❌ MongoDB Connection Error:", err.message);
    }
}
initDB();

// ==========================================
// UTILITIES
// ==========================================
const delay = ms => new Promise(res => setTimeout(res, ms));

function getFormattedTime() {
    const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
    return new Date().toLocaleString('en-IN', options);
}

// ==========================================
// RAILWAY API FETCH
// ==========================================
async function fetchRailwayProjects() {
    const query = `query { projects { edges { node { id name } } } }`;
    try {
        const response = await axios.post('https://backboard.railway.app/graphql/v2', { query }, {
            headers: { 'Authorization': `Bearer ${RAILWAY_API}`, 'Content-Type': 'application/json' }
        });
        const projects = response.data.data.projects.edges.map(edge => edge.node);
        return projects.filter(p => !p.name.toLowerCase().includes('backup')); 
    } catch (e) {
        console.error("Railway API Error:", e.response ? e.response.data : e.message);
        return [];
    }
}

// ==========================================
// CORE BACKUP GENERATOR FUNCTION
// ==========================================
async function generateAndSendBackup(projectName, chatId) {
    const backupDir = path.join(__dirname, `temp_${projectName}`);
    const zipName = path.join(__dirname, `${projectName}.zip`);
    
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    try {
        // 1. Fetch from GitHub
        const githubHeaders = { 'Authorization': `token ${GITHUB_API}`, 'Accept': 'application/vnd.github.v3+json' };
        const filesToFetch = ['index.js', 'package.json', 'backup.js'];
        
        for (const file of filesToFetch) {
            try {
                // Assuming GitHub Username is GourNaitikX
                const url = `https://api.github.com/repos/GourNaitikX/${projectName}/contents/${file}`;
                const res = await axios.get(url, { headers: githubHeaders });
                const fileContent = await axios.get(res.data.download_url);
                fs.writeFileSync(path.join(backupDir, file), typeof fileContent.data === 'object' ? JSON.stringify(fileContent.data, null, 2) : fileContent.data);
            } catch (e) {}
        }

        // 2. Fetching MongoDB Data via target Bot's custom endpoint
        try {
            const dbUrl = `https://${projectName.toLowerCase()}.up.railway.app/get-data?key=MERA_SECRET_KEY_123`;
            const dbRes = await axios.get(dbUrl, { timeout: 10000 }); 
            if (dbRes.data) {
                const dbFolder = path.join(backupDir, 'Database');
                if (!fs.existsSync(dbFolder)) fs.mkdirSync(dbFolder);
                fs.writeFileSync(path.join(dbFolder, 'database_dump.json'), JSON.stringify(dbRes.data, null, 2));
            }
        } catch (e) {
            console.log(`Skipping DB for ${projectName}: Endpoint unreachable.`);
        }

        // 3. Create Zip
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipName);
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(backupDir, false);
            archive.finalize();
        });

        // 4. Send ZIP
        const caption = `📦 <b>Project:</b> ${projectName}\n📅 <b>Date & Time:</b> ${getFormattedTime()}\n\n✅ <i>Backup successfully generated!</i>`;
        await bot.sendDocument(chatId, zipName, { caption: caption, parse_mode: 'HTML' });

    } catch (e) {
        bot.sendMessage(chatId, `❌ Failed to backup ${projectName}:\n${e.message}`);
    } finally {
        // 5. Cleanup
        if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
        if (fs.existsSync(zipName)) fs.unlinkSync(zipName);
    }
}

// ==========================================
// TELEGRAM BOT COMMANDS & ACTIONS
// ==========================================
bot.onText(/\/start/, (msg) => {
    if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;

    const welcomeMsg = `⚡️ <b>𝗪𝗘𝗟𝗖𝗢𝗠𝗘 𝗦𝗣𝗔𝗗𝗘 𝗜𝗡 𝗬𝗢𝗨𝗥 𝗕𝗔𝗖𝗞𝗨𝗣 𝗕𝗢𝗧</b> ⚡️\n\n` +
                       `👨‍💻 Master, aapka centralized backup system ready hai.\n` +
                       `Railway API + GitHub Repo + MongoDB Auto-Sync Active! ✅\n\n` +
                       `👇 <i>Select an option below to proceed:</i>`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🔄 Fetch Projects', callback_data: 'menu_fetch' }],
            [{ text: '⏰ Set Auto Backup', callback_data: 'menu_autobackup' }]
        ]
    };

    bot.sendMessage(ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: keyboard });
});

bot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const data = query.data;
    const msgId = query.message.message_id;

    // --- ANIMATED LOADING ---
    async function playLoading(text) {
        const frames = ['⏳', '🔄', '🔃', '🔂'];
        let loadMsg = await bot.sendMessage(ADMIN_CHAT_ID, `${frames[0]} ${text}...`);
        for (let i = 1; i < 4; i++) {
            await delay(400);
            try { await bot.editMessageText(`${frames[i]} ${text}...`, { chat_id: ADMIN_CHAT_ID, message_id: loadMsg.message_id }); } catch(e) {}
        }
        return loadMsg.message_id;
    }

    // 1. FETCH PROJECTS MENU
    if (data === 'menu_fetch') {
        const loadingId = await playLoading("Fetching from Railway");
        const projects = await fetchRailwayProjects();
        try { await bot.deleteMessage(ADMIN_CHAT_ID, loadingId); } catch(e) {}

        if (projects.length === 0) return bot.sendMessage(ADMIN_CHAT_ID, "❌ Koi project nahi mila!");

        let kb = { inline_keyboard: [] };
        projects.forEach(p => {
            kb.inline_keyboard.push([{ text: `📦 ${p.name}`, callback_data: `genbackup_${p.name}` }]);
        });
        kb.inline_keyboard.push([{ text: '⬅️ Back to Menu', callback_data: 'menu_home' }]);

        bot.sendMessage(ADMIN_CHAT_ID, "🌐 <b>Your Railway Projects</b>\n\nClick on any project to generate a live backup ZIP:", { parse_mode: 'HTML', reply_markup: kb });
    }

    // 2. TRIGGER INSTANT BACKUP
    else if (data.startsWith('genbackup_')) {
        const projName = data.replace('genbackup_', '');
        bot.answerCallbackQuery(query.id, { text: `${projName} backup started!`, show_alert: false });
        
        let status = await bot.sendMessage(ADMIN_CHAT_ID, `⚙️ Processing backup for <b>${projName}</b>...`, { parse_mode: 'HTML' });
        await generateAndSendBackup(projName, ADMIN_CHAT_ID);
        try { await bot.deleteMessage(ADMIN_CHAT_ID, status.message_id); } catch(e) {}
    }

    // 3. AUTO BACKUP CONFIG MENU
    else if (data === 'menu_autobackup') {
        const loadingId = await playLoading("Loading Configuration");
        const projects = await fetchRailwayProjects();
        try { await bot.deleteMessage(ADMIN_CHAT_ID, loadingId); } catch(e) {}

        let doc = await configCol.findOne({ _id: 'autoList' });
        let selected = doc ? doc.projects : [];

        let kb = { inline_keyboard: [] };
        projects.forEach(p => {
            const isSelected = selected.includes(p.name);
            kb.inline_keyboard.push([{ text: `${isSelected ? '✅' : '❌'} ${p.name} ${isSelected ? '(Selected)' : ''}`, callback_data: `toggle_${p.name}` }]);
        });
        kb.inline_keyboard.push([{ text: '💾 Confirm & Save', callback_data: 'save_autobackup' }]);
        kb.inline_keyboard.push([{ text: '⬅️ Back to Menu', callback_data: 'menu_home' }]);

        bot.sendMessage(ADMIN_CHAT_ID, "⏰ <b>Auto Backup Setup (12 AM & 12 PM)</b>\n\nTap to select/deselect projects, then click Confirm:", { parse_mode: 'HTML', reply_markup: kb });
    }

    // 4. TOGGLE AUTO BACKUP SELECTION
    else if (data.startsWith('toggle_')) {
        const projName = data.replace('toggle_', '');
        let doc = await configCol.findOne({ _id: 'autoList' });
        let selected = doc ? doc.projects : [];

        if (selected.includes(projName)) {
            selected = selected.filter(name => name !== projName); 
        } else {
            selected.push(projName); 
        }
        await configCol.replaceOne({ _id: 'autoList' }, { _id: 'autoList', projects: selected }, { upsert: true });

        const projects = await fetchRailwayProjects();
        let kb = { inline_keyboard: [] };
        projects.forEach(p => {
            const isSelected = selected.includes(p.name);
            kb.inline_keyboard.push([{ text: `${isSelected ? '✅' : '❌'} ${p.name} ${isSelected ? '(Selected)' : ''}`, callback_data: `toggle_${p.name}` }]);
        });
        kb.inline_keyboard.push([{ text: '💾 Confirm & Save', callback_data: 'save_autobackup' }]);
        kb.inline_keyboard.push([{ text: '⬅️ Back to Menu', callback_data: 'menu_home' }]);

        bot.editMessageReplyMarkup(kb, { chat_id: ADMIN_CHAT_ID, message_id: msgId });
    }

    // 5. SAVE AUTO BACKUP
    else if (data === 'save_autobackup') {
        let doc = await configCol.findOne({ _id: 'autoList' });
        let count = doc ? doc.projects.length : 0;
        bot.editMessageText(`✅ <b>Auto Backup Saved!</b>\n\nDaily 12 AM and 12 PM par in ${count} projects ka backup automatically generate hoga.`, { chat_id: ADMIN_CHAT_ID, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'menu_home' }]] } });
    }

    // 6. BACK TO HOME
    else if (data === 'menu_home') {
        const welcomeMsg = `⚡️ <b>𝗪𝗘𝗟𝗖𝗢𝗠𝗘 𝗦𝗣𝗔𝗗𝗘 𝗜𝗡 𝗬𝗢𝗨𝗥 𝗕𝗔𝗖𝗞𝗨𝗣 𝗕𝗢𝗧</b> ⚡️\n\n` +
                           `👨‍💻 Master, aapka centralized backup system ready hai.\n` +
                           `Railway API + GitHub Repo + MongoDB Auto-Sync Active! ✅\n\n` +
                           `👇 <i>Select an option below to proceed:</i>`;
        const kb = { inline_keyboard: [[{ text: '🔄 Fetch Projects', callback_data: 'menu_fetch' }], [{ text: '⏰ Set Auto Backup', callback_data: 'menu_autobackup' }]] };
        bot.editMessageText(welcomeMsg, { chat_id: ADMIN_CHAT_ID, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
    }
});

// ==========================================
// CRON JOB (DAILY 12 AM & 12 PM)
// ==========================================
cron.schedule('0 0,12 * * *', async () => {
    let doc = await configCol.findOne({ _id: 'autoList' });
    if (!doc || !doc.projects || doc.projects.length === 0) return;

    bot.sendMessage(ADMIN_CHAT_ID, `⏰ <b>Scheduled Auto Backup Started!</b>\nGenerating backups for ${doc.projects.length} projects...`, { parse_mode: 'HTML' });

    for (const projName of doc.projects) {
        await generateAndSendBackup(projName, ADMIN_CHAT_ID);
        await delay(2000); 
    }
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});

console.log("✅ Backup Bot Instance Running");
