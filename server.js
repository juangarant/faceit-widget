const express = require('express');
const path = require('path');
const fs = require('fs');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');

const app = express();
const port = process.env.PORT || 3000;
const API_KEY = process.env.FACEIT_API_KEY;
const NICKNAME = process.env.FACEIT_NICKNAME;

const REQUIRED_ENV = ['FACEIT_API_KEY', 'FACEIT_NICKNAME', 'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_ID64'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`❌ Faltan variables de entorno: ${missing.join(', ')}`);
    console.error('   Copia .env.example a .env y rellénalo.');
    process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE = path.join(DATA_DIR, 'memoria_elo.json');
const TOKEN_FILE = path.join(DATA_DIR, 'refresh_token.txt');

const client = new SteamUser();
const csgo = new GlobalOffensive(client);

let player_id = null;
let cachedStats = { 
    faceit: { level: "-", elo: "-", sessionElo: "+0", wins: 0, losses: 0 },
    premier: { elo: "-", sessionElo: "+0", wins: 0, losses: 0 }
};

app.use(express.json()); 
app.use(express.static(path.join(__dirname, 'public')));

let token = null;
if (fs.existsSync(TOKEN_FILE)) {
    token = fs.readFileSync(TOKEN_FILE, 'utf8');
}

client.logOn(token ? { refreshToken: token } : {
    accountName: process.env.STEAM_USERNAME,
    password: process.env.STEAM_PASSWORD
});

client.on('loggedOn', () => {
    console.log("🟢 [Steam] Bot conectado.");
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([730]); 
});

client.on('refreshToken', (newToken) => {
    try { fs.writeFileSync(TOKEN_FILE, newToken); } catch (err) {}
});

client.on('steamGuard', (domain, callback) => {
    if (process.env.STEAM_GUARD_CODE) callback(process.env.STEAM_GUARD_CODE);
});

csgo.on('connectedToGC', () => {
    console.log("🎮 [CS2] Conectado al GC. Sincronizando datos...");
    setTimeout(verificarCambioDeDia, 4000);
    setTimeout(updateCurrentStats, 6000); 
});

function fetchPremierData() {
    return new Promise((resolve) => {
        if (!csgo.haveGCSession) return resolve({ elo: "-", wins: 0 });
        const timeoutId = setTimeout(() => resolve({ elo: "-", wins: 0 }), 8000); 
        csgo.requestPlayersProfile(process.env.STEAM_ID64, (profile) => {
            clearTimeout(timeoutId); 
            if (profile && profile.rankings) {
                const pData = profile.rankings.find(r => r.rank_type_id === 11);
                if (pData && pData.rank_id) resolve({ elo: pData.rank_id, wins: pData.wins || 0 });
                else resolve({ elo: "-", wins: 0 });
            } else resolve({ elo: "-", wins: 0 });
        });
    });
}

