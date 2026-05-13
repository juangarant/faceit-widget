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

// === Red de seguridad para errores no capturados ===
process.on('uncaughtException', (err) => {
    console.error('💥 uncaughtException:', err.stack || err);
});
process.on('unhandledRejection', (err) => {
    console.error('💥 unhandledRejection:', err);
});

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

// === Watchdog: vigila la sesión GC y reinicia el proceso si se pierde demasiado tiempo ===
const PROCESS_START = Date.now();
const WATCHDOG_THRESHOLD_MIN = 10;       // minutos sin GC antes de reiniciar
const STARTUP_GRACE_MIN = 10;            // tiempo máximo para conectar al GC desde arranque
let lastGCActivity = null;               // null = nunca hemos visto el GC en esta vida del proceso

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

// === Handlers de errores y reconexión ===
client.on('error', (err) => {
    console.error('❌ [Steam] error:', err.message);
});

client.on('disconnected', (eresult, msg) => {
    console.log(`⚠️  [Steam] Desconectado (${msg}). steam-user reconectará automáticamente.`);
});

csgo.on('disconnectedFromGC', (reason) => {
    console.log(`⚠️  [CS2] Desconectado del GC (razón: ${reason}). Reintentando en 10s...`);
    setTimeout(() => {
        if (client.steamID) client.gamesPlayed([730]);
    }, 10000);
});

client.on('refreshToken', (newToken) => {
    try {
        fs.writeFileSync(TOKEN_FILE, newToken);
    } catch (err) {
        console.error('⚠️  No se pudo guardar refresh token:', err.message);
    }
});

client.on('steamGuard', (domain, callback) => {
    if (process.env.STEAM_GUARD_CODE) callback(process.env.STEAM_GUARD_CODE);
});

csgo.on('connectedToGC', () => {
    console.log("🎮 [CS2] Conectado al GC. Sincronizando datos...");
    lastGCActivity = Date.now();
    setTimeout(verificarCambioDeDia, 4000);
    setTimeout(updateCurrentStats, 6000);
});

// Cada llamada exitosa al GC también resetea el watchdog
function markGCActivity() {
    if (csgo.haveGCSession) lastGCActivity = Date.now();
}

function fetchPremierData() {
    return new Promise((resolve) => {
        if (!csgo.haveGCSession) return resolve({ elo: "-", wins: 0 });
        const timeoutId = setTimeout(() => resolve({ elo: "-", wins: 0 }), 8000);
        csgo.requestPlayersProfile(process.env.STEAM_ID64, (profile) => {
            clearTimeout(timeoutId);
            markGCActivity();
            if (profile && profile.rankings) {
                const pData = profile.rankings.find(r => r.rank_type_id === 11);
                if (pData && pData.rank_id) resolve({ elo: pData.rank_id, wins: pData.wins || 0 });
                else resolve({ elo: "-", wins: 0 });
            } else resolve({ elo: "-", wins: 0 });
        });
    });
}

// === fetchOfficial con timeout de 10s ===
async function fetchOfficial(endpoint, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`https://open.faceit.com/data/v4/${endpoint}`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function getStreamerDate(dateObj) {
    const shiftedTime = new Date(dateObj.getTime() - (6 * 60 * 60 * 1000));
    return new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(shiftedTime);
}

function safeWriteJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data));
    } catch (err) {
        console.error(`⚠️  No se pudo escribir ${path.basename(filePath)}:`, err.message);
    }
}

// --- LÓGICA DE MEMORIA AISLADA (SOLO A LAS 6:00 AM) ---
async function verificarCambioDeDia() {
    const todayStrLocal = getStreamerDate(new Date());
    let savedData = { date: "", faceitElo: "-", premierElo: "-", premierWins: 0 };

    if (fs.existsSync(DATA_FILE)) {
        try { savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
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
        } catch (e) {
            console.error('⚠️  [6AM] Error consultando Faceit:', e.message);
        }

        let prmElo = savedData.premierElo;
        let prmWins = savedData.premierWins;
        try {
            const pData = await fetchPremierData();
            if (pData.elo !== "-") {
                prmElo = pData.elo;
                prmWins = pData.wins;
            }
        } catch (e) {
            console.error('⚠️  [6AM] Error consultando Premier:', e.message);
        }

        const newData = { date: todayStrLocal, faceitElo: fctElo, premierElo: prmElo, premierWins: prmWins };
        safeWriteJson(DATA_FILE, newData);
    } else {
        if ((savedData.premierElo === "-" || savedData.premierElo === undefined) && csgo.haveGCSession) {
            const pData = await fetchPremierData();
            if (pData.elo !== "-") {
                savedData.premierElo = pData.elo;
                savedData.premierWins = pData.wins;
                safeWriteJson(DATA_FILE, savedData);
            }
        }
    }
}

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
            lastPremierElo: premierData.elo,
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
                    baseline.lastPremierElo = fileData.lastPremierElo !== undefined ? fileData.lastPremierElo : premierData.elo;
                    baseline.dailyPremierWins = fileData.dailyPremierWins || 0;
                    baseline.dailyPremierLosses = fileData.dailyPremierLosses || 0;
                }
            } catch (e) {}
        }

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

        if (memoryUpdated || (fileData.lastPremierElo === undefined && premierData.elo !== "-")) {
            fileData.lastPremierElo = baseline.lastPremierElo;
            fileData.dailyPremierWins = baseline.dailyPremierWins;
            fileData.dailyPremierLosses = baseline.dailyPremierLosses;
            safeWriteJson(DATA_FILE, fileData);
        }

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

// === Watchdog: si llevamos demasiado tiempo sin sesión GC, salimos para que Docker reinicie ===
setInterval(() => {
    const now = Date.now();
    const minutesAlive = (now - PROCESS_START) / 60000;

    // Caso 1: nunca nos hemos conectado al GC y ya llevamos mucho vivo
    if (lastGCActivity === null && minutesAlive > STARTUP_GRACE_MIN) {
        console.error(`💀 [Watchdog] ${minutesAlive.toFixed(0)} min sin lograr conectar al GC. Saliendo (Docker reiniciará).`);
        process.exit(1);
    }

    // Caso 2: ya nos conectamos pero la sesión se ha caído hace tiempo
    if (lastGCActivity !== null) {
        const minutesSinceGC = (now - lastGCActivity) / 60000;
        if (!csgo.haveGCSession && minutesSinceGC > WATCHDOG_THRESHOLD_MIN) {
            console.error(`💀 [Watchdog] ${minutesSinceGC.toFixed(0)} min sin sesión GC. Saliendo para forzar reinicio limpio.`);
            process.exit(1);
        }
    }
}, 60000);

// El vigilante de las 6:00 AM (revisa la hora cada minuto)
setInterval(verificarCambioDeDia, 60000);

// Actualización regular de datos (cada minuto si hay sesión GC)
setInterval(() => {
    if (csgo.haveGCSession) updateCurrentStats();
}, 60000);

app.listen(port, async () => {
    console.log(`📡 Servidor activo en puerto ${port}`);
    await verificarCambioDeDia();
    await updateCurrentStats();
});
