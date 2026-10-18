# Multi-stage, pinned and listed (ADR 0060).
FROM example/listed:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef AS builder
ENV A=1 \
    B=2
RUN ["/bin/build"]
FROM example/listed:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
COPY --from=builder /out/ /out/
COPY local.txt /etc/local.txt
USER 1000
