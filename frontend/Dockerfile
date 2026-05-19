# ==============================================================================
# BHSPL SCM ERP - Frontend Production Dockerfile (Multi-stage)
# ==============================================================================

# --- Stage 1: Build the static assets ---
FROM node:20-alpine as builder

WORKDIR /app

# Copy dependency definition files
COPY package.json package-lock.json ./

# Install npm dependencies
RUN npm ci

# Copy frontend source code
COPY . .

# Set dynamic API Base URL build arg (defaults to /api/v1 for reverse proxy routing)
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Build the production code
RUN npm run build

# --- Stage 2: Serve with lightweight Nginx web server ---
FROM nginx:1.25-alpine

# Remove default nginx static assets
RUN rm -rf /usr/share/nginx/html/*

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom Nginx configuration template (mounted dynamically or built-in)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 (HTTP)
EXPOSE 80

# Healthcheck to verify Nginx is healthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
