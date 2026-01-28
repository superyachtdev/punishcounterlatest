FROM node:20-slim

# Install system dependencies Playwright needs
RUN apt-get update && apt-get install -y \
  libnss3 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpangocairo-1.0-0 \
  libgtk-3-0 \
  ca-certificates \
  fonts-liberation \
  wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

# 🔥 THIS IS THE KEY LINE 🔥
RUN npx playwright install chromium

COPY . .

EXPOSE 3001
CMD ["node", "index.js"]
