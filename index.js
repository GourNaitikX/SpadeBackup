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
            
            const dbRes = await axios.get(dbUrl, { timeout: 30000 }); // 30 seconds timeout
            
            // Create Database folder and save as data.json
            if (dbRes.data && Object.keys(dbRes.data).length > 0) {
                const dbFolder = path.join(tempDir, 'Database');
                fs.mkdirSync(dbFolder, { recursive: true });
                fs.writeFileSync(path.join(dbFolder, 'data.json'), JSON.stringify(dbRes.data, null, 2));
                dbStatus = "✅ DB Included Successfully";
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
// BOT LOGIC
// ==========================================
bot.onText(/\/start/, (msg) => {
    if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const kb = { 
        inline_keyboard: [
            [{ text: '🔄 Fetch Projects', callback_data: 'fetch' }], 
            [{ text: '⏰ Auto Backup', callback_data: 'auto' }]
        ] 
    };
    bot.sendMessage(msg.chat.id, "⚡️ <b>SPADE BACKUP BOT ACTIVE</b>\n\nSelect an option below:", { parse_mode: 'HTML', reply_markup: kb });
});

bot.on('callback_query', async (q) => {
    if (q.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const data = q.data;
    
    if (data === 'fetch') {
        const projects = await fetchRailwayProjects();
        const kb = { inline_keyboard: projects.map(p => [{ text: `📦 ${p.name}`, callback_data: `run_${p.name}` }]) };
        bot.sendMessage(q.message.chat.id, "Select project to backup:", { reply_markup: kb });
    } else if (data.startsWith('run_')) {
        const projName = data.replace('run_', '');
        bot.sendMessage(q.message.chat.id, `⚙️ Generating backup for <b>${projName}</b>...`, { parse_mode: 'HTML' });
        generateAndSendBackup(projName, q.message.chat.id);
    }
});

// ==========================================
// CRON JOB
// ==========================================
cron.schedule('0 0,12 * * *', async () => {
    let doc = await configCol.findOne({ _id: 'autoList' });
    if (doc && doc.projects) {
        bot.sendMessage(ADMIN_CHAT_ID, `⏰ <b>Scheduled Auto Backup Started!</b>`, { parse_mode: 'HTML' });
        doc.projects.forEach(p => generateAndSendBackup(p, ADMIN_CHAT_ID));
    }
}, { timezone: "Asia/Kolkata" });
