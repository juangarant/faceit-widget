let currentData = { 
    f_level: null, f_elo: null, f_session: null, f_wins: null, f_losses: null,
    p_elo: null, p_session: null, p_wins: null, p_losses: null
};

function renderData(data) {
    if (!data.faceit || !data.premier) return;

    const updateWithAnimation = (id, newValue, key) => {
        const el = document.getElementById(id);
        if (!el) return;

        if (currentData[key] !== newValue) {
            el.classList.remove('animate-roll');
            void el.offsetWidth; 
            
            el.innerText = newValue;
            el.classList.add('animate-roll');
            
            currentData[key] = newValue;
        }
    };

    // Actualizar Faceit
    updateWithAnimation('val-f-level', data.faceit.level, 'f_level');
    updateWithAnimation('val-f-elo', data.faceit.elo, 'f_elo');
    updateWithAnimation('val-f-wins', data.faceit.wins, 'f_wins');
    updateWithAnimation('val-f-losses', data.faceit.losses, 'f_losses');
    updateWithAnimation('val-f-session', data.faceit.sessionElo, 'f_session');
    
    // Actualizar Premier
    updateWithAnimation('val-p-elo', data.premier.elo, 'p_elo');
    updateWithAnimation('val-p-wins', data.premier.wins, 'p_wins');
    updateWithAnimation('val-p-losses', data.premier.losses, 'p_losses');
    updateWithAnimation('val-p-session', data.premier.sessionElo, 'p_session');
    
    // Función para los colores del ELO de sesión (verde/rojo)
    const colorizeSession = (id, value) => {
        const el = document.getElementById(id);
        if (el) {
            if (value && value.toString().startsWith('+')) {
                el.style.color = '#39FF14'; 
            } else if (value && value.toString().startsWith('-')) {
                el.style.color = '#ff3333'; 
            } else {
                el.style.color = '#ffffff'; 
            }
        }
    };

    colorizeSession('val-f-session', data.faceit.sessionElo);
    colorizeSession('val-p-session', data.premier.sessionElo);
}

async function updateStats() {
    try {
        const response = await fetch('/api/stats?t=' + new Date().getTime(), {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
        });

        if (!response.ok) throw new Error('Error al leer del servidor');
        const data = await response.json();

        localStorage.setItem('lastStatsData', JSON.stringify(data));
        renderData(data);

        // Efecto del guion parpadeante al actualizar
        const blinker = document.querySelector('.blink');
        if (blinker) {
            blinker.style.textShadow = '0 0 15px #39FF14';
            setTimeout(() => { blinker.style.textShadow = 'none'; }, 200);
        }

    } catch (error) {
        console.error("Fallo de conexión con la Raspberry:", error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const cached = localStorage.getItem('lastStatsData');
    if (cached) {
        try {
            const parsedCache = JSON.parse(cached);
            renderData(parsedCache);
        } catch (e) {
            console.error("Cache inválida");
        }
    }
    updateStats();
});

setInterval(updateStats, 3000);
