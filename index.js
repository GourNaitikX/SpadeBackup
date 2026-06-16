const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const cron = require('node-cron');
const express = require('express');

// ==========================================
// DUMMY WEB SERVER
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Spade Master Backup Bot is alive.'));
app.listen(PORT, () => console.log(`✅ Web Server running on port ${PORT}`));

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URL = process.env.MONGO_URL;
const GITHUB_API = process.env.GITHUB_API;
const RAILWAY_API = process.env.RAILWAY_API;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN || !MONGO_URL || !GITHUB_API || !RAILWAY_API || !ADMIN_CHAT_ID) {
    console.error("❌ CRITICAL ERROR: Missing Environment Variables!");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: { drop_pending_updates: true, timeout: 30 } 
});

// ==========================================
// ERROR HANDLING
// ==========================================
bot.on('polling_error', (err) => console.log(`[Polling Error]: ${err.message}`));
process.on('uncaughtException', (err) => console.log(`[Fatal Error]: ${err.message}`));

// ==========================================
// MONGODB SETUP
// ==========================================
const client = new MongoClient(MONGO_URL);
let configCol;

async function initDB() {
    try {
        await client.connect();
        const db = client.db('SpadeBackupDB');
        configCol = db.collection('auto_backup_settings');
        console.log("✅ Master MongoDB Connected Successfully!");
    } catch (err) {
        console.error("❌ MongoDB Error:", err.message);
    }
}
initDB();

// ==========================================
// BACKUP FUNCTIONS
// ==========================================
async function fetchRailwayProjects() {
    const query = `query { projects { edges { node { id name } } } }`;
    try {
        const response = await axios.post('https://backboard.railway.app/graphql/v2', { query }, {
            headers: { 'Authorization': `Bearer ${RAILWAY_API}`, 'Content-Type': 'application/json' }
        });
        return response.data.data.projects.edges.map(e => e.node).filter(p => !p.name.toLowerCase().includes('backup'));
    } catch (e) { return []; }
}

async function generateAndSendBackup(projName, chatId) {
    const tempDir = path.join(__dirname, 'temp_' + projName);
    const zipPath = path.join(__dirname, projName + '.zip');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    let dbStatus = "❌ DB Skipped/Failed";

    try {
        // 1. GitHub Fetch
        const headers = { 'Authorization': `token ${GITHUB_API}` };
        const { data: files } = await axios.get(`https://api.github.com/repos/GourNaitikX/${projName}/contents/`, { headers });
        for (const file of files) {
            if (['index.js', 'package.json', 'backup.js'].includes(file.name)) {
                try {
                    const content = await axios.get(file.download_url);
                    fs.writeFileSync(path.join(tempDir, file.name), typeof content.data === 'object' ? JSON.stringify(content.data, null, 2) : content.data);
                } catch(e) {}
            }
        }

        // 2. Database Fetch via Target Bot API
        try {
            const formattedDomainName = projName.toLowerCase().replace(/[^a-z0-9-]/g, '');
            const dbUrl = `https://${formattedDomainName}.up.railway.app/get-data?key=Spadebotbackup`;
            
            const dbRes = await axios.get(dbUrl, { timeout: 30000 }); 
            
            if (dbRes.data && Object.keys(dbRes.data).length > 0) {
                const dbFolder = path.join(tempDir, 'Database');
                fs.mkdirSync(dbFolder, { recursive: true });

                for (const [collectionName, content] of Object.entries(dbRes.data)) {
                    const fileName = `${collectionName}.json`;
                    fs.writeFileSync(path.join(dbFolder, fileName), JSON.stringify(content, null, 2));
                }
                
                dbStatus = "✅ DB Included (Splitted)";
            }

        } catch (e) {
            console.log(`Database fetch failed for ${projName}:`, e.message);
        }

        // 3. Zip Process
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(tempDir, false);
            archive.finalize();
        });

        // 4. Send File
        const caption = `📦 <b>Project:</b> ${projName}\n📅 <b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n🗄️ <b>Status:</b> ${dbStatus}\n\n✅ <i>Backup Generated!</i>`;
        await bot.sendDocument(chatId, zipPath, { caption: caption, parse_mode: 'HTML' });

    } catch (e) {
        bot.sendMessage(chatId, `❌ Backup Error for ${projName}: ${e.message}`);
    } finally {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    }
}

