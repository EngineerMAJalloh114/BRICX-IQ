FROM example/listed:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
RUN --mount=type=secret,id=x cat /run/secrets/x
