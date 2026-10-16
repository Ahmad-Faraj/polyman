# The polyman verify service. Build from the repository root:
#   docker build -f service/Dockerfile -t polyman-verify .
#
# polyman is built from this repository, so the service always runs the code
# in the same commit. The image carries the compilers and testlib.h because
# the service has no network access when it runs.

FROM node:22-bookworm AS polyman
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund --loglevel=error

FROM node:22-bookworm
# g++ and python3 come with this image. Java solutions need a JDK, and polyman
# runs Python solutions as `python`, which Debian only provides through
# python-is-python3.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jdk-headless python-is-python3 tini \
 && rm -rf /var/lib/apt/lists/*
# testlib.h pinned to a commit, so a change upstream can't change our verdicts
ADD --checksum=sha256:bb323e3c89285214966076e0d23d5a295c5f6126da7ff198c1276ddb95ecb1a0 https://raw.githubusercontent.com/MikeMirzayanov/testlib/2d20123984e9479b8a56ebe0d6a51e23ad7c35b3/testlib.h /opt/testlib/testlib.h
RUN chmod 755 /opt/testlib && chmod 644 /opt/testlib/testlib.h

WORKDIR /app
COPY --from=polyman /src/package.json ./package.json
COPY --from=polyman /src/node_modules ./node_modules
COPY --from=polyman /src/dist ./dist
COPY assets ./assets
COPY template ./template

COPY service/package.json service/package-lock.json ./service/
RUN cd service && npm ci --omit=dev --no-audit --no-fund --loglevel=error
COPY service/src ./service/src
COPY service/public ./service/public
COPY service/samples ./service/samples

# Uploaded code runs as `runner`, a user that owns nothing in the image. The service stays root only to hand each upload to that user, start
# polyman as that user and kill every runner process when a run ends; the
# uploaded code can't signal, inspect or read the service.
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin runner

ARG APP_COMMIT=dev
ENV NODE_ENV=production \
    PORT=8080 \
    POLYMAN_CLI=/app/dist/cli.js \
    TESTLIB_H=/opt/testlib/testlib.h \
    RUNNER_UID=10001 \
    RUNNER_GID=10001 \
    APP_COMMIT=$APP_COMMIT

EXPOSE 8080
# tini as PID 1 reaps whatever a killed run leaves behind
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-sigusr1", "--disable-warning=ExperimentalWarning", "service/src/server.ts"]
