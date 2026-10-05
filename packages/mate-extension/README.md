# pi-mate-companion

Persisto Mate companion as an installable [pi](https://github.com/earendil-works/pi-mono) extension:
a learned body clock, real sleep and dreams, its own memory and feelings — the full MATE kernel
bundled in, zero runtime dependencies (the host provides pi's modules as peers).

## Install

In any pi (or mate) install:

```
pi install git:github.com/m-rui001/pi-mate-companion
# or, if published to npm:
pi install npm:@m-rui/pi-mate-companion
```

The companion's state lives under the host's agent dir (`~/.pi/agent/mate`), next to the sessions,
models.json and auth.json the host already uses. On the mate fork the extension is already bundled.

Built from the [Persisto-Mate monorepo](https://github.com/m-rui001/Persisto-Mate)
(`packages/coding-agent/src/extensions/mate`, kernel `@earendil-works/pi-mate`).