// ==========================================
// AUTO BACKUP MENU HELPERS
// ==========================================
async function showAutoBackupMenu(chatId, messageId = null) {
    const projects = await fetchRailwayProjects();
    let doc = await configCol.findOne({ _id: 'autoList' });
    let autoProjects = doc && doc.projects ? doc.projects : [];

    const kb = { inline_keyboard: [] };

    projects.forEach(p => {
        const isAuto = autoProjects.includes(p.name);
        const statusIcon = isAuto ? '✅' : '❌';
        kb.inline_keyboard.push([{
            text: `${statusIcon} ${p.name}`,
            callback_data: `toggle_auto_${p.name}`
        }]);
    });

    // Add a back button
    kb.inline_keyboard.push([{ text: '🔙 Back to Main Menu', callback_data: 'main_menu' }]);

    const text = "⏰ <b>Auto Backup Settings</b>\n\nSet your projects to backup automatically everyday at <b>12:00 AM</b> and <b>12:00 PM</b>.\n\nClick on a project to Enable (✅) or Disable (❌):";

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb });
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
}

async function toggleAutoBackup(projName) {
    let doc = await configCol.findOne({ _id: 'autoList' });
    let projects = doc && doc.projects ? doc.projects : [];

    if (projects.includes(projName)) {
        projects = projects.filter(p => p !== projName); // Remove from list
    } else {
        projects.push(projName); // Add to list
    }

    await configCol.updateOne(
        { _id: 'autoList' },
        { $set: { projects: projects } },
        { upsert: true }
    );
}

// ==========================================
// BOT LOGIC
// ==========================================
function sendMainMenu(chatId, messageId = null) {
    const kb = { 
        inline_keyboard: [
            [{ text: '🔄 Fetch Projects (Manual)', callback_data: 'fetch' }], 
            [{ text: '⏰ Auto Backup Settings', callback_data: 'auto' }]
        ] 
    };
    const text = "⚡️ <b>SPADE BACKUP BOT ACTIVE</b>\n\nSelect an option below:";
    
    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb });
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
}

bot.onText(/\/start/, (msg) => {
    if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;
    sendMainMenu(msg.chat.id);
});

bot.on('callback_query', async (q) => {
    if (q.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const data = q.data;
    
    if (data === 'main_menu') {
        sendMainMenu(q.message.chat.id, q.message.message_id);
    } 
    else if (data === 'fetch') {
        bot.sendMessage(q.message.chat.id, "⏳ Fetching projects...");
        const projects = await fetchRailwayProjects();
        const kb = { inline_keyboard: projects.map(p => [{ text: `📦 ${p.name}`, callback_data: `run_${p.name}` }]) };
        kb.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
        bot.editMessageText("Select project to backup manually:", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: kb });
    } 
    else if (data.startsWith('run_')) {
        const projName = data.replace('run_', '');
        bot.sendMessage(q.message.chat.id, `⚙️ Generating manual backup for <b>${projName}</b>...`, { parse_mode: 'HTML' });
        generateAndSendBackup(projName, q.message.chat.id);
    } 
    // Yahan Auto Backup ke button handle ho rahe hain
    else if (data === 'auto') {
        await showAutoBackupMenu(q.message.chat.id, q.message.message_id);
    } 
    else if (data.startsWith('toggle_auto_')) {
        const projName = data.replace('toggle_auto_', '');
        await toggleAutoBackup(projName);
        await showAutoBackupMenu(q.message.chat.id, q.message.message_id); // Refresh menu to show tick/cross
    }
});

// ==========================================
// CRON JOB (12 AM and 12 PM Everyday)
// ==========================================
cron.schedule('0 0,12 * * *', async () => {
    let doc = await configCol.findOne({ _id: 'autoList' });
    if (doc && doc.projects && doc.projects.length > 0) {
        bot.sendMessage(ADMIN_CHAT_ID, `⏰ <b>Scheduled Auto Backup Started!</b>\nTriggering for ${doc.projects.length} projects...`, { parse_mode: 'HTML' });
        doc.projects.forEach(p => generateAndSendBackup(p, ADMIN_CHAT_ID));
    }
}, { timezone: "Asia/Kolkata" });
