FROM example/listed:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
COPY --from=example/other:2.0.0 /x /x
