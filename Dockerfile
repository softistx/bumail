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

# ---- build: install, build every package, compile the server --------------
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
 && bun run build \
 # One executable: Bun, the server and its @bumail/* packages, with bun:sqlite,
 # Bun.password and node:tls inside Bun. It reads no .env or bunfig.toml from
 # the directory it runs in, and has no package.json to ask its version of, so
 # the build tells it.
 && cd packages/server \
 && bun build --compile --minify \
      --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
      --define "BUMAIL_COMPILED_VERSION=\"$(bun -p "require('./package.json').version")\"" \
      dist/main.js --outfile /out/bumail \
 && mkdir /out/data

# ---- runtime: glibc, CA certificates, a shell-less non-root process ---------
FROM gcr.io/distroless/cc-debian12:latest
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