async function fetchOfficial(endpoint) {
    const res = await fetch(`https://open.faceit.com/data/v4/${endpoint}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return await res.json();
}

function getStreamerDate(dateObj) {
    const shiftedTime = new Date(dateObj.getTime() - (6 * 60 * 60 * 1000));
    return new Intl.DateTimeFormat('es-ES', { 
        timeZone: 'Europe/Madrid', 
        year: 'numeric', month: '2-digit', day: '2-digit' 
    }).format(shiftedTime); 
}

// --- LÓGICA DE MEMORIA AISLADA (SOLO A LAS 6:00 AM) ---
async function verificarCambioDeDia() {
    const todayStrLocal = getStreamerDate(new Date());
    let savedData = { date: "", faceitElo: "-", premierElo: "-", premierWins: 0 };
    
    if (fs.existsSync(DATA_FILE)) {
        try { savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
    }

    if (savedData.date !== todayStrLocal) {
        console.log("📸 [Memoria] Cruzando las 6:00 AM. Tomando foto base...");
        
        let fctElo = savedData.faceitElo !== "-" ? savedData.faceitElo : 0;
        try {
            if (!player_id) {
                const pData = await fetchOfficial(`players?nickname=${NICKNAME}`);
                player_id = pData.player_id;
            }
            const info = await fetchOfficial(`players/${player_id}`);
            fctElo = info.games.cs2.faceit_elo;
        } catch(e) {}

        let prmElo = savedData.premierElo;
        let prmWins = savedData.premierWins;
        try {
            const pData = await fetchPremierData();
            if (pData.elo !== "-") {
                prmElo = pData.elo;
                prmWins = pData.wins;
            }
        } catch(e) {}

        const newData = { date: todayStrLocal, faceitElo: fctElo, premierElo: prmElo, premierWins: prmWins };
        fs.writeFileSync(DATA_FILE, JSON.stringify(newData));
    } else {
        // Parche: Si a las 6 AM Valve estaba caído, guarda la foto en cuanto recupere conexión
        if ((savedData.premierElo === "-" || savedData.premierElo === undefined) && csgo.haveGCSession) {
            const pData = await fetchPremierData();
            if (pData.elo !== "-") {
                savedData.premierElo = pData.elo;
                savedData.premierWins = pData.wins;
                fs.writeFileSync(DATA_FILE, JSON.stringify(savedData));
            }
        }
    }
}

// --- EL CALCULADOR (SOLO LEE, NUNCA SOBREESCRIBE LA BASE) ---
// --- EL CALCULADOR (SOLO LEE, NUNCA SOBREESCRIBE LA BASE) ---
async function updateCurrentStats() {
    try {
        if (!player_id) {
            const pData = await fetchOfficial(`players?nickname=${NICKNAME}`);
            player_id = pData.player_id;
        }

        const info = await fetchOfficial(`players/${player_id}`);
        const currentEloFaceit = info.games.cs2.faceit_elo;
        const currentLevelFaceit = info.games.cs2.skill_level;
        
        const premierData = await fetchPremierData();
        const todayStrLocal = getStreamerDate(new Date());

        let baseline = { 
            date: todayStrLocal, 
            faceitElo: currentEloFaceit, 
            premierElo: premierData.elo, 
            lastPremierElo: premierData.elo, // Memoria a corto plazo
            dailyPremierWins: 0,
            dailyPremierLosses: 0
        }; 

        let fileData = {};
        if (fs.existsSync(DATA_FILE)) {
            try { 
                fileData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); 
                if (fileData.date === todayStrLocal) {
                    baseline.faceitElo = fileData.faceitElo || fileData.elo || currentEloFaceit;
                    baseline.premierElo = fileData.premierElo !== undefined ? fileData.premierElo : premierData.elo;
                    // Recuperamos el último ELO visto
                    baseline.lastPremierElo = fileData.lastPremierElo !== undefined ? fileData.lastPremierElo : baseline.premierElo;
                    // Recuperamos los contadores DIARIOS (ignorando el historial total de Valve)
                    baseline.dailyPremierWins = fileData.dailyPremierWins || 0;
                    baseline.dailyPremierLosses = fileData.dailyPremierLosses || 0;
                }
            } catch(e) {}
        }
        
        // --- NUEVA LÓGICA DE PREMIER (W/L POR ELO) ---
        let memoryUpdated = false;
        if (baseline.lastPremierElo !== "-" && premierData.elo !== "-") {
            if (premierData.elo > baseline.lastPremierElo) {
                baseline.dailyPremierWins++;
                baseline.lastPremierElo = premierData.elo;
                memoryUpdated = true;
            } else if (premierData.elo < baseline.lastPremierElo) {
                baseline.dailyPremierLosses++;
                baseline.lastPremierElo = premierData.elo;
                memoryUpdated = true;
            }
        }

        // Guardamos los datos nuevos en el archivo sin borrar lo que puso la función de las 6:00 AM
        if (memoryUpdated || fileData.lastPremierElo === undefined) {
            fileData.lastPremierElo = baseline.lastPremierElo;
            fileData.dailyPremierWins = baseline.dailyPremierWins;
            fileData.dailyPremierLosses = baseline.dailyPremierLosses;
            fs.writeFileSync(DATA_FILE, JSON.stringify(fileData));
        }

        // --- LÓGICA DE FACEIT (INTACTA: POR HISTORIAL) ---
        const history = await fetchOfficial(`players/${player_id}/history?game=cs2&limit=50`);
        let fWins = 0, fLosses = 0;

        if (history.items) {
            history.items.filter(m => m.status !== 'CANCELLED' && getStreamerDate(new Date(m.started_at * 1000)) === todayStrLocal)
                .forEach(match => {
                    const playerFaction = match.teams.faction1.players.some(p => p.player_id === player_id) ? 'faction1' : 'faction2';
                    if (match.results?.winner === playerFaction) fWins++; else fLosses++;
                });
        }

        const fDelta = currentEloFaceit - baseline.faceitElo;
        
        let pDelta = 0;
        if (premierData.elo !== "-" && baseline.premierElo !== "-") {
            pDelta = premierData.elo - baseline.premierElo;
        }

        cachedStats = { 
            faceit: {
                level: currentLevelFaceit, 
                elo: currentEloFaceit, 
                sessionElo: fDelta >= 0 ? `+${fDelta}` : fDelta.toString(), 
                wins: fWins, 
                losses: fLosses
            },
            premier: {
                elo: premierData.elo,
                sessionElo: pDelta >= 0 ? `+${pDelta}` : pDelta.toString(),
                wins: baseline.dailyPremierWins,
                losses: baseline.dailyPremierLosses
            }
        };
        
        console.log(`🧮 FCT: ${currentEloFaceit} (${cachedStats.faceit.sessionElo}) [W:${cachedStats.faceit.wins}/L:${cachedStats.faceit.losses}] | PRM: ${premierData.elo} (${cachedStats.premier.sessionElo}) [W:${cachedStats.premier.wins}/L:${cachedStats.premier.losses}]`);
    } catch (error) {
        console.error("❌ Error en el Calculador:", error.message);
    }
}

app.post('/webhook', (req, res) => {
    res.sendStatus(200);
    setTimeout(updateCurrentStats, 20000);
});

app.get('/api/stats', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache');
    res.json(cachedStats);
});

// El vigilante de las 6:00 AM (revisa la hora cada minuto)
setInterval(verificarCambioDeDia, 60000);

// Actualización regular de datos (cada 5 min)
setInterval(() => {
    if (csgo.haveGCSession) updateCurrentStats();
}, 60000);

app.listen(port, async () => {
    console.log(`📡 Servidor activo en puerto ${port}`);
    await verificarCambioDeDia();
    await updateCurrentStats();
});
