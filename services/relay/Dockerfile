# Runs the bundle from `pnpm --filter @zoltbot/relay build`. Build it first; see README.md.
FROM node:24.22.1-slim
ENV NODE_ENV=production
WORKDIR /app
COPY dist/main.mjs ./main.mjs
USER node
EXPOSE 8080
CMD ["node", "main.mjs"]
