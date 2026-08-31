# OmniCrawl Enterprise Production Dockerfile
# Uses official Microsoft Playwright image with all Chromium dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Set working directory
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Install dependencies first for efficient caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose server port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
