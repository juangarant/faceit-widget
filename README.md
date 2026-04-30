# Faceit + CS2 Premier OBS Widget

Widget para OBS / Streamlabs que muestra en tiempo real:
- Nivel y ELO de Faceit (CS2)
- ELO de CS2 Premier (matchmaking oficial de Valve)
- Wins / Losses del día y delta de ELO de la sesión
- Reset diario automático a las 6:00 AM

## Requisitos previos

- Docker y Docker Compose instalados
- Una cuenta de Faceit con CS2 jugado
- Una cuenta de Steam **secundaria** con CS2 activado (recomendado, no uses la principal)
- API key de Faceit gratuita

## Instalación

### 1. Clona el repo

```bash
git clone https://github.com/TU_USUARIO/faceit-widget.git
cd faceit-widget
```

### 2. Saca tu API key de Faceit

1. Ve a https://developers.faceit.com
2. Crea una nueva app
3. Genera una **Server-side API Key**
4. Cópiala

### 3. Saca tu SteamID64

1. Abre tu perfil de Steam en el navegador
2. Pega la URL en https://steamid.io
3. Copia el campo `steamID64` (un número largo que empieza por `7656`)

### 4. Configura las variables

```bash
cp .env.example .env
nano .env
```

Rellena todos los campos con tus datos.

### 5. Arranca el contenedor

```bash
docker compose up -d
```

La primera vez puede tardar un par de minutos en conectar con Steam. Mira los logs:

```bash
docker compose logs -f
```

Deberías ver:
```
📡 Servidor activo en puerto 3000
🟢 [Steam] Bot conectado.
🎮 [CS2] Conectado al GC. Sincronizando datos...
```

### 6. Añadelo a OBS

- Fuente nueva → **Navegador**
- URL: `http://IP_DE_TU_MAQUINA:3000`
- Anchura: 400, Altura: 100 (ajusta a tu gusto)

## Steam Guard

La primera vez que arranque, Steam puede mandar un código a tu email. Coge el código y reinicia el contenedor con esa variable temporal:

```bash
STEAM_GUARD_CODE=ABCDE docker compose up -d --force-recreate
```

Cuando ya esté logueado, `steam-user` guarda un refresh token en `./data/refresh_token.txt` y no te lo volverá a pedir.

## Personalización

El widget está en `public/`. Si quieres editar estilos:

```yaml
# Añade este volumen a docker-compose.yml para editar en caliente:
volumes:
  - ./data:/usr/src/app/data
  - ./public:/usr/src/app/public
```

## Licencia

MIT — ver [LICENSE](LICENSE).