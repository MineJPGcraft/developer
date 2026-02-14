FROM node:lts AS build
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
RUN corepack enable && yarn install --immutable
COPY tsconfig.json ./
COPY src ./src
COPY static ./static
RUN rm -f tsconfig.tsbuildinfo && yarn build

FROM node:lts-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CONFIG_PATH=/data/config.yaml
RUN mkdir -p /data
COPY --from=build /app/package.json /app/yarn.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/static ./static
EXPOSE 8081
CMD ["node", "dist/index.js"]
