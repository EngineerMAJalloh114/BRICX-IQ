FROM example/listed:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef AS one
COPY --from=two /x /x
FROM example/listed:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef AS two
