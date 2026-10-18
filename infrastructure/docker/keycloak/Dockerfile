# Dev and test Keycloak (P5-01, ADR 0060). Used by compose.yml and by
# tooling/keycloak-realm's integration tests (Testcontainers builds this
# same file). kc.sh build runs here once, so `start --optimized` boots in
# seconds instead of rebuilding Quarkus on every start (start-dev took
# about 5 minutes cold on the owner's machine). Build-time options: health
# endpoints on, the dev-file database. Production builds its own image at
# P13-01 (ADR 0060).
FROM keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85 AS builder
ENV KC_HEALTH_ENABLED=true \
    KC_DB=dev-file
RUN ["/opt/keycloak/bin/kc.sh", "build"]

FROM keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85
COPY --from=builder /opt/keycloak/ /opt/keycloak/
