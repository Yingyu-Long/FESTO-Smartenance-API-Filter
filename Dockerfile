FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global npm@11.6.1 && npm ci
RUN node -e "require.resolve('@rolldown/binding-linux-x64-gnu')" || npm install --no-save --no-package-lock @rolldown/binding-linux-x64-gnu@1.0.1
RUN node -e "require.resolve('@tailwindcss/oxide-linux-x64-gnu')" || npm install --no-save --no-package-lock @tailwindcss/oxide-linux-x64-gnu@4.2.1
RUN node -e "require.resolve('lightningcss-linux-x64-gnu')" || npm install --no-save --no-package-lock lightningcss-linux-x64-gnu@1.31.1
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public
COPY next.config.ts vite.config.ts tsconfig.json next-env.d.ts ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.23.2-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node db ./db
COPY --chown=node:node lib ./lib
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 3000
CMD ["node", "node_modules/vinext/dist/cli.js", "start", "-H", "0.0.0.0", "-p", "3000"]
