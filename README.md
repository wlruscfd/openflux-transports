# openflux-transports

Signed transport packages that the OpenFlux app downloads and uses in place of its built-in implementation. The built-in
transport stays in the app as the fallback.

- `catalog.json` is the list of transports: the app reads it from `main` and installs and updates everything it lists, so adding or
  dropping a transport is an edit of that file. A package is only used where the app has a built-in transport of the same id to
  replace and fall back to (today `mailru` and `cupsonline`); the others are downloaded and kept until an app version wires them in.
- `<id>/manifest.json`, `<id>/src/<id>.js` are the source of a transport (JS, run by the app's script host); shared code is in `lib/`.
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

Transports: mailru, cupsonline, yandex, vyandex, boards, oneme-webrtc, oneme-iceinject.
