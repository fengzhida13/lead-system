FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN mkdir -p data logs
ENV PORT=3456
EXPOSE 3456
CMD ["node", "server.js"]
