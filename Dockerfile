# Build + run the zipmem-mcp MCP server (stdio) from source.
# Used by Glama's automated build/introspection pipeline; not shipped to npm
# (package.json#files only includes dist/, README.md, LICENSE).
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENTRYPOINT ["node", "dist/index.js"]
