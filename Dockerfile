# Mailroom — self-hosted mail sender
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    GUI_HOST=0.0.0.0 \
    GUI_PORT=4173

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY src ./src
COPY public ./public
COPY templates ./templates

RUN mkdir -p data logs

# Settings live here unless MAILROOM_CONFIG points elsewhere.
VOLUME ["/root/.mailroom", "/app/data", "/app/templates", "/app/logs"]

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "const tls=!!(process.env.MAILROOM_TLS_CERT&&process.env.MAILROOM_TLS_KEY);const mod=require(tls?'node:https':'node:http');const port=process.env.GUI_PORT||4173;mod.get({host:'127.0.0.1',port,path:'/api/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# MAILROOM_PASSWORD is required when publishing beyond this machine: without
# it, anyone who can reach the port can send mail with your credentials.
# Because the container binds 0.0.0.0, also set MAILROOM_TLS_CERT and
# MAILROOM_TLS_KEY (PEM paths inside the container), or set
# MAILROOM_ALLOW_INSECURE=1 when a trusted proxy terminates TLS.
#   docker run -e MAILROOM_PASSWORD=... -e MAILROOM_TLS_CERT=/certs/cert.pem \
#     -e MAILROOM_TLS_KEY=/certs/key.pem -v "$PWD/certs:/certs:ro" \
#     -p 4173:4173 mailroom
CMD ["node", "src/gui.mjs"]
