FROM node:20-alpine

WORKDIR /usr/src/app

# Instalar dependencias primero (mejor cacheo de capas)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copiar el código fuente
COPY . .

EXPOSE 3000

CMD ["npm", "start"]