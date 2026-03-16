FROM ghcr.io/puppeteer/puppeteer:22.8.0

# L'image Puppeteer utilise l'utilisateur non-root \"pptruser\"
USER root

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

# Copier les fichiers de dépendances et corriger les permissions
COPY package*.json ./
RUN chown -R pptruser:pptruser /app

USER pptruser
RUN npm install --omit=dev

USER root
# Copier le reste du code et corriger les permissions
COPY . .
RUN chown -R pptruser:pptruser /app

USER pptruser

# Par défaut : lancer l'API / bot Telegram + backoffice
# (Sur Railway, pour le service WhatsApp, on surchargera simplement la commande de démarrage en \"node whatsapp.js\")
CMD [\"node\", \"index.js\"]

