FROM node:20-alpine

# Install Chrome/Chromium (required for puppeteer-core)
RUN apk add --no-cache chromium

# Set working directory
WORKDIR /app

# Copy source files
COPY . .

# Install dependencies
RUN npm ci

# Build TypeScript
RUN npm run build

# Start the MCP server
CMD ["node", "dist/index.js"]
