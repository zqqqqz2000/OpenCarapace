FROM oven/bun:1.3-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
RUN bun run src/cli/opencarapace.ts config init

EXPOSE 3010

CMD ["bun", "run", "src/cli/opencarapace.ts", "gateway"]
