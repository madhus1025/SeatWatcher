FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source
COPY server.js ./
COPY storage.js ./
COPY public ./public

# Azure App Service default port is 8080
ENV PORT=8080
ENV HEADLESS=1
ENV CHECK_INTERVAL=15
EXPOSE 8080

# Persist watches to a writable dir. Mount an Azure Files share here for durability.
ENV DATA_FILE=/app/data/watches.json
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app

USER pwuser
CMD ["node", "server.js"]
