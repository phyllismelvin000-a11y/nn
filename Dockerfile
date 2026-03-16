FROM ghcr.io/puppeteer/puppeteer:22.8.0

# Répertoire de travail dans le conteneur
WORKDIR /app

# Éviter de retélécharger Chrome (l'image Puppeteer en a déjà un)
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

# Copier les fichiers de dépendances et installer
COPY package*.json ./
RUN npm install --omit=dev

# Copier le reste du code
COPY . .

# Par défaut : lancer l'API / bot Telegram + backoffice
# (Sur Railway, pour le service WhatsApp, on surchargera simplement la commande de démarrage en \"node whatsapp.js\")
CMD [\"node\", \"index.js\"]

