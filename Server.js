const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const axios = require('axios')
const P = require('pino')
const logger = P({ level: 'silent' })
const FIREBASE_URL = "https://abdulchico-ai-default-rtdb.firebaseio.com"

async function checkBotStatus() {
    try {
        const res = await axios.get(`${FIREBASE_URL}/settings/botEnabled.json`)
        return res.data !== false // default ON
    } catch { return true }
}
async function isBlocked(number) {
    try {
        const res = await axios.get(`${FIREBASE_URL}/blocked/${number}.json`)
        return res.data === true
    } catch { return false }
}
async function logToFirebase(from, message, reply) {
    try {
        const data = {
            from: from,
            number: from.split('@')[0],
            message: message.substring(0,500),
            reply: reply.substring(0,500),
            time: new Date().toISOString(),
            timestamp: Date.now()
        }
        await axios.post(`${FIREBASE_URL}/chats.json`, data)
        await axios.put(`${FIREBASE_URL}/stats/lastChat.json`, data)
        // increment total
        const countRes = await axios.get(`${FIREBASE_URL}/stats/totalChats.json`)
        let count = (countRes.data || 0) + 1
        await axios.put(`${FIREBASE_URL}/stats/totalChats.json`, count)
    } catch(e){ console.log("FB log error", e.message) }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger, browser: ["Chico AI", "Chrome", "1.0"] })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if(shouldReconnect) startBot()
        } else if(connection === 'open') {
            console.log('✅ CHICO BOT CONNECTED WITH ADMIN CONTROL!')
        }
    })
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0]
        if(!msg.message || msg.key.fromMe) return
        const from = msg.key.remoteJid
        if(from.endsWith('@g.us')) return
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ""
        if(!text) return
        
        // CHECK IF BOT IS OFF FROM ADMIN
        const enabled = await checkBotStatus()
        if(!enabled) { console.log("Bot is OFF from Admin"); return }
        
        // CHECK IF USER BLOCKED
        if(await isBlocked(from.split('@')[0])) { console.log("Blocked user"); return }

        console.log(`[${from}]: ${text}`)
        try {
            await sock.sendPresenceUpdate('composing', from)
            
            // Get custom prompt from Admin
            let systemPrompt = "You are Chico AI for AFUST students, helpful, brief"
            try {
                const p = await axios.get(`${FIREBASE_URL}/settings/prompt.json`)
                if(p.data) systemPrompt = p.data
            } catch {}
            
            const aiRes = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(systemPrompt + ". User: " + text)}`, {timeout:25000})
            let reply = typeof aiRes.data === 'string' ? aiRes.data : JSON.stringify(aiRes.data)
            reply += "\n\n_🤖 Chico AI | aiguruabdulchico.netlify.app_"
            
            await sock.sendMessage(from, { text: reply.substring(0,4000) })
            await logToFirebase(from, text, reply)
            
        } catch(e) {
            await sock.sendMessage(from, { text: "Chico is thinking... try again! 🤖" })
        }
    })
    
    // Check for broadcast messages from Admin
    setInterval(async () => {
        try {
            const b = await axios.get(`${FIREBASE_URL}/broadcast.json`)
            if(b.data && b.data.message && b.data.active) {
                console.log("Broadcasting:", b.data.message)
                const chats = await axios.get(`${FIREBASE_URL}/chats.json`)
                if(chats.data) {
                    const numbers = [...new Set(Object.values(chats.data).map(c=>c.from))]
                    for(let num of numbers) {
                        await sock.sendMessage(num, {text: `📢 BROADCAST FROM CHICO ADMIN:\n\n${b.data.message}`})
                        await new Promise(r=>setTimeout(r,2000))
                    }
                }
                await axios.put(`${FIREBASE_URL}/broadcast.json`, {message:"", active:false})
            }
        } catch {}
    }, 10000)
}
startBot()