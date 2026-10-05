# syntax=docker/dockerfile:1
#
# The bumail image: the whole stack (SMTP, IMAP, JMAP, the queue, ACME) as one
# `bumail` binary on a small glibc base. Nothing is baked in: no configuration,
# no key, no certificate. Everything the server keeps lives on the /data volume.
#
#   docker build -t bumail .
#   docker run --rm -v bumail-data:/data bumail init --hostname mail.example.com --domain example.com
#
# See deploy/ and packages/server/docs/deploy.md.

# ---- manifests: every package.json, so the install layer is cached --------
# oven/bun:1.4.2, by digest. Built for the build machine, like the stage below:
# it only copies files, and no stage of the image runs a program of its platform,
# so a multi-platform build needs no emulation at all.
FROM --platform=$BUILDPLATFORM oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests \;

# ---- build: install, build every package, compile the server --------------
# Always on the build machine's own platform, whatever the image's: Bun
# cross-compiles the executable for TARGETARCH (--target below), so a
# multi-platform build never runs Bun under emulation.
FROM --platform=$BUILDPLATFORM oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
ARG TARGETARCH
WORKDIR /src
# The install changes only when a manifest or the lockfile does.
COPY --from=manifests /manifests ./
COPY bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build \
 # One executable: Bun, the server and its @bumail/* packages, with bun:sqlite,
 # Bun.password and node:tls inside Bun. It reads no .env or bunfig.toml from
 # the directory it runs in, and has no package.json to ask its version of, so
 # the build tells it. The target is the image's architecture (Docker's amd64
 # and arm64, Bun's x64 and arm64), glibc as the runtime base is.
 && cd packages/server \
 && bun build --compile --minify \
      --target "bun-linux-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH")" \
      --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
      --define "BUMAIL_COMPILED_VERSION=\"$(bun -p "require('./package.json').version")\"" \
      dist/main.js --outfile /out/bumail \
 && mkdir /out/data

# ---- runtime: glibc, CA certificates, a shell-less non-root process ---------
# gcr.io/distroless/cc-debian12 (the `latest` tag when pinned), by digest.
FROM gcr.io/distroless/cc-debian12@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa
COPY --from=build /out/bumail /usr/local/bin/bumail
# The volume starts as this folder, so a new named volume is owned by the user.
COPY --from=build --chown=10001:10001 /out/data /data
USER 10001:10001
WORKDIR /data
VOLUME /data

# 25 mail from other servers, 465 and 587 submission, 993 IMAP, 443 JMAP,
# 80 ACME's HTTP-01 challenges. Which are published is the compose file's choice.
EXPOSE 25 80 443 465 587 993

# bumail reads /data/bumail.toml, which `bumail init` writes. Binding a port
# below 1024 as this user needs net.ipv4.ip_unprivileged_port_start=0 in the
# container's network namespace: Docker sets it, and the compose files say so.
ENTRYPOINT ["/usr/local/bin/bumail"]
CMD ["serve", "--config", "/data/bumail.toml"]

# `docker stop` sends SIGTERM: a clean stop takes up to 15 seconds, so give it
# stop_grace_period: 30s. SIGHUP looks for a renewed certificate.
STOPSIGNAL SIGTERM

# The first certificate can take minutes (five tries, with waits): no failure
# counts until the start period has passed.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5m --retries=3 \
  CMD ["/usr/local/bin/bumail", "health"]
