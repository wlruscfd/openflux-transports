# openflux-transports

Signed transport packages that the OpenFlux app downloads and uses in place of its built-in implementation. The built-in
transport stays in the app as the fallback.

- `catalog.json` lists the transports; the app reads it from `main`.
- `<id>/manifest.json`, `<id>/src/<id>.js` are the source of a transport (JS, run by the app's script host).
- `<id>/<id>-<version>.flux` is the signed package, `<id>/update.json` the index the app follows.

## How an update reaches a phone

1. The app fetches `catalog.json` and each `update.json`, and downloads a newer package if the sha256 matches.
2. The package must verify under the project key built into the app, and keep the same wire format (`wire`).
3. If the new version does not connect within 45 s while the built-in transport does, twice, the app rolls back to the
   previous package, or to the built-in transport when there is none.

## Releasing a transport

Bump `version` in `<id>/manifest.json`, then:

```bash
python tools/build.py --server ../openflux-server --key /path/to/transports_priv.key --notes "what changed"
```

Commit the new `.flux` and `update.json` together. A change of the wire format needs a new `wire` number and a matching
node release.
