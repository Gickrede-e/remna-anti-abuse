FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache python3 make g++
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /data && chown -R node:node /data
USER node
ENV DB_PATH=/data/anti-abuse.sqlite
EXPOSE 3088
CMD ["node", "dist/main.js"]
