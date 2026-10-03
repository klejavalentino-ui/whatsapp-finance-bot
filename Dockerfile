FROM node:22-alpine

WORKDIR /app

# Instalar dependencias
COPY package*.json tsconfig.json ./
RUN npm install --omit=dev

# Copiar código fuente
COPY src ./src

# Crear directorios para persistencia de sesión y credenciales
RUN mkdir -p /app/auth_session /app/credentials

VOLUME ["/app/auth_session", "/app/credentials"]

CMD ["npm", "start"]
