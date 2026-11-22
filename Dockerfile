# Mailroom — self-hosted mail sender
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    GUI_HOST=0.0.0.0 \
    GUI_PORT=4173 \
    MAILROOM_CONFIG=/home/node/.mailroom/config.env

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Code stays root-owned and read-only to the app; only the directories it
# writes to belong to the unprivileged `node` user (uid 1000).
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY --chown=node:node templates ./templates

RUN mkdir -p data logs /home/node/.mailroom \
 && chown node:node data logs /home/node/.mailroom

USER node

# Settings live in the first volume. Named volumes are created owned by
# `node`; a bind mount must be writable by uid 1000.
VOLUME ["/home/node/.mailroom", "/app/data", "/app/templates", "/app/logs"]

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "const tls=!!(process.env.MAILROOM_TLS_CERT&&process.env.MAILROOM_TLS_KEY);const mod=require(tls?'node:https':'node:http');const port=process.env.GUI_PORT||4173;mod.get({host:'127.0.0.1',port,path:'/api/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# MAILROOM_PASSWORD_HASH (or MAILROOM_PASSWORD) is required: the container
# binds 0.0.0.0 and the app refuses to start on a non-loopback host without a
# password (even with MAILROOM_ALLOW_INSECURE=1). Also set MAILROOM_TLS_CERT and
# MAILROOM_TLS_KEY (PEM paths inside the container), or set
# MAILROOM_ALLOW_INSECURE=1 and MAILROOM_TRUST_PROXY=1 when a trusted proxy
# terminates TLS.
#   docker run -e MAILROOM_PASSWORD_HASH=scrypt:... -e MAILROOM_TLS_CERT=/certs/cert.pem \
#     -e MAILROOM_TLS_KEY=/certs/key.pem -v "$PWD/certs:/certs:ro" \
#     -p 4173:4173 mailroom
CMD ["node", "src/gui.mjs"]
