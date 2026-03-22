# ── Stage 1: Build ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (layer caching — only reinstalls on package.json change)
COPY package*.json ./
RUN npm ci --include=dev

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Production ─────────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Copy config files needed at runtime
COPY .sequelizerc   ./
COPY .sequelizerc.js ./

# Copy migrations and seeders (needed for db:migrate at startup)
COPY src/migrations ./src/migrations
COPY src/seeders    ./src/seeders

# Create logs directory
RUN mkdir -p logs

# Entrypoint: run migrations then start server
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
