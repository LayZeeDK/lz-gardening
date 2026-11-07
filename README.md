# lz-gardening

A Claude Code plugin marketplace hosting **lz-gardening**: garden a codebase that agents write. Watch for weeds,
queue them with evidence, and turn each recurring weed into a rule so it cannot grow back.

```text
/plugin marketplace add LayZeeDK/lz-gardening
/plugin install lz-gardening@lz-gardening
```

The plugin lives in [`plugins/lz-gardening/`](plugins/lz-gardening/); its [README](plugins/lz-gardening/README.md)
covers the skills, the garden site and usage. [`GLOSSARY.md`](GLOSSARY.md) defines the terms.

## Development

Node.js 22.18 or later.

```bash
npm ci
npm run check
claude --plugin-dir ./plugins/lz-gardening
```

`npm run check` type-checks, lints, checks formatting and runs every test, including `tools/hygiene.test.ts`,
which keeps the plugin free of references to other tools and the maintainer's identity public.

## License

MIT, see [LICENSE](LICENSE).
