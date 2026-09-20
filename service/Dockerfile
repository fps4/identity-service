FROM node:current-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The tests run against DynamoDB Local (tests/helpers/store.ts), which an image build has no network to;
# the DoD gate runs them (.github/workflows/dod.yml). The build is the type check.
RUN npm run build && npm prune --production

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
EXPOSE 7305
CMD ["node", "dist/server.js"]
