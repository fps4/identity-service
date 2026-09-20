# One-off SEEDER image for a seed or migration run against a compose stack (RQ-0004 follow-up; it served
# the seed-ds1 and migrate-*-ds1 workflows, retired with the ds1 deploy — maestro ADR-0017). The
# production service image is dist-only and cannot run the seeder (no tsx/scripts/config), so this image
# carries the source + dev deps + the seed YAML and runs `npm run seed` against the table on the compose
# network (DynamoDB Local; ADR-0023).
#
# Build context is the REPO ROOT (it needs both service/ and config/); the root .dockerignore keeps the
# context small. Run it with SEED_FILE=/config/<file>, TABLE_NAME, DYNAMODB_ENDPOINT=http://dynamodb:8000
# and the ${SEED_*} secrets.
FROM node:current-alpine
WORKDIR /app

# Install deps first for layer caching.
COPY service/package*.json ./
RUN npm install

# Source (scripts/, src/) + the seed definitions (copied to /config so SEED_FILE=/config/<file> resolves).
COPY service/ ./
COPY config/ /config/

CMD ["npm", "run", "seed"]
