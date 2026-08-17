FROM node:24-alpine

WORKDIR /app
COPY gateway.mjs ./gateway.mjs

USER node
EXPOSE 18081
CMD ["node", "gateway.mjs"]
