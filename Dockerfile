FROM oven/bun:1.4.4-alpine AS build
WORKDIR /src

COPY bin ./bin
COPY src ./src

RUN bun build \
  --compile \
  --target=bun-linux-x64-musl \
  --outfile=/out/gnutonium \
  ./bin/gnutonium.ts

FROM scratch

COPY --from=build /out/gnutonium /gnutonium
COPY --from=build /lib/ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1
COPY --from=build /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=build /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

VOLUME ["/data"]

ENTRYPOINT ["/gnutonium"]
CMD ["run", "--config", "/data/gnutella.json"]
