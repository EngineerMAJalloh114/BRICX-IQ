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
# P6-05e (ADR 0081): the password denylist the realm's passwordBlacklist
# policy reads. Not in data/ (the keycloak-data volume: an existing volume
# never sees new image files, and the P5-02b nested-mount defect), so the
# image carries it in conf/ and points Keycloak there. Without the file
# Keycloak refuses to start (fail closed).
COPY password-blacklists/bricx-common-passwords.txt /opt/keycloak/conf/password-blacklists/bricx-common-passwords.txt
ENV KC_SPI_PASSWORD_POLICY__PASSWORD_BLACKLIST__BLACKLISTS_PATH=/opt/keycloak/conf/password-blacklists
