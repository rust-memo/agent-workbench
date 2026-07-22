FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS tools

ARG TARGETARCH
RUN apk add --no-cache ca-certificates unzip \
    && mkdir /out \
    && case "$TARGETARCH" in \
      amd64) \
        subfinder_sha=6529294788f56a20ed96a9b70e71f8f3c247f1d6104ba1e2c2e9e58d8a32c6cb; \
        dnsx_sha=1415020474886151a4820c62b9e68a315cc062f7f111a2fd13fda99047a809a6; \
        httpx_sha=63eac4dcd6e5c9867c94765fdaaf66e7b4eeae3474a1f06e600e266a1c81a53e; \
        katana_sha=503754f1bd370c3ef287df6998e317baed2dd75bdd13ea64034f09b80ca393f3; \
        nuclei_sha=dc238d6040813e14fc30514dac5a2eb1b430c694f3ca99eee2a5097e55076283 ;; \
      arm64) \
        subfinder_sha=e3dc19f1e1b1f01840989e5d2501fd59069e3fd6fc2387ca78fbe246ef5e0680; \
        dnsx_sha=94dc2d96aed1ae3e680dc09f070e67e48bd796583b8144c1de5bd3425a318847; \
        httpx_sha=7f3eaf5a6839504f5e2ce29c3ce94aa2ddeeaa7619d9a497e017232c6dc49b1c; \
        katana_sha=663b4ed2c6559a7dacc819e816889940d567ff554ac3f543c8c8f9b50245cd45; \
        nuclei_sha=78401fc570ed60a48b8a659f65f6645015a8b3b3097a5e50fc6fbe106a4b108a ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && fetch() { \
      name="$1"; version="$2"; checksum="$3"; archive="/tmp/${name}.zip"; \
      wget -qO "$archive" "https://github.com/projectdiscovery/${name}/releases/download/v${version}/${name}_${version}_linux_${TARGETARCH}.zip"; \
      echo "${checksum}  ${archive}" | sha256sum -c -; \
      unzip -q -j "$archive" "$name" -d /out; \
      chmod 0755 "/out/${name}"; \
      rm "$archive"; \
    } \
    && fetch subfinder 2.14.0 "$subfinder_sha" \
    && fetch dnsx 1.3.0 "$dnsx_sha" \
    && fetch httpx 1.10.0 "$httpx_sha" \
    && fetch katana 1.6.1 "$katana_sha" \
    && fetch nuclei 3.11.0 "$nuclei_sha"

FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS templates
RUN apk add --no-cache ca-certificates \
    && mkdir /templates \
    && wget -qO /tmp/templates.tar.gz https://github.com/projectdiscovery/nuclei-templates/archive/7d66fa06cc0a5ad85f7bf35f18cf8ee9218fa9a5.tar.gz \
    && echo "bb519f9fe89bfc37ae4bf5590c82507536aa1fc7fa00268d15589a0314643aa7  /tmp/templates.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/templates.tar.gz --strip-components=1 -C /templates \
    && echo "7d66fa06cc0a5ad85f7bf35f18cf8ee9218fa9a5" > /templates/.agent-workbench-commit \
    && rm /tmp/templates.tar.gz

FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

RUN apk upgrade --no-cache \
    && apk add --no-cache bind-tools ca-certificates \
    && addgroup -g 65532 scanner \
    && adduser -D -H -u 65532 -G scanner scanner

COPY --from=tools /out/ /usr/local/bin/
COPY --from=templates /templates /opt/nuclei-templates

ENV HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config

USER 65532:65532
WORKDIR /tmp
CMD ["subfinder", "-version"]
